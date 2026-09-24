export interface UsageReport {
  input?: number;
  output?: number;
}

export interface ReportingAdapter {
  reportUsage(usage: UsageReport): void;
}

export function createReportingAdapter(report: (input: number, output: number) => void): ReportingAdapter {
  return {
    reportUsage: (usage) => report(usage?.input ?? 0, usage?.output ?? 0)
  };
}
