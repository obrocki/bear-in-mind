import { hrToMs, resourceAttributes } from './otelParse';
import { emptySpanDigest, type CallTally, type SpanDigest, type SpanSession } from './otelSummary';
import { TokenTally } from '../.github/extensions/ai-attribution/lib/tokenCoverage.cjs';

/** OTel span status codes. UNSET (0) means no status was reported, so it is unknown. */
const SPAN_STATUS_OK = 1;
const SPAN_STATUS_ERROR = 2;
/** Request-option blobs larger than this are skipped rather than parsed. */
const MAX_OPTIONS_CHARS = 64 * 1024;

/** Metadata only. Never retain prompts, tool arguments, events or response text. */
export interface UsageSpan {
  id: string;
  operation: string;
  sessionId?: string;
  nativeSessionId?: string;
  conversationId?: string;
  traceId?: string;
  parentSpanId?: string;
  parentKnown?: boolean;
  model: string | null;
  start: number;
  end: number;
  input?: number;
  output?: number;
  cached?: number;
  reasoning?: number;
  cacheWrite?: number;
  credits?: number;
  /** SDK nano_aiu is kept at its native grain, never aliased to VS Code per-call credits. */
  sdkCredits?: number;
  sdk?: boolean;
  ttft?: number;
  firstChunk?: number;
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
  /**
   * `user.name`: the signed-in GitHub account, emitted on agent invocation
   * spans only when Copilot's OTel identity capture is on (VS Code 1.140+).
   */
  user?: string;
  userSource?: 'span' | 'resource';
  /** Native SDK analytics pseudonym, not a GitHub login or a derived actor key. */
  actorId?: string;
  /** Span status ERROR; undefined when the source reported no status. */
  failed?: boolean;
}

export function nonnegative(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function tokenCount(value: unknown): number | undefined {
  const count = nonnegative(value);
  return count !== undefined && Number.isSafeInteger(count) ? count : undefined;
}

export interface SpanLinks {
  traceId?: string;
  parentSpanId?: string;
  parentKnown?: boolean;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined;
}

/** An account name: one short line, never a blob that could carry content. */
export function identityName(value: unknown): string | undefined {
  const name = typeof value === 'string' ? value.trim() : '';
  return name.length > 0 && name.length <= 128 && !/[\u0000-\u001f\u007f]/.test(name) ? name : undefined;
}

/**
 * `owner/name` for github.com, `host/path` elsewhere. Remote URLs can carry
 * credentials, so only the host and path of a parsed URL survive. Local
 * filesystem remotes (absolute, home-relative, Windows or `file:` paths) are
 * rejected so no local path reaches the dashboard.
 */
export function repositoryName(value: unknown): string | undefined {
  const raw = text(value)?.trim();
  if (!raw || /^(file:|[/\\~.]|[a-z]:)/i.test(raw) || raw.includes('\\')) {
    return undefined;
  }
  let name = raw.replace(/^git@([^:/]+):/, 'https://$1/').replace(/^ssh:\/\/(?:[^@/]+@)?/, 'https://');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(name)) {
    try {
      const url = new URL(name);
      if (!url.hostname) {
        return undefined;
      }
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
  // An unusable options blob is treated as absent, not as a reason to drop the
  // standard attribute.
  let options = attributes['copilot_chat.request.options'];
  if (typeof options === 'string') {
    try {
      options = options.length > MAX_OPTIONS_CHARS ? undefined : JSON.parse(options);
    } catch {
      options = undefined;
    }
  }
  const o = options && typeof options === 'object' ? (options as Record<string, unknown>) : {};
  const reasoning = o.reasoning && typeof o.reasoning === 'object' ? (o.reasoning as Record<string, unknown>) : {};
  for (const effort of [reasoning.effort, o.reasoning_effort, attributes['gen_ai.request.reasoning.level']]) {
    if (typeof effort === 'string' && /^[a-z][a-z_-]{0,23}$/i.test(effort)) {
      return effort.toLowerCase();
    }
  }
  return undefined;
}

/** OK is a success and ERROR a failure; UNSET and anything else are unknown. */
function spanFailed(status: unknown): boolean | undefined {
  const code = typeof status === 'string' && status.trim() !== '' ? Number(status) : status;
  if (code === SPAN_STATUS_OK) {
    return false;
  }
  return code === SPAN_STATUS_ERROR ? true : undefined;
}

export function usageSpan(
  id: unknown,
  attributes: Record<string, unknown>,
  start: number,
  end: number,
  status?: unknown,
  links: SpanLinks = {}
): UsageSpan | undefined {
  const key = text(id);
  const operation = text(attributes['gen_ai.operation.name']);
  if (!key || !operation || !Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end < start) {
    return undefined;
  }
  const nano = nonnegative(attributes['copilot_chat.copilot_usage_nano_aiu']);
  const sdkNano = nonnegative(attributes['github.copilot.nano_aiu']);
  const firstChunkSeconds = nonnegative(attributes['gen_ai.response.time_to_first_chunk']);
  return {
    id: key, operation, start, end,
    sessionId: text(attributes['copilot_chat.chat_session_id']) ?? text(attributes['gen_ai.conversation.id']),
    nativeSessionId: text(attributes['copilot_chat.chat_session_id']),
    conversationId: text(attributes['gen_ai.conversation.id']),
    traceId: text(links.traceId),
    parentSpanId: text(links.parentSpanId),
    parentKnown: links.parentKnown === true && (links.parentSpanId === undefined || text(links.parentSpanId) !== undefined),
    model: text(attributes['gen_ai.response.model']) ?? text(attributes['gen_ai.request.model']) ?? null,
    input: tokenCount(attributes['gen_ai.usage.input_tokens']),
    output: tokenCount(attributes['gen_ai.usage.output_tokens']),
    cached: tokenCount(attributes['gen_ai.usage.cache_read.input_tokens']),
    cacheWrite: tokenCount(attributes['gen_ai.usage.cache_creation.input_tokens']),
    reasoning: tokenCount(attributes['gen_ai.usage.reasoning.output_tokens']) ??
      tokenCount(attributes['gen_ai.usage.reasoning_tokens']),
    credits: nano === undefined ? undefined : nano / 1_000_000_000,
    sdkCredits: sdkNano === undefined ? undefined : sdkNano / 1_000_000_000,
    sdk: attributes['github.copilot.nano_aiu'] !== undefined || attributes['github.copilot.cost'] !== undefined,
    ttft: nonnegative(attributes['copilot_chat.time_to_first_token']),
    firstChunk: firstChunkSeconds === undefined ? undefined : nonnegative(firstChunkSeconds * 1000),
    turns: tokenCount(attributes['copilot_chat.turn_count']) ?? tokenCount(attributes['github.copilot.turn_count']),
    tool: text(attributes['gen_ai.tool.name']),
    promptLimit: nonnegative(attributes['copilot_chat.request.max_prompt_tokens']),
    auxiliary: !!attributes['copilot_chat.parent_chat_session_id'] || !!attributes['copilot_chat.debug_log_label'],
    agent: text(attributes['gen_ai.agent.name']),
    parentSessionId: text(attributes['copilot_chat.parent_chat_session_id']),
    effort: operation === 'chat' ? reasoningEffort(attributes) : undefined,
    repository: repositoryName(attributes['github.copilot.git.repository']) ??
      repositoryName(attributes['copilot_chat.repo.remote_url']),
    branch: text(attributes['github.copilot.git.branch']) ?? text(attributes['copilot_chat.repo.head_branch_name']),
    user: identityName(attributes['user.name']),
    actorId: identityName(attributes['enduser.pseudo.id']),
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
  // Identity can also be set explicitly as a resource attribute; the span's own value wins.
  const resourceUser = resourceAttributes(record)['user.name'];
  const attributes = r.attributes as Record<string, unknown>;
  const parentContext = r.parentSpanContext && typeof r.parentSpanContext === 'object'
    ? r.parentSpanContext as Record<string, unknown> : undefined;
  const rawParent = r.parentSpanId ?? parentContext?.spanId;
  const parentSpanId = text(rawParent);
  const span = usageSpan(
    r.spanId,
    resourceUser !== undefined && attributes['user.name'] === undefined ? { ...attributes, 'user.name': resourceUser } : attributes,
    hrToMs(r.startTime), hrToMs(r.endTime), status,
    {
      traceId: text(r.traceId), parentSpanId,
      parentKnown: (r.parentSpanContext == null || text(parentContext?.spanId) !== undefined) &&
        (r.parentSpanId == null || text(r.parentSpanId) !== undefined)
    }
  );
  if (span?.user) span.userSource = attributes['user.name'] === undefined && resourceUser !== undefined ? 'resource' : 'span';
  return span;
}

/** A database copy wins known values; absent optional metadata can still come from the same file span. */
export function mergeUsageSpan(file: UsageSpan | undefined, db: UsageSpan): UsageSpan {
  if (!file) return db;
  return {
    ...file, ...db,
    nativeSessionId: db.nativeSessionId ?? file.nativeSessionId,
    sessionId: db.nativeSessionId ?? file.nativeSessionId ?? db.sessionId ?? file.sessionId,
    input: db.input ?? file.input, output: db.output ?? file.output,
    cached: db.cached ?? file.cached, cacheWrite: db.cacheWrite ?? file.cacheWrite,
    reasoning: db.reasoning ?? file.reasoning, credits: db.credits ?? file.credits,
    sdkCredits: db.sdkCredits ?? file.sdkCredits, sdk: db.sdk || file.sdk,
    ttft: db.ttft ?? file.ttft, firstChunk: db.firstChunk ?? file.firstChunk,
    traceId: db.traceId ?? file.traceId, conversationId: db.conversationId ?? file.conversationId,
    parentKnown: db.parentKnown || file.parentKnown,
    parentSpanId: db.parentKnown ? db.parentSpanId : file.parentSpanId,
    actorId: db.actorId ?? file.actorId, user: db.user ?? file.user,
    userSource: db.user !== undefined ? db.userSource : file.userSource,
    repository: db.repository ?? file.repository, branch: db.branch ?? file.branch,
    effort: db.effort ?? file.effort, parentSessionId: db.parentSessionId ?? file.parentSessionId,
    auxiliary: db.auxiliary || file.auxiliary,
    promptLimit: db.promptLimit ?? file.promptLimit, turns: db.turns ?? file.turns,
    model: db.model ?? file.model, agent: db.agent ?? file.agent, tool: db.tool ?? file.tool,
    failed: db.failed ?? file.failed
  };
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

type ActorIdentity = { user?: string; actorId?: string; userSource?: 'span' | 'resource' };
type WorkContext = { repository?: string; branch?: string };
type Timeline<T> = Map<string, Array<T & { at: number; nativeSessionId?: string }>>;
type ContextIndexes<T> = { session: Timeline<T>; conversation: Timeline<T>; trace: Timeline<T> };

function indexes<T>(): ContextIndexes<T> {
  return { session: new Map(), conversation: new Map(), trace: new Map() };
}

function remember<T>(maps: ContextIndexes<T>, span: UsageSpan, context: T): void {
  const keys: Array<[Timeline<T>, string | undefined]> = [
    [maps.session, span.sessionId], [maps.conversation, span.conversationId], [maps.trace, span.traceId]
  ];
  for (const [map, key] of keys) {
    if (!key) continue;
    const entries = map.get(key) ?? [];
    entries.push({ ...context, at: span.start, nativeSessionId: span.nativeSessionId });
    map.set(key, entries);
  }
}

function sortContexts<T>(maps: ContextIndexes<T>): void {
  for (const map of Object.values(maps)) {
    for (const entries of map.values()) entries.sort((a, b) => a.at - b.at);
  }
}

function contextAt<T>(maps: ContextIndexes<T>, span: UsageSpan): T | undefined {
  const keys: Array<[Timeline<T>, string | undefined, boolean]> = [
    [maps.session, span.sessionId, false], [maps.conversation, span.conversationId, true],
    [maps.session, span.parentSessionId, false], [maps.trace, span.traceId, true]
  ];
  for (const [map, key, fallback] of keys) {
    if (!key) continue;
    let match: T | undefined;
    for (const entry of map.get(key) ?? []) {
      if (entry.at > span.start) break;
      if (fallback && span.nativeSessionId && entry.nativeSessionId &&
        entry.nativeSessionId !== span.nativeSessionId && entry.nativeSessionId !== span.parentSessionId) continue;
      match = entry;
    }
    if (match) return match;
  }
  return undefined;
}

function distinctActorUsers(entries: ActorIdentity[]): string[] {
  const seen = new Set<string>();
  const users: string[] = [];
  for (const entry of entries) {
    if (entry.user && !seen.has(entry.user)) {
      seen.add(entry.user);
      users.push(entry.user);
    }
  }
  return users;
}

function sdkRoot(span: UsageSpan, spans: Map<string, UsageSpan>): 'root' | 'nested' | 'unknown' {
  if (!span.parentKnown) return 'unknown';
  const seen = new Set([span.id]);
  let nested = false;
  let parentId = span.parentSpanId;
  while (parentId) {
    if (seen.has(parentId)) return 'unknown';
    seen.add(parentId);
    const parent = spans.get(parentId);
    if (!parent || (span.traceId && parent.traceId && span.traceId !== parent.traceId)) return 'unknown';
    if (parent.operation === 'invoke_agent') nested = true;
    if (!parent.parentKnown) return 'unknown';
    parentId = parent.parentSpanId;
  }
  return nested ? 'nested' : 'root';
}

function sessionActorLabel(users: string[]): string | undefined {
  if (users.length === 0) {
    return undefined;
  }
  if (users.length <= 3) {
    return users.join(', ');
  }
  return `${users.slice(0, 3).join(', ')}, +${users.length - 3} more`;
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
  const work = indexes<WorkContext>();
  const actors = indexes<ActorIdentity>();
  const byId = new Map(unique.map((span) => [span.id, span]));
  const tokens = new TokenTally();
  for (const span of unique) {
    if (span.operation === 'invoke_agent' && (span.repository || span.branch)) {
      remember(work, span, { repository: span.repository, branch: span.branch });
    }
    if (span.operation === 'invoke_agent' && (span.user || span.actorId)) {
      remember(actors, span, { user: span.user, actorId: span.actorId, userSource: span.userSource });
    }
  }
  sortContexts(work);
  sortContexts(actors);
  const byModel = new Map<string | null, CallTally>();
  const byCaller = new Map<string | null, CallTally>();
  const byEffort = new Map<string | null, CallTally>();
  const byRepository = new Map<string | null, CallTally>();
  const byUser = new Map<string | null, CallTally>();
  const byActorId = new Map<string | null, CallTally>();

  for (const span of unique) {
    digest.available = true;
    if (span.sdk) {
      digest.sdkCredits.available = true;
      if (span.operation === 'chat') digest.sdkCredits.modelCalls++;
      if (span.operation === 'invoke_agent') {
        const root = sdkRoot(span, byId);
        if (root === 'unknown') digest.sdkCredits.unclassifiedInvocations++;
        if (root === 'root') {
          digest.sdkCredits.invocations++;
          if (span.sdkCredits !== undefined) {
            digest.sdkCredits.reportedInvocations++;
            digest.sdkCredits.credits += span.sdkCredits;
          }
        }
      }
    }
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
      digest.cacheWriteTokens += span.cacheWrite ?? 0;
      tokens.add({
        inputTokens: span.input, outputTokens: span.output, cacheReadTokens: span.cached,
        cacheWriteTokens: span.cacheWrite, reasoningTokens: span.reasoning
      });
      digest.chatCalls++;
      if (span.credits !== undefined) {
        digest.creditCalls++;
        digest.credits += span.credits;
      }
      if (!span.sessionId) {
        digest.sessionlessCalls++;
        if (span.credits !== undefined) {
          digest.sessionlessCreditCalls++;
          digest.sessionlessCredits += span.credits;
        }
      }
      const repository = contextAt(work, span)?.repository;
      const actor = contextAt(actors, span);
      const user = span.user ?? actor?.user;
      const userSource = span.user ? span.userSource : actor?.userSource;
      if (user && userSource === 'resource') digest.configuredUserCalls++;
      const actorId = span.actorId ?? actor?.actorId;
      tally(byModel, span.model, span.credits);
      tally(byCaller, span.agent ?? null, span.credits);
      tally(byEffort, span.effort ?? null, span.credits);
      tally(byRepository, repository ?? null, span.credits);
      tally(byUser, user ?? null, span.credits);
      tally(byActorId, actorId ?? null, span.credits);
      if (span.ttft !== undefined) {
        digest.ttftMs.push(span.ttft);
      }
      if (span.firstChunk !== undefined) digest.firstChunkMs.push(span.firstChunk);
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
  for (const [sessionId, timeline] of work.session) {
    const context = timeline[timeline.length - 1];
    const session = sessions.get(sessionId);
    if (session) {
      session.repository = context.repository;
      session.branch = context.branch;
    }
  }
  for (const [sessionId, timeline] of actors.session) {
    const session = sessions.get(sessionId);
    if (session) {
      const users = distinctActorUsers(timeline);
      session.users = users;
      session.user = sessionActorLabel(users);
    }
  }
  digest.byModel = [...byModel.values()];
  digest.byCaller = [...byCaller.values()];
  digest.byEffort = [...byEffort.values()];
  digest.byRepository = [...byRepository.values()];
  digest.byUser = [...byUser.values()];
  digest.byActorId = [...byActorId.values()];
  digest.tokenCoverage = tokens.coverage(digest.chatCalls);
  digest.cacheReadRatio = tokens.cacheReadRatio() ?? undefined;
  digest.cacheReadRatioCoverage = tokens.ratioCoverage(digest.chatCalls);
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
