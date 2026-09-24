import type * as vscode from 'vscode';
import type { TokenMeter, UsageSnapshot } from './tokenMeter';

export type { UsageSnapshot } from './tokenMeter';

export interface UsageReport {
  input?: number;
  output?: number;
}

export interface IcebergApi {
  /** Adds usage not already observed by the automatic watchers. A number means input tokens. */
  reportUsage(usage: UsageReport | number): void;
  getUsage(): UsageSnapshot;
  onDidChangeUsage: vscode.Event<UsageSnapshot>;
}

export function createIcebergApi(meter: TokenMeter): IcebergApi {
  return {
    reportUsage: (usage) => {
      if (typeof usage === 'number') {
        meter.report(usage);
      } else {
        meter.report(usage?.input ?? 0, usage?.output ?? 0);
      }
    },
    getUsage: () => meter.snapshot(),
    onDidChangeUsage: meter.onDidChange
  };
}
