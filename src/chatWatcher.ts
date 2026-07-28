import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const STATE_KEY = 'iceberg.chatWatch.v3';

/** How often the directory list is rebuilt (new windows create new storage dirs). */
const DIR_REFRESH_MS = 30_000;
/** Files bigger than this are ignored so a pathological transcript can't stall the host. */
const MAX_FILE_BYTES = 96 * 1024 * 1024;

export interface ChatUsageDelta {
  input: number;
  output: number;
  credits: number;
  requests: number;
}

interface Totals {
  prompt: number;
  completion: number;
  credits: number;
  requests: number;
}

interface PersistedFile {
  /** Bytes already consumed. */
  offset: number;
  /** Last observed size, used to detect rewrites/truncation. */
  size: number;
  /** Totals from this file already pushed into the meter. */
  input: number;
  output: number;
  credits: number;
  requests: number;
}

interface PersistedState {
  seeded: boolean;
  files: Record<string, PersistedFile>;
}

interface RequestTotals {
  prompt: number;
  completion: number;
  credits: number;
}

/**
 * Running parse state for one transcript.
 *
 * `live` holds the newest counter values per request slot. Copilot rewrites a
 * request's counters as an agent turn progresses, so they are cumulative and
 * only grow — until a slot is reused by a different request, at which point the
 * counter drops. When that happens the finished value moves into `retired` so
 * earlier burn is never forgotten.
 *
 * `base` is whatever a `kind:0` snapshot brought in. VS Code seeds continuation
 * transcripts with the previous session's state, and that is history rather
 * than fresh burn, so it is subtracted before anything is charged.
 */
export interface ParserState {
  live: Map<number, RequestTotals>;
  count: number;
  retired: Totals;
  base: Totals;
}

function zero(): Totals {
  return { prompt: 0, completion: 0, credits: 0, requests: 0 };
}

export function newParserState(): ParserState {
  return { live: new Map(), count: 0, retired: zero(), base: zero() };
}

/** Everything this transcript has burned so far, retired slots included. */
export function parserTotals(state: ParserState): Totals {
  const out: Totals = { ...state.retired };
  for (const totals of state.live.values()) {
    if (totals.prompt === 0 && totals.completion === 0 && totals.credits === 0) {
      continue;
    }
    out.prompt += totals.prompt;
    out.completion += totals.completion;
    out.credits += totals.credits;
    out.requests += 1;
  }
  return out;
}

/** Per-file live state. */
interface LiveFile extends PersistedFile {
  parser: ParserState;
  /** Amount already charged from the current parse window. */
  window: Totals;
  /** Set when the file was re-read from the top and the window needs rebasing. */
  pendingRebase?: boolean;
}

/**
 * Watches the chat transcripts VS Code writes to disk and turns the token
 * counters recorded there into usage deltas.
 *
 * VS Code (1.130+) stores each chat session as an append-only JSONL patch log:
 *   {"kind":0,"v":{...session...}}                             snapshot
 *   {"kind":1,"k":["requests",3,"promptTokens"],"v":37764}     set value
 *   {"kind":2,"k":["requests"],"v":[{...}]}                    append to array
 *
 * Copilot writes the authoritative counts per request as `promptTokens`,
 * `completionTokens` and `copilotCredits`, so no estimation is involved.
 */
export class ChatUsageWatcher implements vscode.Disposable {
  private readonly files = new Map<string, LiveFile>();
  private dirs: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private dirsRefreshedAt = 0;
  private seeded: boolean;
  private disposed = false;
  private scanning = false;
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onUsage: (delta: ChatUsageDelta) => void,
    private readonly log?: (message: string) => void
  ) {
    const stored = context.globalState.get<PersistedState>(STATE_KEY);
    this.seeded = stored?.seeded ?? false;
    for (const [file, state] of Object.entries(stored?.files ?? {})) {
      this.files.set(file, {
        offset: Math.max(0, state.offset | 0),
        size: Math.max(0, state.size | 0),
        input: Math.max(0, state.input || 0),
        output: Math.max(0, state.output || 0),
        credits: Math.max(0, state.credits || 0),
        requests: Math.max(0, state.requests || 0),
        parser: newParserState(),
        window: zero()
      });
    }
  }

  get enabled(): boolean {
    return vscode.workspace.getConfiguration('iceberg').get<boolean>('trackCopilotChat', true);
  }

  private get pollMs(): number {
    const raw = vscode.workspace.getConfiguration('iceberg').get<number>('chatPollIntervalMs', 4000);
    return Math.min(60_000, Math.max(1000, Math.round(raw) || 4000));
  }

  start(): void {
    this.stop();
    if (this.disposed || !this.enabled) {
      return;
    }
    // Defer the first pass: it walks every transcript on disk and must not sit
    // in the way of activation.
    const first = setTimeout(() => this.scan(), 0);
    first.unref?.();
    this.timer = setInterval(() => this.scan(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Re-reads settings; called when the user toggles tracking on or off. */
  reconfigure(): void {
    if (this.enabled) {
      this.start();
    } else {
      this.stop();
    }
  }

  /**
   * Forgets everything learned so far and re-baselines against the current
   * transcripts, so a reset doesn't immediately re-import historic usage.
   */
  rebaseline(): void {
    this.files.clear();
    this.seeded = false;
    this.persist(true);
    // Synchronous on purpose: after a reset everything already on disk must be
    // history before the next poll can charge any of it.
    this.scan();
  }

  /** Roots that can contain chat transcripts, derived from our own storage path. */
  private discoverDirs(): string[] {
    const globalStorage = path.dirname(this.context.globalStorageUri.fsPath);
    const userDir = path.dirname(globalStorage);
    const found: string[] = [];

    const emptyWindow = path.join(globalStorage, 'emptyWindowChatSessions');
    if (isDir(emptyWindow)) {
      found.push(emptyWindow);
    }

    const workspaceStorage = path.join(userDir, 'workspaceStorage');
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(workspaceStorage, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = path.join(workspaceStorage, entry.name, 'chatSessions');
      if (isDir(dir)) {
        found.push(dir);
      }
    }
    return found;
  }

  scan(): void {
    if (this.disposed || this.scanning || !this.enabled) {
      return;
    }
    this.scanning = true;
    try {
      const now = Date.now();
      if (now - this.dirsRefreshedAt > DIR_REFRESH_MS || this.dirs.length === 0) {
        this.dirs = this.discoverDirs();
        this.dirsRefreshedAt = now;
      }

      const delta: ChatUsageDelta = { input: 0, output: 0, credits: 0, requests: 0 };
      let touched = false;

      for (const dir of this.dirs) {
        let names: string[];
        try {
          names = fs.readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.endsWith('.jsonl')) {
            continue;
          }
          const file = path.join(dir, name);
          let stat: fs.Stats;
          try {
            stat = fs.statSync(file);
          } catch {
            continue;
          }
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
            continue;
          }
          const known = this.files.get(file);
          if (known && stat.size === known.size) {
            continue;
          }
          if (this.consume(file, stat.size, delta)) {
            touched = true;
          }
        }
      }

      if (delta.input > 0 || delta.output > 0 || delta.credits > 0) {
        this.log?.(
          `chat usage +${delta.input} in / +${delta.output} out / ` +
            `${delta.credits.toFixed(2)} credits over ${delta.requests} request(s)`
        );
        this.onUsage(delta);
      }
      if (!this.seeded) {
        this.seeded = true;
        this.persist(true);
      } else if (touched) {
        this.persist();
      }
    } finally {
      this.scanning = false;
    }
  }

  /** Reads the unseen tail of one transcript. Returns true if state changed. */
  private consume(file: string, size: number, delta: ChatUsageDelta): boolean {
    let state = this.files.get(file);
    const isNew = !state;
    if (!state) {
      state = {
        offset: 0,
        size: 0,
        input: 0,
        output: 0,
        credits: 0,
        requests: 0,
        parser: newParserState(),
        window: zero()
      };
      this.files.set(file, state);
    }

    // A shrunken file means VS Code rewrote it, so re-read from the top. How
    // much of the rescan counts as already-charged depends on how much history
    // the rewritten file declares up front, which is only known after parsing.
    if (size < state.offset) {
      state.offset = 0;
      state.parser = newParserState();
      state.window = zero();
      state.pendingRebase = true;
    }

    const from = state.offset;
    let chunk: Buffer;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const length = Math.max(0, size - from);
        chunk = Buffer.alloc(length);
        if (length > 0) {
          fs.readSync(fd, chunk, 0, length, from);
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }

    const text = chunk.toString('utf8');
    // Only advance past the last complete line; the tail may still be mid-write.
    const lastBreak = text.lastIndexOf('\n');
    if (lastBreak >= 0) {
      for (const line of text.slice(0, lastBreak).split('\n')) {
        applyLine(line, state.parser);
      }
      state.offset = from + Buffer.byteLength(text.slice(0, lastBreak + 1), 'utf8');
    }
    state.size = size;

    const total = parserTotals(state.parser);
    const base = state.parser.base;
    // Anything a snapshot brought in is prior history, not new burn.
    const prompt = Math.max(0, total.prompt - base.prompt);
    const completion = Math.max(0, total.completion - base.completion);
    const credits = Math.max(0, total.credits - base.credits);
    const requests = Math.max(0, total.requests - base.requests);

    // After a rewrite, discount whatever the new file already declares as
    // history so the same requests are not billed a second time.
    if (state.pendingRebase) {
      state.pendingRebase = false;
      state.window = {
        prompt: Math.max(0, state.input - base.prompt),
        completion: Math.max(0, state.output - base.completion),
        credits: Math.max(0, state.credits - base.credits),
        requests: Math.max(0, state.requests - base.requests)
      };
    }

    // First run ever: adopt what is already on disk so installing the extension
    // doesn't instantly melt the iceberg with the user's back catalogue.
    if (!this.seeded && isNew) {
      state.input = state.window.prompt = prompt;
      state.output = state.window.completion = completion;
      state.credits = state.window.credits = credits;
      state.requests = state.window.requests = requests;
      return true;
    }

    const dIn = Math.max(0, prompt - state.window.prompt);
    const dOut = Math.max(0, completion - state.window.completion);
    const dCredits = Math.max(0, credits - state.window.credits);
    const dRequests = Math.max(0, requests - state.window.requests);

    if (dIn > 0 || dOut > 0 || dCredits > 0) {
      state.window.prompt += dIn;
      state.window.completion += dOut;
      state.window.credits += dCredits;
      state.window.requests += dRequests;
      state.input += dIn;
      state.output += dOut;
      state.credits += dCredits;
      state.requests += dRequests;
      delta.input += dIn;
      delta.output += dOut;
      delta.credits += dCredits;
      delta.requests += dRequests;
    }
    return true;
  }

  private persist(immediate = false): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    const write = () => {
      const files: Record<string, PersistedFile> = {};
      for (const [file, state] of this.files) {
        files[file] = {
          offset: state.offset,
          size: state.size,
          input: state.input,
          output: state.output,
          credits: state.credits,
          requests: state.requests
        };
      }
      void this.context.globalState.update(STATE_KEY, {
        seeded: this.seeded,
        files
      } satisfies PersistedState);
    };
    if (immediate) {
      write();
      return;
    }
    this.saveTimer = setTimeout(write, 2000);
    this.saveTimer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.persist(true);
  }
}

/**
 * Applies one JSONL patch record to the running parse state.
 * Exported for tests.
 */
export function applyLine(line: string, state: ParserState): void {
  const trimmed = line.trim();
  if (!trimmed || trimmed.charCodeAt(0) !== 123 /* { */) {
    return;
  }
  // Transcripts are dominated by huge response blobs, so skip anything that
  // cannot affect the counters before paying for JSON.parse.
  const isAppend = trimmed.startsWith('{"kind":2,"k":["requests"],');
  const isSnapshot = trimmed.startsWith('{"kind":0');
  if (!isAppend && !isSnapshot && !trimmed.includes('Tokens') && !trimmed.includes('copilotCredits')) {
    return;
  }

  let record: unknown;
  try {
    record = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!record || typeof record !== 'object') {
    return;
  }
  const { k, v } = record as { k?: unknown; v?: unknown };
  const key = Array.isArray(k) ? k : [];

  // {"kind":1,"k":["requests",3,"promptTokens"],"v":37764}
  if (key.length === 3 && key[0] === 'requests') {
    const index = toIndex(key[1]);
    if (index >= 0 && typeof v === 'number' && Number.isFinite(v)) {
      assign(state, index, String(key[2]), v);
    }
    return;
  }

  // {"kind":1|2,"k":["requests",3],"v":{...}} — a whole request object.
  if (key.length === 2 && key[0] === 'requests') {
    const index = toIndex(key[1]);
    if (index >= 0) {
      absorbRequest(state, index, v);
    }
    return;
  }

  // {"kind":2,"k":["requests"],"v":[{...}]} — requests appended to the array.
  if (key.length === 1 && key[0] === 'requests' && Array.isArray(v)) {
    const start = state.count;
    v.forEach((entry, i) => absorbRequest(state, start + i, entry));
    state.count = start + v.length;
    return;
  }

  // {"kind":0,"v":{...session...}} — the document is replaced wholesale.
  if (key.length === 0 && v && typeof v === 'object') {
    const requests = (v as { requests?: unknown }).requests;
    if (!Array.isArray(requests)) {
      return;
    }
    // Retire whatever the previous document held, then adopt the snapshot and
    // record its contents as history that must never be charged.
    state.retired = parserTotals(state);
    state.live.clear();
    state.count = requests.length;
    requests.forEach((entry, i) => absorbRequest(state, i, entry));
    const adopted = parserTotals(state);
    state.base.prompt += adopted.prompt - state.retired.prompt;
    state.base.completion += adopted.completion - state.retired.completion;
    state.base.credits += adopted.credits - state.retired.credits;
    state.base.requests += adopted.requests - state.retired.requests;
  }
}

function absorbRequest(state: ParserState, index: number, value: unknown): void {
  state.count = Math.max(state.count, index + 1);
  if (!value || typeof value !== 'object') {
    return;
  }
  const req = value as Record<string, unknown>;
  for (const field of ['promptTokens', 'completionTokens', 'copilotCredits']) {
    const raw = req[field];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      assign(state, index, field, raw);
    }
  }
}

type CounterKey = 'prompt' | 'completion' | 'credits';

function assign(state: ParserState, index: number, field: string, value: number): void {
  if (!(value >= 0)) {
    return;
  }
  state.count = Math.max(state.count, index + 1);
  let totals = state.live.get(index);
  if (!totals) {
    totals = { prompt: 0, completion: 0, credits: 0 };
    state.live.set(index, totals);
  }

  const key: CounterKey =
    field === 'promptTokens' ? 'prompt' : field === 'completionTokens' ? 'completion' : 'credits';
  const current = totals[key];
  if (value < current) {
    // The slot was handed to a different request, so bank the finished value.
    state.retired[key] += current;
    if (key === 'prompt') {
      state.retired.requests += 1;
    }
  }
  totals[key] = value;
}

function toIndex(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n >= 0 ? n : -1;
}

function isDir(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
