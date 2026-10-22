const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

export function formatTokens(value) {
  return value === null || value === undefined ? '—' : compact.format(value);
}

export function coverageText(coverage, calls) {
  if (!coverage || coverage.share === null) return 'Not measured';
  return `${coverage.reportedCalls} / ${calls} requests (${Math.round(coverage.share * 100)}%)`;
}

export const usageLabels = { measured: 'User recorded', inferred: 'Owner estimate', unattributed: 'User unknown' };
export const evidenceLabels = { verified: 'Checked online', recorded: 'Mentioned', convention: 'Branch name', observed: 'Local record' };
export const sourceLabels = {
  sessionStore: 'Copilot CLI / app',
  traces: 'VS Code · Local harness',
  agentHost: 'VS Code · Copilot Agent Host harness',
};
export const entityLabels = {
  actor: 'Account', ai_session: 'AI session', model_call: 'AI request', tool_call: 'Tool action',
  work_item: 'Work item', attribution: 'Link to work', outcome: 'Result',
  cost_ledger: 'GitHub bill', billing_reconciliation: 'Compare with bill', work_allocation: 'Estimated work cost',
};
