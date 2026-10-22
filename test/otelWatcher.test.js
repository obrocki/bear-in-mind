'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { it } = require('node:test');
const { OtelWatcher, identityCaptureOverride } = require(path.join(process.env.BEAR_TEST_BUILD, 'otelWatcher.js'));
const { buildPeriod, periodStart } = require(path.join(process.env.BEAR_TEST_BUILD, 'otelSummary.js'));

const record = fs.readFileSync(path.join(__dirname, 'fixtures', 'otel-feed.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(JSON.parse).find((entry) => entry.scopeMetrics);
const metric = record.scopeMetrics.flatMap((scope) => scope.metrics)
  .find((entry) => entry.descriptor.name === 'gen_ai.client.token.usage');
const point = metric.dataPoints.find((entry) => entry.attributes['gen_ai.token.type'] === 'input');

function exportLine(input) {
  return JSON.stringify({
    resource: record.resource,
    scopeMetrics: [{
      metrics: [{
        ...metric,
        dataPoints: [{ ...point, value: { ...point.value, sum: input } }]
      }]
    }]
  }) + '\n';
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bear-feed-'));
  const store = new Map();
  const context = {
    globalStorageUri: { fsPath: path.join(dir, 'extension') },
    globalState: {
      get: (key) => store.get(key),
      update: async (key, value) => store.set(key, structuredClone(value))
    }
  };
  const deltas = [];
  const watchers = [];
  const create = () => {
    const watcher = new OtelWatcher(context, (delta) => deltas.push(delta));
    watchers.push(watcher);
    return watcher;
  };
  globalThis.__BEAR_SETTINGS__ = { 'iceberg.otel.feedPath': path.join(dir, 'feed.jsonl') };
  const watcher = create();
  t.after(() => {
    watchers.forEach((item) => item.dispose());
    fs.rmSync(dir, { recursive: true, force: true });
    delete globalThis.__BEAR_SETTINGS__;
  });
  return { dir, file: path.join(dir, 'feed.jsonl'), watcher, deltas, create };
}

it('reports whether identity capture is requested, with the environment variable taking precedence', (t) => {
  const { watcher } = fixture(t);
  const saved = process.env.COPILOT_OTEL_CAPTURE_IDENTITY;
  t.after(() => {
    if (saved === undefined) delete process.env.COPILOT_OTEL_CAPTURE_IDENTITY;
    else process.env.COPILOT_OTEL_CAPTURE_IDENTITY = saved;
  });
  delete process.env.COPILOT_OTEL_CAPTURE_IDENTITY;
  assert.equal(watcher.health().identityCapture, false, 'off by default');
  globalThis.__BEAR_SETTINGS__['github.copilot.chat.otel.captureIdentity'] = true;
  assert.equal(watcher.health().identityCapture, true);
  process.env.COPILOT_OTEL_CAPTURE_IDENTITY = 'false';
  assert.equal(watcher.health().identityCapture, false);
  globalThis.__BEAR_SETTINGS__['github.copilot.chat.otel.captureIdentity'] = false;
  process.env.COPILOT_OTEL_CAPTURE_IDENTITY = 'true';
  assert.equal(watcher.health().identityCapture, true);
  process.env.COPILOT_OTEL_CAPTURE_IDENTITY = 'TRUE';
  assert.equal(watcher.health().identityCapture, false, 'parsed exactly as Copilot Chat does');
});

it('parses the identity-capture environment override exactly as Copilot Chat does', () => {
  assert.equal(identityCaptureOverride({}), undefined, 'unset defers to the setting');
  assert.equal(identityCaptureOverride({ COPILOT_OTEL_CAPTURE_IDENTITY: 'true' }), true);
  assert.equal(identityCaptureOverride({ COPILOT_OTEL_CAPTURE_IDENTITY: '1' }), true);
  assert.equal(identityCaptureOverride({ COPILOT_OTEL_CAPTURE_IDENTITY: '' }), false, 'set but empty is off, not unset');
  assert.equal(identityCaptureOverride({ COPILOT_OTEL_CAPTURE_IDENTITY: 'yes' }), false);
});

it('does not carry a missing-feed flag onto a different existing feed', (t) => {
  const { dir, watcher, deltas } = fixture(t);
  watcher.scan();
  const file = path.join(dir, 'existing.jsonl');
  fs.writeFileSync(file, exportLine(2000));
  globalThis.__BEAR_SETTINGS__['iceberg.otel.feedPath'] = file;
  watcher.reconfigure();
  watcher.scan();
  assert.deepEqual(deltas, [], 'the new path has history, not live usage');
  fs.appendFileSync(file, exportLine(2300));
  watcher.scan();
  assert.deepEqual(deltas, [{ input: 300, output: 0, requests: 0 }]);
});

it('charges a feed created after that same path was observed missing', (t) => {
  const { file, watcher, deltas } = fixture(t);
  watcher.scan();
  fs.writeFileSync(file, exportLine(700));
  watcher.scan();
  assert.deepEqual(deltas, [{ input: 700, output: 0, requests: 0 }]);
});

it('finishes seeding a backlog ending mid-record and charges subsequent growth', (t) => {
  const { file, watcher, deltas } = fixture(t);
  const partial = exportLine(150);
  fs.writeFileSync(file, exportLine(100) + partial.slice(0, -5));
  watcher.scan();
  watcher.scan();
  assert.deepEqual(deltas, []);
  fs.appendFileSync(file, partial.slice(-5) + exportLine(200));
  watcher.scan();
  assert.deepEqual(deltas, [{ input: 100, output: 0, requests: 0 }]);
  fs.appendFileSync(file, exportLine(250));
  watcher.scan();
  assert.equal(deltas[1].input, 50);
  assert.equal(watcher.health().records.malformed, 0);
});

it('handles an initial feed containing only a partial record', (t) => {
  const { file, watcher, deltas } = fixture(t);
  const partial = exportLine(150);
  fs.writeFileSync(file, partial.slice(0, -1));
  watcher.scan();
  fs.appendFileSync(file, '\n');
  watcher.scan();
  watcher.scan();
  assert.deepEqual(deltas, [{ input: 150, output: 0, requests: 0 }]);
});

it('rebuilds its rollup after restart without losing or repeating growth', (t) => {
  const { file, watcher, deltas, create } = fixture(t);
  fs.writeFileSync(file, exportLine(100));
  watcher.scan();
  fs.appendFileSync(file, exportLine(200));
  watcher.scan();
  watcher.dispose();
  const restarted = create();
  restarted.scan();
  assert.deepEqual(deltas, [{ input: 100, output: 0, requests: 0 }]);
  fs.appendFileSync(file, exportLine(250));
  restarted.scan();
  assert.equal(deltas[1].input, 50);
});

it('rebuilds quality event totals once after restart without charging tokens', (t) => {
  const { file, watcher, deltas, create } = fixture(t);
  const line = JSON.stringify({
    _body: 'copilot_chat.user.feedback',
    attributes: { rating: 'positive' }
  }) + '\n';
  fs.writeFileSync(file, line);
  watcher.scan();
  watcher.scan();
  assert.equal(watcher.rollup.total('copilot_chat.user.feedback.count', { rating: 'positive' }), 1);
  watcher.dispose();
  const restarted = create();
  restarted.scan();
  assert.equal(restarted.rollup.total('copilot_chat.user.feedback.count', { rating: 'positive' }), 1);
  fs.appendFileSync(file, line);
  restarted.scan();
  assert.equal(restarted.rollup.total('copilot_chat.user.feedback.count', { rating: 'positive' }), 2);
  assert.deepEqual(deltas, [], 'quality events never feed the token ledger');
});

function spanRecord(id, now, operation = 'chat') {
  return {
    spanId: id, ended: true,
    startTime: [Math.floor(now / 1000), (now % 1000) * 1e6],
    endTime: [Math.floor(now / 1000) + 1, (now % 1000) * 1e6],
    attributes: {
      'gen_ai.operation.name': operation, 'gen_ai.conversation.id': 's',
      'gen_ai.usage.input_tokens': 1000, 'gen_ai.usage.output_tokens': 100,
      'gen_ai.usage.cache_read.input_tokens': 500,
      'copilot_chat.copilot_usage_nano_aiu': 2000000000,
      'copilot_chat.request.max_prompt_tokens': 128000
    }
  };
}

it('parses captured-content spans once through redaction before extracting usage', (t) => {
  let now = Date.UTC(2026, 8, 24, 12);
  t.mock.method(Date, 'now', () => now);
  const { file, watcher, deltas } = fixture(t);
  now += 2000;
  const span = spanRecord('redacted', now - 1000);
  span.attributes['gen_ai.input.messages'] = 'private prompt'.repeat(10000);
  span.attributes['gen_ai.tool.call.arguments'] = { command: 'private argument' };
  const line = JSON.stringify(span);
  fs.writeFileSync(file, line + '\n');
  const parse = JSON.parse;
  const parsed = [];
  t.mock.method(JSON, 'parse', (text, reviver) => {
    const record = parse(text, reviver);
    if (text === line) {
      parsed.push(record);
    }
    return record;
  });

  watcher.scan();
  assert.equal(parsed.length, 1, 'the raw captured-content span must not be reparsed');
  assert.doesNotMatch(JSON.stringify(parsed), /private/);
  assert.equal(watcher.spanDigest.sessions[0].credits, 2);
  assert.equal(watcher.spanDigest.sessions[0].llmCalls, 1);
  assert.equal(watcher.spanDigest.context.limit, 128000);
  assert.deepEqual(deltas, [{ input: 1000, output: 100, requests: 1, source: 'traces' }]);
  assert.equal(watcher.health().records.spans, 1);
});

it('meters modern serialized file spans without metrics and never repeats them after restart', (t) => {
  let now = Date.UTC(2026, 8, 24, 12);
  t.mock.method(Date, 'now', () => now);
  const { file, watcher, deltas, create } = fixture(t);
  const history = spanRecord('old', now - 10000);
  fs.writeFileSync(file, JSON.stringify(history) + '\n');
  watcher.scan();
  assert.equal(deltas.length, 0);
  now += 2000;
  const live = JSON.stringify(spanRecord('new', now - 1000)) + '\n';
  fs.appendFileSync(file, live + live + JSON.stringify(spanRecord('root', now - 1000, 'invoke_agent')) + '\n');
  watcher.scan();
  assert.deepEqual(deltas, [{ input: 1000, output: 100, requests: 1, source: 'traces' }]);
  assert.equal(watcher.spanDigest.sessions[0].credits, 4);
  assert.equal(watcher.spanDigest.cachedTokens, 1000);
  assert.equal(watcher.health().jsonlActive, true);
  watcher.dispose();
  const restarted = create();
  restarted.scan();
  assert.equal(deltas.length, 1);
  assert.equal(restarted.spanDigest.sessions[0].llmCalls, 2);
});

it('exposes the seven-day trace cutoff when older billing-period sessions lose their traces', (t) => {
  let now = new Date(2026, 8, 25, 12).getTime();
  t.mock.method(Date, 'now', () => now);
  const { file, watcher } = fixture(t);
  const day = 24 * 60 * 60 * 1000;
  const early = spanRecord('early-call', periodStart(now) + day);
  early.attributes['gen_ai.conversation.id'] = 'early';
  const recent = spanRecord('recent-call', now - 5 * day);
  const transcripts = [
    { sessionId: 'early', updatedAt: periodStart(now) + day, credits: 8 },
    { sessionId: 's', updatedAt: now - 5 * day, credits: 11 }
  ];
  fs.writeFileSync(file, [early, recent].map((span) => JSON.stringify(span)).join('\n') + '\n');
  watcher.scan();
  let period = buildPeriod({ spans: watcher.spanDigest, transcripts });
  assert.equal(period.sessions, 2);
  assert.equal(period.credits, 19);
  assert.equal(period.tracedSessions, 1);
  assert.equal(period.inputTokens, 1000);
  assert.equal(period.traceSinceMs, now - 7 * day);
  assert.ok(period.traceSinceMs > period.sinceMs);

  now += 3 * day;
  watcher.scan();
  period = buildPeriod({ spans: watcher.spanDigest, transcripts });
  assert.equal(period.sessions, 2);
  assert.equal(period.credits, 19);
  assert.equal(period.tracedSessions, 0);
  assert.equal(period.inputTokens, 0);
  assert.equal(period.traceSinceMs, now - 7 * day);
});

it('reads real SQLite spans, aliases and credits; deduplicates the same file-exported span', (t) => {
  const { DatabaseSync } = require('node:sqlite');
  let now = Date.UTC(2026, 8, 24, 12);
  t.mock.method(Date, 'now', () => now);
  const { dir, file, watcher, deltas } = fixture(t);
  const dbFile = path.join(dir, 'agent-traces.db');
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE spans (
      span_id TEXT, operation_name TEXT, tool_name TEXT, start_time_ms INTEGER, end_time_ms INTEGER,
      ttft_ms REAL, conversation_id TEXT, chat_session_id TEXT, request_model TEXT, response_model TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, reasoning_tokens INTEGER
    );
    CREATE TABLE span_attributes (span_id TEXT, key TEXT, value TEXT);
  `);
  now += 2000;
  const record = spanRecord('shared', now - 1000);
  db.prepare('INSERT INTO spans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'shared', 'chat', null, now - 1000, now, 250, 's', null, 'auto', 'resolved', 1000, 100, 500, 20
  );
  db.prepare('INSERT INTO spans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'expired', 'chat', null, now - 8 * 24 * 60 * 60 * 1000, now - 8 * 24 * 60 * 60 * 1000 + 1000,
    250, 'old-session', null, 'auto', 'resolved', 2000, 200, 500, 20
  );
  const insert = db.prepare('INSERT INTO span_attributes VALUES (?, ?, ?)');
  insert.run('shared', 'copilot_chat.request.max_prompt_tokens', '128000');
  insert.run('shared', 'copilot_chat.copilot_usage_nano_aiu', '293200000000');
  insert.run('shared', 'gen_ai.usage.reasoning.output_tokens', '30');
  db.close();
  fs.writeFileSync(file, JSON.stringify(record) + '\n');
  globalThis.__BEAR_SETTINGS__['iceberg.otel.tracesDbPath'] = dbFile;
  watcher.scan();
  assert.equal(watcher.spanDigest.sinceMs, now - 7 * 24 * 60 * 60 * 1000);
  assert.equal(watcher.spanDigest.sessions.length, 1);
  assert.equal(watcher.spanDigest.sessions[0].credits, 293.2);
  assert.equal(watcher.spanDigest.sessions[0].llmCalls, 1);
  assert.equal(watcher.spanDigest.reasoningTokens, 30);
  assert.equal(watcher.spanDigest.context.limit, 128000);
  assert.deepEqual(deltas, [{ input: 1000, output: 100, requests: 1, source: 'traces' }]);
  assert.equal(watcher.health().sqliteActive, true);
});

it('reads work context, callers, reasoning effort and tool status from a current trace store', (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const now = Date.UTC(2026, 8, 30, 12);
  t.mock.method(Date, 'now', () => now);
  const { dir, watcher } = fixture(t);
  const dbFile = path.join(dir, 'agent-traces.db');
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE spans (
      span_id TEXT PRIMARY KEY, trace_id TEXT, name TEXT, start_time_ms INTEGER, end_time_ms INTEGER,
      status_code INTEGER NOT NULL DEFAULT 0, operation_name TEXT, agent_name TEXT, conversation_id TEXT,
      request_model TEXT, response_model TEXT, input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
      reasoning_tokens INTEGER, tool_name TEXT, chat_session_id TEXT, ttft_ms REAL
    );
    CREATE TABLE span_attributes (span_id TEXT, key TEXT, value TEXT, PRIMARY KEY (span_id, key));
  `);
  const span = db.prepare(`INSERT INTO spans (span_id, start_time_ms, end_time_ms, status_code, operation_name,
    agent_name, chat_session_id, response_model, input_tokens, output_tokens, cached_tokens, tool_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const attr = db.prepare('INSERT INTO span_attributes VALUES (?, ?, ?)');
  const at = now - 60000;
  span.run('agent', at, at + 9000, 0, 'invoke_agent', 'GitHub Copilot Chat', 'chat-1', null, null, null, null, null);
  attr.run('agent', 'github.copilot.git.repository', 'https://github.com/o/r.git');
  attr.run('agent', 'github.copilot.git.branch', 'feature');
  attr.run('agent', 'user.name', 'octocat');
  span.run('call', at + 10, at + 900, 0, 'chat', 'panel/editAgent', 'chat-1', 'opus', 1000, 20, 750, null);
  attr.run('call', 'copilot_chat.copilot_usage_nano_aiu', '3000000000');
  attr.run('call', 'copilot_chat.request.options', JSON.stringify({ stream: true, reasoning: { effort: 'high' } }));
  span.run('title', at + 20, at + 100, 0, 'chat', 'title', null, 'mini', 50, 5, 0, null);
  attr.run('title', 'copilot_chat.copilot_usage_nano_aiu', ' ');
  attr.run('title', 'copilot_chat.request.options', JSON.stringify({ pad: 'x'.repeat(70000), reasoning: { effort: 'max' } }));
  span.run('ok', at + 30, at + 40, 1, 'execute_tool', null, 'chat-1', null, null, null, null, 'read_file');
  span.run('bad', at + 50, at + 60, 2, 'execute_tool', null, 'chat-1', null, null, null, null, 'read_file');
  db.close();
  globalThis.__BEAR_SETTINGS__['iceberg.otel.tracesDbPath'] = dbFile;
  watcher.scan();

  const digest = watcher.spanDigest;
  assert.equal(digest.chatCalls, 2);
  assert.equal(digest.credits, 3);
  assert.equal(digest.sessionlessCalls, 1);
  assert.equal(digest.creditCalls, 1, 'a blank credit value is unreported, not a zero-credit call');
  assert.equal(digest.sessionlessCreditCalls, 0);
  assert.equal(digest.sessions[0].repository, 'o/r');
  assert.equal(digest.sessions[0].branch, 'feature');
  assert.equal(digest.sessions[0].agentName, 'GitHub Copilot Chat');
  assert.equal(digest.sessions[0].user, 'octocat');
  assert.deepEqual(
    digest.byRepository.map((row) => [row.key, row.calls, row.credits]),
    [['o/r', 1, 3], [null, 1, 0]]
  );
  assert.deepEqual(
    digest.byUser.map((row) => [row.key, row.calls, row.credits]),
    [['octocat', 1, 3], [null, 1, 0]],
    'the sessionless title call stays unattributed'
  );
  assert.deepEqual(digest.byCaller.map((row) => row.key), ['panel/editAgent', 'title']);
  assert.deepEqual(digest.byEffort.map((row) => [row.key, row.calls]), [['high', 1], [null, 1]]);
  assert.equal(digest.toolStatusCalls, 2);
  assert.equal(digest.toolFailures, 1);
});

it('reads SDK ancestry, analytics identity, cache creation and first-chunk timing from SQLite', (t) => {
  const { DatabaseSync } = require('node:sqlite');
  let now = Date.UTC(2026, 9, 5, 12);
  t.mock.method(Date, 'now', () => now);
  const { dir, watcher, deltas } = fixture(t);
  now += 2000;
  const dbFile = path.join(dir, 'sdk-traces.db');
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE spans (span_id TEXT PRIMARY KEY, operation_name TEXT, tool_name TEXT, start_time_ms INTEGER,
      end_time_ms INTEGER, conversation_id TEXT, request_model TEXT, response_model TEXT, input_tokens INTEGER,
      output_tokens INTEGER, cached_tokens INTEGER, reasoning_tokens INTEGER, trace_id TEXT, parent_span_id TEXT);
    CREATE TABLE span_attributes (span_id TEXT, key TEXT, value TEXT);
  `);
  const span = db.prepare('INSERT INTO spans VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?)');
  span.run('sdk-root', 'invoke_agent', now - 1000, now, 'sdk-session', 'sdk-model', null, null, null, 'sdk-trace', null);
  span.run('sdk-call', 'chat', now - 900, now - 100, 'sdk-session', 'sdk-model', 100, 10, null, 'sdk-trace', 'sdk-root');
  const attr = db.prepare('INSERT INTO span_attributes VALUES (?, ?, ?)');
  attr.run('sdk-root', 'github.copilot.nano_aiu', '2000000000');
  attr.run('sdk-root', 'enduser.pseudo.id', 'opaque-id');
  attr.run('sdk-root', 'github.copilot.git.repository', 'o/sdk');
  attr.run('sdk-call', 'github.copilot.nano_aiu', '2000000000');
  attr.run('sdk-call', 'gen_ai.response.time_to_first_chunk', '0.15');
  attr.run('sdk-call', 'gen_ai.usage.cache_creation.input_tokens', '0');
  attr.run('sdk-call', 'gen_ai.request.reasoning.level', 'high');
  db.close();
  globalThis.__BEAR_SETTINGS__['iceberg.otel.tracesDbPath'] = dbFile;
  watcher.scan();
  const digest = watcher.spanDigest;
  assert.equal(digest.sdkCredits.credits, 2);
  assert.equal(digest.sdkCredits.reportedInvocations, 1);
  assert.equal(digest.credits, 0);
  assert.equal(digest.creditCalls, 0, 'SDK root-grain values are not promoted to VS Code per-call credits');
  assert.deepEqual(digest.firstChunkMs, [150]);
  assert.equal(digest.tokenCoverage.cacheWriteTokens.reportedCalls, 1);
  assert.equal(digest.tokenCoverage.cacheReadTokens.reportedCalls, 0);
  assert.equal(digest.cacheReadRatio, undefined);
  assert.equal(digest.byRepository[0].key, 'o/sdk');
  assert.equal(digest.byActorId[0].key, 'opaque-id');
  assert.equal(digest.byUser[0].key, null);
  assert.equal(digest.byEffort[0].key, 'high');
  assert.deepEqual(deltas, [{ input: 100, output: 10, requests: 1, source: 'traces' }], 'only the model call is metered');
});

function agentHostStore(file) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // The platform OTelSqliteStore schema, shared by agent-traces.db and agent-host-traces.db.
  db.exec(`
    CREATE TABLE spans (
      span_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_span_id TEXT, name TEXT NOT NULL,
      start_time_ms INTEGER NOT NULL, end_time_ms INTEGER NOT NULL, status_code INTEGER NOT NULL DEFAULT 0,
      status_message TEXT, operation_name TEXT, provider_name TEXT, agent_name TEXT, conversation_id TEXT,
      request_model TEXT, response_model TEXT, input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
      reasoning_tokens INTEGER, tool_name TEXT, tool_call_id TEXT, tool_type TEXT, chat_session_id TEXT,
      turn_index INTEGER, ttft_ms REAL
    );
    CREATE TABLE span_attributes (span_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (span_id, key));
  `);
  const span = db.prepare(`INSERT INTO spans (span_id, trace_id, parent_span_id, name, start_time_ms, end_time_ms,
    status_code, operation_name, conversation_id, response_model, input_tokens, output_tokens, cached_tokens, tool_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const attr = db.prepare('INSERT INTO span_attributes VALUES (?, ?, ?)');
  return { db, span, attr };
}

it('reads Copilot Agent Host harness spans from the Agent Host trace store, excluding other harnesses and duplicates', (t) => {
  let now = Date.UTC(2026, 9, 19, 12);
  t.mock.method(Date, 'now', () => now);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bear-agent-host-'));
  const userData = path.join(dir, 'Code');
  const store = new Map();
  const context = {
    globalStorageUri: { fsPath: path.join(userData, 'User', 'globalStorage', 'obrocki.bear-in-mind') },
    globalState: { get: (key) => store.get(key), update: async (key, value) => store.set(key, structuredClone(value)) }
  };
  globalThis.__BEAR_SETTINGS__ = { 'chat.agentHost.otel.dbSpanExporter.enabled:default': false };
  const deltas = [];
  const watcher = new OtelWatcher(context, (delta) => deltas.push(delta));
  t.after(() => {
    watcher.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
    delete globalThis.__BEAR_SETTINGS__;
  });

  watcher.scan();
  assert.equal(watcher.health().agentHostPath, undefined);
  assert.match(watcher.health().notes.join(' '), /chat\.agentHost\.otel\.dbSpanExporter\.enabled is on\. Connect can turn it on/);

  now += 2000;
  const file = path.join(userData, 'agent-host', 'otel', 'agent-host-traces.db');
  const { db, span, attr } = agentHostStore(file);
  const at = now - 1000;
  // The host's session anchor carries no GenAI operation; the runtime's invocation root sits under it.
  span.run('anchor', 't1', null, 'vscode.agent_host.session', at, at, 0, null, null, null, null, null, null, null);
  span.run('root', 't1', 'anchor', 'invoke_agent', at, now, 0, 'invoke_agent', 'harness-1', null, null, null, null, null);
  attr.run('root', 'github.copilot.nano_aiu', '3000000000');
  attr.run('root', 'enduser.pseudo.id', 'pseudo');
  span.run('call', 't1', 'root', 'chat', at + 10, at + 500, 0, 'chat', 'harness-1', 'opus', 400, 40, 100, null);
  attr.run('call', 'github.copilot.nano_aiu', '3000000000');
  attr.run('call', 'github.copilot.cost', '1');
  span.run('tool', 't1', 'root', 'execute_tool', at + 600, at + 700, 1, 'execute_tool', 'harness-1', null, null, null, null, 'view');
  // Recorded only by the Agent Host, with the semantic-convention cache-write and reasoning names it emits.
  span.run('call-2', 't1', 'root', 'chat', at + 800, at + 900, 0, 'chat', 'harness-1', 'opus', 600, 60, 500, null);
  attr.run('call-2', 'github.copilot.nano_aiu', '1000000000');
  attr.run('call-2', 'gen_ai.usage.cache_write.input_tokens', '0');
  attr.run('call-2', 'gen_ai.usage.reasoning.output_tokens', '12');
  // A Claude harness session in the same store: no github.copilot.* anywhere in its trace.
  span.run('claude-root', 't2', null, 'invoke_agent', at, now, 0, 'invoke_agent', 'claude-1', null, null, null, null, null);
  span.run('claude-call', 't2', 'claude-root', 'chat', at + 10, at + 500, 0, 'chat', 'claude-1', 'sonnet', 999, 99, 0, null);
  span.run('claude-tool', 't2', 'claude-root', 'execute_tool', at + 600, at + 700, 2, 'execute_tool', 'claude-1', null, null, null, null, 'Bash');
  db.close();

  // The same model call also reached the Local store: it counts once.
  const local = agentHostStore(path.join(dir, 'agent-traces.db'));
  local.span.run('call', 't1', 'root', 'chat', at + 10, at + 500, 0, 'chat', 'harness-1', 'opus', 400, 40, 100, null);
  local.db.close();
  globalThis.__BEAR_SETTINGS__['iceberg.otel.tracesDbPath'] = path.join(dir, 'agent-traces.db');
  now += 31_000; // past the path refresh interval
  watcher.scan();

  const digest = watcher.spanDigest;
  assert.equal(digest.chatCalls, 2, 'the Claude call and the duplicate are excluded');
  assert.equal(digest.inputTokens, 1000);
  assert.equal(digest.tokenCoverage.cacheWriteTokens.reportedCalls, 1, 'a reported zero under the semconv name counts');
  assert.equal(digest.reasoningTokens, 12);
  assert.equal(digest.sessions.length, 1);
  assert.equal(digest.sessions[0].sessionId, 'harness-1');
  assert.equal(digest.sdkCredits.invocations, 1, 'the host anchor does not hide the invocation root');
  assert.equal(digest.sdkCredits.unclassifiedInvocations, 0);
  assert.equal(digest.sdkCredits.credits, 3);
  assert.equal(digest.credits, 0, 'runtime nano_aiu is not promoted to VS Code per-call credits');
  assert.equal(digest.byActorId[0].key, 'pseudo');
  assert.equal(digest.toolStatusCalls, 1);
  assert.equal(digest.toolFailures, 0);
  assert.deepEqual(deltas, [
    { input: 400, output: 40, requests: 1, source: 'traces' },
    { input: 600, output: 60, requests: 1, source: 'harness' }
  ], 'a call the Local store also recorded reconciles with it; an Agent Host-only call is metered apart');

  const health = watcher.health();
  assert.equal(health.agentHostPath, file);
  assert.equal(health.agentHostActive, true);
  assert.equal(health.sqliteActive, true);
  globalThis.__BEAR_SETTINGS__['chat.agentHost.otel.dbSpanExporter.enabled'] = true;
  assert.equal(watcher.health().copilotOtelEnabled, true);
  assert.doesNotMatch(watcher.health().notes.join(' '), /agent-host-traces\.db/);
});

for (const order of ['agent host first', 'local first']) {
  it(`meters a call recorded by both stores once when they arrive on separate scans (${order})`, (t) => {
    let now = Date.UTC(2026, 9, 19, 12);
    t.mock.method(Date, 'now', () => now);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bear-overlap-'));
    const userData = path.join(dir, 'Code');
    const store = new Map();
    const context = {
      globalStorageUri: { fsPath: path.join(userData, 'User', 'globalStorage', 'obrocki.bear-in-mind') },
      globalState: { get: (key) => store.get(key), update: async (key, value) => store.set(key, structuredClone(value)) }
    };
    const localFile = path.join(dir, 'agent-traces.db');
    globalThis.__BEAR_SETTINGS__ = { 'iceberg.otel.tracesDbPath': localFile };
    const deltas = [];
    const watcher = new OtelWatcher(context, (delta) => deltas.push(delta));
    t.after(() => {
      watcher.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
      delete globalThis.__BEAR_SETTINGS__;
    });
    now += 2000;
    const at = now - 1000;
    const write = (file, input, output) => {
      const { db, span } = agentHostStore(file);
      span.run('root', 't1', null, 'invoke_agent', at, now, 0, 'invoke_agent', 'harness-1', null, null, null, null, null);
      span.run('call', 't1', 'root', 'chat', at + 10, at + 500, 0, 'chat', 'harness-1', 'opus', input, output, 0, null);
      if (file !== localFile) {
        db.prepare('INSERT INTO span_attributes VALUES (?, ?, ?)').run('call', 'github.copilot.nano_aiu', '1000000000');
      }
      db.close();
    };
    const agentHostFile = path.join(userData, 'agent-host', 'otel', 'agent-host-traces.db');
    const [first, second] = order === 'local first' ? [localFile, agentHostFile] : [agentHostFile, localFile];

    write(first, 100, 10);
    watcher.scan();
    now += 31_000; // past the path refresh interval
    write(second, 100, 10);
    watcher.scan();
    watcher.scan();

    if (order === 'local first') {
      assert.deepEqual(deltas, [{ input: 100, output: 10, requests: 1, source: 'traces' }],
        'a Local call stays in the reconciled ledger when the Agent Host copy appears');
    } else {
      assert.deepEqual(deltas, [
        { input: 100, output: 10, requests: 1, source: 'harness' },
        { input: 100, output: 10, requests: 1, source: 'traces', fromHarness: true }
      ], 'the harness charge moves to traces once a Local source records the call');
    }
    assert.equal(watcher.spanDigest.chatCalls, 1);
  });
}

function overlapFixture(t) {
  const { TokenMeter } = require(path.join(process.env.BEAR_TEST_BUILD, 'tokenMeter.js'));
  let now = Date.UTC(2026, 9, 19, 12);
  t.mock.method(Date, 'now', () => now);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bear-authoritative-'));
  const userData = path.join(dir, 'Code');
  const localFile = path.join(dir, 'agent-traces.db');
  const store = new Map();
  const memento = { get: (key) => store.get(key), update: async (key, value) => store.set(key, structuredClone(value)) };
  globalThis.__BEAR_SETTINGS__ = { 'iceberg.otel.tracesDbPath': localFile };
  const meter = new TokenMeter(memento);
  const watcher = new OtelWatcher(
    { globalStorageUri: { fsPath: path.join(userData, 'User', 'globalStorage', 'obrocki.bear-in-mind') }, globalState: memento },
    (delta) => delta.fromHarness
      ? meter.moveHarnessToTraces(delta.input, delta.output, delta.requests)
      : meter.observe(delta.source ?? 'otel', delta.input, delta.output, delta.requests)
  );
  t.after(() => {
    watcher.dispose();
    meter.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
    delete globalThis.__BEAR_SETTINGS__;
  });
  now += 2000;
  const at = now - 1000;
  const write = (file) => {
    const { db, span, attr } = agentHostStore(file);
    span.run('call', 't1', null, 'chat', at, at + 500, 0, 'chat', 'harness-1', 'opus', 100, 10, 0, null);
    if (file !== localFile) attr.run('call', 'github.copilot.nano_aiu', '1000000000');
    db.close();
  };
  const scan = () => {
    now += 31_000; // past the path refresh interval
    watcher.scan();
  };
  const authoritative = (value) => { globalThis.__BEAR_SETTINGS__['iceberg.otel.authoritative'] = value; };
  return { meter, scan, authoritative, writeAgentHost: () => write(path.join(userData, 'agent-host', 'otel', 'agent-host-traces.db')), writeLocal: () => write(localFile) };
}

it('never moves a display-only harness call into the meter when metering is switched on later', (t) => {
  const { meter, scan, authoritative, writeAgentHost, writeLocal } = overlapFixture(t);
  authoritative(false);
  writeAgentHost();
  scan();
  assert.equal(meter.snapshot().total, 0, 'display-only telemetry is not charged');
  authoritative(true);
  writeLocal();
  scan();
  scan();
  assert.equal(meter.snapshot().total, 0, 'no transfer of usage that was never charged');
  assert.equal(meter.snapshot().requests, 0);
});

it('retries a harness-to-traces move rejected while metering was display-only', (t) => {
  const { meter, scan, authoritative, writeAgentHost, writeLocal } = overlapFixture(t);
  meter.observe('otel', 100, 10, 0);
  writeAgentHost();
  scan();
  assert.equal(meter.snapshot().total, 220, 'charged as harness-only before the overlap is known');
  authoritative(false);
  writeLocal();
  scan();
  assert.equal(meter.snapshot().total, 220, 'the move is rejected while display-only');
  authoritative(true);
  scan();
  assert.equal(meter.snapshot().total, 110, 'the pending move is applied once metering resumes');
  assert.equal(meter.snapshot().requests, 1);
  scan();
  assert.equal(meter.snapshot().total, 110, 'and applied only once');
});
