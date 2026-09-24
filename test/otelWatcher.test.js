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
