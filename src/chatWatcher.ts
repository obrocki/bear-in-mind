import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { nonnegative } from './spanUsage';
import { loadSqlite, type SqliteDatabase } from './sqlite';

const STATE_KEY = 'iceberg.chatCredits.v1';
const MAX_FILE_BYTES = 96 * 1024 * 1024;
const INDEX_KEY = 'chat.ChatSessionStore.index';

interface RequestUsage {
  modelId?: string;
  copilotCredits?: number;
  sessionCopilotCredits?: number;
}

export interface ChatSessionUsage {
  sessionId: string;
  /** The displayed chat-history title, including generated and custom titles. */
  title?: string;
  updatedAt: number;
  credits?: number;
  model?: string;
}

export interface ParserState {
  sessionId?: string;
  title?: string;
  requests: RequestUsage[];
}

export function newParserState(): ParserState {
  return { requests: [] };
}

const FIELDS = ['modelId', 'copilotCredits', 'sessionCopilotCredits'] as const;

function requestUsage(raw: unknown): RequestUsage {
  const result: RequestUsage = {};
  if (!raw || typeof raw !== 'object') {
    return result;
  }
  const value = raw as Record<string, unknown>;
  for (const field of FIELDS) {
    if (field === 'modelId') {
      if (typeof value[field] === 'string' && value[field].length <= 512) {
        result[field] = value[field];
      }
    } else {
      result[field] = nonnegative(value[field]);
    }
  }
  return result;
}

/** Keep only the bounded display title, never reconstruct it from prompt text. */
export function sessionTitle(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 512) {
    return undefined;
  }
  const title = raw.replace(/\s+/g, ' ').trim();
  if (!title) {
    return undefined;
  }
  return title;
}

export function chatSessionIndex(raw: unknown): ChatSessionUsage[] {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid chat-history index; session names may be unavailable.');
  }
  const index = raw as Record<string, unknown>;
  if (index.version !== 1 || !index.entries || typeof index.entries !== 'object' || Array.isArray(index.entries)) {
    throw new Error('Unsupported chat-history index; session names may be unavailable.');
  }
  const sessions: ChatSessionUsage[] = [];
  for (const [id, value] of Object.entries(index.entries)) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const entry = value as Record<string, unknown>;
    const updatedAt = nonnegative(entry.lastMessageDate);
    if (updatedAt !== undefined) {
      sessions.push({
        sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : id,
        title: sessionTitle(entry.title),
        updatedAt
      });
    }
  }
  return sessions;
}

/** Replay VS Code's mutation log, projecting only usage metadata. */
export function applyLine(line: string, state: ParserState): boolean {
  if (!line.trim()) {
    return true;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return false;
  }
  if (!raw || typeof raw !== 'object') {
    return false;
  }
  const { kind, k, v, i } = raw as { kind?: number; k?: unknown; v?: unknown; i?: number };
  if (kind === 0) {
    const doc = v as { sessionId?: unknown; customTitle?: unknown; requests?: unknown[] } | undefined;
    state.sessionId = typeof doc?.sessionId === 'string' ? doc.sessionId : undefined;
    state.title = sessionTitle(doc?.customTitle);
    state.requests = Array.isArray(doc?.requests) ? doc.requests.map(requestUsage) : [];
    return true;
  }
  const key = Array.isArray(k) ? k : [];
  if (key.length === 1 && key[0] === 'sessionId') {
    state.sessionId = kind === 3 ? undefined : typeof v === 'string' ? v : undefined;
  }
  if (key.length === 1 && key[0] === 'customTitle') {
    state.title = kind === 3 ? undefined : sessionTitle(v);
  }
  if (key[0] !== 'requests') {
    return true;
  }
  if (key.length === 1) {
    if (kind === 2) {
      const start = i === undefined ? state.requests.length : i;
      if (!Number.isInteger(start) || start < 0 || start > state.requests.length) {
        return false;
      }
      state.requests.splice(start, state.requests.length - start, ...(Array.isArray(v) ? v.map(requestUsage) : []));
    } else if (kind === 1 || kind === 3) {
      state.requests = Array.isArray(v) && kind !== 3 ? v.map(requestUsage) : [];
    }
    return true;
  }
  const index = key[1];
  if (!Number.isInteger(index) || index < 0 || index > state.requests.length) {
    return false;
  }
  if (key.length === 2) {
    state.requests[index] = kind === 3 ? {} : requestUsage(v);
  } else if (key.length === 3 && FIELDS.some((field) => field === key[2])) {
    const field = key[2] as typeof FIELDS[number];
    state.requests[index] = requestUsage({
      ...state.requests[index],
      [field]: kind === 3 ? undefined : v
    });
  }
  return true;
}

/** Same formula as IChatModel.sessionCost, including backend session totals. */
export function sessionUsage(state: ParserState, fallbackId: string, updatedAt: number): ChatSessionUsage {
  let summed = 0;
  let reported = 0;
  let hasCredits = false;
  for (const request of state.requests) {
    if (request.copilotCredits !== undefined) {
      summed += request.copilotCredits;
      hasCredits = true;
    }
    if (request.sessionCopilotCredits !== undefined) {
      reported = Math.max(reported, request.sessionCopilotCredits);
      hasCredits = true;
    }
  }
  const last = [...state.requests].reverse().find((request) => request.modelId !== undefined);
  return {
    sessionId: state.sessionId ?? fallbackId, title: state.title, updatedAt,
    credits: hasCredits ? Math.max(summed, reported) : undefined,
    model: last?.modelId
  };
}

interface LiveFile {
  offset: number;
  size: number;
  mtime: number;
  parser: ParserState;
  usage?: ChatSessionUsage;
}

interface CachedIndex {
  fingerprint: string;
  sessions: ChatSessionUsage[];
}

function fileFingerprint(file: string): string | undefined {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function indexFingerprint(file: string): string | undefined {
  const database = fileFingerprint(file);
  return database === undefined ? undefined : `${database}|${fileFingerprint(`${file}-wal`) ?? 'missing'}`;
}

/** Reads transcript metadata and reported credits; token snapshots are ignored. */
export class ChatUsageWatcher implements vscode.Disposable {
  private readonly files = new Map<string, LiveFile>();
  private readonly indexCache = new Map<string, CachedIndex>();
  private readonly indexedSessions = new Map<string, ChatSessionUsage>();
  private readonly _onDidScan = new vscode.EventEmitter<void>();
  readonly onDidScan = this._onDidScan.event;
  private readonly credits: Record<string, number>;
  private seeded: boolean;
  private timer?: NodeJS.Timeout;
  private disposed = false;
  private readonly warnings = new Set<string>();

  constructor(
    private readonly context: Pick<vscode.ExtensionContext, 'globalStorageUri'> & { readonly globalState: vscode.Memento },
    private readonly onUsage: (credits: number) => void,
    private readonly log?: (message: string) => void
  ) {
    const stored = context.globalState.get<{ seeded: boolean; credits: Record<string, number> }>(STATE_KEY);
    this.seeded = stored?.seeded ?? false;
    this.credits = stored?.credits ?? {};
  }

  get enabled(): boolean {
    return vscode.workspace.getConfiguration('iceberg').get<boolean>('trackCopilotChat', true);
  }

  get sessions(): ChatSessionUsage[] {
    if (!this.enabled) {
      return [];
    }
    const sessions = new Map(this.indexedSessions);
    const transcripts = new Map<string, ChatSessionUsage>();
    for (const file of this.files.values()) {
      const usage = file.usage;
      if (usage && (!transcripts.has(usage.sessionId) || transcripts.get(usage.sessionId)!.updatedAt < usage.updatedAt)) {
        transcripts.set(usage.sessionId, usage);
      }
    }
    for (const usage of transcripts.values()) {
      const indexed = this.indexedSessions.get(usage.sessionId);
      sessions.set(usage.sessionId, {
        ...usage,
        title: indexed?.title ?? usage.title,
        updatedAt: indexed?.updatedAt ?? usage.updatedAt
      });
    }
    return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  start(): void {
    this.stop();
    if (!this.enabled || this.disposed) {
      return;
    }
    const first = setTimeout(() => this.scan(), 0);
    first.unref?.();
    const raw = vscode.workspace.getConfiguration('iceberg').get<number>('chatPollIntervalMs', 4000);
    this.timer = setInterval(() => this.scan(), Math.min(60_000, Math.max(1000, raw || 4000)));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  reconfigure(): void {
    this.start();
    this._onDidScan.fire();
  }

  private dirs(): string[] {
    const global = path.dirname(this.context.globalStorageUri.fsPath);
    const parent = path.dirname(global);
    const user = path.basename(path.dirname(parent)) === 'profiles' ? path.dirname(path.dirname(parent)) : parent;
    const workspace = path.join(user, 'workspaceStorage');
    const dirs = [...new Set([global, path.join(user, 'globalStorage')])]
      .map((root) => path.join(root, 'emptyWindowChatSessions'));
    try {
      for (const entry of fs.readdirSync(workspace, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          dirs.push(path.join(workspace, entry.name, 'chatSessions'));
        }
      }
    } catch (error) {
      this.warn(error);
    }
    return dirs;
  }

  private readIndex(file: string): ChatSessionUsage[] {
    try {
      const fingerprint = indexFingerprint(file);
      if (fingerprint === undefined) {
        this.indexCache.delete(file);
        return [];
      }
      const cached = this.indexCache.get(file);
      if (cached?.fingerprint === fingerprint) {
        return cached.sessions;
      }
      this.indexCache.delete(file);
      const sqlite = loadSqlite();
      if (!sqlite) {
        throw new Error('node:sqlite is unavailable in this VS Code build; chat-history titles cannot be read.');
      }
      const sessions: ChatSessionUsage[] = [];
      let db: SqliteDatabase | undefined;
      try {
        db = new sqlite.DatabaseSync(file, { readOnly: true });
        const rows = db.prepare('SELECT value FROM ItemTable WHERE key = ?').all(INDEX_KEY);
        for (const row of rows) {
          const value = (row as Record<string, unknown>).value;
          if (typeof value !== 'string' || value.length > MAX_FILE_BYTES) {
            throw new Error('Invalid chat-history index size or format.');
          }
          for (const session of chatSessionIndex(JSON.parse(value))) {
            sessions.push(session);
          }
        }
      } finally {
        db?.close();
      }
      // A concurrent writer/checkpoint must be re-read on the next scan.
      if (indexFingerprint(file) === fingerprint) {
        this.indexCache.set(file, { fingerprint, sessions });
      }
      return sessions;
    } catch (error) {
      this.indexCache.delete(file);
      this.warn(error instanceof SyntaxError ? new Error('Malformed chat-history index; session names may be unavailable.') : error);
      return [];
    }
  }

  scan(): void {
    if (!this.enabled || this.disposed) {
      return;
    }
    const present = new Set<string>();
    const presentIndexes = new Set<string>();
    this.indexedSessions.clear();
    for (const dir of this.dirs()) {
      const index = path.join(path.dirname(dir), 'state.vscdb');
      presentIndexes.add(index);
      for (const session of this.readIndex(index)) {
        const previous = this.indexedSessions.get(session.sessionId);
        if (!previous || session.updatedAt >= previous.updatedAt) {
          this.indexedSessions.set(session.sessionId, session);
        }
      }
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch (error) {
        this.warn(error);
        continue;
      }
      for (const name of names.filter((name) => name.endsWith('.jsonl') ||
        (name.endsWith('.json') && !names.includes(`${path.basename(name, '.json')}.jsonl`)))) {
        const file = path.join(dir, name);
        present.add(file);
        try {
          const stat = fs.statSync(file);
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
            this.warn(new Error('A chat transcript exceeds the 96 MB reading limit.'));
            continue;
          }
          let live = this.files.get(file);
          if (live && live.size === stat.size && live.mtime === stat.mtimeMs) {
            continue;
          }
          if (name.endsWith('.json')) {
            const parser = newParserState();
            if (!applyLine(JSON.stringify({ kind: 0, v: JSON.parse(fs.readFileSync(file, 'utf8')) }), parser)) {
              throw new Error('Malformed legacy chat usage record; session figures may be incomplete.');
            }
            this.files.set(file, {
              offset: stat.size, size: stat.size, mtime: stat.mtimeMs, parser,
              usage: sessionUsage(parser, path.basename(name, '.json'), stat.mtimeMs)
            });
            continue;
          }
          if (!live || stat.size <= live.size) {
            live = { offset: 0, size: 0, mtime: 0, parser: newParserState() };
            this.files.set(file, live);
          }
          const length = stat.size - live.offset;
          const buffer = Buffer.alloc(length);
          const fd = fs.openSync(file, 'r');
          let read: number;
          try {
            read = fs.readSync(fd, buffer, 0, length, live.offset);
          } finally {
            fs.closeSync(fd);
          }
          const last = buffer.lastIndexOf(10, read - 1);
          if (read > 0 && last >= 0) {
            for (const line of buffer.subarray(0, last).toString('utf8').split('\n')) {
              if (!applyLine(line, live.parser)) {
                this.warn(new Error('A malformed chat usage record was skipped; session figures may be incomplete.'));
              }
            }
            live.offset += last + 1;
          }
          live.size = stat.size;
          live.mtime = stat.mtimeMs;
          live.usage = sessionUsage(live.parser, path.basename(name, '.jsonl'), stat.mtimeMs);
        } catch (error) {
          this.warn(error instanceof SyntaxError
            ? new Error('Malformed chat usage record; session figures may be incomplete.') : error);
        }
      }
    }
    for (const file of this.indexCache.keys()) {
      if (!presentIndexes.has(file)) {
        this.indexCache.delete(file);
      }
    }
    for (const file of this.files.keys()) {
      if (!present.has(file)) {
        this.files.delete(file);
      }
    }
    let delta = 0;
    const transcriptIds = new Set([...this.files.values()].map((file) => file.usage?.sessionId));
    for (const session of this.sessions) {
      if (session.credits === undefined) {
        // An observed new/empty session can later report its first credits.
        if (transcriptIds.has(session.sessionId)) {
          this.credits[session.sessionId] ??= 0;
        }
        continue;
      }
      const previous = this.credits[session.sessionId];
      // Newly discovered histories are baselines too, not fresh charges.
      if (this.seeded && previous !== undefined) {
        delta += Math.max(0, session.credits - previous);
      }
      this.credits[session.sessionId] = Math.max(previous ?? 0, session.credits);
    }
    this.seeded = true;
    if (delta > 0) {
      this.onUsage(delta);
    }
    void this.context.globalState.update(STATE_KEY, { seeded: this.seeded, credits: this.credits });
    this._onDidScan.fire();
  }

  private warn(error: unknown): void {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (!this.warnings.has(message)) {
      this.warnings.add(message);
      this.log?.(`chat usage: ${message}`);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this._onDidScan.dispose();
  }
}
