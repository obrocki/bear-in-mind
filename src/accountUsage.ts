import * as https from 'https';
import * as vscode from 'vscode';
import { RESET_KEY, type SealableMemento } from './restore';
import { nonnegative } from './spanUsage';

export const ACCOUNT_QUOTA_MAX_AGE_MS = 15 * 60 * 1000;
export const ACCOUNT_CONNECTION_KEY = 'iceberg.accountConnection.v1';
const QUOTA_URL = 'https://api.github.com/copilot_internal/user';

export interface AccountQuota {
  login: string;
  plan?: string;
  unit: 'credits' | 'premium requests' | 'chat requests';
  unlimited: boolean;
  hasQuota?: boolean;
  allowance?: number;
  used?: number;
  /** Included usage derived from the reported percentage rather than an exact count. */
  approximate: boolean;
  percentRemaining?: number;
  /** Only for uncapped pooled plans; never divide this by an entitlement. */
  creditsUsed?: number;
  resetAtMs?: number;
  fetchedAtMs: number;
}

export type AccountUsageState =
  | { status: 'ready'; quota: AccountQuota }
  | { status: 'disabled' | 'signedOut' | 'loading' | 'error'; message?: string };

class QuotaError extends Error {}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numeric(value: unknown): number | undefined {
  return nonnegative(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value);
}

/** Mirrors VS Code's quota semantics without mixing credits with legacy requests. */
export function parseAccountQuota(raw: unknown, login: string, nowMs = Date.now()): AccountQuota {
  const data = record(raw);
  const snapshots = record(data?.quota_snapshots);
  const premium = record(snapshots?.premium_interactions) ?? record(snapshots?.premium_models);
  const chat = record(snapshots?.chat);
  const snapshot = premium && (premium.unlimited === true || numeric(premium.entitlement) !== 0) ? premium : chat;
  if (!data || !snapshot || typeof snapshot.unlimited !== 'boolean') {
    throw new QuotaError('GitHub did not report a usable Copilot quota. The unofficial API may have changed.');
  }
  const unlimited = snapshot.unlimited;
  const allowance = unlimited ? undefined : numeric(snapshot.entitlement);
  const percent = snapshot.percent_remaining;
  const percentRemaining = typeof percent === 'number' && Number.isFinite(percent)
    ? Math.max(0, Math.min(100, percent)) : undefined;
  if (!unlimited && percentRemaining === undefined) {
    throw new QuotaError('GitHub did not report the remaining Copilot allowance.');
  }
  const remaining = numeric(snapshot.quota_remaining);
  const used = allowance && percentRemaining !== undefined
    ? Math.max(0, remaining !== undefined ? allowance - remaining : allowance * (100 - percentRemaining) / 100)
    : undefined;
  const reset = numeric(snapshot.quota_reset_at);
  const date = data.quota_reset_date_utc ?? data.quota_reset_date ?? data.limited_user_reset_date;
  const resetAtMs = reset ? reset * 1000 : typeof date === 'string' ? Date.parse(date) : undefined;
  if (resetAtMs !== undefined && !Number.isFinite(new Date(resetAtMs).getTime())) {
    throw new QuotaError('GitHub reported an invalid Copilot allowance reset date.');
  }
  return {
    login,
    plan: typeof data.copilot_plan === 'string' && data.copilot_plan.length <= 128 ? data.copilot_plan : undefined,
    unit: data.token_based_billing === true || snapshot.token_based_billing === true
      ? 'credits' : snapshot === premium ? 'premium requests' : 'chat requests',
    unlimited,
    hasQuota: typeof snapshot.has_quota === 'boolean' ? snapshot.has_quota : undefined,
    allowance,
    used,
    approximate: used !== undefined && remaining === undefined,
    percentRemaining,
    creditsUsed: unlimited ? numeric(snapshot.credits_used) : undefined,
    resetAtMs,
    fetchedAtMs: nowMs
  };
}

/** Fixed GitHub origin, bounded response, no redirects or response-body logging. */
export function requestAccountQuota(token: string, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = https.get(QUOTA_URL, {
      signal,
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/json',
        'User-Agent': 'Bear-in-Mind',
        'X-GitHub-Api-Version': '2025-04-01'
      }
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new QuotaError(`GitHub quota API returned HTTP ${response.statusCode ?? 'unknown'}. ` +
          'Refresh account usage to retry or sign in again; this is an unofficial endpoint.'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          const error = new QuotaError('GitHub quota response exceeded the 1 MB reading limit.');
          reject(error);
          request.destroy(error);
        } else {
          chunks.push(chunk);
        }
      });
      response.on('error', () => reject(new QuotaError('The GitHub quota response could not be read.')));
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new QuotaError('GitHub returned malformed quota data; the account gauge is unavailable.'));
        }
      });
    });
    const deadline = setTimeout(() => request.destroy(new QuotaError('The GitHub quota request timed out.')), 10_000);
    request.on('close', () => clearTimeout(deadline));
    request.on('error', (error: Error) => reject(error instanceof QuotaError
      ? error : new QuotaError('The GitHub quota request failed. Check your connection and refresh account usage.')));
  });
}

interface AccountServices {
  session(interactive: boolean): Promise<vscode.AuthenticationSession | undefined>;
  request(token: string, signal: AbortSignal): Promise<unknown>;
}

const services: AccountServices = {
  async session(interactive) {
    for (const scopes of [['user:email'], ['read:user']]) {
      const session = await vscode.authentication.getSession('github', scopes, { silent: true });
      if (session) {
        return session;
      }
    }
    return interactive
      ? vscode.authentication.getSession('github', ['user:email'], {
        createIfNone: { detail: 'Read your Copilot plan allowance and combined account usage from GitHub\'s unofficial quota API.' }
      })
      : undefined;
  },
  request: requestAccountQuota
};

export class AccountUsageWatcher implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<AccountUsageState>();
  readonly onDidChange = this.emitter.event;
  private state: AccountUsageState = { status: 'loading' };
  private timer?: NodeJS.Timeout;
  private controller?: AbortController;
  private signingIn?: AbortController;
  private disposed = false;
  private running = false;
  private readonly authentication: vscode.Disposable;

  constructor(
    private readonly log: (message: string) => void,
    private readonly memento: SealableMemento,
    private readonly api: AccountServices = services
  ) {
    this.authentication = vscode.authentication.onDidChangeSessions((event) => {
      if (event.provider.id === 'github' && this.running && this.connected && !this.disposed) {
        // Creating a session emits this event before getSession resolves.
        if (this.signingIn === this.controller && this.controller) {
          return;
        }
        this.controller?.abort();
        this.controller = undefined;
        this.publish({ status: 'loading' });
        void this.refresh();
      }
    });
  }

  get snapshot(): AccountUsageState {
    return this.state;
  }

  get enabled(): boolean {
    return vscode.workspace.getConfiguration('iceberg').get<boolean>('accountUsage.enabled', true);
  }

  private get connected(): boolean {
    const connection = this.memento.get<{ resetAt: number }>(ACCOUNT_CONNECTION_KEY);
    return !this.memento.isSealed && connection?.resetAt === this.memento.get<number>(RESET_KEY, 0);
  }

  private allowRefresh(interactive = false): boolean {
    const state: AccountUsageState | undefined = !this.enabled
      ? { status: 'disabled', message: 'Copilot account usage is disabled in settings.' }
      : this.memento.isSealed || (!interactive && !this.connected)
        ? { status: 'signedOut', message: 'Refresh account usage to connect and authorize GitHub sign-in.' }
        : undefined;
    if (!state) {
      return true;
    }
    this.cancel();
    this.publish(state);
    return false;
  }

  private schedule(): void {
    if (this.running && this.enabled && this.connected && !this.timer && !this.disposed) {
      this.timer = setInterval(() => void this.refresh(), 60_000);
      this.timer.unref?.();
    }
  }

  start(): void {
    this.stop();
    if (this.disposed) {
      return;
    }
    this.running = true;
    void this.refresh();
    this.schedule();
  }

  async refresh(interactive = false): Promise<void> {
    if (this.disposed || !this.allowRefresh(interactive)) {
      return;
    }
    if (this.controller && !interactive) {
      return;
    }
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const resetAt = this.memento.get<number>(RESET_KEY, 0);
    if (interactive || this.state.status !== 'ready') {
      this.publish({ status: 'loading' });
    }
    try {
      if (interactive) {
        this.signingIn = controller;
      }
      const session = await this.api.session(interactive);
      if (this.signingIn === controller) {
        this.signingIn = undefined;
      }
      if (controller.signal.aborted || !this.allowRefresh(interactive)) {
        return;
      }
      if (!session) {
        this.publish({ status: 'signedOut', message: 'Refresh account usage to authorize GitHub sign-in.' });
        return;
      }
      if (interactive) {
        // A reset also invalidates a delayed opt-in write or one kept after a failed restore.
        await this.memento.update(ACCOUNT_CONNECTION_KEY, { resetAt });
      }
      if (controller.signal.aborted || !this.allowRefresh()) {
        return;
      }
      this.schedule();
      const raw = await this.api.request(session.accessToken, controller.signal);
      if (!controller.signal.aborted && this.allowRefresh()) {
        this.publish({ status: 'ready', quota: parseAccountQuota(raw, session.account.label) });
      }
    } catch (error) {
      if (!controller.signal.aborted && this.allowRefresh(interactive)) {
        const message = error instanceof QuotaError ? error.message
          : 'GitHub sign-in or quota lookup failed. Refresh account usage to retry.';
        this.log(`account usage: ${message}`);
        this.publish({ status: 'error', message });
      }
    } finally {
      if (this.signingIn === controller) {
        this.signingIn = undefined;
      }
      if (this.controller === controller) {
        this.controller = undefined;
      }
    }
  }

  private publish(state: AccountUsageState): void {
    this.state = state;
    this.emitter.fire(state);
  }

  stop(): void {
    this.running = false;
    this.cancel();
  }

  private cancel(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.controller?.abort();
    this.controller = undefined;
    this.signingIn = undefined;
  }

  async disconnect(): Promise<void> {
    this.stop();
    this.publish({ status: 'signedOut', message: 'Refresh account usage to connect and authorize GitHub sign-in.' });
    await this.memento.update(ACCOUNT_CONNECTION_KEY, undefined);
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.authentication.dispose();
    this.emitter.dispose();
  }
}
