import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import * as vscode from 'vscode';
import { OtelRollup } from './otelParse';
import { digestSpans, fileUsageSpan, usageSpan, type UsageSpan } from './spanUsage';
import {
  emptySpanDigest,
  redactUrl,
  type FeedHealth,
  type SpanDigest
} from './otelSummary';

const STATE_KEY = 'iceberg.otelWatch.v1';

/** Transcripts can be enormous; the OTel feed should never stall the host either. */
const MAX_FILE_BYTES = 256 * 1024 * 1024;
/** Per-poll read window, so a large backlog is caught up over several passes. */
const MAX_READ_BYTES = 8 * 1024 * 1024;
/** Bytes of the feed's head used as its identity fingerprint. */
const MAX_SIGNATURE_BYTES = 512;
/** How often the feed path and SQLite location are re-resolved. */
const PATH_REFRESH_MS = 30_000;
/** Spans older than this are ignored, matching the store's own 7-day retention. */
const SPAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** How recently the feed must have exported token usage to count as live. */
const FEED_FRESH_MS = 15 * 60 * 1000;

export interface OtelUsageDelta {
  input: number;
  output: number;
  requests: number;
  source?: 'traces';
}

interface TraceAccounting {
  since: number;
  seen: Record<string, { input: number; output: number; at: number }>;
}

interface PersistedState {
  /** Which feed the offsets below belong to. */
  path: string;
  /**
   * Fingerprint of the feed's first bytes.
   *
   * Neither size nor birth time identifies a stream: a replacement can be the
   * same size, and truncating and rewriting in place keeps the birth time. The
   * opening bytes change in every one of those cases.
   */
  head: string;
  /** Bytes of the feed already consumed. */
  offset: number;
  /**
   * Where the pre-existing backlog ended when this stream was first seen.
   *
   * Catch-up reads in windows, so EOF moves while it runs. Seeding against a
   * moving EOF would fold records written during catch-up into the baseline and
   * never charge them; this boundary does not move.
   */
  baselineEnd: number;
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
 * - **The JSONL file feed** carries metrics, log events and current serialized
 *   spans. Legacy SDK v2 exports can contain empty `{}` span records instead.
 * - **`agent-traces.db`** carries completed spans and their attributes. Read
 *   metadata only and merge by span ID so file/SQLite copies count just once.
 *
 * They are also not equally intrusive. Setting `outfile` *replaces* whatever
 * OTLP exporter the user configured, silently cutting off their collector. The
 * SQLite exporter is registered as an additional span processor and runs
 * alongside one. Both are therefore optional and detected independently.
 */
export class OtelWatcher implements vscode.Disposable {
  /** Replaced outright when the feed path changes; see `consumeFeed`. */
  private _rollup = new OtelRollup();

  get rollup(): OtelRollup {
    return this._rollup;
  }

  private readonly _onDidScan = new vscode.EventEmitter<void>();
  /** Fires after every poll, whether or not anything changed. */
  readonly onDidScan = this._onDidScan.event;

  private state: PersistedState;
  private spans: SpanDigest = emptySpanDigest();
  private readonly fileSpans = new Map<string, UsageSpan>();
  private dbSpans: UsageSpan[] = [];
  private readonly traceAccounting: TraceAccounting;
  private feedPath: string | undefined;
  private dbPath: string | undefined;
  private pathsResolvedAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private scanning = false;
  /**
   * The feed path that was found missing, if any.
   *
   * Tied to the path rather than a bare flag: if the setting is repointed at a
   * different file that already exists, that file *does* have a backlog, and
   * charging all of it as live usage would melt the berg on a config change.
   */
  private missingFeedPath: string | undefined;
  private disposed = false;
  private notes: string[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onUsage: (delta: OtelUsageDelta) => void,
    private readonly log?: (message: string) => void
  ) {
    const stored = context.globalState.get<Partial<PersistedState>>(STATE_KEY);
    this.state = {
      path: stored?.path ?? '',
      head: stored?.head ?? '',
      offset: Math.max(0, stored?.offset ?? 0),
      baselineEnd: Math.max(0, stored?.baselineEnd ?? 0),
      size: Math.max(0, stored?.size ?? 0),
      input: Math.max(0, stored?.input ?? 0),
      output: Math.max(0, stored?.output ?? 0),
      seeded: stored?.seeded ?? false
    };
    // A fresh process has an empty rollup, but the saved offset points into the
    // middle of the feed. Resuming there would rebuild the rollup from the tail
    // alone — far below the persisted totals — so every delta would clamp to
    // zero and telemetry would stop charging until the live series grew past
    // the whole of history. Re-reading from the top rebuilds the true
    // cumulative; the persisted totals stay put, so nothing is charged twice.
    this.state.offset = 0;
    this.traceAccounting = context.globalState.get<TraceAccounting>('iceberg.traceWatch.v1') ??
      { since: Date.now(), seen: {} };
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
   * True while the feed is exporting token usage *now*.
   *
   * General feed activity is not evidence that the feed can meter: a writer can
   * export logs or non-token metrics forever after token usage has stopped. Only
   * the timestamp on a token-usage metric can keep telemetry authoritative.
   */
  get producing(): boolean {
    const lastTokenUsageAtMs = this.rollup.stats.lastTokenUsageAtMs;
    return lastTokenUsageAtMs > 0 && Date.now() - lastTokenUsageAtMs <= FEED_FRESH_MS;
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

      const cutoff = Date.now() - SPAN_WINDOW_MS;
      for (const [id, span] of this.fileSpans) {
        if (span.start < cutoff) {
          this.fileSpans.delete(id);
        }
      }
      this.consumeFeed();
      this.readSpans();
      const spans = new Map(this.fileSpans);
      for (const span of this.dbSpans) {
        if (span.start >= cutoff) {
          spans.set(span.id, span);
        }
      }
      this.spans = digestSpans(spans.values());
      this.spans.sinceMs = cutoff;
      this.emitSpanDelta(spans.values());
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

    // The offsets describe one specific file. If the configured path changes,
    // reusing them would skip a same-sized file entirely, or read a larger one
    // from the wrong position — and the seeded token baseline would belong to a
    // different stream altogether.
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      // Configured but not there yet — Copilot Chat creates it on its next
      // start. Remember that, so when it does appear its contents are charged
      // instead of being mistaken for history that predates us.
      this.missingFeedPath = file;
      return;
    }
    if (!stat.isFile()) {
      return;
    }

    // Identity, not size or age. A replacement of the same size is invisible to
    // a size comparison, and truncating and rewriting a file in place keeps its
    // birth time, so neither is enough on its own — the reader would resume
    // mid-record in a stream it has never seen. Fingerprinting the head catches
    // all three cases: replaced, rotated, or rewritten.
    //
    // The fingerprint has to stay stable while the file grows. Hashing "the
    // first up-to-512 bytes" does not: every append changes the hash until the
    // file reaches 512 bytes, which would reset the rollup and re-baseline on
    // every poll and quietly treat all of that early usage as history. So the
    // stored prefix length travels with the hash, and a later scan re-hashes
    // exactly that many bytes to compare like with like.
    const previous = parseSignature(this.state.head);
    // Only *this* file appearing after we saw it missing means it has no
    // backlog. A different path that happens to exist has one.
    const appeared = this.missingFeedPath === file;
    let replaced = this.state.path !== file;
    if (!replaced && previous) {
      replaced =
        stat.size < previous.length || hashPrefix(file, previous.length) !== previous.hash;
    }

    if (replaced || stat.size < this.state.offset) {
      this.state = {
        path: file,
        head: signatureFor(file, stat.size),
        offset: 0,
        // Whatever is already on disk is the backlog. Fixing the boundary here
        // means records appended while we catch up fall outside it and are
        // charged rather than quietly folded into the baseline.
        baselineEnd: appeared ? 0 : stat.size,
        size: 0,
        input: 0,
        output: 0,
        // A feed that did not exist when we started watching is not a backlog:
        // everything in it happened on our watch and has to be charged.
        seeded: appeared
      };
      // The rollup has to go too. It still holds the previous stream's series,
      // events and record counts, so keeping it would blend two unrelated feeds
      // into one dashboard, and the new file's lower counters would read as a
      // counter restart and have the old history banked and added again.
      this._rollup = new OtelRollup();
      this.fileSpans.clear();
      this.missingFeedPath = undefined;
      this.persist(true);
    } else if (!previous || previous.length < MAX_SIGNATURE_BYTES) {
      // Grown past what we last fingerprinted — take a longer one now that
      // there are more bytes to be sure of.
      const upgraded = signatureFor(file, stat.size);
      if (upgraded !== this.state.head) {
        this.state.head = upgraded;
        this.persist();
      }
    }
    if (stat.size > MAX_FILE_BYTES) {
      this.note(
        `the telemetry feed has grown past ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB and is no longer ` +
          'being read. Delete or rotate it, or point iceberg.otel.feedPath somewhere fresh.'
      );
      return;
    }
    // Nothing new, and the tail is not a half-written line we still owe a read.
    if (stat.size === this.state.size && this.state.offset >= stat.size) {
      return;
    }

    const from = this.state.offset;
    // While still adopting the backlog, never read past its boundary. A window
    // that straddled it would ingest post-boundary records into the rollup
    // before seeding ran, and they would be copied into the baseline instead of
    // being charged.
    const limit = this.state.seeded
      ? stat.size
      : Math.min(stat.size, Math.max(this.state.baselineEnd, 0));
    // Read in bounded windows: the file is append-only and nothing trims it, so
    // a large backlog would otherwise be resident three times over — buffer,
    // string, and the array of split lines.
    const available = Math.max(0, limit - from);
    const length = Math.min(available, MAX_READ_BYTES);

    let chunk: Buffer;
    try {
      const fd = fs.openSync(file, 'r');
      try {
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
      if (!this.state.seeded && available > 0 && available === length) {
        // The backlog's final record has no terminating newline, so the
        // boundary sits inside it and the offset can never reach it. Pull the
        // boundary back to the last complete line: seeding finishes here, and
        // the partial record is read normally — and charged — once complete.
        this.state.baselineEnd = this.state.offset;
        this.persist();
        return;
      }
      if (available > length) {
        // The window is full and there is more file on disk beyond it, so
        // this is not a tail still being written — a single record is bigger
        // than MAX_READ_BYTES (captureContent can produce these). Retrying
        // the same window forever would wedge the reader on it permanently;
        // scan forward for its terminating newline and discard it instead.
        const end = this.findRecordEnd(file, from + length, stat.size);
        if (end === undefined) {
          // Terminator not written yet; the record may still be growing.
          return;
        }
        this.note(
          'a telemetry record larger than the read window was skipped — captureContent ' +
            'attributes can produce records like this.'
        );
        this.state.offset = end;
        this.state.size = stat.size;
        this.persist();
      }
      // Otherwise nothing complete to consume. Leaving `size` alone is
      // deliberate: recording it here would make the next poll believe the
      // file was unchanged and the half-written line would never be read,
      // taking every later record with it.
      return;
    }
    for (const line of text.slice(0, lastBreak).split('\n')) {
      this.rollup.ingestLine(line, (record) => {
        const span = fileUsageSpan(record);
        if (span && span.start >= Date.now() - SPAN_WINDOW_MS) {
          if (this.fileSpans.size < 50_000 || this.fileSpans.has(span.id)) {
            this.fileSpans.set(span.id, span);
          } else {
            this.note('The file span limit (50,000) was reached; trace details are incomplete.');
          }
        }
      });
    }
    this.state.offset = from + Buffer.byteLength(text.slice(0, lastBreak + 1), 'utf8');
    this.state.size = stat.size;
    this.persist();
  }

  /**
   * Scans forward from `from`, in the same bounded windows `consumeFeed` reads
   * with, for the newline that ends an oversized record. Returns the offset
   * just past it, or `undefined` if the file ends before one is found.
   */
  private findRecordEnd(file: string, from: number, size: number): number | undefined {
    let pos = from;
    let fd: number;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      return undefined;
    }
    try {
      while (pos < size) {
        const length = Math.min(size - pos, MAX_READ_BYTES);
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, pos);
        const idx = buf.indexOf(10 /* \n */);
        if (idx >= 0) {
          return pos + idx + 1;
        }
        pos += length;
      }
    } finally {
      fs.closeSync(fd);
    }
    return undefined;
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
      this.dbSpans = [];
      return;
    }
    const sqlite = loadSqlite();
    if (!sqlite) {
      this.note('node:sqlite is unavailable in this VS Code build, so span timings are off.');
      this.dbSpans = [];
      return;
    }

    let db: SqliteDatabase | undefined;
    try {
      db = new sqlite.DatabaseSync(file, { readOnly: true });
      const since = Date.now() - SPAN_WINDOW_MS;
      const rows = db
        .prepare(
          'SELECT span_id, operation_name, tool_name, start_time_ms, end_time_ms, ttft_ms, ' +
            'conversation_id, chat_session_id, request_model, response_model, ' +
            'input_tokens, output_tokens, cached_tokens, reasoning_tokens ' +
            'FROM spans WHERE start_time_ms >= ?'
        )
        .all(since);
      const attributes = new Map<string, Record<string, unknown>>();
      for (const raw of db.prepare(
        'SELECT a.span_id, a.key, a.value FROM span_attributes a JOIN spans s ON s.span_id = a.span_id ' +
        'WHERE s.start_time_ms >= ? AND a.key IN (?, ?, ?, ?, ?, ?)'
      ).all(since, 'copilot_chat.request.max_prompt_tokens', 'copilot_chat.turn_count',
        'copilot_chat.copilot_usage_nano_aiu', 'gen_ai.usage.reasoning.output_tokens',
        'copilot_chat.parent_chat_session_id', 'copilot_chat.debug_log_label')) {
        const r = raw as Record<string, unknown>;
        const id = String(r.span_id);
        const a = attributes.get(id) ?? {};
        const key = String(r.key);
        a[key] = key.endsWith('session_id') || key.endsWith('debug_log_label') ? r.value : Number(r.value);
        attributes.set(id, a);
      }
      const completed: UsageSpan[] = [];
      for (const raw of rows) {
        const r = raw as Record<string, unknown>;
        const span = usageSpan(r.span_id, {
          'gen_ai.operation.name': r.operation_name,
          'gen_ai.tool.name': r.tool_name,
          'gen_ai.conversation.id': r.conversation_id,
          'copilot_chat.chat_session_id': r.chat_session_id,
          'gen_ai.request.model': r.request_model,
          'gen_ai.response.model': r.response_model,
          'gen_ai.usage.input_tokens': r.input_tokens,
          'gen_ai.usage.output_tokens': r.output_tokens,
          'gen_ai.usage.cache_read.input_tokens': r.cached_tokens,
          'gen_ai.usage.reasoning_tokens': r.reasoning_tokens,
          'copilot_chat.time_to_first_token': r.ttft_ms,
          ...attributes.get(String(r.span_id))
        }, numeric(r.start_time_ms), numeric(r.end_time_ms));
        if (span) {
          completed.push(span);
        }
      }
      this.dbSpans = completed;
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

  private emitSpanDelta(spans: Iterable<UsageSpan>): void {
    const delta: OtelUsageDelta = { input: 0, output: 0, requests: 0, source: 'traces' };
    const seen = this.traceAccounting.seen;
    const cutoff = Date.now() - SPAN_WINDOW_MS;
    for (const [id, previous] of Object.entries(seen)) {
      if (previous.at < cutoff) {
        delete seen[id];
      }
    }
    let size = Object.keys(seen).length;
    for (const span of spans) {
      if (span.operation !== 'chat' || span.start < this.traceAccounting.since ||
          span.start < cutoff || (span.input === undefined && span.output === undefined)) {
        continue;
      }
      const previous = seen[span.id];
      if (!previous && size >= 50_000) {
        this.note('The trace accounting limit (50,000 calls) was reached; new calls are not metered.');
        continue;
      }
      const input = Math.max(previous?.input ?? 0, span.input ?? 0);
      const output = Math.max(previous?.output ?? 0, span.output ?? 0);
      delta.input += input - (previous?.input ?? 0);
      delta.output += output - (previous?.output ?? 0);
      if (!previous) {
        size++;
        delta.requests++;
      }
      seen[span.id] = { input, output, at: span.start };
    }
    if (delta.input || delta.output || delta.requests) {
      this.onUsage(delta);
      this.persist();
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
    //
    // "First pass" means the whole backlog, not the first window. The reader
    // catches up 8 MiB at a time, so declaring the baseline early would leave
    // later windows — still older cumulative snapshots — to be charged as fresh
    // burn, melting the berg on install.
    if (!this.state.seeded) {
      this.state.input = totals.input;
      this.state.output = totals.output;
      if (this.state.offset >= this.state.baselineEnd) {
        this.state.seeded = true;
      }
      this.persist(true);
      return;
    }

    // The rollup banks a counter's peak when it drops, so its totals are
    // monotonic by construction — a feed or process restart shows up as the old
    // peak plus the new run rather than as a decrease. There is therefore no
    // re-baselining to do here; the guard below only exists because a corrupt
    // or truncated record could still produce a smaller figure.
    const dIn = Math.max(0, totals.input - this.state.input);
    const dOut = Math.max(0, totals.output - this.state.output);
    if (dIn === 0 && dOut === 0) {
      return;
    }
    // Never ratchet the baseline down. One dimension can grow while the other
    // sits below the stored figure — a series that stopped exporting is simply
    // absent from the rebuilt rollup — and lowering the baseline there would
    // let that history be charged a second time when the series came back.
    this.state.input = Math.max(this.state.input, totals.input);
    this.state.output = Math.max(this.state.output, totals.output);
    this.persist();
    this.log?.(`otel usage +${dIn} in / +${dOut} out`);
    this.onUsage({ input: dIn, output: dOut, requests: 0 });
  }

  /** Forgets what it has charged and re-adopts the current feed as history. */
  rebaseline(): void {
    this.state = {
      path: this.feedPath ?? '',
      head: '',
      offset: 0,
      baselineEnd: 0,
      size: 0,
      input: 0,
      output: 0,
      seeded: false
    };
    this.persist(true);
    this.scan();
  }

  // ----------------------------------------------------------- reporting ----

  health(): FeedHealth {
    const feedPath = this.feedPath ?? this.resolveFeedPath();
    const dbPath = this.dbPath ?? this.resolveDbPath();
    const copilotEnabled = this.copilotConfig.get<boolean>('enabled', false) ||
      this.copilotConfig.get<boolean>('dbSpanExporter.enabled', false) ||
      this.copilotConfig.get<boolean>('dbSpanExporter', false) ||
      process.env.COPILOT_OTEL_ENABLED === 'true' || !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const endpoint = (this.copilotConfig.get<string>('otlpEndpoint', '') || '').trim();
    const exporterType = (this.copilotConfig.get<string>('exporterType', '') || '').trim();

    const notes = [...this.notes];
    if (!copilotEnabled) {
      notes.push('Copilot Chat telemetry is switched off, so there is nothing to read.');
    }
    if (!feedPath) {
      notes.push('No JSONL feed configured — quality signals need one; traces can still supply tokens and credits.');
    }
    if (!dbPath) {
      notes.push('No agent-traces.db found — exact timings require serialized file spans or the trace store.');
    }
    if (endpoint && exporterType !== 'file' && !feedPath) {
      notes.push(
        `An OTLP endpoint is configured (${redactUrl(endpoint)}); enabling the file feed would replace it.`
      );
    }

    return {
      watching: this.enabled,
      copilotOtelEnabled: copilotEnabled,
      jsonlPath: feedPath,
      jsonlActive: !!feedPath && this.rollup.stats.metrics + this.rollup.stats.logs + this.fileSpans.size > 0,
      sqlitePath: dbPath,
      sqliteActive: this.dbSpans.length > 0,
      // Redacted before it leaves this method: `FeedHealth` is posted to the
      // webview and written to diagnostics, and an OTLP URL can carry a token
      // in its userinfo or query string.
      otlpEndpoint: endpoint ? redactUrl(endpoint) : undefined,
      lastRecordAtMs: Math.max(this.rollup.stats.lastRecordAtMs, ...this.spans.sessions.map((s) => s.endedAt), 0),
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
    const write = () => {
      void this.context.globalState.update(STATE_KEY, this.state);
      void this.context.globalState.update('iceberg.traceWatch.v1', this.traceAccounting);
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
    this._onDidScan.dispose();
  }
}

function numeric(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Cheap fingerprint of a file's opening bytes, used to tell one stream from
 * another. FNV-1a, small enough to run on every poll.
 *
 * The prefix length is stored alongside the hash so a later scan can re-hash
 * exactly the same number of bytes. Comparing hashes taken over different
 * lengths would report a new stream on every append.
 */
function hashPrefix(file: string, length: number): string {
  if (length <= 0) {
    return '0';
  }
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, 0);
      let hash = 0x811c9dc5;
      for (const byte of buf) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return hash.toString(16);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function signatureFor(file: string, size: number): string {
  const length = Math.min(MAX_SIGNATURE_BYTES, Math.max(0, size));
  return `${length}:${hashPrefix(file, length)}`;
}

function parseSignature(raw: string): { length: number; hash: string } | undefined {
  const at = raw.indexOf(':');
  if (at <= 0) {
    return undefined;
  }
  const length = Number(raw.slice(0, at));
  if (!Number.isFinite(length) || length <= 0) {
    return undefined;
  }
  return { length, hash: raw.slice(at + 1) };
}

function fileExists(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}
