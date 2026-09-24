import * as vscode from 'vscode';
import { computeDrift, type ContextWindow, type DriftReport } from './otelSummary';

const STORAGE_KEY = 'iceberg.usage.v3';
const LEGACY_V2 = 'iceberg.usage.v2';
const LEGACY_V1 = 'iceberg.usage.v1';

/** Expire context from abandoned sessions. */
const CONTEXT_STALE_MS = 30 * 60 * 1000;

/** Recent transcript usage is only an estimate of overlap, not request identity. */
const OVERLAP_WINDOW_MS = 5 * 60 * 1000;
const MAX_RECENT_TRANSCRIPTS = 1024;

/** Which watcher the meter is currently taking its numbers from. */
export type UsageSource = 'otel' | 'transcripts';

/** What the melting ice is measuring. */
export type MeltBasis = 'context' | 'budget';

export interface UsageSnapshot {
  input: number;
  output: number;
  total: number;
  budget: number;
  /** 1 = pristine iceberg, 0 = fully melted. */
  health: number;
  requests: number;
  /** Copilot premium-request credits reported by VS Code, when available. */
  credits: number;
  meltdownDemo: boolean;
  bearName: string;
  animate: boolean;
  pixelScale: number;
  /** Where the charged numbers came from. */
  source: UsageSource;
  /** Whether the ice tracks the context window or the cumulative budget. */
  basis: MeltBasis;
  /** Live context-window occupancy, when telemetry is reporting it. */
  context?: ContextWindow;
  /** Agreement between the two watchers since they started overlapping. */
  drift: DriftReport;
}

interface Ledger {
  input: number;
  output: number;
  requests: number;
}

interface TranscriptObservation {
  at: number;
  input: number;
  output: number;
}

interface StoredUsage {
  /** Cumulative observations, reconciled per dimension with max(), not addition. */
  otel: Ledger;
  transcripts: Ledger;
  /** Set once telemetry has reported; before that `otel` means nothing. */
  promoted: boolean;
  /** Charged by explicit reports: the API, the chat participant, the demo. */
  manual: Ledger;
  credits: number;
  since: number;
  /** Tokens each watcher saw since they began overlapping, for the drift readout. */
  sinceHandover: { otel: number; transcripts: number };
  /** Persist overlap evidence so a restart between observations does not discard it. */
  recentTranscript: TranscriptObservation[];
}

function ledger(): Ledger {
  return { input: 0, output: 0, requests: 0 };
}

function tokens(l: Ledger): number {
  return l.input + l.output;
}

/**
 * Reconciles automatic usage with max(otel, transcripts) per dimension.
 * Promotion carries the transcript balance and absorbs estimated recent overlap;
 * the sources have no shared request ID, so that estimate can undercount.
 * Manual reports add separately; premium credits come from transcripts.
 */
export class TokenMeter implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<UsageSnapshot>();
  readonly onDidChange = this._onDidChange.event;

  private state: StoredUsage;
  private saveTimer: NodeJS.Timeout | undefined;
  private demoTimer: NodeJS.Timeout | undefined;
  private demo = false;
  private lastSource: UsageSource = 'transcripts';
  private lastBasis: MeltBasis = 'budget';
  private context: ContextWindow | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly memento: vscode.Memento) {
    this.state = this.load();
    this.lastSource = this.source;

    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('iceberg')) {
          this.publish();
        }
      })
    );
  }

  private load(): StoredUsage {
    const stored = this.memento.get<Partial<StoredUsage>>(STORAGE_KEY);
    if (stored?.otel || stored?.transcripts) {
      return {
        otel: sanitise(stored.otel),
        transcripts: sanitise(stored.transcripts),
        promoted: stored.promoted ?? false,
        manual: sanitise(stored.manual),
        credits: Math.max(0, stored.credits ?? 0),
        since: stored.since ?? Date.now(),
        sinceHandover: {
          otel: Math.max(0, stored.sinceHandover?.otel ?? 0),
          transcripts: Math.max(0, stored.sinceHandover?.transcripts ?? 0)
        },

        recentTranscript: recentTranscripts(stored.recentTranscript)
      };
    }

    // A v2 meter kept one `auto` ledger fed by whichever watcher was
    // authoritative. Everything in it was observed traffic, so it becomes the
    // transcripts' cumulative total; telemetry adopts that figure the moment it
    // first reports, exactly as it would have done anyway.
    const v2 = this.memento.get<{
      auto?: Partial<Ledger>;
      manual?: Partial<Ledger>;
      credits?: number;
      since?: number;
    }>(LEGACY_V2);
    if (v2?.auto || v2?.manual) {
      return {
        otel: ledger(),
        transcripts: sanitise(v2.auto),
        promoted: false,
        manual: sanitise(v2.manual),
        credits: Math.max(0, v2.credits ?? 0),
        since: v2.since ?? Date.now(),
        sinceHandover: { otel: 0, transcripts: 0 },
        recentTranscript: []
      };
    }

    const v1 = this.memento.get<{
      input?: number;
      output?: number;
      requests?: number;
      credits?: number;
      since?: number;
    }>(LEGACY_V1);
    return {
      otel: ledger(),
      transcripts: {
        input: Math.max(0, v1?.input ?? 0),
        output: Math.max(0, v1?.output ?? 0),
        requests: Math.max(0, v1?.requests ?? 0)
      },
      promoted: false,
      manual: ledger(),
      credits: Math.max(0, v1?.credits ?? 0),
      since: v1?.since ?? Date.now(),
      sinceHandover: { otel: 0, transcripts: 0 },
      recentTranscript: []
    };
  }

  private get config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('iceberg');
  }

  get budget(): number {
    return Math.max(1000, this.config.get<number>('tokenBudget', 5_000_000));
  }

  /** Whether telemetry may hold the meter at all. */
  private get otelAllowed(): boolean {
    return (
      this.config.get<boolean>('otel.enabled', true) &&
      this.config.get<boolean>('otel.authoritative', true)
    );
  }

  /** The watcher currently setting the figure: whichever has seen more. */
  private get charged(): Ledger {
    const t = this.state.transcripts;
    if (!this.state.promoted) {
      return t;
    }
    const o = this.state.otel;
    // Keep each dimension monotonic, including usage recorded before OTel was disabled.
    return {
      input: Math.max(o.input, t.input),
      output: Math.max(o.output, t.output),
      requests: Math.max(o.requests, t.requests)
    };
  }

  get source(): UsageSource {
    if (!this.state.promoted) {
      return 'transcripts';
    }
    return tokens(this.state.otel) >= tokens(this.state.transcripts) ? 'otel' : 'transcripts';
  }

  get countedTotal(): number {
    const countIn = this.config.get<boolean>('countInputTokens', true);
    const countOut = this.config.get<boolean>('countOutputTokens', true);
    const auto = this.charged;
    const input = auto.input + this.state.manual.input;
    const output = auto.output + this.state.manual.output;
    return (countIn ? input : 0) + (countOut ? output : 0);
  }

  get since(): number {
    return this.state.since;
  }

  get drift(): DriftReport {
    return computeDrift(this.state.sinceHandover.otel, this.state.sinceHandover.transcripts);
  }

  /** Context headroom can recover after summarisation or a new session. */
  setContext(context: ContextWindow | undefined): void {
    const before = this.context?.atMs;
    this.context = context;
    if (context?.atMs !== before) {
      this._onDidChange.fire(this.snapshot());
    }
  }

  /** The context reading, if one arrived recently enough to still mean anything. */
  private get liveContext(): ContextWindow | undefined {
    const c = this.context;
    // The demo burns a synthetic budget, so it has to own the scene outright.
    if (this.demo || !c || c.limit <= 0) {
      return undefined;
    }
    return Date.now() - c.atMs <= CONTEXT_STALE_MS ? c : undefined;
  }

  get basis(): MeltBasis {
    return this.liveContext ? 'context' : 'budget';
  }

  snapshot(): UsageSnapshot {
    const budget = this.budget;
    const total = this.countedTotal;
    const auto = this.charged;
    const context = this.liveContext;
    // Context limits require spans; without them, show cumulative budget headroom.
    const health = context
      ? clamp(1 - context.used / context.limit, 0, 1)
      : clamp(1 - total / budget, 0, 1);

    return {
      input: auto.input + this.state.manual.input,
      output: auto.output + this.state.manual.output,
      total,
      budget,
      health,
      requests: auto.requests + this.state.manual.requests,
      credits: this.state.credits,
      meltdownDemo: this.demo,
      bearName: this.config.get<string>('bearName', 'Nanuq') || 'Nanuq',
      animate: this.config.get<boolean>('animate', true),
      pixelScale: Math.round(this.config.get<number>('pixelScale', 0)),
      source: this.source,
      basis: context ? 'context' : 'budget',
      context,
      drift: this.drift
    };
  }

  /** Adds a watcher delta, estimating overlap only when telemetry is promoted. */
  observe(
    from: UsageSource,
    input: number,
    output: number,
    countAsRequest: boolean | number = true,
    credits = 0
  ): void {
    const i = sane(input);
    const o = sane(output);
    const c = Number.isFinite(credits) && credits > 0 ? credits : 0;
    if (i === 0 && o === 0 && c === 0) {
      return;
    }

    // Telemetry switched off means stop ingesting it. What it already reported
    // stays charged — see `charged`.
    if (from === 'otel' && !this.otelAllowed) {
      return;
    }

    // Only the transcripts carry credits, so they are taken regardless of which
    // watcher is currently setting the token figure.
    if (c > 0) {
      this.state.credits += c;
    }

    if (from === 'transcripts' && (i > 0 || o > 0)) {
      // Bound on append even if telemetry is never connected.
      this.state.recentTranscript.push({ at: Date.now(), input: i, output: o });
      this.state.recentTranscript = recentTranscripts(this.state.recentTranscript);
    }

    let absorbedIn = 0;
    let absorbedOut = 0;
    if (from === 'otel' && !this.state.promoted) {
      // Carry the existing balance so newly connected telemetry can catch up.
      this.state.promoted = true;

      // No shared request ID exists. Absorb at most this delta's recent overlap
      // per dimension; unrelated traffic can be absorbed, and max() alone does
      // not guarantee recovery of that undercount.
      const seen = this.recentTranscriptTokens();
      absorbedIn = Math.min(i, seen.input);
      absorbedOut = Math.min(o, seen.output);
      this.state.otel = { ...this.state.transcripts };
      this.state.sinceHandover = { otel: 0, transcripts: 0 };
    }

    const surplusIn = Math.max(0, i - absorbedIn);
    const surplusOut = Math.max(0, o - absorbedOut);
    if (surplusIn > 0 || surplusOut > 0) {
      const target = from === 'otel' ? this.state.otel : this.state.transcripts;
      target.input += surplusIn;
      target.output += surplusOut;
      target.requests += requestsFrom(countAsRequest);
      if (this.state.promoted) {
        this.state.sinceHandover[from] += surplusIn + surplusOut;
      }
    }

    this.persist();
    this.publish();
  }

  /** Keep input/output overlap separate to preserve the reported split. */
  private recentTranscriptTokens(): { input: number; output: number } {
    if (!this.config.get<boolean>('trackCopilotChat', true)) {
      return { input: 0, output: 0 };
    }
    this.state.recentTranscript = recentTranscripts(this.state.recentTranscript);
    return this.state.recentTranscript.reduce(
      (sum, e) => ({ input: sum.input + e.input, output: sum.output + e.output }),
      { input: 0, output: 0 }
    );
  }

  private publish(): void {
    this.lastSource = this.source;
    this._onDidChange.fire(this.snapshot());
  }

  /** Polling detects idle telemetry and stale context without new token usage. */
  noteOtelAlive(alive: boolean): void {
    if (this.state.promoted && !alive) {
      // Carry the charged balance so subsequent transcript deltas count immediately.
      this.state.transcripts = { ...this.charged };
      this.state.promoted = false;
      this.persist();
    }
    const basis = this.basis;
    if (this.source !== this.lastSource || basis !== this.lastBasis) {
      this.lastBasis = basis;
      this.publish();
    }
  }

  /**
   * Adds usage neither watcher can see: the exported API, the `iceberg.report`
   * command, the `@iceberg` chat participant and the meltdown demo.
   */
  report(input: number, output = 0, countAsRequest: boolean | number = true): void {
    const i = sane(input);
    const o = sane(output);
    if (i === 0 && o === 0) {
      return;
    }
    this.state.manual.input += i;
    this.state.manual.output += o;
    this.state.manual.requests += requestsFrom(countAsRequest);
    this.persist();
    this.publish();
  }

  reset(): void {
    this.state = {
      otel: ledger(),
      transcripts: ledger(),
      promoted: false,
      manual: ledger(),
      credits: 0,
      since: Date.now(),
      sinceHandover: { otel: 0, transcripts: 0 },
      recentTranscript: []
    };
    this.persist(true);
    this.publish();
  }

  toggleDemo(): boolean {
    this.demo = !this.demo;
    if (this.demoTimer) {
      clearInterval(this.demoTimer);
      this.demoTimer = undefined;
    }
    if (this.demo) {
      // Burn the whole budget over roughly 60 seconds so the melt is watchable.
      const step = Math.max(1, Math.round(this.budget / 240));
      this.demoTimer = setInterval(() => {
        if (this.countedTotal >= this.budget) {
          this.toggleDemo();
          return;
        }
        this.report(Math.round(step * 0.7), Math.round(step * 0.3), false);
      }, 250);
      this.demoTimer.unref?.();
    }
    this._onDidChange.fire(this.snapshot());
    return this.demo;
  }

  private persist(immediate = false): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    const write = () => void this.memento.update(STORAGE_KEY, this.state);
    if (immediate) {
      write();
      return;
    }
    this.saveTimer = setTimeout(write, 1500);
    this.saveTimer.unref?.();
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    if (this.demoTimer) {
      clearInterval(this.demoTimer);
    }
    void this.memento.update(STORAGE_KEY, this.state);
    this._onDidChange.dispose();
    this.subscriptions.forEach((d) => d.dispose());
  }
}

function recentTranscripts(value: unknown): TranscriptObservation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const now = Date.now();
  const recent: TranscriptObservation[] = [];
  for (let index = value.length - 1; index >= 0 && recent.length < MAX_RECENT_TRANSCRIPTS; index--) {
    const entry: unknown = value[index];
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const { at, input, output } = entry as Partial<TranscriptObservation>;
    if (
      typeof at === 'number' && Number.isFinite(at) && at >= now - OVERLAP_WINDOW_MS && at <= now &&
      typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 &&
      typeof output === 'number' && Number.isSafeInteger(output) && output >= 0
    ) {
      recent.push({ at, input, output });
    }
  }
  return recent.reverse();
}

function sanitise(value: Partial<Ledger> | undefined): Ledger {
  return {
    input: Math.max(0, value?.input ?? 0),
    output: Math.max(0, value?.output ?? 0),
    requests: Math.max(0, value?.requests ?? 0)
  };
}

function requestsFrom(countAsRequest: boolean | number): number {
  return typeof countAsRequest === 'number'
    ? Math.max(0, Math.round(countAsRequest))
    : countAsRequest
      ? 1
      : 0;
}

function sane(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v) || v <= 0) {
    return 0;
  }
  return Math.round(v);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Best-effort token count. Uses the real tokenizer of a language model when one
 * is reachable, otherwise falls back to a ~4 chars/token estimate.
 */
export async function countTokens(
  text: string,
  model?: { countTokens(text: string): Thenable<number> }
): Promise<number> {
  if (!text) {
    return 0;
  }
  try {
    if (model) {
      return await model.countTokens(text);
    }
    const [picked] = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (picked) {
      return await picked.countTokens(text);
    }
  } catch {
    // fall through to the estimate
  }
  return Math.ceil(text.length / 4);
}
