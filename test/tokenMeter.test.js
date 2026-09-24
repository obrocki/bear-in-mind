'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { it } = require('node:test');
const { TokenMeter } = require(path.join(process.env.BEAR_TEST_BUILD, 'tokenMeter.js'));

function fixture(t, settings = {}, entries = []) {
  globalThis.__BEAR_SETTINGS__ = settings;
  const store = new Map(entries);
  const memory = {
    get: (key) => store.get(key),
    update: async (key, value) => store.set(key, structuredClone(value))
  };
  const meter = new TokenMeter(memory);
  t.after(() => { meter.dispose(); delete globalThis.__BEAR_SETTINGS__; });
  return { meter, store, memory };
}

it('does not count transcript context snapshots as consumed tokens', (t) => {
  const { meter } = fixture(t);
  meter.observe('transcripts', 90000, 1000, 1, 2.5);
  meter.observe('transcripts', 5000, 200, 1, 1.5);
  assert.equal(meter.snapshot().total, 0);
  assert.equal(meter.snapshot().requests, 0);
  assert.equal(meter.snapshot().credits, 4);
});

it('reconciles matching metrics and spans once, in either delivery order', (t) => {
  for (const sources of [['otel', 'traces'], ['traces', 'otel']]) {
    const { meter } = fixture(t);
    for (const source of sources) meter.observe(source, 90000, 1000, 1);
    assert.equal(meter.snapshot().total, 91000);
    assert.equal(meter.snapshot().requests, 1);
  }
});

it('never adds cached or reasoning subtotals to input/output', (t) => {
  const { meter } = fixture(t);
  meter.observe('otel', 1000, 100);
  meter.observe('traces', 1000, 100);
  assert.equal(meter.snapshot().total, 1100);
});

it('does not copy ledgers after idle, disablement, or delayed exports', (t) => {
  const { meter } = fixture(t);
  meter.observe('traces', 2000, 100, 2);
  meter.noteOtelAlive(false);
  meter.observe('otel', 2000, 100, 0);
  assert.equal(meter.snapshot().total, 2100);
  meter.noteOtelAlive(false);
  meter.observe('otel', 500, 50, 0);
  meter.observe('traces', 500, 50, 1);
  assert.equal(meter.snapshot().total, 2650);
  assert.equal(meter.snapshot().requests, 3);
});

it('reconciles each dimension independently without changing the split', (t) => {
  const { meter } = fixture(t);
  meter.observe('traces', 100, 20);
  meter.observe('otel', 200, 10);
  assert.equal(meter.snapshot().input, 200);
  assert.equal(meter.snapshot().output, 20);
});

it('has no arbitrary default target or implied percentage', (t) => {
  const { meter } = fixture(t);
  meter.observe('otel', 5000000, 1000000);
  assert.equal(meter.snapshot().budget, 0);
  assert.equal(meter.snapshot().basis, 'unavailable');
  assert.equal(meter.snapshot().health, 1, 'neutral drawing, not 100% of an invented limit');
});

it('honors an explicitly configured personal target and enabled dimensions', (t) => {
  const { meter } = fixture(t, { 'iceberg.tokenBudget': 1000, 'iceberg.countInputTokens': false });
  meter.observe('otel', 8000, 250);
  assert.equal(meter.snapshot().total, 250);
  assert.equal(meter.snapshot().health, 0.75);
  assert.equal(meter.snapshot().basis, 'budget');
});

it('uses recent observed prompt headroom and expires it to unscaled', (t) => {
  const { meter } = fixture(t);
  meter.setContext({ used: 75000, limit: 100000, atMs: Date.now(), model: 'test', sessionId: 's1' });
  assert.equal(meter.snapshot().health, 0.25);
  assert.equal(meter.snapshot().basis, 'context');
  meter.setContext({ used: 75000, limit: 100000, atMs: Date.now() - 31 * 60000, model: 'test' });
  assert.equal(meter.snapshot().basis, 'unavailable');
});

it('rejects invalid or future prompt readings without rendering NaN', (t) => {
  const { meter } = fixture(t);
  for (const context of [
    { used: 1, limit: Infinity, atMs: Date.now() },
    { used: NaN, limit: 100, atMs: Date.now() },
    { used: 1, limit: 100, atMs: Date.now() + 60000 }
  ]) {
    meter.setContext(context);
    assert.equal(meter.snapshot().basis, 'unavailable');
  }
});

it('keeps demo animation entirely outside persisted usage', (t) => {
  const { meter, store } = fixture(t);
  meter.observe('otel', 1000, 100);
  const before = meter.snapshot().total;
  meter.toggleDemo();
  assert.equal(meter.snapshot().basis, 'demo');
  assert.equal(meter.snapshot().total, before);
  meter.toggleDemo();
  meter.dispose();
  assert.equal(store.get('iceberg.usage.v4').manual.input, 0);
  assert.equal(meter.snapshot().total, before);
});

it('preserves old inflated estimates separately, never calls them measured usage', (t) => {
  const old = { otel: { input: 1000, output: 100 }, transcripts: { input: 500, output: 200 },
    manual: { input: 30, output: 20 }, credits: 500 };
  const { meter, memory, store } = fixture(t, {}, [['iceberg.usage.v3', old]]);
  assert.equal(meter.snapshot().legacyTokens, 1250);
  assert.equal(meter.snapshot().total, 0);
  assert.equal(meter.snapshot().credits, 0);
  meter.observe('otel', 100, 10);
  meter.dispose();
  const restarted = new TokenMeter(memory);
  t.after(() => restarted.dispose());
  assert.equal(restarted.snapshot().total, 110);
  assert.equal(restarted.snapshot().legacyTokens, 1250);
  assert.deepEqual(store.get('iceberg.usage.v3'), old, 'legacy state retained for diagnostics');
});

it('keeps manual usage labeled and adds it only once', (t) => {
  const { meter } = fixture(t);
  meter.observe('otel', 100, 10);
  meter.observe('traces', 100, 10);
  meter.report(20, 5);
  assert.equal(meter.snapshot().total, 135);
  assert.equal(meter.snapshot().manualTokens, 25);
});

it('keeps telemetry display-only when authoritative is disabled', (t) => {
  const { meter } = fixture(t, { 'iceberg.otel.authoritative': false });
  meter.observe('otel', 100, 10);
  meter.observe('traces', 100, 10);
  assert.equal(meter.snapshot().total, 0);
});
