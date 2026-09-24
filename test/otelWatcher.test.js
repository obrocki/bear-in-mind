'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { it } = require('node:test');
const { OtelWatcher } = require(path.join(process.env.BEAR_TEST_BUILD, 'otelWatcher.js'));

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
  const insert = db.prepare('INSERT INTO span_attributes VALUES (?, ?, ?)');
  insert.run('shared', 'copilot_chat.request.max_prompt_tokens', '128000');
  insert.run('shared', 'copilot_chat.copilot_usage_nano_aiu', '293200000000');
  insert.run('shared', 'gen_ai.usage.reasoning.output_tokens', '30');
  db.close();
  fs.writeFileSync(file, JSON.stringify(record) + '\n');
  globalThis.__BEAR_SETTINGS__['iceberg.otel.tracesDbPath'] = dbFile;
  watcher.scan();
  assert.equal(watcher.spanDigest.sessions[0].credits, 293.2);
  assert.equal(watcher.spanDigest.sessions[0].llmCalls, 1);
  assert.equal(watcher.spanDigest.reasoningTokens, 30);
  assert.equal(watcher.spanDigest.context.limit, 128000);
  assert.deepEqual(deltas, [{ input: 1000, output: 100, requests: 1, source: 'traces' }]);
  assert.equal(watcher.health().sqliteActive, true);
});
