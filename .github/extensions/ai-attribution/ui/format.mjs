const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

export function formatTokens(value) {
  return value === null || value === undefined ? '—' : compact.format(value);
}

export function coverageText(coverage, calls) {
  if (!coverage || coverage.share === null) return 'Not measured';
  return `${coverage.reportedCalls} / ${calls} calls (${Math.round(coverage.share * 100)}%)`;
}
