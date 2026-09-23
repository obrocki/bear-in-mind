import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import * as vscode from 'vscode';
import { OtelRollup } from './otelParse';
import { emptySpanDigest, type ContextWindow, type FeedHealth, type SpanDigest, type SpanSession } from './otelSummary';

const STATE_KEY = 'iceberg.otelWatch.v1';

/** Transcripts can be enormous; the OTel feed should never stall the host either. */
const MAX_FILE_BYTES = 256 * 1024 * 1024;
/** How often the feed path and SQLite location are re-resolved. */
const PATH_REFRESH_MS = 30_000;
/** Spans older than this are ignored, matching the store's own 7-day retention. */
const SPAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface OtelUsageDelta {
  input: number;
  output: number;
  requests: number;
}

interface PersistedState {
  /** Bytes of the feed already consumed. */
  offset: number;
  size: number;
  /** Token totals already pushed into the meter, so a restart never re-charges. */
  input: number;
  output: number;
  seeded: boolean;
}

/** The subset of `node:sqlite` this file uses. */
interface SqliteDatabase {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

let sqliteModule: SqliteModule | null | undefined;

/**
 * `node:sqlite` only exists on Node 22.5+. VS Code 1.139 has it, older builds do
 * not, and the extension must keep working either way — so this is resolved at
 * runtime and a failure just means the span source stays dark.
 */
function loadSqlite(): SqliteModule | undefined {
  if (sqliteModule !== undefined) {
    return sqliteModule ?? undefined;
  }
  try {
    const nodeRequire = createRequire(__filename);
    sqliteModule = nodeRequire('node:sqlite') as SqliteModule;
  } catch {
    sqliteModule = null;
  }
  return sqliteModule ?? undefined;
}

/**
 * Reads the telemetry Copilot Chat emits and turns it into usage deltas and a
 * dashboard rollup.
 *
 * Two sources, because neither is sufficient alone:
 *
 * - **The JSONL file feed** (`github.copilot.chat.otel.outfile`) carries metrics
 *   and log events. Metrics cover all three dashboard sections and are the
 *   authoritative token total. Its spans are worthless — under OTel JS SDK v2
 *   they serialise to `{}` — so it cannot supply per-session timings.
 * - **`agent-traces.db`** (`…otel.dbSpanExporter`) carries real spans with exact
 *   start and end times, and a prebuilt `sessions` view. It has no metrics and
 *   no log records, so it cannot supply the quality signals.
 *
 * They are also not equally intrusive. Setting `outfile` *replaces* whatever
 * OTLP exporter the user configured, silently cutting off their collector. The
 * SQLite exporter is registered as an additional span processor and runs
 * alongside one. Both are therefore optional and detected independently.
 */
export class OtelWatcher implements vscode.Disposable {
  readonly rollup = new OtelRollup();

  private readonly _onDidScan = new vscode.EventEmitter<void>();
  /** Fires after every poll, whether or not anything changed. */
  readonly onDidScan = this._onDidScan.event;

  private state: PersistedState;
  private spans: SpanDigest = emptySpanDigest();
  private feedPath: string | undefined;
  private dbPath: string | undefined;
  private pathsResolvedAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private scanning = false;
  private disposed = false;
  private notes: string[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onUsage: (delta: OtelUsageDelta) => void,
    private readonly log?: (message: string) => void
  ) {
    const stored = context.globalState.get<Partial<PersistedState>>(STATE_KEY);
    this.state = {
      offset: Math.max(0, stored?.offset ?? 0),
      size: Math.max(0, stored?.size ?? 0),
      input: Math.max(0, stored?.input ?? 0),
      output: Math.max(0, stored?.output ?? 0),
      seeded: stored?.seeded ?? false
    };
  }

  private get config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('iceberg');
  }

  private get copilotConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('github.copilot.chat.otel');
  }

  get enabled(): boolean {
    return this.config.get<boolean>('otel.enabled', true);
  }

  private get pollMs(): number {
    const raw = this.config.get<number>('otel.pollIntervalMs', 4000);
    return Math.min(60_000, Math.max(1000, Math.round(raw) || 4000));
  }

  /** True once the feed has actually produced token counts. */
  get live(): boolean {
    const totals = this.rollup.tokenTotals();
    return totals.input + totals.output > 0;
  }

  /**
   * True while a configured source is still there to read.
   *
   * Distinct from `live`: the rollup keeps its totals after a feed is removed,
   * so this also checks a source is actually present before telling the meter
   * that telemetry is still the better authority.
   */
  get producing(): boolean {
    return this.live && (!!this.resolveFeedPath() || this.spans.available);
  }

  get observedTokens(): number {
    const totals = this.rollup.tokenTotals();
    return totals.input + totals.output;
  }

  get spanDigest(): SpanDigest {
    return this.spans;
  }

  start(): void {
    this.stop();
    if (this.disposed || !this.enabled) {
      return;
    }
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

  reconfigure(): void {
    this.pathsResolvedAt = 0;
    if (this.enabled) {
      this.start();
    } else {
      this.stop();
    }
  }

  // ------------------------------------------------------------ discovery ---

  /**
   * Where the JSONL feed lives. Mirrors Copilot Chat's own precedence: the env
   * var wins over the setting, because that is the order `resolveOTelConfig`
   * uses upstream.
   */
  resolveFeedPath(): string | undefined {
    const override = (this.config.get<string>('otel.feedPath', '') || '').trim();
    if (override) {
      return override;
    }
    const env = process.env.COPILOT_OTEL_FILE_EXPORTER_PATH;
    if (env) {
      return env;
    }
    const outfile = (this.copilotConfig.get<string>('outfile', '') || '').trim();
    return outfile || undefined;
  }

  /** Our suggested location for the feed, used by the connect command. */
  defaultFeedPath(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'copilot-otel.jsonl');
  }

  /**
   * Locates `agent-traces.db`. Copilot Chat keeps it under its own global
   * storage; the exact filename is fixed by the export command upstream, so a
   * shallow search of the likely roots is both sufficient and version-proof.
   */
  resolveDbPath(): string | undefined {
    const override = (this.config.get<string>('otel.tracesDbPath', '') || '').trim();
    if (override) {
      return fs.existsSync(override) ? override : undefined;
    }
    const globalStorage = path.dirname(this.context.globalStorageUri.fsPath);
    const roots = [
      path.join(globalStorage, 'github.copilot-chat'),
      path.join(globalStorage, 'github.copilot-chat', 'otel'),
      globalStorage
    ];
    for (const root of roots) {
      const candidate = path.join(root, 'agent-traces.db');
      if (fileExists(candidate)) {
        return candidate;
      }
    }
    // Fall back to a one-level scan of the Copilot Chat storage directory.
    const chatDir = path.join(globalStorage, 'github.copilot-chat');
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(chatDir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const candidate = path.join(chatDir, entry.name, 'agent-traces.db');
        if (fileExists(candidate)) {
          return candidate;
        }
      }
    }
    return undefined;
  }

  // ----------------------------------------------------------------- scan ---

  scan(): void {
    if (this.disposed || this.scanning || !this.enabled) {
      return;
    }
    this.scanning = true;
    try {
      const now = Date.now();
      if (now - this.pathsResolvedAt > PATH_REFRESH_MS) {
        this.feedPath = this.resolveFeedPath();
        this.dbPath = this.resolveDbPath();
        this.pathsResolvedAt = now;
      }

      this.consumeFeed();
      this.readSpans();
      this.emitDelta();
      this._onDidScan.fire();
    } finally {
      this.scanning = false;
    }
  }

  private consumeFeed(): void {
    const file = this.feedPath;
    if (!file) {
      return;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return;
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      return;
    }
    if (stat.size === this.state.size && this.state.offset > 0) {
      return;
    }
    // A shrunken file means it was rotated or cleared; start again from the top.
    if (stat.size < this.state.offset) {
      this.state.offset = 0;
    }

    const from = this.state.offset;
    let chunk: Buffer;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const length = Math.max(0, stat.size - from);
        chunk = Buffer.alloc(length);
        if (length > 0) {
          fs.readSync(fd, chunk, 0, length, from);
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }

    const text = chunk.toString('utf8');
    // The tail may be a partial line, so only ever advance past the last break.
    const lastBreak = text.lastIndexOf('\n');
    if (lastBreak < 0) {
      this.state.size = stat.size;
      return;
    }
    for (const line of text.slice(0, lastBreak).split('\n')) {
      this.rollup.ingestLine(line);
    }
    this.state.offset = from + Buffer.byteLength(text.slice(0, lastBreak + 1), 'utf8');
    this.state.size = stat.size;
    this.persist();
  }

  /**
   * Rebuilds the span digest from scratch on every pass.
   *
   * The store is capped at 7 days and 100 sessions, so the row count stays
   * small, and re-reading avoids having to track deletions from its own
   * retention sweep.
   */
  private readSpans(): void {
    const file = this.dbPath;
    if (!file) {
      this.spans = emptySpanDigest();
      return;
    }
    const sqlite = loadSqlite();
    if (!sqlite) {
      this.note('node:sqlite is unavailable in this VS Code build, so span timings are off.');
      this.spans = emptySpanDigest();
      return;
    }

    let db: SqliteDatabase | undefined;
    try {
      db = new sqlite.DatabaseSync(file, { readOnly: true });
      const since = Date.now() - SPAN_WINDOW_MS;
      const digest = emptySpanDigest();
      digest.available = true;

      for (const raw of db.prepare('SELECT * FROM sessions WHERE started_at >= ?').all(since)) {
        const r = raw as Record<string, unknown>;
        digest.sessions.push({
          sessionId: String(r.session_id ?? ''),
          agentName: (r.agent_name as string) ?? null,
          model: (r.model as string) ?? null,
          startedAt: numeric(r.started_at),
          endedAt: numeric(r.ended_at),
          durationMs: numeric(r.duration_ms),
          llmCalls: numeric(r.llm_calls),
          toolCalls: numeric(r.tool_calls),
          inputTokens: numeric(r.total_input_tokens),
          outputTokens: numeric(r.total_output_tokens),
          cachedTokens: numeric(r.total_cached_tokens)
        } satisfies SpanSession);
      }

      const rows = db
        .prepare(
          'SELECT operation_name, tool_name, start_time_ms, end_time_ms, ttft_ms, turn_index, ' +
            'input_tokens, output_tokens, cached_tokens, reasoning_tokens ' +
            'FROM spans WHERE start_time_ms >= ?'
        )
        .all(since);

      const turnsByNothing: number[] = [];
      for (const raw of rows) {
        const r = raw as Record<string, unknown>;
        const op = String(r.operation_name ?? '');
        const duration = Math.max(0, numeric(r.end_time_ms) - numeric(r.start_time_ms));
        if (op === 'invoke_agent') {
          if (duration > 0) {
            digest.agentDurationsMs.push(duration);
          }
          const turns = numeric(r.turn_index);
          if (turns > 0) {
            turnsByNothing.push(turns + 1);
          }
        } else if (op === 'chat') {
          if (duration > 0) {
            digest.llmDurationsMs.push(duration);
          }
          const ttft = numeric(r.ttft_ms);
          if (ttft > 0) {
            digest.ttftMs.push(ttft);
          }
        } else if (op === 'execute_tool') {
          const name = String(r.tool_name ?? 'unknown');
          const list = digest.toolDurationsMs.get(name) ?? [];
          list.push(duration);
          digest.toolDurationsMs.set(name, list);
        }
        digest.cachedTokens += numeric(r.cached_tokens);
        digest.reasoningTokens += numeric(r.reasoning_tokens);
      }
      digest.turnCounts = turnsByNothing;
      digest.inputTokens = digest.sessions.reduce((a, s) => a + s.inputTokens, 0);
      digest.outputTokens = digest.sessions.reduce((a, s) => a + s.outputTokens, 0);
      digest.context = this.readContextWindow(db);
      this.spans = digest;
    } catch (err) {
      // A locked or mid-recovery WAL database is normal and transient; keep the
      // previous digest rather than flapping the dashboard to empty.
      this.note(`could not read agent-traces.db (${err instanceof Error ? err.message : String(err)})`);
    } finally {
      try {
        db?.close();
      } catch {
        /* already gone */
      }
    }
  }

  /**
   * Reads how full the context window was on the most recent model call.
   *
   * `copilot_chat.request.max_prompt_tokens` is not one of the columns the
   * store denormalises, but every attribute is kept in `span_attributes`, so it
   * is one join away. Only the newest `chat` span matters — this is a live
   * gauge, not a total.
   */
  private readContextWindow(db: SqliteDatabase): ContextWindow | undefined {
    try {
      const rows = db
        .prepare(
          'SELECT s.input_tokens AS used, s.request_model AS model, ' +
            's.start_time_ms AS at, a.value AS limit_value ' +
            'FROM spans s JOIN span_attributes a ON a.span_id = s.span_id ' +
            "WHERE s.operation_name = 'chat' AND a.key = ? AND s.input_tokens IS NOT NULL " +
            'ORDER BY s.start_time_ms DESC LIMIT 1'
        )
        .all('copilot_chat.request.max_prompt_tokens');
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        return undefined;
      }
      const limit = numeric(row.limit_value);
      const used = numeric(row.used);
      if (limit <= 0 || used <= 0) {
        return undefined;
      }
      return { used, limit, model: (row.model as string) ?? null, atMs: numeric(row.at) };
    } catch {
      return undefined;
    }
  }

  /**
   * Pushes the growth in the cumulative token totals into the meter.
   *
   * The metric stream is cumulative, so charging the difference against what has
   * already been charged makes the accounting idempotent: a re-read of the same
   * file, or a duplicated export, adds nothing.
   */
  private emitDelta(): void {
    const totals = this.rollup.tokenTotals();

    // First pass after an install adopts whatever the feed already holds as
    // history, exactly as the transcript watcher does with its back catalogue.
    if (!this.state.seeded) {
      this.state.seeded = true;
      this.state.input = totals.input;
      this.state.output = totals.output;
      this.persist(true);
      return;
    }

    // The cumulative total going backwards means the feed itself restarted —
    // the file was rotated, cleared, or pointed somewhere new. Re-baselining
    // silently is the only correct response: charging the difference would be
    // negative, and charging the new total again would bill it twice. This is
    // why there is no manual refreeze; it fixes itself.
    if (totals.input < this.state.input || totals.output < this.state.output) {
      this.note('telemetry feed restarted; re-baselining rather than re-charging.');
      this.state.input = totals.input;
      this.state.output = totals.output;
      this.persist(true);
      return;
    }

    const dIn = totals.input - this.state.input;
    const dOut = totals.output - this.state.output;
    if (dIn === 0 && dOut === 0) {
      return;
    }
    this.state.input = totals.input;
    this.state.output = totals.output;
    this.persist();
    this.log?.(`otel usage +${dIn} in / +${dOut} out`);
    this.onUsage({ input: dIn, output: dOut, requests: 0 });
  }

  /** Forgets what it has charged and re-adopts the current feed as history. */
  rebaseline(): void {
    this.state = { offset: 0, size: 0, input: 0, output: 0, seeded: false };
    this.persist(true);
    this.scan();
  }

  // ----------------------------------------------------------- reporting ----

  health(): FeedHealth {
    const feedPath = this.feedPath ?? this.resolveFeedPath();
    const dbPath = this.dbPath ?? this.resolveDbPath();
    const copilotEnabled = this.copilotConfig.get<boolean>('enabled', false);
    const endpoint = (this.copilotConfig.get<string>('otlpEndpoint', '') || '').trim();
    const exporterType = (this.copilotConfig.get<string>('exporterType', '') || '').trim();

    const notes = [...this.notes];
    if (!copilotEnabled) {
      notes.push('Copilot Chat telemetry is switched off, so there is nothing to read.');
    }
    if (!feedPath) {
      notes.push('No JSONL feed configured — cost and quality signals need one.');
    }
    if (!dbPath) {
      notes.push('No agent-traces.db found — session timings fall back to histogram estimates.');
    }
    if (endpoint && exporterType !== 'file' && !feedPath) {
      notes.push(`An OTLP endpoint is configured (${endpoint}); enabling the file feed would replace it.`);
    }

    return {
      watching: this.enabled,
      copilotOtelEnabled: copilotEnabled,
      jsonlPath: feedPath,
      jsonlActive: !!feedPath && this.rollup.stats.metrics + this.rollup.stats.logs > 0,
      sqlitePath: dbPath,
      sqliteActive: this.spans.available,
      otlpEndpoint: endpoint || undefined,
      lastRecordAtMs: this.rollup.stats.lastRecordAtMs,
      records: {
        metrics: this.rollup.stats.metrics,
        logs: this.rollup.stats.logs,
        spans: this.rollup.stats.spans,
        unknown: this.rollup.stats.unknown,
        malformed: this.rollup.stats.malformed
      },
      notes: [...new Set(notes)]
    };
  }

  private note(message: string): void {
    if (!this.notes.includes(message)) {
      this.notes.push(message);
      if (this.notes.length > 8) {
        this.notes.shift();
      }
      this.log?.(message);
    }
  }

  private persist(immediate = false): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    const write = () => void this.context.globalState.update(STATE_KEY, this.state);
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
    this._onDidScan.dispose();
  }
}

function numeric(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function fileExists(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}
