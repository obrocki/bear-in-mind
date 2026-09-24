export interface UsageReport {
  input?: number;
  output?: number;
}

export interface ReportingAdapter {
  reportUsage(usage: UsageReport): void;
}

/** Non-finite or negative usage is normalised to zero before it reaches the meter. */
export function createReportingAdapter(report: (input: number, output: number) => void): ReportingAdapter {
  return {
    reportUsage: (usage) => report(safe(usage?.input), safe(usage?.output))
  };
}

function safe(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
