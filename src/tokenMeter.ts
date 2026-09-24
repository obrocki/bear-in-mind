import * as vscode from 'vscode';
import { computeDrift, type ContextWindow, type DriftReport } from './otelSummary';

const STORAGE_KEY = 'iceberg.usage.v4';
const CONTEXT_STALE_MS = 30 * 60 * 1000;

export type UsageSource = 'otel' | 'none';
export type MeltBasis = 'context' | 'budget' | 'unavailable' | 'demo';

export interface UsageSnapshot {
  input: number;
  output: number;
  total: number;
  /** Zero means no user-selected visual budget. Never a billing allowance. */
  budget: number;
  /** Animation position only when basis is unavailable; do not display a percentage. */
  health: number;
  requests: number;
  credits: number;
  manualTokens: number;
  /** Preserved pre-v4 estimates, excluded from measured usage. */
  legacyTokens: number;
  meltdownDemo: boolean;
  bearName: string;
  animate: boolean;
  pixelScale: number;
  source: UsageSource;
  basis: MeltBasis;
  context?: ContextWindow;
  drift: DriftReport;
}

interface Ledger {
  input: number;
  output: number;
  requests: number;
}

interface StoredUsage {
  metrics: Ledger;
  traces: Ledger;
  manual: Ledger;
  credits: number;
  legacyTokens: number;
  since: number;
}

function ledger(value?: Partial<Ledger>): Ledger {
  return { input: sane(value?.input), output: sane(value?.output), requests: sane(value?.requests) };
}

/** Metrics and spans describe overlapping calls. Never add them or rebase on idle. */
export class TokenMeter implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<UsageSnapshot>();
  readonly onDidChange = this._onDidChange.event;
  private readonly state: StoredUsage;
  private context?: ContextWindow;
  private demoTimer?: NodeJS.Timeout;
  private demoProgress = 0;
  private saveTimer?: NodeJS.Timeout;
  private lastBasis: MeltBasis = 'unavailable';
  private readonly configuration: vscode.Disposable;

  constructor(private readonly memento: vscode.Memento) {
    const stored = memento.get<StoredUsage>(STORAGE_KEY);
    const old = memento.get<{
      otel?: Ledger; transcripts?: Ledger; manual?: Ledger; auto?: Ledger; input?: number; output?: number;
    }>('iceberg.usage.v3') ?? memento.get('iceberg.usage.v2') ?? memento.get('iceberg.usage.v1');
    const legacyTokens = old
      ? Math.max(sane(old.otel?.input), sane(old.transcripts?.input ?? old.auto?.input ?? old.input)) +
        Math.max(sane(old.otel?.output), sane(old.transcripts?.output ?? old.auto?.output ?? old.output)) +
        sane(old.manual?.input) + sane(old.manual?.output)
      : 0;
    this.state = {
      metrics: ledger(stored?.metrics), traces: ledger(stored?.traces), manual: ledger(stored?.manual),
      credits: stored?.credits ?? 0,
      legacyTokens: stored?.legacyTokens ?? legacyTokens,
      since: stored?.since ?? Date.now()
    };
    this.configuration = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('iceberg')) {
        this.publish();
      }
    });
    this.persist();
  }

  private get config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('iceberg');
  }

  get budget(): number {
    return sane(this.config.get<number>('tokenBudget', 0));
  }

  get since(): number {
    return this.state.since;
  }

  get source(): UsageSource {
    return this.state.metrics.input + this.state.metrics.output + this.state.traces.input + this.state.traces.output > 0
      ? 'otel' : 'none';
  }

  get drift(): DriftReport {
    const { metrics, traces } = this.state;
    return computeDrift(metrics.input + metrics.output, traces.input + traces.output);
  }

  private get liveContext(): ContextWindow | undefined {
    const context = this.context;
    return context && !this.demoTimer && context.limit > 0 && context.used >= 0 &&
      Number.isFinite(context.limit) && Number.isFinite(context.used) &&
      Date.now() - context.atMs >= 0 && Date.now() - context.atMs <= CONTEXT_STALE_MS
      ? context : undefined;
  }

  get basis(): MeltBasis {
    return this.demoTimer ? 'demo' : this.liveContext ? 'context' : this.budget > 0 ? 'budget' : 'unavailable';
  }

  get countedTotal(): number {
    const { metrics, traces, manual } = this.state;
    return (this.config.get<boolean>('countInputTokens', true) ? Math.max(metrics.input, traces.input) + manual.input : 0) +
      (this.config.get<boolean>('countOutputTokens', true) ? Math.max(metrics.output, traces.output) + manual.output : 0);
  }

  snapshot(): UsageSnapshot {
    const { metrics, traces, manual } = this.state;
    const context = this.liveContext;
    const total = this.countedTotal;
    const budget = this.budget;
    const health = this.demoTimer ? 1 - this.demoProgress : context ? clamp(1 - context.used / context.limit, 0, 1) :
      budget > 0 ? clamp(1 - total / budget, 0, 1) : 1;
    return {
      input: Math.max(metrics.input, traces.input) + manual.input,
      output: Math.max(metrics.output, traces.output) + manual.output,
      total, budget, health,
      requests: traces.requests + manual.requests,
      credits: this.state.credits,
      manualTokens: manual.input + manual.output,
      legacyTokens: this.state.legacyTokens,
      meltdownDemo: !!this.demoTimer,
      bearName: this.config.get<string>('bearName', 'Nanuq') || 'Nanuq',
      animate: this.config.get<boolean>('animate', true),
      pixelScale: Math.round(this.config.get<number>('pixelScale', 0)),
      source: this.source, basis: this.basis, context, drift: this.drift
    };
  }

  setContext(context: ContextWindow | undefined): void {
    if (JSON.stringify(context) !== JSON.stringify(this.context)) {
      this.context = context;
      this.publish();
    }
  }

  observe(from: 'otel' | 'traces' | 'transcripts', input: number, output: number, requests: boolean | number = true, credits = 0): void {
    if (from === 'transcripts') {
      // Neither promptTokens nor serialized completionTokens identifies billed
      // model calls. Only Copilot's explicitly reported credits belong here.
      if (Number.isFinite(credits) && credits > 0) {
        this.state.credits += credits;
        this.persist();
        this.publish();
      }
      return;
    }
    if (!this.config.get<boolean>('otel.enabled', true) || !this.config.get<boolean>('otel.authoritative', true)) {
      return;
    }
    const target = from === 'traces' ? this.state.traces : this.state.metrics;
    target.input += sane(input);
    target.output += sane(output);
    target.requests += sane(typeof requests === 'boolean' ? Number(requests) : requests);
    this.persist();
    this.publish();
  }

  /** A missing or delayed export must never promote, copy or reset a ledger. */
  noteOtelAlive(_alive: boolean): void {
    if (this.lastBasis !== this.basis) {
      this.publish();
    }
  }

  report(input: number, output = 0, requests: boolean | number = true): void {
    const i = sane(input);
    const o = sane(output);
    if (!i && !o) {
      return;
    }
    this.state.manual.input += i;
    this.state.manual.output += o;
    this.state.manual.requests += sane(typeof requests === 'boolean' ? Number(requests) : requests);
    this.persist();
    this.publish();
  }

  toggleDemo(): boolean {
    if (this.demoTimer) {
      clearInterval(this.demoTimer);
      this.demoTimer = undefined;
    } else {
      this.demoProgress = 0;
      this.demoTimer = setInterval(() => {
        this.demoProgress = Math.min(1, this.demoProgress + 1 / 240);
        this.publish();
      }, 250);
      this.demoTimer.unref?.();
    }
    this.publish();
    return !!this.demoTimer;
  }

  private publish(): void {
    this.lastBasis = this.basis;
    this._onDidChange.fire(this.snapshot());
  }

  private persist(): void {
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = undefined;
        void this.memento.update(STORAGE_KEY, this.state);
      }, 1500);
      this.saveTimer.unref?.();
    }
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    if (this.demoTimer) {
      clearInterval(this.demoTimer);
    }
    void this.memento.update(STORAGE_KEY, this.state);
    this.configuration.dispose();
    this._onDidChange.dispose();
  }
}

function sane(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}
