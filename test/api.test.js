'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { it } = require('node:test');
const { createIcebergApi } = require(path.join(process.env.BEAR_TEST_BUILD, 'api.js'));
const { TokenMeter } = require(path.join(process.env.BEAR_TEST_BUILD, 'tokenMeter.js'));

function api(t) {
  globalThis.__BEAR_SETTINGS__ = {};
  const meter = new TokenMeter({ get: () => undefined, update: async () => {} });
  t.after(() => meter.dispose());
  return { meter, api: createIcebergApi(meter) };
}

it('shares object and legacy numeric reports through the same API callback', (t) => {
  const { api: a, meter } = api(t);
  meter.observe('traces', 1000, 100);
  const command = a.reportUsage;
  command({ input: 120, output: 30 });
  command(50);
  command({ output: 10 });
  assert.equal(a.getUsage().input, 1170);
  assert.equal(a.getUsage().output, 140);
  assert.equal(a.getUsage().requests, 4);
});

it('preserves normalization and ignores empty or invalid reports', (t) => {
  const { api: a } = api(t);
  a.reportUsage({});
  a.reportUsage(undefined);
  a.reportUsage({ input: -10, output: Infinity });
  a.reportUsage(NaN);
  assert.equal(a.getUsage().total, 0);
  a.reportUsage({ input: 1.6, output: 2.4 });
  assert.equal(a.getUsage().total, 4);
  assert.equal(a.getUsage().requests, 1);
});

it('exposes current snapshots and disposable usage events', (t) => {
  const { api: a } = api(t);
  const snapshots = [];
  const subscription = a.onDidChangeUsage((usage) => snapshots.push(usage));
  a.reportUsage({ input: 100 });
  assert.deepEqual(snapshots[0], a.getUsage());
  subscription.dispose();
  a.reportUsage({ output: 20 });
  assert.equal(snapshots.length, 1);
  assert.equal(a.getUsage().total, 120);
});
