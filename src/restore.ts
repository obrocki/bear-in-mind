import * as path from 'path';
import type * as vscode from 'vscode';

/**
 * Undoing what Bear in Mind changed: the Copilot Chat telemetry settings the
 * connect command wrote, its own settings, and its stored state. Everything
 * here is pure so the decisions can be tested without a VS Code host.
 */

export const BACKUP_KEY = 'iceberg.copilotSettingsBackup.v1';

/** Copilot Chat OTel keys the connect command may write, relative to `github.copilot.chat.otel`. */
export const CONNECT_KEYS = ['enabled', 'dbSpanExporter.enabled', 'dbSpanExporter', 'outfile', 'exporterType', 'captureIdentity'] as const;

/** The user-scope value a Copilot setting held before Bear in Mind first wrote it. */
export interface BackupEntry {
  /** False when there was no user value, so restoring removes ours and the default applies. */
  hadValue: boolean;
  value?: unknown;
  /** What Bear in Mind last wrote. A different current value means the user changed it since. */
  applied: unknown;
}

export type SettingsBackup = Record<string, BackupEntry>;

/** Keeps the first recorded original, so reconnecting never overwrites it with our own value. */
export function recordBackup(
  backup: SettingsBackup | undefined,
  key: string,
  previous: unknown,
  applied: unknown
): SettingsBackup {
  const existing = backup?.[key];
  const entry: BackupEntry = existing
    ? { ...existing, applied }
    : previous === undefined
      ? { hadValue: false, applied }
      : { hadValue: true, value: previous, applied };
  return { ...backup, [key]: entry };
}

export type RestoreAction =
  | { key: string; kind: 'restore'; value: unknown }
  | { key: string; kind: 'remove' }
  | { key: string; kind: 'keep'; reason: string };

export interface CopilotRestoreInput {
  /** Current user-scope values, keyed like `CONNECT_KEYS`; `undefined` means not set. */
  current: Record<string, unknown>;
  backup: SettingsBackup | undefined;
  /** Feed files Bear in Mind points Copilot at: its default path and any `iceberg.otel.feedPath`. */
  feedPaths: string[];
  /** An OTLP endpoint is configured, so `enabled` may well be the user's own choice. */
  collectorConfigured: boolean;
}

/**
 * Settings recorded in the backup return to their original value, unless the
 * user has changed them since. Settings written by versions that kept no backup
 * are only reset when they still hold what Bear in Mind writes.
 */
export function planCopilotRestore(input: CopilotRestoreInput): RestoreAction[] {
  const actions: RestoreAction[] = [];
  const backup = input.backup ?? {};

  for (const [key, entry] of Object.entries(backup)) {
    const current = input.current[key];
    const target = entry.hadValue ? entry.value : undefined;
    if (same(current, target)) {
      continue;
    }
    if (!same(current, entry.applied)) {
      actions.push({ key, kind: 'keep', reason: 'changed after Bear in Mind set it' });
      continue;
    }
    actions.push(entry.hadValue ? { key, kind: 'restore', value: entry.value } : { key, kind: 'remove' });
  }
  return [...actions, ...legacyActions(input)];
}

/**
 * For settings with no backup entry: which still hold what an earlier Bear in
 * Mind wrote. Connecting consults this too, so a reconnect after upgrading does
 * not record our own earlier values as the user's originals.
 */
export function legacyActions(input: CopilotRestoreInput): RestoreAction[] {
  const backup = input.backup ?? {};
  const actions: RestoreAction[] = [];
  const legacy = (key: string) => !(key in backup) && input.current[key] !== undefined;
  const ours = (value: unknown) =>
    typeof value === 'string' && input.feedPaths.some((feed) => samePath(value, feed));

  const outfileOurs = legacy('outfile') && ours(input.current.outfile);
  if (outfileOurs) {
    actions.push({ key: 'outfile', kind: 'remove' });
  }
  if (legacy('exporterType') && input.current.exporterType === 'file' && outfileOurs) {
    actions.push({ key: 'exporterType', kind: 'remove' });
  }
  for (const key of ['dbSpanExporter.enabled', 'dbSpanExporter']) {
    if (legacy(key) && input.current[key] === true) {
      actions.push({ key, kind: 'remove' });
    }
  }
  if (legacy('enabled') && input.current.enabled === true) {
    actions.push(
      input.collectorConfigured
        ? { key: 'enabled', kind: 'keep', reason: 'an OTLP collector is configured, so it may predate Bear in Mind' }
        : { key: 'enabled', kind: 'remove' }
    );
  }
  return actions;
}

export type SettingScope = 'global' | 'workspace' | 'workspaceFolder';

export interface SettingInspection {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

/** Scopes at which each contributed setting is customised. Folder scopes are inspected per folder by the caller. */
export function planSettingsReset(
  keys: readonly string[],
  inspect: (key: string) => SettingInspection | undefined
): Array<{ key: string; scopes: SettingScope[] }> {
  const plan: Array<{ key: string; scopes: SettingScope[] }> = [];
  for (const key of keys) {
    const found = inspect(key);
    const scopes: SettingScope[] = [];
    if (found?.globalValue !== undefined) scopes.push('global');
    if (found?.workspaceValue !== undefined) scopes.push('workspace');
    if (found?.workspaceFolderValue !== undefined) scopes.push('workspaceFolder');
    if (scopes.length > 0) {
      plan.push({ key, scopes });
    }
  }
  return plan;
}

/** Setting keys from a manifest's `contributes.configuration`, which may be one object or an array. */
export function contributedSettings(packageJSON: unknown): string[] {
  const configuration = (packageJSON as { contributes?: { configuration?: unknown } } | undefined)?.contributes?.configuration;
  const blocks = Array.isArray(configuration) ? configuration : configuration ? [configuration] : [];
  const keys = new Set<string>();
  for (const block of blocks) {
    const properties = (block as { properties?: Record<string, unknown> } | undefined)?.properties;
    for (const key of Object.keys(properties ?? {})) {
      keys.add(key);
    }
  }
  return [...keys];
}

export function describeAction(section: string, action: RestoreAction): string {
  const name = `${section}.${action.key}`;
  switch (action.kind) {
    case 'restore':
      return `${name} → ${JSON.stringify(action.value)} (your previous value)`;
    case 'remove':
      return `${name} → default`;
    default:
      return `${name} left alone (${action.reason})`;
  }
}

/** Written by a reset so other windows, which share global state, stop saving their stale copies. */
export const RESET_KEY = 'iceberg.resetAt';

/**
 * A memento that can be emptied and then refuses further writes. Components
 * persist on timers and on dispose, so without the seal a reset would be
 * written straight back before the window reloads.
 *
 * With a `resetKey`, every write first checks that no reset has happened since
 * this window started: global state is shared across windows, and the others
 * still hold the old ledgers in memory.
 */
export class SealableMemento implements vscode.Memento {
  private sealed = false;
  private readonly epoch: unknown;

  constructor(private readonly inner: vscode.Memento, private readonly resetKey?: string) {
    this.epoch = resetKey ? inner.get(resetKey) : undefined;
  }

  get isSealed(): boolean {
    if (!this.sealed && this.resetKey && !same(this.inner.get(this.resetKey), this.epoch)) {
      this.sealed = true;
    }
    return this.sealed;
  }

  keys(): readonly string[] {
    return this.inner.keys();
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.inner.get<T>(key) ?? defaultValue;
  }

  update(key: string, value: unknown): Thenable<void> {
    return this.isSealed ? Promise.resolve() : this.inner.update(key, value);
  }

  /** Stops writes here and, with a `resetKey`, in every other window. Stored values are kept. */
  async seal(now = Date.now()): Promise<void> {
    if (this.sealed) {
      return;
    }
    this.sealed = true;
    if (this.resetKey) {
      await this.inner.update(this.resetKey, now);
    }
  }

  async clear(now = Date.now()): Promise<void> {
    // Publish the reset first, so other windows stop writing before the
    // deletions below rather than after them.
    await this.seal(now);
    const keys = this.inner.keys().filter((key) => key !== this.resetKey);
    await Promise.all(keys.map((key) => this.inner.update(key, undefined)));
  }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p.trim());
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return !!a.trim() && !!b.trim() && norm(a) === norm(b);
}
