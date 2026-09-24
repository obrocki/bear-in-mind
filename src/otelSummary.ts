/**
 * Turns an `OtelRollup` (plus whatever span detail is available) into the shape
 * the dashboard webview renders. Pure — no `vscode`, no I/O — so it is testable
 * and so the renderer never has to know anything about OpenTelemetry.
 *
 * The three sections mirror the measurement hypotheses the dashboard is built
 * around: 01 cost in tokens, 02 speed in session duration, 03 quality from PR
 * and IDE signals.
 */

import {
  AGENT_DURATION,
  AGENT_TURNS,
  CHAT_EDIT_OUTCOME,
  CLOUD_SESSIONS,
  EDIT_ACCEPTANCE,
  EDIT_RESPONSES,
  LINES_OF_CODE,
  OPERATION_DURATION,
  type OtelRollup,
  PULL_REQUESTS,
  SESSION_COUNT,
  SUMMARIZATIONS,
  SURVIVAL_FOUR_GRAM,
  SURVIVAL_NO_REVERT,
  TIME_TO_FIRST_TOKEN,
  TOKEN_USAGE,
  TOOL_CALL_COUNT,
  TOOL_CALL_DURATION,
  type TokenBucket,
  USER_ACTIONS,
  USER_FEEDBACK
} from './otelParse';

/** One row of the `sessions` view in Copilot Chat's `agent-traces.db`. */
export interface SpanSession {
  sessionId: string;
  agentName: string | null;
  model: string | null;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  llmCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/** Aggregates derived from the `spans` table, when the SQLite source is live. */
export interface SpanDigest {
  available: boolean;
  sessions: SpanSession[];
  /** Exact durations in ms, collected per operation. */
  agentDurationsMs: number[];
  llmDurationsMs: number[];
  ttftMs: number[];
  turnCounts: number[];
  toolDurationsMs: Map<string, number[]>;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  /** How full the context window was on the most recent model call. */
  context?: ContextWindow;
}

/**
 * Prompt occupancy from the latest observed chat span, across the trace store.
 * `limit` is `copilot_chat.request.max_prompt_tokens`, not a billing allowance
 * or necessarily the full context window shown by VS Code (including response
 * reserve). This reading is not tied to the selected editor chat.
 */
export interface ContextWindow {
  used: number;
  limit: number;
  model: string | null;
  atMs: number;
}

export function emptySpanDigest(): SpanDigest {
  return {
    available: false,
    sessions: [],
    agentDurationsMs: [],
    llmDurationsMs: [],
    ttftMs: [],
    turnCounts: [],
    toolDurationsMs: new Map(),
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0
  };
}

export type MetricSource = 'spans' | 'metrics' | 'none';

/** A number plus where it came from, so the UI can mark estimates honestly. */
export interface Measure {
  value?: number;
  source: MetricSource;
}

export interface FeedHealth {
  /** Bear in Mind is configured to read telemetry at all. */
  watching: boolean;
  /** Copilot Chat has OTel switched on. */
  copilotOtelEnabled: boolean;
  jsonlPath?: string;
  jsonlActive: boolean;
  sqlitePath?: string;
  sqliteActive: boolean;
  /** Set when an OTLP endpoint is configured that `outfile` would displace. */
  otlpEndpoint?: string;
  lastRecordAtMs: number;
  records: { metrics: number; logs: number; spans: number; unknown: number; malformed: number };
  notes: string[];
}

export interface DriftReport {
  /** Tokens both watchers saw since OTel took over. */
  otelObserved: number;
  transcriptObserved: number;
  deltaTokens: number;
  deltaPercent: number;
  agreeing: boolean;
  /** No overlap yet, so there is nothing to compare. */
  pending: boolean;
}

export interface CostSection {
  available: boolean;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  credits: number;
  /** Token dimensions enabled for the local visual budget, not all raw tokens. */
  countedTokens: number;
  meterSinceMs: number;
  budget: number;
  health: number;
  /** What `health` measures, so the UI never mislabels it. */
  basis: 'context' | 'budget';
  context?: ContextWindow;
  burnPerHour: number;
  byModel: Array<{ model: string; input: number; output: number; total: number; share: number }>;
  series: TokenBucket[];
  source: 'otel' | 'transcripts';
  drift: DriftReport;
}

export interface SpeedSection {
  available: boolean;
  sessions: number;
  sessionMedianMs: Measure;
  sessionP95Ms: Measure;
  llmCalls: number;
  llmMedianMs: Measure;
  llmP95Ms: Measure;
  ttftMedianMs: Measure;
  turnsPerSession: Measure;
  toolCalls: number;
  toolMedianMs: Measure;
  slowestTools: Array<{ name: string; calls: number; medianMs: number }>;
  tokensPerMinute: number;
}

export interface QualitySection {
  available: boolean;
  editsAccepted: number;
  editsRejected: number;
  acceptRate?: number;
  chatEditsAccepted: number;
  chatEditsRejected: number;
  chatEditsSaved: number;
  linesAdded: number;
  linesRemoved: number;
  survivalFourGram?: number;
  survivalNoRevert?: number;
  pullRequests: number;
  cloudSessions: number;
  feedbackPositive: number;
  feedbackNegative: number;
  /** Share of votes that were positive, when anyone has voted. */
  feedbackRate?: number;
  /** IDE engagement: what the user did with a response. */
  actionCopy: number;
  actionInsert: number;
  actionApply: number;
  actionFollowup: number;
  toolCalls: number;
  toolFailures: number;
  toolSuccessRate?: number;
  editResponseErrors: number;
  summarizationsApplied: number;
  summarizationsFailed: number;
  /** Signals the feed has not produced yet, named so the gap is explainable. */
  missing: string[];
}

export interface DashboardSnapshot {
  generatedAtMs: number;
  bearName: string;
  feed: FeedHealth;
  cost: CostSection;
  speed: SpeedSection;
  quality: QualitySection;
}

export interface SummaryInput {
  rollup: OtelRollup;
  spans: SpanDigest;
  feed: FeedHealth;
  bearName: string;
  budget: number;
  countedTokens: number;
  meterSinceMs: number;
  health: number;
  /** Totals currently charged to the meter. */
  totals: { input: number; output: number; credits: number };
  source: 'otel' | 'transcripts';
  /** What `health` measures. */
  basis: 'context' | 'budget';
  context?: ContextWindow;
  drift: DriftReport;
}

// ------------------------------------------------------------------ helpers --

export function percentile(values: number[], q: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) {
    return sorted[0];
  }
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function mean(values: number[]): number | undefined {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
}

/**
 * Prefers an exact figure computed from span timings and falls back to a
 * bucket-interpolated estimate from the metric histograms. The `source` travels
 * with the value so the dashboard can label estimates rather than implying a
 * precision the histograms do not have.
 */
function prefer(exact: number | undefined, estimate: number | undefined): Measure {
  if (exact !== undefined) {
    return { value: exact, source: 'spans' };
  }
  if (estimate !== undefined) {
    return { value: estimate, source: 'metrics' };
  }
  return { source: 'none' };
}

// ----------------------------------------------------------------- sections --

export function buildCost(input: SummaryInput): CostSection {
  const { spans, totals } = input;

  // Both figures must come from the same ledger. Taking the total from the
  // rollup while `health` comes from the meter produces a headline that
  // contradicts itself — the rollup adopts pre-existing telemetry as history
  // without charging it, and it cannot see manually reported usage at all.
  const inputTokens = totals.input;
  const outputTokens = totals.output;

  const byModelRaw = input.rollup.tokensByModel();
  const modelTotal = byModelRaw.reduce((a, m) => a + m.total, 0) || 1;
  const byModel = byModelRaw.map((m) => ({ ...m, share: m.total / modelTotal }));

  const series = input.rollup.tokenSeries();

  return {
    available: inputTokens + outputTokens > 0 || totals.credits > 0 || input.context !== undefined,
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    cachedTokens: spans.cachedTokens,
    reasoningTokens: spans.reasoningTokens,
    credits: totals.credits,
    countedTokens: input.countedTokens,
    meterSinceMs: input.meterSinceMs,
    budget: input.budget,
    health: input.health,
    basis: input.basis,
    context: input.context,
    burnPerHour: burnRate(series),
    byModel,
    series,
    source: input.source,
    drift: input.drift
  };
}

/** Tokens per hour over the span the series actually covers. */
function burnRate(series: TokenBucket[]): number {
  if (series.length < 2) {
    return 0;
  }
  const first = series[0].tMs;
  const last = series[series.length - 1].tMs;
  const hours = (last - first) / 3_600_000;
  if (hours <= 0) {
    return 0;
  }
  const burned = series.reduce((a, b) => a + b.input + b.output, 0);
  return burned / hours;
}

export function buildSpeed(input: SummaryInput): SpeedSection {
  const { rollup, spans } = input;

  const sessionDurations = spans.sessions.map((s) => s.durationMs).filter((d) => d > 0);
  const agentDurations = sessionDurations.length ? sessionDurations : spans.agentDurationsMs;

  // The metric histograms record seconds; the dashboard works in milliseconds.
  const agentEstMedian = scaleSeconds(rollup.quantile(AGENT_DURATION, 0.5));
  const agentEstP95 = scaleSeconds(rollup.quantile(AGENT_DURATION, 0.95));
  const llmEstMedian = scaleSeconds(rollup.quantile(OPERATION_DURATION, 0.5));
  const llmEstP95 = scaleSeconds(rollup.quantile(OPERATION_DURATION, 0.95));
  const ttftEstMedian = scaleSeconds(rollup.quantile(TIME_TO_FIRST_TOKEN, 0.5));

  const sessionsFromMetrics = Math.round(rollup.total(SESSION_COUNT));
  const sessions = spans.sessions.length || sessionsFromMetrics;

  const llmCallsFromSpans = spans.sessions.reduce((a, s) => a + s.llmCalls, 0) || spans.llmDurationsMs.length;
  const llmCalls = llmCallsFromSpans || Math.round(rollup.observations(OPERATION_DURATION));

  const toolCallsFromSpans = spans.sessions.reduce((a, s) => a + s.toolCalls, 0);
  const toolCalls = toolCallsFromSpans || Math.round(rollup.total(TOOL_CALL_COUNT));

  const toolDurations: number[] = [];
  const slowest: Array<{ name: string; calls: number; medianMs: number }> = [];
  for (const [name, values] of spans.toolDurationsMs) {
    toolDurations.push(...values);
    const median = percentile(values, 0.5);
    if (median !== undefined) {
      slowest.push({ name, calls: values.length, medianMs: median });
    }
  }
  slowest.sort((a, b) => b.medianMs - a.medianMs);

  const turnsExact = mean(spans.turnCounts);
  const turnsEstimate = rollup.mean(AGENT_TURNS);

  const tokensPerMinute = tokenThroughput(input, agentDurations);

  return {
    available: sessions > 0 || llmCalls > 0 || toolCalls > 0,
    sessions,
    sessionMedianMs: prefer(percentile(agentDurations, 0.5), agentEstMedian),
    sessionP95Ms: prefer(percentile(agentDurations, 0.95), agentEstP95),
    llmCalls,
    llmMedianMs: prefer(percentile(spans.llmDurationsMs, 0.5), llmEstMedian),
    llmP95Ms: prefer(percentile(spans.llmDurationsMs, 0.95), llmEstP95),
    ttftMedianMs: prefer(percentile(spans.ttftMs, 0.5), ttftEstMedian),
    turnsPerSession: prefer(turnsExact, turnsEstimate),
    toolCalls,
    toolMedianMs: prefer(percentile(toolDurations, 0.5), rollup.quantile(TOOL_CALL_DURATION, 0.5)),
    slowestTools: slowest.slice(0, 5),
    tokensPerMinute
  };
}

function scaleSeconds(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value * 1000;
}

/**
 * Tokens burned per minute of actual agent work, not wall-clock.
 *
 * Both halves must describe the same window. The meter's total is a lifetime
 * figure while the span digest only retains seven days, so pairing them would
 * report years of old burn as the throughput of this week's sessions. When the
 * span window has no token total of its own there is nothing honest to divide,
 * so the figure is omitted.
 */
function tokenThroughput(input: SummaryInput, durationsMs: number[]): number {
  const busyMs = durationsMs.reduce((a, b) => a + b, 0);
  const windowTokens = input.spans.inputTokens + input.spans.outputTokens;
  if (busyMs <= 0 || windowTokens <= 0) {
    return 0;
  }
  return windowTokens / (busyMs / 60_000);
}

export function buildQuality(input: SummaryInput): QualitySection {
  const { rollup } = input;

  const editsAccepted = Math.round(rollup.total(EDIT_ACCEPTANCE, { 'copilot_chat.edit.outcome': 'accepted' }));
  const editsRejected = Math.round(rollup.total(EDIT_ACCEPTANCE, { 'copilot_chat.edit.outcome': 'rejected' }));
  const decided = editsAccepted + editsRejected;

  const chatEditsAccepted = Math.round(rollup.total(CHAT_EDIT_OUTCOME, { 'copilot_chat.edit.outcome': 'accepted' }));
  const chatEditsRejected = Math.round(rollup.total(CHAT_EDIT_OUTCOME, { 'copilot_chat.edit.outcome': 'rejected' }));
  const chatEditsSaved = Math.round(rollup.total(CHAT_EDIT_OUTCOME, { 'copilot_chat.edit.outcome': 'saved' }));

  const linesAdded = Math.round(rollup.total(LINES_OF_CODE, { type: 'added' }));
  const linesRemoved = Math.round(rollup.total(LINES_OF_CODE, { type: 'removed' }));

  const survivalFourGram = rollup.mean(SURVIVAL_FOUR_GRAM);
  const survivalNoRevert = rollup.mean(SURVIVAL_NO_REVERT);

  const pullRequests = Math.round(rollup.total(PULL_REQUESTS));
  const cloudSessions = Math.round(rollup.total(CLOUD_SESSIONS));

  const feedbackPositive = Math.round(rollup.total(USER_FEEDBACK, { rating: 'positive' }));
  const feedbackNegative = Math.round(rollup.total(USER_FEEDBACK, { rating: 'negative' }));
  const votes = feedbackPositive + feedbackNegative;

  // What the user did with a response is an IDE-side quality signal in its own
  // right: copying or applying an answer is a stronger endorsement than a
  // thumbs up, because it costs something.
  const actionCopy = Math.round(rollup.total(USER_ACTIONS, { action: 'copy' }));
  const actionInsert = Math.round(rollup.total(USER_ACTIONS, { action: 'insert' }));
  const actionApply = Math.round(rollup.total(USER_ACTIONS, { action: 'apply' }));
  const actionFollowup = Math.round(rollup.total(USER_ACTIONS, { action: 'followup' }));

  const toolCalls = Math.round(rollup.total(TOOL_CALL_COUNT));
  const toolFailures = Math.round(rollup.total(TOOL_CALL_COUNT, { success: 'false' }));

  const editResponseErrors = Math.round(rollup.total(EDIT_RESPONSES, { outcome: 'error' }));
  const summarizationsApplied = Math.round(rollup.total(SUMMARIZATIONS, { outcome: 'applied' }));
  const summarizationsFailed = Math.round(rollup.total(SUMMARIZATIONS, { outcome: 'failed' }));

  const missing: string[] = [];
  if (decided === 0) {
    missing.push('edit accept / reject');
  }
  if (survivalFourGram === undefined) {
    missing.push('edit survival');
  }
  if (pullRequests === 0) {
    missing.push('pull requests');
  }
  if (votes === 0) {
    missing.push('thumbs up / down');
  }

  const engagement = actionCopy + actionInsert + actionApply + actionFollowup;

  return {
    available:
      decided > 0 ||
      linesAdded + linesRemoved > 0 ||
      pullRequests > 0 ||
      votes > 0 ||
      engagement > 0 ||
      toolCalls > 0 ||
      survivalFourGram !== undefined ||
      survivalNoRevert !== undefined ||
      cloudSessions > 0 ||
      editResponseErrors > 0 ||
      summarizationsApplied + summarizationsFailed > 0,
    editsAccepted,
    editsRejected,
    acceptRate: decided > 0 ? editsAccepted / decided : undefined,
    chatEditsAccepted,
    chatEditsRejected,
    chatEditsSaved,
    linesAdded,
    linesRemoved,
    survivalFourGram,
    survivalNoRevert,
    pullRequests,
    cloudSessions,
    feedbackPositive,
    feedbackNegative,
    feedbackRate: votes > 0 ? feedbackPositive / votes : undefined,
    actionCopy,
    actionInsert,
    actionApply,
    actionFollowup,
    toolCalls,
    toolFailures,
    toolSuccessRate: toolCalls > 0 ? (toolCalls - toolFailures) / toolCalls : undefined,
    editResponseErrors,
    summarizationsApplied,
    summarizationsFailed,
    missing
  };
}

export function buildSnapshot(input: SummaryInput): DashboardSnapshot {
  return {
    generatedAtMs: Date.now(),
    bearName: input.bearName,
    feed: input.feed,
    cost: buildCost(input),
    speed: buildSpeed(input),
    quality: buildQuality(input)
  };
}

/**
 * Strips anything credential-shaped out of a URL before it is shown or stored.
 *
 * OTLP endpoints routinely carry tokens in userinfo or a query string. The host
 * and path are what make a message useful; the secrets are not. Everything
 * user-facing — the connect prompts, the dashboard banner, the diagnostics
 * dump — goes through here, so there is one place to get this right rather than
 * three places to forget it.
 */
export function redactUrl(raw: string | undefined): string {
  if (!raw) {
    return '(none)';
  }
  try {
    const url = new URL(raw);
    const credentials = url.username || url.password ? '<redacted>@' : '';
    const query = url.search ? '?<redacted>' : '';
    return `${url.protocol}//${credentials}${url.host}${url.pathname}${query}`;
  } catch {
    // Not a URL we can take apart, so say nothing about its contents.
    return '(unparseable, withheld)';
  }
}

/** Compares what each source saw over the window in which both were running. */
export function computeDrift(otelObserved: number, transcriptObserved: number): DriftReport {
  const pending = otelObserved === 0 || transcriptObserved === 0;
  const delta = otelObserved - transcriptObserved;
  const base = Math.max(otelObserved, transcriptObserved) || 1;
  const percent = (delta / base) * 100;
  return {
    otelObserved,
    transcriptObserved,
    deltaTokens: delta,
    deltaPercent: percent,
    // Transcripts round differently and miss cache/reasoning tokens entirely,
    // so exact equality is not the bar. Within 2% is agreement.
    agreeing: pending || Math.abs(percent) <= 2,
    pending
  };
}

export const METRIC_INDEX = {
  TOKEN_USAGE,
  OPERATION_DURATION,
  AGENT_DURATION,
  AGENT_TURNS,
  SESSION_COUNT,
  TIME_TO_FIRST_TOKEN,
  TOOL_CALL_COUNT,
  TOOL_CALL_DURATION
};
