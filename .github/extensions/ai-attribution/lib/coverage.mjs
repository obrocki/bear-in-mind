// Read-only attribution coverage over local Copilot stores.
//
// Sources:
//   - Copilot CLI / GitHub Copilot app session store ($COPILOT_HOME/session-store.db)
//   - VS Code Copilot Chat span store (globalStorage/github.copilot-chat/agent-traces.db)
//
// Only aggregates leave this module: counts, token and credit sums, model,
// agent and repository names. Prompt, response and tool content are never read.
// Databases are opened read-only; if that fails (locked, mid-recovery) a
// temporary copy is read instead and deleted afterwards.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NANO_AIU_PER_CREDIT = 1_000_000_000;
const DAY_MS = 86_400_000;
const TOP_N = 8;
/** OTel status codes. UNSET (0) means no status was reported, so it is unknown. */
const SPAN_STATUS_OK = 1;
const SPAN_STATUS_ERROR = 2;
/** Request-option blobs larger than this are skipped rather than parsed. */
const MAX_OPTIONS_CHARS = 64 * 1024;

/** Keep only a short effort word; anything else is dropped as possible content. */
export function effortWord(value) {
  return typeof value === 'string' && /^[a-z][a-z_-]{0,23}$/i.test(value) ? value.toLowerCase() : null;
}

let sqliteModule;

export async function loadSqlite() {
  if (sqliteModule === undefined) {
    try {
      sqliteModule = await import('node:sqlite');
    } catch {
      sqliteModule = null;
    }
  }
  return sqliteModule;
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------ paths ---

export function copilotHome({ env = process.env, home = os.homedir() } = {}) {
  const configured = (env.COPILOT_HOME || '').trim();
  return configured || path.join(home, '.copilot');
}

export function defaultSessionStorePath(options = {}) {
  return path.join(copilotHome(options), 'session-store.db');
}

export function vscodeGlobalStorageDirs({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  let base;
  if (platform === 'win32') base = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  else if (platform === 'darwin') base = path.join(home, 'Library', 'Application Support');
  else base = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return ['Code', 'Code - Insiders'].map((product) => path.join(base, product, 'User', 'globalStorage'));
}

/** Mirrors Bear in Mind's discovery (src/otelWatcher.ts); prefers the most recently written store. */
export function findTracesDb(globalStorageDirs) {
  const found = [];
  for (const globalStorage of globalStorageDirs) {
    const chatDir = path.join(globalStorage, 'github.copilot-chat');
    const candidates = [
      path.join(chatDir, 'agent-traces.db'),
      path.join(chatDir, 'otel', 'agent-traces.db'),
      path.join(globalStorage, 'agent-traces.db'),
    ];
    let entries = [];
    try {
      entries = fs.readdirSync(chatDir, { withFileTypes: true });
    } catch {
      /* no Copilot Chat storage for this product */
    }
    for (const entry of entries) {
      if (entry.isDirectory()) candidates.push(path.join(chatDir, entry.name, 'agent-traces.db'));
    }
    for (const candidate of candidates) {
      if (isFile(candidate) && !found.includes(candidate)) found.push(candidate);
    }
  }
  found.sort((a, b) => mtime(b) - mtime(a));
  return found[0];
}

// ---------------------------------------------------------------- helpers ---

/**
 * owner/name for github.com, host/path otherwise. Remote URLs can carry
 * credentials, so only the host and path of a parsed URL survive. Unparsed
 * values containing `@`, and local filesystem remotes (absolute, home-relative,
 * Windows or `file:` paths), are rejected rather than shown.
 */
export function normalizeRepository(value) {
  if (value === null || value === undefined) return null;
  let v = String(value).trim();
  if (!v) return null;
  if (/^(file:|[/\\~.]|[a-z]:)/i.test(v) || v.includes('\\')) return null;
  v = v.replace(/^git@([^:/]+):/, 'https://$1/').replace(/^ssh:\/\/(?:[^@/]+@)?/, 'https://');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    try {
      const url = new URL(v);
      if (!url.hostname) return null;
      const pathname = url.pathname.replace(/^\/+/, '');
      v = url.hostname.toLowerCase() === 'github.com' ? pathname : `${url.hostname}/${pathname}`;
    } catch {
      return null;
    }
  } else if (v.includes('@')) {
    return null;
  }
  v = v.replace(/\.git$/i, '').replace(/\/+$/, '');
  return v || null;
}

function num(value) {
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** A reported nano-AIU value, or null when it is missing, non-numeric or negative (unknown, not zero). */
export function nanoAiu(value) {
  if (typeof value === 'bigint') value = Number(value);
  if (typeof value === 'string') value = value.trim() === '' ? NaN : Number(value);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function present(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

/** An account name: one short line, never a blob that could carry content. */
export function identityName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length > 0 && name.length <= 128 && !/[\u0000-\u001f\u007f]/.test(name) ? name : null;
}

function share(part, whole) {
  return whole > 0 ? part / whole : null;
}

function credits(nano) {
  return nano / NANO_AIU_PER_CREDIT;
}

class Tally {
  constructor() {
    this.map = new Map();
  }
  add(key, calls, nano) {
    const k = present(key) ? String(key) : '(none)';
    const entry = this.map.get(k) ?? { key: k, calls: 0, nano: 0 };
    entry.calls += calls;
    entry.nano += nano;
    this.map.set(k, entry);
  }
  top(limit = TOP_N) {
    const rows = [...this.map.values()].sort((a, b) => b.nano - a.nano || b.calls - a.calls);
    const head = rows.slice(0, limit);
    const rest = rows.slice(limit);
    if (rest.length) {
      head.push({
        key: `${rest.length} more`,
        calls: rest.reduce((s, r) => s + r.calls, 0),
        nano: rest.reduce((s, r) => s + r.nano, 0),
      });
    }
    return head.map((r) => ({ key: r.key, calls: r.calls, credits: credits(r.nano) }));
  }
}

function tableColumns(db, table) {
  // `table` is always a literal from this module.
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((r) => r.name),
  );
}

function tableNames(db) {
  return new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name),
  );
}

function selectList(columns, wanted) {
  return wanted.map((name) => (columns.has(name) ? name : `NULL AS ${name}`)).join(', ');
}

function stage(id, label, acc, emitted = true) {
  return { id, label, emitted, sessions: acc.sessions.size, calls: acc.calls, credits: credits(acc.nano) };
}

function newAcc() {
  return { sessions: new Set(), calls: 0, nano: 0 };
}

function addTo(acc, sessionKey, nano) {
  if (sessionKey) acc.sessions.add(sessionKey);
  acc.calls += 1;
  acc.nano += nano;
}

// ------------------------------------------------------- session store ---

/**
 * Milliseconds for a session-store timestamp: ISO 8601, or SQLite's
 * `YYYY-MM-DD HH:MM:SS` (UTC). Date-only values are reported separately.
 */
export function timestampMs(value) {
  if (!present(value)) return { ms: null, dateOnly: false };
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return { ms: null, dateOnly: true, day: text };
  let iso = text.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T');
  if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(iso)) iso += 'Z';
  const ms = Date.parse(iso);
  return { ms: Number.isFinite(ms) ? ms : null, dateOnly: false };
}

/**
 * Rolling-window policy: exact timestamps count from `sinceMs`; a date-only
 * value counts only when its whole day lies after the cutoff day; values
 * that cannot be read are left out.
 */
function withinWindow(value, sinceMs, sinceDay) {
  const t = timestampMs(value);
  if (t.ms !== null) return t.ms >= sinceMs;
  return t.dateOnly && t.day > sinceDay;
}

/** Coverage for the Copilot CLI / GitHub Copilot app session store. */
export function sessionStoreCoverage(db, { sinceDay = null, sinceMs = 0 } = {}) {
  const tables = tableNames(db);
  if (!tables.has('assistant_usage_events')) {
    return {
      status: 'schema',
      reason: 'Table assistant_usage_events not found; the session store schema may have changed.',
    };
  }
  const usageCols = tableColumns(db, 'assistant_usage_events');
  const windowed = Boolean(sinceDay) && usageCols.has('created_at');
  // A day early, so timestamps with a negative UTC offset survive the textual
  // prefilter; the exact rolling cutoff is applied after parsing.
  const prefilterDay = windowed ? new Date(sinceMs - 86_400_000).toISOString().slice(0, 10) : null;
  const usageRows = db
    .prepare(
      `SELECT ${selectList(usageCols, [
        'session_id',
        'model',
        'initiator',
        'agent_id',
        'reasoning_effort',
        'input_tokens',
        'output_tokens',
        'cache_read_tokens',
        'cache_write_tokens',
        'reasoning_tokens',
        'total_nano_aiu',
        'created_at',
      ])} FROM assistant_usage_events${windowed ? ' WHERE substr(created_at, 1, 10) >= ?' : ''}`,
    )
    .all(...(windowed ? [prefilterDay] : []))
    .filter((row) => !windowed || withinWindow(row.created_at, sinceMs, sinceDay));

  const sessions = new Map();
  if (tables.has('sessions')) {
    const cols = tableColumns(db, 'sessions');
    for (const row of db
      .prepare(`SELECT ${selectList(cols, ['id', 'repository', 'branch', 'updated_at'])} FROM sessions`)
      .all()) {
      sessions.set(String(row.id), row);
    }
  }

  // Optional: a missing or incompatible refs table means work references are
  // unavailable, not that the whole source failed.
  const refs = new Map();
  const refCols = tables.has('session_refs') ? tableColumns(db, 'session_refs') : new Set();
  const refsAvailable = refCols.has('session_id') && refCols.has('ref_type');
  if (refsAvailable) {
    for (const row of db.prepare('SELECT session_id, ref_type FROM session_refs GROUP BY session_id, ref_type').all()) {
      const set = refs.get(String(row.session_id)) ?? new Set();
      set.add(String(row.ref_type));
      refs.set(String(row.session_id), set);
    }
  }

  const totals = {
    calls: 0,
    creditedCalls: 0,
    nano: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
  const stages = {
    observed: newAcc(),
    session: newAcc(),
    repository: newAcc(),
    branch: newAcc(),
    workRef: newAcc(),
    pullRequest: newAcc(),
  };
  const byModel = new Tally();
  const byInitiator = new Tally();
  const byEffort = new Tally();
  const byRepository = new Tally();
  const byDay = new Map();
  let subAgentNano = 0;
  let first = null;
  let last = null;

  for (const row of usageRows) {
    const sessionId = present(row.session_id) ? String(row.session_id) : null;
    const reportedNano = nanoAiu(row.total_nano_aiu);
    const hasCredit = reportedNano !== null;
    const nano = reportedNano ?? 0;
    totals.calls += 1;
    totals.creditedCalls += hasCredit ? 1 : 0;
    totals.nano += nano;
    totals.inputTokens += num(row.input_tokens);
    totals.outputTokens += num(row.output_tokens);
    totals.cacheReadTokens += num(row.cache_read_tokens);
    totals.cacheWriteTokens += num(row.cache_write_tokens);
    totals.reasoningTokens += num(row.reasoning_tokens);
    if (row.initiator === 'sub-agent' || present(row.agent_id)) subAgentNano += nano;

    const session = sessionId ? sessions.get(sessionId) : undefined;
    const repository = normalizeRepository(session?.repository);
    const sessionRefs = (sessionId && refs.get(sessionId)) || new Set();

    addTo(stages.observed, sessionId, nano);
    // The event's own session ID establishes the stage; the optional sessions
    // table only adds repository and branch.
    if (sessionId) {
      addTo(stages.session, sessionId, nano);
      if (session && repository) {
        addTo(stages.repository, sessionId, nano);
        if (present(session.branch)) {
          addTo(stages.branch, sessionId, nano);
          if (sessionRefs.size > 0) {
            addTo(stages.workRef, sessionId, nano);
            if (sessionRefs.has('pr')) addTo(stages.pullRequest, sessionId, nano);
          }
        }
      }
    }

    byModel.add(row.model, 1, nano);
    byInitiator.add(row.initiator, 1, nano);
    byEffort.add(effortWord(row.reasoning_effort), 1, nano);
    byRepository.add(repository, 1, nano);

    // Bucket by normalized UTC instant, not raw text; unreadable values are skipped.
    const t = timestampMs(row.created_at);
    const iso = t.ms !== null ? new Date(t.ms).toISOString() : t.dateOnly ? `${t.day}T00:00:00.000Z` : null;
    if (iso) {
      const day = iso.slice(0, 10);
      const d = byDay.get(day) ?? { day, calls: 0, nano: 0 };
      d.calls += 1;
      d.nano += nano;
      byDay.set(day, d);
      if (!first || iso < first) first = iso;
      if (!last || iso > last) last = iso;
    }
  }

  const funnel = [
    stage('observed', 'Model calls observed', stages.observed),
    stage('session', 'With a session ID', stages.session),
    stage('repository', '…with a repository', stages.repository),
    stage('branch', '…and a branch', stages.branch),
    stage('workRef', '…and a work reference (PR, issue or commit)', stages.workRef, refsAvailable),
    stage('pullRequest', '…and a recorded PR reference', stages.pullRequest, refsAvailable),
  ];

  return {
    status: 'ok',
    totals: {
      sessions: stages.observed.sessions.size,
      calls: totals.calls,
      creditedCalls: totals.creditedCalls,
      credits: credits(totals.nano),
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      reasoningTokens: totals.reasoningTokens,
    },
    funnel,
    metrics: {
      creditCoverage: share(totals.creditedCalls, totals.calls),
      creditsToRepoShare: share(stages.repository.nano, totals.nano),
      creditsToPrShare: refsAvailable ? share(stages.pullRequest.nano, totals.nano) : null,
      creditsToActorShare: null,
      cacheReadRatio: share(totals.cacheReadTokens, totals.inputTokens),
      subAgentShare: share(subAgentNano, totals.nano),
    },
    breakdowns: {
      model: byModel.top(),
      initiator: byInitiator.top(),
      reasoningEffort: byEffort.top(),
      repository: byRepository.top(),
    },
    daily: [...byDay.values()]
      .sort((a, b) => (a.day < b.day ? -1 : 1))
      .map((d) => ({ day: d.day, calls: d.calls, credits: credits(d.nano) })),
    freshness: { first, last },
    notes: [
      !refsAvailable
        ? 'session_refs is missing or lacks session_id / ref_type, so work references are unavailable in this store.'
        : refs.size === 0
          ? 'session_refs is empty: no session has a recorded PR, issue or commit reference, so work-item attribution needs a VCS join.'
          : null,
      windowed || !sinceDay ? null : 'created_at is missing, so the window could not be applied.',
      windowed ? 'Rows with only a date count when their whole day falls inside the window.' : null,
      'No user identity is stored per session, so credits cannot be attributed to an actor from this store.',
    ].filter(Boolean),
  };
}

// ------------------------------------------------------------ VS Code ---

const GIT_KEYS = {
  repository: ['github.copilot.git.repository', 'copilot_chat.repo.remote_url'],
  branch: ['github.copilot.git.branch', 'copilot_chat.repo.head_branch_name'],
  commit: ['github.copilot.git.commit_sha', 'copilot_chat.repo.head_commit_hash'],
};
/** The signed-in GitHub account on agent invocation spans, when Copilot's identity capture is on (VS Code 1.140+). */
const IDENTITY_KEY = 'user.name';
const CHAT_KEYS = [
  'copilot_chat.copilot_usage_nano_aiu',
  'copilot_chat.request.options',
  'copilot_chat.parent_chat_session_id',
  IDENTITY_KEY,
];

/** The newest agent context for a chat span: its chat session, conversation, parent session, then trace. */
function agentLink(maps, chat, parent) {
  if (present(chat.chat_session_id) && maps.session.has(String(chat.chat_session_id))) {
    return { ctx: maps.session.get(String(chat.chat_session_id)), link: 'chat session' };
  }
  if (present(chat.conversation_id) && maps.conversation.has(String(chat.conversation_id))) {
    return { ctx: maps.conversation.get(String(chat.conversation_id)), link: 'conversation' };
  }
  if (present(parent) && maps.session.has(String(parent))) {
    return { ctx: maps.session.get(String(parent)), link: 'parent session' };
  }
  if (present(chat.trace_id) && maps.trace.has(String(chat.trace_id))) {
    return { ctx: maps.trace.get(String(chat.trace_id)), link: 'trace' };
  }
  return { ctx: null, link: 'none' };
}

function identityAt(entries, at) {
  if (!entries?.length) return null;
  let match = entries[0];
  for (const entry of entries) {
    if (entry.at <= at) match = entry;
    else break;
  }
  return match;
}

function agentIdentityLink(maps, chat, parent, at) {
  if (present(chat.chat_session_id)) {
    const ctx = identityAt(maps.session.get(String(chat.chat_session_id)), at);
    if (ctx) return ctx;
  }
  if (present(chat.conversation_id)) {
    const ctx = identityAt(maps.conversation.get(String(chat.conversation_id)), at);
    if (ctx) return ctx;
  }
  if (present(parent)) {
    const ctx = identityAt(maps.session.get(String(parent)), at);
    if (ctx) return ctx;
  }
  if (present(chat.trace_id)) {
    const ctx = identityAt(maps.trace.get(String(chat.trace_id)), at);
    if (ctx) return ctx;
  }
  return null;
}

export function reasoningEffortFromOptions(raw) {
  if (!present(raw) || String(raw).length > MAX_OPTIONS_CHARS) return null;
  try {
    const options = JSON.parse(String(raw));
    return effortWord(options?.reasoning?.effort ?? options?.reasoning_effort);
  } catch {
    return null;
  }
}

/** Coverage for VS Code's agent-traces.db. */
export function tracesCoverage(db, { sinceMs = 0 } = {}) {
  const tables = tableNames(db);
  if (!tables.has('spans')) {
    return { status: 'schema', reason: 'Table spans not found; the trace store schema may have changed.' };
  }
  const cols = tableColumns(db, 'spans');
  for (const required of ['span_id', 'operation_name', 'start_time_ms']) {
    if (!cols.has(required)) return { status: 'schema', reason: `Column spans.${required} not found.` };
  }
  const hasAttributes = tables.has('span_attributes');

  const chats = db
    .prepare(
      `SELECT ${selectList(cols, [
        'span_id',
        'trace_id',
        'conversation_id',
        'chat_session_id',
        'agent_name',
        'request_model',
        'response_model',
        'input_tokens',
        'output_tokens',
        'cached_tokens',
        'reasoning_tokens',
        'start_time_ms',
      ])} FROM spans WHERE operation_name = 'chat' AND start_time_ms >= ?`,
    )
    .all(sinceMs);

  const chatAttributes = new Map();
  const agentContext = { session: new Map(), conversation: new Map(), trace: new Map() };
  // Tracked apart from git context, so an identity-only agent span never changes how repository is linked.
  const agentIdentity = { session: new Map(), conversation: new Map(), trace: new Map() };
  if (hasAttributes) {
    const placeholders = CHAT_KEYS.map(() => '?').join(', ');
    for (const row of db
      .prepare(
        `SELECT a.span_id, a.key, a.value FROM span_attributes a JOIN spans s ON s.span_id = a.span_id
                 WHERE s.operation_name = 'chat' AND s.start_time_ms >= ? AND a.key IN (${placeholders})`,
      )
      .all(sinceMs, ...CHAT_KEYS)) {
      const attrs = chatAttributes.get(String(row.span_id)) ?? {};
      attrs[row.key] = row.value;
      chatAttributes.set(String(row.span_id), attrs);
    }

    const agentKeys = [...Object.values(GIT_KEYS).flat(), IDENTITY_KEY];
    const agentCols = selectList(cols, ['span_id', 'trace_id', 'conversation_id', 'chat_session_id', 'start_time_ms'])
      .split(', ')
      .map((c) => (c.startsWith('NULL') ? c : `s.${c}`))
      .join(', ');
    // Collect every git value first: SQL row order is unspecified, and the
    // canonical key must win over its legacy fallback.
    const agents = new Map();
    for (const row of db
      .prepare(
        `SELECT ${agentCols}, a.key, a.value FROM spans s
                 LEFT JOIN span_attributes a ON a.span_id = s.span_id AND a.key IN (${agentKeys.map(() => '?').join(', ')})
                 WHERE s.operation_name = 'invoke_agent'`,
      )
      .all(...agentKeys)) {
      const agent = agents.get(String(row.span_id)) ?? { row, values: {} };
      if (present(row.key) && present(row.value)) agent.values[row.key] = String(row.value);
      agents.set(String(row.span_id), agent);
    }
    // The newest agent span per session, conversation or trace supplies git context.
    const remember = (map, key, ctx, at) => {
      if (!present(key)) return;
      const known = map.get(String(key));
      if (!known || known.at <= at) map.set(String(key), { ...ctx, at });
    };
    const rememberTimed = (map, key, ctx, at) => {
      if (!present(key)) return;
      const k = String(key);
      const entries = map.get(k) ?? [];
      entries.push({ ...ctx, at });
      map.set(k, entries);
    };
    const rememberAll = (maps, row, ctx, at) => {
      remember(maps.session, row.chat_session_id, ctx, at);
      remember(maps.conversation, row.conversation_id, ctx, at);
      remember(maps.trace, row.trace_id, ctx, at);
    };
    const rememberAllTimed = (maps, row, ctx, at) => {
      rememberTimed(maps.session, row.chat_session_id, ctx, at);
      rememberTimed(maps.conversation, row.conversation_id, ctx, at);
      rememberTimed(maps.trace, row.trace_id, ctx, at);
    };
    for (const agent of agents.values()) {
      const pick = (keys) => keys.map((key) => agent.values[key]).find(present) ?? null;
      const at = num(agent.row.start_time_ms);
      const user = identityName(agent.values[IDENTITY_KEY]);
      if (user) rememberAllTimed(agentIdentity, agent.row, { user }, at);
      const ctx = {
        repository: normalizeRepository(pick(GIT_KEYS.repository)),
        branch: pick(GIT_KEYS.branch),
        commit: pick(GIT_KEYS.commit),
      };
      if (!ctx.repository && !ctx.branch && !ctx.commit) continue;
      rememberAll(agentContext, agent.row, ctx, at);
    }
    for (const map of Object.values(agentIdentity)) {
      for (const entries of map.values()) entries.sort((a, b) => a.at - b.at);
    }
  }

  const totals = {
    calls: 0,
    creditedCalls: 0,
    nano: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
  };
  const stages = {
    observed: newAcc(),
    session: newAcc(),
    repository: newAcc(),
    branch: newAcc(),
    workRef: newAcc(),
    pullRequest: newAcc(),
  };
  const byModel = new Tally();
  const byAgent = new Tally();
  const byEffort = new Tally();
  const byRepository = new Tally();
  const byLink = new Tally();
  const byUser = new Tally();
  const actor = newAcc();
  const byDay = new Map();
  let first = null;
  let last = null;

  for (const chat of chats) {
    const attrs = chatAttributes.get(String(chat.span_id)) ?? {};
    const reportedNano = nanoAiu(attrs['copilot_chat.copilot_usage_nano_aiu']);
    const hasCredit = reportedNano !== null;
    const nano = reportedNano ?? 0;
    totals.calls += 1;
    totals.creditedCalls += hasCredit ? 1 : 0;
    totals.nano += nano;
    totals.inputTokens += num(chat.input_tokens);
    totals.outputTokens += num(chat.output_tokens);
    totals.cacheReadTokens += num(chat.cached_tokens);
    totals.reasoningTokens += num(chat.reasoning_tokens);

    const sessionKey = present(chat.chat_session_id)
      ? String(chat.chat_session_id)
      : present(chat.conversation_id)
        ? String(chat.conversation_id)
        : null;
    const parent = attrs['copilot_chat.parent_chat_session_id'];
    const { ctx, link } = agentLink(agentContext, chat, parent);
    const user = identityName(attrs[IDENTITY_KEY]) ?? agentIdentityLink(agentIdentity, chat, parent, num(chat.start_time_ms))?.user ?? null;

    const stageKey = sessionKey ?? (present(parent) ? String(parent) : null);
    // Every stage, including "observed", counts sessions by the same key so
    // session counts stay monotonic down the funnel.
    addTo(stages.observed, stageKey, nano);
    if (stageKey) {
      addTo(stages.session, stageKey, nano);
      if (ctx?.repository) {
        addTo(stages.repository, stageKey, nano);
        if (ctx.branch || ctx.commit) addTo(stages.branch, stageKey, nano);
      }
    }

    byModel.add(chat.response_model || chat.request_model, 1, nano);
    byAgent.add(chat.agent_name, 1, nano);
    byEffort.add(reasoningEffortFromOptions(attrs['copilot_chat.request.options']), 1, nano);
    byRepository.add(ctx?.repository, 1, nano);
    byLink.add(link, 1, nano);
    byUser.add(user, 1, nano);
    if (user) addTo(actor, stageKey, nano);

    const start = num(chat.start_time_ms);
    if (start > 0) {
      const iso = new Date(start).toISOString();
      const day = iso.slice(0, 10);
      const d = byDay.get(day) ?? { day, calls: 0, nano: 0 };
      d.calls += 1;
      d.nano += nano;
      byDay.set(day, d);
      if (!first || iso < first) first = iso;
      if (!last || iso > last) last = iso;
    }
  }

  const tools = db
    .prepare(
      `SELECT ${cols.has('tool_name') ? 'tool_name' : 'NULL AS tool_name'}, ${cols.has('status_code') ? 'status_code' : 'NULL AS status_code'}
             FROM spans WHERE operation_name = 'execute_tool' AND start_time_ms >= ?`,
    )
    .all(sinceMs);
  // Only spans with a reported status count toward failures; older stores
  // without `status_code` leave the failure count unknown, not zero.
  const toolTally = new Map();
  for (const tool of tools) {
    const key = present(tool.tool_name) ? String(tool.tool_name) : '(none)';
    const t = toolTally.get(key) ?? { key, calls: 0, statusCalls: 0, failed: 0 };
    t.calls += 1;
    const status = present(tool.status_code) ? Number(tool.status_code) : NaN;
    if (status === SPAN_STATUS_OK || status === SPAN_STATUS_ERROR) {
      t.statusCalls += 1;
      t.failed += status === SPAN_STATUS_ERROR ? 1 : 0;
    }
    toolTally.set(key, t);
  }

  const funnel = [
    stage('observed', 'Model calls (chat spans) observed', stages.observed),
    stage('session', 'With a session, conversation or parent-session ID', stages.session),
    stage('repository', '…resolved to a repository via invoke_agent', stages.repository),
    stage('branch', '…and a branch or commit', stages.branch),
    stage('workRef', '…and a work reference', stages.workRef, false),
    stage('pullRequest', '…and a recorded PR reference', stages.pullRequest, false),
  ];

  return {
    status: 'ok',
    totals: {
      sessions: stages.observed.sessions.size,
      calls: totals.calls,
      creditedCalls: totals.creditedCalls,
      credits: credits(totals.nano),
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: null,
      reasoningTokens: totals.reasoningTokens,
    },
    funnel,
    metrics: {
      creditCoverage: share(totals.creditedCalls, totals.calls),
      creditsToRepoShare: share(stages.repository.nano, totals.nano),
      creditsToPrShare: null,
      creditsToActorShare: share(actor.nano, totals.nano),
      cacheReadRatio: share(totals.cacheReadTokens, totals.inputTokens),
      subAgentShare: null,
    },
    breakdowns: {
      model: byModel.top(),
      agent: byAgent.top(),
      reasoningEffort: byEffort.top(),
      repository: byRepository.top(),
      user: byUser.top(),
      link: byLink.top(),
    },
    tools: [...toolTally.values()].sort((a, b) => b.calls - a.calls).slice(0, TOP_N),
    daily: [...byDay.values()]
      .sort((a, b) => (a.day < b.day ? -1 : 1))
      .map((d) => ({ day: d.day, calls: d.calls, credits: credits(d.nano) })),
    freshness: { first, last },
    notes: [
      'VS Code emits no pull request or issue ID; the last two stages need a VCS join.',
      'Copilot Chat prunes this store to recent history (about seven days).',
      hasAttributes ? null : 'span_attributes not found: credits and repository context are unavailable.',
      hasAttributes && actor.calls === 0
        ? 'No user.name on agent spans: turn on github.copilot.chat.otel.captureIdentity (VS Code 1.140+, Local harness) to attribute calls to a GitHub account.'
        : null,
      actor.calls > 0
        ? 'User comes from user.name on agent spans in the same session, conversation, parent session or trace. process.user.name and host.name are resource attributes and are not stored in this database.'
        : null,
    ].filter(Boolean),
  };
}

// ----------------------------------------------------------- entry point ---

async function readDatabase(file, read) {
  if (!file) return { status: 'missing', reason: 'No store found.' };
  if (!isFile(file)) return { status: 'missing', reason: `Not found: ${file}` };
  const sqlite = await loadSqlite();
  if (!sqlite) return { status: 'unavailable', reason: 'node:sqlite is not available in this runtime.' };

  let db;
  let snapshotDir;
  try {
    try {
      db = new sqlite.DatabaseSync(file, { readOnly: true });
      db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
    } catch {
      try {
        db?.close();
      } catch {
        /* not open */
      }
      snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-attribution-'));
      const copy = path.join(snapshotDir, 'snapshot.db');
      for (const suffix of ['', '-wal', '-shm']) {
        if (isFile(file + suffix)) fs.copyFileSync(file + suffix, copy + suffix);
      }
      db = new sqlite.DatabaseSync(copy, { readOnly: true });
    }
    return read(db);
  } catch (err) {
    return { status: 'error', reason: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    if (snapshotDir) fs.rmSync(snapshotDir, { recursive: true, force: true });
  }
}

/**
 * @param {{ windowDays?: number, sessionStorePath?: string, tracesDbPath?: string, now?: number,
 *           env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string }} options
 */
export async function computeCoverage(options = {}) {
  const {
    windowDays = 30,
    now = Date.now(),
    env = process.env,
    platform = process.platform,
    home = os.homedir(),
  } = options;
  const days = Number.isFinite(windowDays) && windowDays > 0 ? Math.floor(windowDays) : 0;
  const sinceMs = days > 0 ? now - days * DAY_MS : 0;
  const sinceDay = days > 0 ? new Date(sinceMs).toISOString().slice(0, 10) : null;

  const storePath = options.sessionStorePath || defaultSessionStorePath({ env, home });
  const tracesPath = options.tracesDbPath || findTracesDb(vscodeGlobalStorageDirs({ env, platform, home }));

  const store = await readDatabase(storePath, (db) => sessionStoreCoverage(db, { sinceDay, sinceMs }));
  const traces = await readDatabase(tracesPath, (db) => tracesCoverage(db, { sinceMs }));

  return {
    generatedAt: new Date(now).toISOString(),
    window: { days, since: sinceDay },
    sources: [
      {
        id: 'sessionStore',
        label: 'Copilot CLI / app session store',
        surfaces: ['cli', 'app'],
        path: storePath,
        ...store,
      },
      { id: 'traces', label: 'VS Code agent-traces.db', surfaces: ['vscode'], path: tracesPath ?? null, ...traces },
    ],
    caveats: [
      'Sources are shown side by side and never summed: VS Code-hosted Copilot CLI sessions can appear in both.',
      'Local observations, not a bill. Credits = nano-AIU / 1,000,000,000.',
    ],
  };
}
