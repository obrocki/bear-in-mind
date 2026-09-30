import { hrToMs } from './otelParse';
import { emptySpanDigest, type CallTally, type SpanDigest, type SpanSession } from './otelSummary';

/** OTel span status code for ERROR; UNSET (0) and OK (1) are not failures. */
const SPAN_STATUS_ERROR = 2;
/** Request-option blobs larger than this are skipped rather than parsed. */
const MAX_OPTIONS_CHARS = 64 * 1024;

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
  /** `gen_ai.agent.name`: the Copilot component that made the call. */
  agent?: string;
  /** Chat session a sub-agent call belongs to. */
  parentSessionId?: string;
  /** Reported reasoning effort; only this value is kept from the request options. */
  effort?: string;
  /** `owner/name` from agent-span git attributes, credentials removed. */
  repository?: string;
  branch?: string;
  /** Span status ERROR; undefined when the source reported no status. */
  failed?: boolean;
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

/**
 * `owner/name` for github.com, `host/path` elsewhere. Remote URLs can carry
 * credentials, so only the host and path of a parsed URL survive.
 */
export function repositoryName(value: unknown): string | undefined {
  const raw = text(value)?.trim();
  if (!raw) {
    return undefined;
  }
  let name = raw.replace(/^git@([^:/]+):/, 'https://$1/').replace(/^ssh:\/\/(?:[^@/]+@)?/, 'https://');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(name)) {
    try {
      const url = new URL(name);
      const pathname = url.pathname.replace(/^\/+/, '');
      name = url.hostname.toLowerCase() === 'github.com' ? pathname : `${url.hostname}/${pathname}`;
    } catch {
      return undefined;
    }
  } else if (name.includes('@')) {
    return undefined;
  }
  name = name.replace(/\.git$/i, '').replace(/\/+$/, '');
  return name || undefined;
}

/**
 * Copilot records reasoning effort inside `copilot_chat.request.options`, a
 * JSON blob of request settings. Only a short effort word is kept from it.
 */
export function reasoningEffort(attributes: Record<string, unknown>): string | undefined {
  let options = attributes['copilot_chat.request.options'];
  if (typeof options === 'string') {
    if (options.length > MAX_OPTIONS_CHARS) {
      return undefined;
    }
    try {
      options = JSON.parse(options);
    } catch {
      return undefined;
    }
  }
  let effort: unknown = attributes['gen_ai.request.reasoning.level'];
  if (options && typeof options === 'object') {
    const o = options as Record<string, unknown>;
    const reasoning = o.reasoning && typeof o.reasoning === 'object' ? (o.reasoning as Record<string, unknown>) : undefined;
    effort = reasoning?.effort ?? o.reasoning_effort ?? effort;
  }
  return typeof effort === 'string' && /^[a-z][a-z_-]{0,23}$/i.test(effort) ? effort.toLowerCase() : undefined;
}

function spanFailed(status: unknown): boolean | undefined {
  const code = typeof status === 'string' && status.trim() !== '' ? Number(status) : status;
  return typeof code === 'number' && Number.isInteger(code) ? code === SPAN_STATUS_ERROR : undefined;
}

export function usageSpan(
  id: unknown,
  attributes: Record<string, unknown>,
  start: number,
  end: number,
  status?: unknown
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
    auxiliary: !!attributes['copilot_chat.parent_chat_session_id'] || !!attributes['copilot_chat.debug_log_label'],
    agent: text(attributes['gen_ai.agent.name']),
    parentSessionId: text(attributes['copilot_chat.parent_chat_session_id']),
    effort: operation === 'chat' ? reasoningEffort(attributes) : undefined,
    repository: repositoryName(attributes['github.copilot.git.repository']) ??
      repositoryName(attributes['copilot_chat.repo.remote_url']),
    branch: text(attributes['github.copilot.git.branch']) ?? text(attributes['copilot_chat.repo.head_branch_name']),
    failed: spanFailed(status)
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
  const status = r.status && typeof r.status === 'object' ? (r.status as Record<string, unknown>).code : undefined;
  return usageSpan(
    r.spanId, r.attributes as Record<string, unknown>, hrToMs(r.startTime), hrToMs(r.endTime), status
  );
}

function tally(rows: Map<string | null, CallTally>, key: string | null, credits: number | undefined): void {
  const row = rows.get(key) ?? { key, calls: 0, creditCalls: 0, credits: 0 };
  row.calls++;
  if (credits !== undefined) {
    row.creditCalls++;
    row.credits += credits;
  }
  rows.set(key, row);
}

export function digestSpans(spans: Iterable<UsageSpan>): SpanDigest {
  const digest = emptySpanDigest();
  const sessions = new Map<string, SpanSession>();
  const latestCalls = new Map<string, UsageSpan>();
  const seen = new Set<string>();
  const unique: UsageSpan[] = [];
  for (const span of spans) {
    if (!seen.has(span.id)) {
      seen.add(span.id);
      unique.push(span);
    }
  }

  // Agent spans carry the git context; the model calls under them do not.
  const work = new Map<string, { repository?: string; branch?: string; at: number }>();
  for (const span of unique) {
    if (span.operation === 'invoke_agent' && span.sessionId && (span.repository || span.branch)) {
      const known = work.get(span.sessionId);
      if (!known || known.at <= span.start) {
        work.set(span.sessionId, { repository: span.repository, branch: span.branch, at: span.start });
      }
    }
  }
  const byModel = new Map<string | null, CallTally>();
  const byCaller = new Map<string | null, CallTally>();
  const byEffort = new Map<string | null, CallTally>();
  const byRepository = new Map<string | null, CallTally>();

  for (const span of unique) {
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
      digest.chatCalls++;
      if (span.credits !== undefined) {
        digest.creditCalls++;
        digest.credits += span.credits;
      }
      if (!span.sessionId) {
        digest.sessionlessCalls++;
        digest.sessionlessCredits += span.credits ?? 0;
      }
      const repository = work.get(span.sessionId ?? '')?.repository ?? work.get(span.parentSessionId ?? '')?.repository;
      tally(byModel, span.model, span.credits);
      tally(byCaller, span.agent ?? null, span.credits);
      tally(byEffort, span.effort ?? null, span.credits);
      tally(byRepository, repository ?? null, span.credits);
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
      if (session && span.agent) {
        session.agentName = span.agent;
      }
    } else if (span.operation === 'execute_tool') {
      if (session) {
        session.toolCalls++;
      }
      const name = span.tool ?? 'unknown';
      const values = digest.toolDurationsMs.get(name) ?? [];
      values.push(duration);
      digest.toolDurationsMs.set(name, values);
      if (span.failed !== undefined) {
        digest.toolStatusCalls++;
        digest.toolFailures += span.failed ? 1 : 0;
      }
    }
  }
  for (const [sessionId, context] of work) {
    const session = sessions.get(sessionId);
    if (session) {
      session.repository = context.repository;
      session.branch = context.branch;
    }
  }
  digest.byModel = [...byModel.values()];
  digest.byCaller = [...byCaller.values()];
  digest.byEffort = [...byEffort.values()];
  digest.byRepository = [...byRepository.values()];
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
