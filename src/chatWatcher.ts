import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { nonnegative } from './spanUsage';

const STATE_KEY = 'iceberg.chatCredits.v1';
const MAX_FILE_BYTES = 96 * 1024 * 1024;

interface RequestUsage {
  requestId?: string;
  modelId?: string;
  promptTokens?: number;
  completionTokens?: number;
  copilotCredits?: number;
  sessionCopilotCredits?: number;
}

export interface ChatSessionUsage {
  sessionId: string;
  updatedAt: number;
  requests: number;
  credits?: number;
  creditRequests: number;
  model?: string;
  latestPromptTokens?: number;
}

export interface ParserState {
  sessionId?: string;
  requests: RequestUsage[];
}

export function newParserState(): ParserState {
  return { requests: [] };
}

const FIELDS = ['requestId', 'modelId', 'promptTokens', 'completionTokens', 'copilotCredits', 'sessionCopilotCredits'] as const;

function requestUsage(raw: unknown): RequestUsage {
  const result: RequestUsage = {};
  if (!raw || typeof raw !== 'object') {
    return result;
  }
  const value = raw as Record<string, unknown>;
  for (const field of FIELDS) {
    if (field === 'requestId' || field === 'modelId') {
      if (typeof value[field] === 'string' && value[field].length <= 512) {
        result[field] = value[field];
      }
    } else {
      result[field] = nonnegative(value[field]);
    }
  }
  return result;
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
    const doc = v as { sessionId?: unknown; requests?: unknown[] } | undefined;
    state.sessionId = typeof doc?.sessionId === 'string' ? doc.sessionId : undefined;
    state.requests = Array.isArray(doc?.requests) ? doc.requests.map(requestUsage) : [];
    return true;
  }
  const key = Array.isArray(k) ? k : [];
  if (key.length === 1 && key[0] === 'sessionId') {
    state.sessionId = kind === 3 ? undefined : typeof v === 'string' ? v : undefined;
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
  let creditRequests = 0;
  let hasCredits = false;
  for (const request of state.requests) {
    if (request.copilotCredits !== undefined) {
      summed += request.copilotCredits;
      creditRequests++;
      hasCredits = true;
    }
    if (request.sessionCopilotCredits !== undefined) {
      reported = Math.max(reported, request.sessionCopilotCredits);
      hasCredits = true;
    }
  }
  const last = [...state.requests].reverse().find((r) => r.promptTokens !== undefined);
  return {
    sessionId: state.sessionId ?? fallbackId, updatedAt,
    requests: state.requests.length,
    credits: hasCredits ? Math.max(summed, reported) : undefined,
    creditRequests, model: last?.modelId, latestPromptTokens: last?.promptTokens
  };
}

interface LiveFile {
  offset: number;
  size: number;
  mtime: number;
  parser: ParserState;
  usage?: ChatSessionUsage;
}

/** Transcript prompt/completion fields are snapshots, never a token ledger. */
export class ChatUsageWatcher implements vscode.Disposable {
  private readonly files = new Map<string, LiveFile>();
  private readonly _onDidScan = new vscode.EventEmitter<void>();
  readonly onDidScan = this._onDidScan.event;
  private readonly credits: Record<string, number>;
  private seeded: boolean;
  private timer?: NodeJS.Timeout;
  private disposed = false;
  private readonly warnings = new Set<string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onUsage: (delta: { input: number; output: number; credits: number; requests: number }) => void,
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
    const sessions = new Map<string, ChatSessionUsage>();
    for (const file of this.files.values()) {
      const usage = file.usage;
      if (usage && (!sessions.has(usage.sessionId) || sessions.get(usage.sessionId)!.updatedAt < usage.updatedAt)) {
        sessions.set(usage.sessionId, usage);
      }
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
    const workspace = path.join(path.dirname(global), 'workspaceStorage');
    const dirs = [path.join(global, 'emptyWindowChatSessions')];
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

  scan(): void {
    if (!this.enabled || this.disposed) {
      return;
    }
    const present = new Set<string>();
    for (const dir of this.dirs()) {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch (error) {
        this.warn(error);
        continue;
      }
      for (const name of names.filter((name) => name.endsWith('.jsonl'))) {
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
          // An observed new/empty session can later report its first credits.
          if (live.usage.credits === undefined && this.credits[live.usage.sessionId] === undefined) {
            this.credits[live.usage.sessionId] = 0;
          }
        } catch (error) {
          this.warn(error);
        }
      }
    }
    for (const file of this.files.keys()) {
      if (!present.has(file)) {
        this.files.delete(file);
      }
    }
    let delta = 0;
    for (const session of this.sessions) {
      if (session.credits === undefined) {
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
      this.onUsage({ input: 0, output: 0, credits: delta, requests: 0 });
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
