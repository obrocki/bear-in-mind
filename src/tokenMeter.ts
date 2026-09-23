import * as vscode from 'vscode';
import { computeDrift, type ContextWindow, type DriftReport } from './otelSummary';

const STORAGE_KEY = 'iceberg.usage.v2';
const LEGACY_KEY = 'iceberg.usage.v1';

/** How long the OpenTelemetry feed may go quiet before transcripts take over. */
const OTEL_STALE_MS = 10 * 60 * 1000;

/**
 * How long a context-window reading stays current.
 *
 * Long enough to survive a pause for thought mid-session, short enough that an
 * abandoned session stops driving the scene.
 */
const CONTEXT_STALE_MS = 30 * 60 * 1000;

/** Which watcher the meter is currently charging. */
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

interface StoredUsage {
  /** Charged by whichever watcher is authoritative. */
  auto: Ledger;
  /** Charged by explicit reports: the API, the chat participant, the demo. */
  manual: Ledger;
  credits: number;
  since: number;
  /** Tokens each watcher has *seen* since they began overlapping. */
  observed: { otel: number; transcripts: number };
  overlapping: boolean;
}

function ledger(): Ledger {
  return { input: 0, output: 0, requests: 0 };
}

/**
 * Tracks how many tokens have been burned and derives the "health" of the
 * iceberg from it. Everything the webview needs comes out of `snapshot()`.
 *
 * ## Two ledgers, never summed
 *
 * The transcript watcher and the OpenTelemetry watcher both observe the *same*
 * Copilot traffic. Adding them together would double every number, so they
 * share one `auto` ledger and only whichever is currently authoritative is
 * allowed to charge it. `manual` is separate and always charged, because the
 * things that feed it — the exported API, the `@iceberg` participant, the
 * meltdown demo — are not Copilot Chat traffic that either watcher can see.
 *
 * Switching which watcher is authoritative therefore costs nothing: the ledger
 * is a running total of what has already been charged, so handing over
 * mid-flight carries the balance automatically and the ice never jumps.
 *
 * The one thing that cannot be arbitrated is `credits`. OpenTelemetry has no
 * equivalent of `copilotCredits`, so premium-request credits always come from
 * the transcripts regardless of which source holds the meter.
 */
export class TokenMeter implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<UsageSnapshot>();
  readonly onDidChange = this._onDidChange.event;

  private state: StoredUsage;
  private saveTimer: NodeJS.Timeout | undefined;
  private demoTimer: NodeJS.Timeout | undefined;
  private demo = false;
  private otelLastSeenMs = 0;
  private context: ContextWindow | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly memento: vscode.Memento) {
    this.state = this.load();

    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('iceberg')) {
          this._onDidChange.fire(this.snapshot());
        }
      })
    );
  }

  private load(): StoredUsage {
    const stored = this.memento.get<Partial<StoredUsage>>(STORAGE_KEY);
    if (stored?.auto || stored?.manual) {
      return {
        auto: sanitise(stored.auto),
        manual: sanitise(stored.manual),
        credits: Math.max(0, stored.credits ?? 0),
        since: stored.since ?? Date.now(),
        observed: {
          otel: Math.max(0, stored.observed?.otel ?? 0),
          transcripts: Math.max(0, stored.observed?.transcripts ?? 0)
        },
        overlapping: stored.overlapping ?? false
      };
    }

    // Carry a v1 meter forward. Everything it holds was charged from the
    // transcripts, which is exactly what the auto ledger means.
    const legacy = this.memento.get<{
      input?: number;
      output?: number;
      requests?: number;
      credits?: number;
      since?: number;
    }>(LEGACY_KEY);
    return {
      auto: {
        input: Math.max(0, legacy?.input ?? 0),
        output: Math.max(0, legacy?.output ?? 0),
        requests: Math.max(0, legacy?.requests ?? 0)
      },
      manual: ledger(),
      credits: Math.max(0, legacy?.credits ?? 0),
      since: legacy?.since ?? Date.now(),
      observed: { otel: 0, transcripts: 0 },
      overlapping: false
    };
  }

  private get config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('iceberg');
  }

  get budget(): number {
    return Math.max(1000, this.config.get<number>('tokenBudget', 5_000_000));
  }

  /** Whether OpenTelemetry should hold the meter when it is producing data. */
  private get preferOtel(): boolean {
    return this.config.get<boolean>('otel.authoritative', true);
  }

  get source(): UsageSource {
    // Turning the reader off must hand the meter back immediately. Without this
    // a recent reading would keep telemetry authoritative for the rest of the
    // staleness window, leaving nothing able to charge.
    if (!this.config.get<boolean>('otel.enabled', true)) {
      return 'transcripts';
    }
    if (!this.preferOtel) {
      return 'transcripts';
    }
    // With the transcript watcher switched off there is no second source to
    // fall back to, so telemetry has to charge from its very first delta —
    // otherwise that delta, and one after every idle spell, is simply lost.
    if (!this.config.get<boolean>('trackCopilotChat', true)) {
      return 'otel';
    }
    if (this.otelLastSeenMs === 0) {
      return 'transcripts';
    }
    return Date.now() - this.otelLastSeenMs <= OTEL_STALE_MS ? 'otel' : 'transcripts';
  }

  get countedTotal(): number {
    const countIn = this.config.get<boolean>('countInputTokens', true);
    const countOut = this.config.get<boolean>('countOutputTokens', true);
    const input = this.state.auto.input + this.state.manual.input;
    const output = this.state.auto.output + this.state.manual.output;
    return (countIn ? input : 0) + (countOut ? output : 0);
  }

  get since(): number {
    return this.state.since;
  }

  get drift(): DriftReport {
    return computeDrift(this.state.observed.otel, this.state.observed.transcripts);
  }

  /**
   * Records the live context-window occupancy.
   *
   * This is what the ice tracks when it is available, because it is a genuine
   * constraint the model is working under rather than a number somebody typed.
   * It also refreezes on its own: a new session, or a context summarisation,
   * drops the prompt size and the berg grows back.
   */
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
    const context = this.liveContext;
    // Falling back to the cumulative budget is not a lesser mode — it is the
    // only thing available until the trace store is connected, since the
    // context limit rides on spans and the file feed's spans are empty.
    const health = context
      ? clamp(1 - context.used / context.limit, 0, 1)
      : clamp(1 - total / budget, 0, 1);

    return {
      input: this.state.auto.input + this.state.manual.input,
      output: this.state.auto.output + this.state.manual.output,
      total,
      budget,
      health,
      requests: this.state.auto.requests + this.state.manual.requests,
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

  /**
   * Records what a watcher saw.
   *
   * Every delta counts towards the drift comparison, but only the authoritative
   * watcher's delta is charged against the budget. Credits are the exception:
   * only the transcripts carry them, so they are always taken.
   */
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

    // Authority is decided from the state as it stood *before* this delta.
    // Letting an arriving delta promote its own source is what double-charges a
    // handover: telemetry lags the transcripts by an export interval, so the
    // transcripts have already charged this exact traffic. Reading `source`
    // after refreshing `otelLastSeenMs` would charge it a second time.
    const active = this.source;

    let opened = false;
    if (from === 'otel') {
      if (!this.state.overlapping) {
        // First telemetry data. From here both watchers run side by side, so
        // start the comparison from a shared zero rather than from history.
        this.state.overlapping = true;
        this.state.observed = { otel: 0, transcripts: 0 };
        opened = true;
      }
      this.otelLastSeenMs = Date.now();
    }
    // The delta that opens the window describes traffic the transcripts
    // recorded before the window existed. Counting it would report a 100%
    // disagreement between two sources that in fact agreed exactly.
    if (this.state.overlapping && !opened) {
      this.state.observed[from] += i + o;
    }

    if (c > 0) {
      this.state.credits += c;
    }
    if (from === active && (i > 0 || o > 0)) {
      this.state.auto.input += i;
      this.state.auto.output += o;
      this.state.auto.requests += requestsFrom(countAsRequest);
    }

    this.persist();
    this._onDidChange.fire(this.snapshot());
  }

  /**
   * Keeps telemetry authoritative while its feed is alive.
   *
   * `observe` only fires when tokens actually move, so without this an idle
   * spell longer than `OTEL_STALE_MS` would quietly demote telemetry and hand
   * the next request back to the transcripts.
   */
  noteOtelAlive(alive: boolean): void {
    if (alive) {
      this.otelLastSeenMs = Date.now();
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
    this._onDidChange.fire(this.snapshot());
  }

  reset(): void {
    this.state = {
      auto: ledger(),
      manual: ledger(),
      credits: 0,
      since: Date.now(),
      observed: { otel: 0, transcripts: 0 },
      overlapping: false
    };
    this.otelLastSeenMs = 0;
    this.persist(true);
    this._onDidChange.fire(this.snapshot());
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
