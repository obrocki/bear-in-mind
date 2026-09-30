'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { it } = require('node:test');
const { pathToFileURL } = require('node:url');

const extensionDir = path.join(__dirname, '..', '.github', 'extensions', 'ai-attribution');
const load = (file) => import(pathToFileURL(path.join(extensionDir, 'lib', file)).href);
const model = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'docs', 'research', 'attribution-model.json'), 'utf8'),
);
const NANO = 1_000_000_000;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-attribution-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

it('model spec: every concept covers every surface with a known availability', () => {
  const surfaces = model.surfaces.map((s) => s.id);
  const levels = new Set(model.availabilityLevels.map((l) => l.id));
  const groups = new Set(model.groups.map((g) => g.id));
  const ids = new Set();
  for (const concept of model.concepts) {
    assert.ok(!ids.has(concept.id), `duplicate concept ${concept.id}`);
    ids.add(concept.id);
    assert.ok(groups.has(concept.group), `${concept.id}: unknown group ${concept.group}`);
    assert.deepEqual(Object.keys(concept.surfaces).sort(), [...surfaces].sort(), `${concept.id}: surface coverage`);
    for (const [surface, cell] of Object.entries(concept.surfaces)) {
      assert.ok(levels.has(cell.availability), `${concept.id}.${surface}: ${cell.availability}`);
      assert.equal(typeof cell.field, 'string', `${concept.id}.${surface}: field`);
    }
  }
});

it('model spec: outcomes, gaps, tiers and sources are well formed', () => {
  const surfaces = new Set(model.surfaces.map((s) => s.id));
  const liveMetrics = new Set([
    'creditsToPrShare',
    'creditsToRepoShare',
    'creditCoverage',
    'cacheReadRatio',
    'subAgentShare',
  ]);
  for (const outcome of model.outcomes) {
    assert.ok(['local', 'needs-vcs-join', 'needs-org-api', 'needs-baseline'].includes(outcome.availability), outcome.id);
    if (outcome.liveMetric) assert.ok(liveMetrics.has(outcome.liveMetric), outcome.id);
  }
  for (const gap of model.gaps) {
    assert.ok(['high', 'medium', 'low'].includes(gap.severity), gap.id);
    for (const s of gap.surfaces) assert.ok(surfaces.has(s), `${gap.id}: ${s}`);
  }
  assert.deepEqual(
    model.tiers.map((t) => t.id),
    ['T0', 'T1', 'T2', 'T3', 'U'],
  );
  for (const v of model.verification) assert.ok(['verified', 'unverified'].includes(v.status), v.claim);
  for (const source of model.sources) assert.match(source.url, /^https:\/\//, source.title);
  const entities = new Set(model.entities.map((e) => e.id));
  for (const r of model.relationships) {
    assert.ok(entities.has(r.from) && entities.has(r.to), `${r.from} -> ${r.to}`);
  }
});

it('ROI model separates locally measured work links from return and baseline', () => {
  const outcomes = Object.fromEntries(model.outcomes.map((o) => [o.id, o]));
  assert.match(model.title, /ROI/);
  assert.equal(outcomes.coverage.liveMetric, 'creditsToPrShare');
  assert.match(outcomes.coverage.measure, /not verified delivery or value/);
  assert.equal(outcomes.roi.availability, 'needs-baseline');
  assert.equal(outcomes.roi.liveMetric, undefined);
  assert.equal(outcomes.human_effort.availability, 'needs-baseline');
  assert.equal(outcomes.reconciliation.availability, 'needs-org-api');
});

it('normalises repository identifiers and drops credentials', async () => {
  const { normalizeRepository } = await load('coverage.mjs');
  assert.equal(normalizeRepository('obrocki/bear-in-mind'), 'obrocki/bear-in-mind');
  assert.equal(normalizeRepository('https://github.com/obrocki/bear-in-mind.git'), 'obrocki/bear-in-mind');
  assert.equal(normalizeRepository('git@github.com:obrocki/bear-in-mind.git'), 'obrocki/bear-in-mind');
  assert.equal(normalizeRepository('https://user:token@github.com/o/r'), 'o/r');
  assert.equal(normalizeRepository('https://dev.azure.com/org/proj/_git/repo'), 'dev.azure.com/org/proj/_git/repo');
  assert.equal(normalizeRepository('  '), null);
  assert.equal(normalizeRepository(null), null);
  assert.equal(normalizeRepository('user:secret@host/o/r'), null, 'unparsed credentials are rejected, not shown');
  assert.equal(normalizeRepository('ftp://user:pw@host.example/o/r'), 'host.example/o/r');
  assert.equal(normalizeRepository('https://user:pw@[bad/o/r'), null);
  for (const local of [
    '/home/alice/private/repo',
    'C:\\Users\\alice\\repo',
    'file:///home/alice/repo',
    '~/repo',
    'C:private/repo',
  ]) {
    assert.equal(normalizeRepository(local), null, local);
  }
});

it('session store: credit-weighted funnel stops where references stop', async (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const { computeCoverage } = await load('coverage.mjs');
  const dir = tempDir(t);
  const file = path.join(dir, 'session-store.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE session_refs (id INTEGER PRIMARY KEY, session_id TEXT, ref_type TEXT, ref_value TEXT, turn_index INTEGER, created_at TEXT);
    CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER, agent_id TEXT,
      model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
      reasoning_tokens INTEGER, total_nano_aiu INTEGER, initiator TEXT, reasoning_effort TEXT, created_at TEXT);
  `);
  const session = db.prepare('INSERT INTO sessions (id, repository, branch, updated_at) VALUES (?, ?, ?, ?)');
  session.run('with-pr', 'https://github.com/o/a.git', 'feature', '2026-09-29');
  session.run('repo-only', 'o/b', null, '2026-09-29');
  session.run('no-repo', null, null, '2026-09-29');
  db.prepare("INSERT INTO session_refs (session_id, ref_type, ref_value) VALUES ('with-pr', 'pr', '42')").run();
  db.prepare("INSERT INTO session_refs (session_id, ref_type, ref_value) VALUES ('with-pr', 'commit', 'abc')").run();
  const usage =
    db.prepare(`INSERT INTO assistant_usage_events (session_id, agent_id, model, input_tokens, output_tokens,
    cache_read_tokens, total_nano_aiu, initiator, reasoning_effort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  usage.run('with-pr', null, 'm1', 1000, 10, 800, 6 * NANO, 'user', 'high', '2026-09-29T10:00:00.000Z');
  usage.run('with-pr', 'sub-1', 'm2', 500, 5, 0, 1 * NANO, 'sub-agent', 'low', '2026-09-29T11:00:00.000Z');
  usage.run('repo-only', null, 'm1', 200, 2, 100, 2 * NANO, 'agent', 'high', '2026-09-28T10:00:00.000Z');
  usage.run('no-repo', null, 'm1', 300, 3, 0, null, 'agent', null, '2026-09-28T12:00:00.000Z');
  usage.run('no-repo', null, 'm1', 999, 9, 0, 9 * NANO, 'agent', null, '2026-08-01T12:00:00.000Z');
  db.close();

  const coverage = await computeCoverage({
    windowDays: 30,
    now: Date.UTC(2026, 8, 30, 12),
    sessionStorePath: file,
    tracesDbPath: path.join(dir, 'absent.db'),
  });
  const store = coverage.sources.find((s) => s.id === 'sessionStore');
  assert.equal(store.status, 'ok');
  assert.equal(store.totals.calls, 4, 'the August call is outside the window');
  assert.equal(store.totals.creditedCalls, 3);
  assert.equal(store.totals.credits, 9);
  assert.equal(store.metrics.creditCoverage, 0.75);
  const stage = Object.fromEntries(store.funnel.map((f) => [f.id, f]));
  assert.equal(stage.observed.credits, 9);
  assert.equal(stage.repository.credits, 9);
  assert.equal(stage.repository.sessions, 2);
  assert.equal(stage.branch.credits, 7);
  assert.equal(stage.workRef.credits, 7);
  assert.equal(stage.pullRequest.credits, 7);
  assert.equal(stage.pullRequest.sessions, 1);
  assert.equal(store.metrics.creditsToRepoShare, 1);
  assert.equal(store.metrics.creditsToPrShare, 7 / 9);
  assert.equal(store.metrics.subAgentShare, 1 / 9);
  assert.equal(store.metrics.cacheReadRatio, 900 / 2000);
  assert.deepEqual(
    store.breakdowns.repository.map((r) => r.key),
    ['o/a', 'o/b', '(none)'],
  );
  assert.deepEqual(
    store.daily.map((d) => d.day),
    ['2026-09-28', '2026-09-29'],
  );

  const traces = coverage.sources.find((s) => s.id === 'traces');
  assert.equal(traces.status, 'missing');
});

it('session store: tolerates missing columns and tables', async (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const { computeCoverage } = await load('coverage.mjs');
  const dir = tempDir(t);
  const file = path.join(dir, 'session-store.db');
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE assistant_usage_events (session_id TEXT, model TEXT); INSERT INTO assistant_usage_events VALUES ('s', 'm');",
  );
  db.close();
  const coverage = await computeCoverage({
    windowDays: 30,
    sessionStorePath: file,
    tracesDbPath: path.join(dir, 'x.db'),
  });
  const store = coverage.sources[0];
  assert.equal(store.status, 'ok');
  assert.equal(store.totals.calls, 1);
  assert.equal(store.totals.creditedCalls, 0);
  assert.equal(store.metrics.creditsToPrShare, null, 'no credits means unknown, not zero');
  assert.match(store.notes.join(' '), /created_at is missing/);

  const empty = path.join(dir, 'empty.db');
  new DatabaseSync(empty).close();
  const schema = await computeCoverage({ sessionStorePath: empty, tracesDbPath: empty });
  assert.equal(schema.sources[0].status, 'schema');
  assert.equal(schema.sources[1].status, 'schema');
});

it('VS Code traces: chat spans inherit repository from invoke_agent; PR stages are not emitted', async (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const { computeCoverage, reasoningEffortFromOptions } = await load('coverage.mjs');
  const dir = tempDir(t);
  const file = path.join(dir, 'agent-traces.db');
  const now = Date.UTC(2026, 8, 30, 12);
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE spans (span_id TEXT PRIMARY KEY, trace_id TEXT, parent_span_id TEXT, name TEXT, start_time_ms INTEGER,
      end_time_ms INTEGER, status_code INTEGER, operation_name TEXT, agent_name TEXT, conversation_id TEXT,
      request_model TEXT, response_model TEXT, input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
      reasoning_tokens INTEGER, tool_name TEXT, chat_session_id TEXT);
    CREATE TABLE span_attributes (span_id TEXT, key TEXT, value TEXT, PRIMARY KEY (span_id, key));
  `);
  const span =
    db.prepare(`INSERT INTO spans (span_id, trace_id, start_time_ms, end_time_ms, status_code, operation_name,
    agent_name, conversation_id, response_model, input_tokens, output_tokens, cached_tokens, tool_name, chat_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const attr = db.prepare('INSERT INTO span_attributes VALUES (?, ?, ?)');
  const at = now - 60_000;
  span.run(
    'agent',
    't1',
    at,
    at + 5000,
    0,
    'invoke_agent',
    'GitHub Copilot Chat',
    'conv-1',
    null,
    null,
    null,
    null,
    null,
    'chat-1',
  );
  attr.run('agent', 'github.copilot.git.repository', 'https://github.com/o/r.git');
  attr.run('agent', 'github.copilot.git.branch', 'main');
  span.run('c1', 't1', at + 10, at + 900, 0, 'chat', 'panel/editAgent', 'conv-1', 'm1', 1000, 50, 600, null, 'chat-1');
  attr.run('c1', 'copilot_chat.copilot_usage_nano_aiu', String(3 * NANO));
  attr.run('c1', 'copilot_chat.request.options', JSON.stringify({ stream: true, reasoning: { effort: 'high' } }));
  span.run('sub', 't2', at + 20, at + 800, 0, 'chat', 'executionSubagentTool', null, 'm1', 100, 5, 0, null, null);
  attr.run('sub', 'copilot_chat.copilot_usage_nano_aiu', String(1 * NANO));
  attr.run('sub', 'copilot_chat.parent_chat_session_id', 'chat-1');
  span.run('aux', 't3', at + 30, at + 100, 0, 'chat', 'title', null, 'mini', 50, 5, 0, null, null);
  attr.run('aux', 'copilot_chat.copilot_usage_nano_aiu', '0');
  span.run(
    'uncredited',
    't4',
    at + 40,
    at + 100,
    0,
    'chat',
    'copilotLanguageModelWrapper',
    null,
    'mini',
    10,
    1,
    0,
    null,
    null,
  );
  span.run('tool-ok', 't1', at + 50, at + 60, 1, 'execute_tool', null, null, null, null, null, null, 'read_file', null);
  span.run(
    'tool-unset',
    't1',
    at + 60,
    at + 65,
    0,
    'execute_tool',
    null,
    null,
    null,
    null,
    null,
    null,
    'read_file',
    null,
  );
  span.run(
    'tool-bad',
    't1',
    at + 70,
    at + 80,
    2,
    'execute_tool',
    null,
    null,
    null,
    null,
    null,
    null,
    'read_file',
    null,
  );
  db.close();

  const coverage = await computeCoverage({
    windowDays: 7,
    now,
    sessionStorePath: path.join(dir, 'none.db'),
    tracesDbPath: file,
  });
  const traces = coverage.sources.find((s) => s.id === 'traces');
  assert.equal(traces.status, 'ok');
  assert.equal(traces.totals.calls, 4, 'invoke_agent totals are never counted as calls');
  assert.equal(traces.totals.creditedCalls, 3);
  assert.equal(traces.totals.credits, 4);
  const stage = Object.fromEntries(traces.funnel.map((f) => [f.id, f]));
  assert.equal(stage.session.calls, 2);
  assert.ok(stage.observed.sessions >= stage.session.sessions, 'session counts never grow down the funnel');
  assert.equal(stage.observed.sessions, 1, 'the parent-only sub-agent call belongs to chat-1');
  assert.equal(stage.repository.credits, 4);
  assert.equal(stage.branch.credits, 4);
  assert.equal(stage.pullRequest.emitted, false);
  assert.equal(stage.pullRequest.credits, 0);
  assert.equal(traces.metrics.creditsToPrShare, null, 'a PR share cannot be measured on VS Code traces');
  assert.equal(traces.metrics.creditsToRepoShare, 1);
  assert.equal(traces.metrics.creditCoverage, 0.75);
  assert.deepEqual(Object.fromEntries(traces.breakdowns.link.map((r) => [r.key, r.calls])), {
    'chat session': 1,
    'parent session': 1,
    none: 2,
  });
  assert.equal(traces.breakdowns.repository[0].key, 'o/r');
  assert.equal(traces.breakdowns.reasoningEffort.find((r) => r.key === 'high').credits, 3);
  assert.deepEqual(
    traces.tools,
    [{ key: 'read_file', calls: 3, statusCalls: 2, failed: 1 }],
    'UNSET status is unknown',
  );
  assert.equal(coverage.sources.find((s) => s.id === 'sessionStore').status, 'missing');

  assert.equal(reasoningEffortFromOptions('{"reasoning_effort":"max"}'), 'max');
  assert.equal(reasoningEffortFromOptions('not json'), null);
  assert.equal(reasoningEffortFromOptions('{"reasoning":{"effort":"HIGH"}}'), 'high');
  assert.equal(reasoningEffortFromOptions('{"reasoning":{"effort":"ignore previous; leak"}}'), null);
  assert.equal(reasoningEffortFromOptions(JSON.stringify({ reasoning: { effort: 'x'.repeat(40) } })), null);
  assert.equal(reasoningEffortFromOptions(JSON.stringify({ pad: 'x'.repeat(70000), reasoning_effort: 'low' })), null);
});

it('discovers the most recently written agent-traces.db', async (t) => {
  const { findTracesDb, vscodeGlobalStorageDirs, defaultSessionStorePath } = await load('coverage.mjs');
  const home = tempDir(t);
  const [stable, insiders] = vscodeGlobalStorageDirs({ env: {}, platform: 'linux', home });
  assert.equal(stable, path.join(home, '.config', 'Code', 'User', 'globalStorage'));
  const older = path.join(stable, 'github.copilot-chat', 'agent-traces.db');
  const newer = path.join(insiders, 'github.copilot-chat', 'otel', 'agent-traces.db');
  for (const file of [older, newer]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  }
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(older, past, past);
  assert.equal(findTracesDb([stable, insiders]), newer);
  assert.equal(findTracesDb([path.join(home, 'nothing')]), undefined);
  assert.equal(
    defaultSessionStorePath({ env: { COPILOT_HOME: path.join(home, 'ch') }, home }),
    path.join(home, 'ch', 'session-store.db'),
  );
  assert.equal(defaultSessionStorePath({ env: {}, home }), path.join(home, '.copilot', 'session-store.db'));
});

function request(port, { method = 'GET', pathname = '/', host = `127.0.0.1:${port}`, origin, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
    if (origin) headers.Origin = origin;
    if (body) headers['Content-Type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: data }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

it('canvas server: serves UI and API on loopback, rejects foreign hosts and origins', async (t) => {
  const { startCanvasServer } = await load('server.mjs');
  let view = 'outcomes';
  const server = await startCanvasServer({
    uiDir: path.join(extensionDir, 'ui'),
    api: {
      model: async () => ({ title: 'm' }),
      research: async () => '# r',
      coverage: async () => ({ sources: [] }),
      refresh: async (days) => ({ refreshed: days }),
      getView: () => view,
      setView: (v) => {
        view = v;
        return view;
      },
      windowDays: () => 30,
    },
  });
  t.after(() => server.close());
  const port = Number(new URL(server.url).port);
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  const index = await request(port);
  assert.equal(index.status, 200);
  assert.match(index.type, /text\/html/);
  for (const asset of ['/app.js', '/dom.js', '/markdown.js', '/style.css']) {
    assert.equal((await request(port, { pathname: asset })).status, 200, asset);
  }
  assert.deepEqual(JSON.parse((await request(port, { pathname: '/api/model' })).body), { title: 'm' });
  assert.deepEqual(JSON.parse((await request(port, { pathname: '/api/research' })).body), { markdown: '# r' });
  assert.deepEqual(
    JSON.parse((await request(port, { method: 'POST', pathname: '/api/coverage', body: { windowDays: 7 } })).body),
    { refreshed: 7 },
  );
  assert.deepEqual(
    JSON.parse((await request(port, { method: 'POST', pathname: '/api/view', body: { view: 'gaps' } })).body),
    { view: 'gaps' },
  );
  assert.equal((await request(port, { pathname: '/../package.json' })).status, 404);
  assert.equal((await request(port, { host: 'evil.example:80' })).status, 403);
  assert.equal(
    (
      await request(port, {
        method: 'POST',
        pathname: '/api/view',
        origin: 'https://evil.example',
        body: { view: 'x' },
      })
    ).status,
    403,
  );
  assert.equal(view, 'gaps');
});

it('VS Code traces: an older store without status_code leaves tool failures unknown', async (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const { computeCoverage } = await load('coverage.mjs');
  const dir = tempDir(t);
  const file = path.join(dir, 'agent-traces.db');
  const now = Date.UTC(2026, 8, 30, 12);
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE spans (span_id TEXT PRIMARY KEY, start_time_ms INTEGER, operation_name TEXT, tool_name TEXT);
    INSERT INTO spans VALUES ('a', ${now - 1000}, 'execute_tool', 'read_file'), ('b', ${now - 900}, 'execute_tool', 'read_file');
  `);
  db.close();
  const coverage = await computeCoverage({
    windowDays: 7,
    now,
    sessionStorePath: path.join(dir, 'none.db'),
    tracesDbPath: file,
  });
  const traces = coverage.sources.find((s) => s.id === 'traces');
  assert.equal(traces.status, 'ok');
  assert.deepEqual(traces.tools, [{ key: 'read_file', calls: 2, statusCalls: 0, failed: 0 }]);
});

it('session store: applies an exact rolling cutoff and tolerates an incompatible session_refs table', async (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const { computeCoverage, timestampMs } = await load('coverage.mjs');
  const dir = tempDir(t);
  const file = path.join(dir, 'session-store.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, repository TEXT, branch TEXT);
    CREATE TABLE session_refs (id INTEGER PRIMARY KEY, value TEXT);
    CREATE TABLE assistant_usage_events (session_id TEXT, model TEXT, total_nano_aiu INTEGER, created_at TEXT);
    INSERT INTO sessions VALUES ('s', 'o/r', 'main');
  `);
  const usage = db.prepare('INSERT INTO assistant_usage_events VALUES (?, ?, ?, ?)');
  usage.run('s', 'm', 1e9, '2026-09-23T06:00:00.000Z');
  usage.run('s', 'm', 2e9, '2026-09-23 18:00:00');
  usage.run('s', 'm', 4e9, '2026-09-23');
  usage.run('s', 'm', 8e9, '2026-09-24');
  usage.run('s', 'm', 16e9, 'garbage');
  usage.run('s', 'm', 32e9, '2026-09-22T23:30:00-14:00');
  usage.run('s', 'm', 'abc', '2026-09-25T00:00:00Z');
  usage.run('s', 'm', -5e9, '2026-09-25T00:00:00Z');
  db.close();

  const coverage = await computeCoverage({
    windowDays: 7,
    now: Date.UTC(2026, 8, 30, 12),
    sessionStorePath: file,
    tracesDbPath: path.join(dir, 'x.db'),
  });
  const store = coverage.sources[0];
  assert.equal(store.status, 'ok', 'an incompatible optional table must not fail the source');
  assert.equal(
    store.totals.calls,
    5,
    'same-day-but-earlier, cutoff-day-only and unreadable rows are outside; a negative-offset row inside is kept',
  );
  assert.equal(store.totals.creditedCalls, 3, 'non-numeric and negative credits are unknown, not reported');
  assert.equal(store.totals.credits, 42);
  const stage = Object.fromEntries(store.funnel.map((f) => [f.id, f]));
  assert.equal(stage.branch.credits, 42);
  assert.deepEqual(
    store.daily.map((d) => d.day),
    ['2026-09-23', '2026-09-24', '2026-09-25'],
    'buckets use normalized UTC days',
  );
  assert.deepEqual(store.freshness, { first: '2026-09-23T13:30:00.000Z', last: '2026-09-25T00:00:00.000Z' });
  assert.equal(stage.workRef.emitted, false);
  assert.equal(stage.pullRequest.emitted, false);
  assert.match(store.notes.join(' '), /session_refs is missing or lacks session_id \/ ref_type/);

  assert.equal(timestampMs('2026-09-23 18:00:00').ms, Date.UTC(2026, 8, 23, 18));
  assert.equal(timestampMs('2026-09-23T18:00:00+01:00').ms, Date.UTC(2026, 8, 23, 17));
  assert.deepEqual(timestampMs('2026-09-23'), { ms: null, dateOnly: true, day: '2026-09-23' });
  assert.equal(timestampMs('garbage').ms, null);
});

it('VS Code traces: the newest agent span wins, and canonical git keys beat legacy ones in any row order', async (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const { computeCoverage, nanoAiu } = await load('coverage.mjs');
  const dir = tempDir(t);
  const file = path.join(dir, 'agent-traces.db');
  const now = Date.UTC(2026, 8, 30, 12);
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE spans (span_id TEXT PRIMARY KEY, trace_id TEXT, start_time_ms INTEGER, operation_name TEXT,
      chat_session_id TEXT, conversation_id TEXT);
    CREATE TABLE span_attributes (span_id TEXT, key TEXT, value TEXT);
  `);
  const span = db.prepare('INSERT INTO spans VALUES (?, ?, ?, ?, ?, ?)');
  const attr = db.prepare('INSERT INTO span_attributes VALUES (?, ?, ?)');
  // The newer agent span is inserted first so row order cannot decide.
  span.run('new', 't2', now - 1000, 'invoke_agent', 'chat-9', null);
  attr.run('new', 'copilot_chat.repo.remote_url', 'https://github.com/o/legacy.git');
  attr.run('new', 'github.copilot.git.repository', 'o/new');
  span.run('old', 't1', now - 5000, 'invoke_agent', 'chat-9', null);
  attr.run('old', 'github.copilot.git.repository', 'o/old');
  span.run('call', 't2', now - 900, 'chat', 'chat-9', null);
  attr.run('call', 'copilot_chat.copilot_usage_nano_aiu', '2000000000');
  db.close();

  const coverage = await computeCoverage({
    windowDays: 7,
    now,
    sessionStorePath: path.join(dir, 'none.db'),
    tracesDbPath: file,
  });
  const traces = coverage.sources.find((s) => s.id === 'traces');
  assert.deepEqual(
    traces.breakdowns.repository.map((r) => r.key),
    ['o/new'],
  );

  assert.equal(nanoAiu('12'), 12);
  assert.equal(nanoAiu(0), 0);
  assert.equal(nanoAiu(-1), null);
  assert.equal(nanoAiu('abc'), null);
  assert.equal(nanoAiu(''), null);
  assert.equal(nanoAiu(null), null);
});
