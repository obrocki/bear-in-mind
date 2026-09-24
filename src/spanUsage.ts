import { hrToMs } from './otelParse';
import { emptySpanDigest, type SpanDigest, type SpanSession } from './otelSummary';

/** Metadata only. Never retain prompts, tool arguments, events or response text. */
export interface UsageSpan {
  id: string;
  operation: string;
  sessionId?: string;
  model: string | null;
  start: number;
  end: number;
  input?: number;
  output?: number;
  cached?: number;
  reasoning?: number;
  credits?: number;
  ttft?: number;
  turns?: number;
  tool?: string;
  promptLimit?: number;
  auxiliary: boolean;
}

export function nonnegative(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined;
}

export function usageSpan(
  id: unknown,
  attributes: Record<string, unknown>,
  start: number,
  end: number
): UsageSpan | undefined {
  const key = text(id);
  const operation = text(attributes['gen_ai.operation.name']);
  if (!key || !operation || !Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end < start) {
    return undefined;
  }
  const nano = nonnegative(attributes['copilot_chat.copilot_usage_nano_aiu']);
  return {
    id: key, operation, start, end,
    sessionId: text(attributes['copilot_chat.chat_session_id']) ?? text(attributes['gen_ai.conversation.id']),
    model: text(attributes['gen_ai.response.model']) ?? text(attributes['gen_ai.request.model']) ?? null,
    input: nonnegative(attributes['gen_ai.usage.input_tokens']),
    output: nonnegative(attributes['gen_ai.usage.output_tokens']),
    cached: nonnegative(attributes['gen_ai.usage.cache_read.input_tokens']),
    reasoning: nonnegative(attributes['gen_ai.usage.reasoning.output_tokens']) ??
      nonnegative(attributes['gen_ai.usage.reasoning_tokens']),
    credits: nano === undefined ? undefined : nano / 1_000_000_000,
    ttft: nonnegative(attributes['copilot_chat.time_to_first_token']),
    turns: nonnegative(attributes['copilot_chat.turn_count']),
    tool: text(attributes['gen_ai.tool.name']),
    promptLimit: nonnegative(attributes['copilot_chat.request.max_prompt_tokens']),
    auxiliary: !!attributes['copilot_chat.parent_chat_session_id'] || !!attributes['copilot_chat.debug_log_label']
  };
}

/** Current Copilot's file exporter serializes public ReadableSpan fields. */
export function fileUsageSpan(record: unknown): UsageSpan | undefined {
  if (!record || typeof record !== 'object') {
    return undefined;
  }
  const r = record as Record<string, unknown>;
  if (!r.attributes || typeof r.attributes !== 'object' || r.ended === false) {
    return undefined;
  }
  return usageSpan(r.spanId, r.attributes as Record<string, unknown>, hrToMs(r.startTime), hrToMs(r.endTime));
}

export function digestSpans(spans: Iterable<UsageSpan>): SpanDigest {
  const digest = emptySpanDigest();
  const sessions = new Map<string, SpanSession>();
  const latestCalls = new Map<string, UsageSpan>();
  const seen = new Set<string>();
  for (const span of spans) {
    if (seen.has(span.id)) {
      continue;
    }
    seen.add(span.id);
    digest.available = true;
    let session: SpanSession | undefined;
    if (span.sessionId) {
      session = sessions.get(span.sessionId);
      if (!session) {
        session = {
          sessionId: span.sessionId, agentName: null, model: span.model,
          startedAt: span.start, endedAt: span.end, durationMs: 0, llmCalls: 0, toolCalls: 0,
          inputTokens: 0, outputTokens: 0, cachedTokens: 0, credits: undefined, creditCalls: 0,
          activeMs: 0, tokenCalls: 0
        };
        sessions.set(span.sessionId, session);
      }
      session.startedAt = Math.min(session.startedAt, span.start);
      if (span.end >= session.endedAt) {
        session.model = span.model ?? session.model;
      }
      session.endedAt = Math.max(session.endedAt, span.end);
      session.durationMs = session.endedAt - session.startedAt;
    }
    const duration = span.end - span.start;
    if (span.operation === 'chat') {
      digest.llmDurationsMs.push(duration);
      digest.inputTokens += span.input ?? 0;
      digest.outputTokens += span.output ?? 0;
      digest.cachedTokens += span.cached ?? 0;
      digest.reasoningTokens += span.reasoning ?? 0;
      if (span.ttft !== undefined) {
        digest.ttftMs.push(span.ttft);
      }
      if (session) {
        session.llmCalls++;
        if (span.input !== undefined && span.output !== undefined) {
          session.tokenCalls = (session.tokenCalls ?? 0) + 1;
        }
        session.activeMs = (session.activeMs ?? 0) + duration;
        session.inputTokens += span.input ?? 0;
        session.outputTokens += span.output ?? 0;
        session.cachedTokens += span.cached ?? 0;
        if (span.credits !== undefined) {
          session.credits = (session.credits ?? 0) + span.credits;
          session.creditCalls = (session.creditCalls ?? 0) + 1;
        }
      }
      if (!span.auxiliary) {
        const key = span.sessionId ?? '';
        if (!latestCalls.has(key) || latestCalls.get(key)!.start < span.start) {
          latestCalls.set(key, span);
        }
      }
    } else if (span.operation === 'invoke_agent') {
      digest.agentDurationsMs.push(duration);
      if (span.turns !== undefined) {
        digest.turnCounts.push(span.turns);
      }
    } else if (span.operation === 'execute_tool') {
      if (session) {
        session.toolCalls++;
      }
      const name = span.tool ?? 'unknown';
      const values = digest.toolDurationsMs.get(name) ?? [];
      values.push(duration);
      digest.toolDurationsMs.set(name, values);
    }
  }
  for (const span of latestCalls.values()) {
    if (span.promptLimit && span.input !== undefined) {
      const context = {
        used: span.input, limit: span.promptLimit, model: span.model,
        atMs: span.start, sessionId: span.sessionId
      };
      if (!digest.context || context.atMs > digest.context.atMs) {
        digest.context = context;
      }
      const session = span.sessionId ? sessions.get(span.sessionId) : undefined;
      if (session) {
        session.context = context;
      }
    }
  }
  digest.sessions = [...sessions.values()].sort((a, b) => b.endedAt - a.endedAt);
  return digest;
}
