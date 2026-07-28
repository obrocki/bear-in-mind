import * as vscode from 'vscode';

const STORAGE_KEY = 'iceberg.usage.v1';

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
}

interface StoredUsage {
  input: number;
  output: number;
  requests: number;
  credits: number;
  since: number;
}

/**
 * Tracks how many tokens have been burned and derives the "health" of the
 * iceberg from it. Everything the webview needs comes out of `snapshot()`.
 */
export class TokenMeter implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<UsageSnapshot>();
  readonly onDidChange = this._onDidChange.event;

  private state: StoredUsage;
  private saveTimer: NodeJS.Timeout | undefined;
  private demoTimer: NodeJS.Timeout | undefined;
  private demo = false;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly memento: vscode.Memento) {
    const stored = memento.get<Partial<StoredUsage>>(STORAGE_KEY);
    this.state = {
      input: Math.max(0, stored?.input ?? 0),
      output: Math.max(0, stored?.output ?? 0),
      requests: Math.max(0, stored?.requests ?? 0),
      credits: Math.max(0, stored?.credits ?? 0),
      since: stored?.since ?? Date.now()
    };

    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('iceberg')) {
          this._onDidChange.fire(this.snapshot());
        }
      })
    );
  }

  private get config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('iceberg');
  }

  get budget(): number {
    return Math.max(1000, this.config.get<number>('tokenBudget', 5_000_000));
  }

  get countedTotal(): number {
    const countIn = this.config.get<boolean>('countInputTokens', true);
    const countOut = this.config.get<boolean>('countOutputTokens', true);
    return (countIn ? this.state.input : 0) + (countOut ? this.state.output : 0);
  }

  get since(): number {
    return this.state.since;
  }

  snapshot(): UsageSnapshot {
    const budget = this.budget;
    const total = this.countedTotal;
    return {
      input: this.state.input,
      output: this.state.output,
      total,
      budget,
      health: clamp(1 - total / budget, 0, 1),
      requests: this.state.requests,
      credits: this.state.credits,
      meltdownDemo: this.demo,
      bearName: this.config.get<string>('bearName', 'Nanuq') || 'Nanuq',
      animate: this.config.get<boolean>('animate', true),
      pixelScale: Math.round(this.config.get<number>('pixelScale', 0))
    };
  }

  /**
   * Adds usage. `countAsRequest` may be a boolean or an explicit number of
   * requests, which the chat watcher uses when it catches up on a batch.
   */
  report(input: number, output = 0, countAsRequest: boolean | number = true, credits = 0): void {
    const i = sane(input);
    const o = sane(output);
    const c = Number.isFinite(credits) && credits > 0 ? credits : 0;
    if (i === 0 && o === 0 && c === 0) {
      return;
    }
    this.state.input += i;
    this.state.output += o;
    this.state.credits += c;
    const added =
      typeof countAsRequest === 'number' ? Math.max(0, Math.round(countAsRequest)) : countAsRequest ? 1 : 0;
    this.state.requests += added;
    this.persist();
    this._onDidChange.fire(this.snapshot());
  }

  reset(): void {
    this.state = { input: 0, output: 0, requests: 0, credits: 0, since: Date.now() };
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
