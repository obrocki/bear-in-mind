'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { it } = require('node:test');
const build = process.env.BEAR_TEST_BUILD;
const {
  BACKUP_KEY,
  RESET_KEY,
  SealableMemento,
  contributedSettings,
  describeAction,
  legacyActions,
  planCopilotRestore,
  planSettingsReset,
  recordBackup
} = require(path.join(build, 'restore.js'));

const FEED = path.resolve('/tmp/bear/copilot-otel.jsonl');

function memory(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    keys: () => [...values.keys()],
    get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
    update: async (key, value) => {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    }
  };
}

it('keeps the first original value when connecting more than once', () => {
  let backup = recordBackup(undefined, 'enabled', undefined, true);
  backup = recordBackup(backup, 'outfile', '/theirs.jsonl', FEED);
  backup = recordBackup(backup, 'enabled', true, true);
  backup = recordBackup(backup, 'outfile', FEED, '/other.jsonl');
  assert.deepEqual(backup, {
    enabled: { hadValue: false, applied: true },
    outfile: { hadValue: true, value: '/theirs.jsonl', applied: '/other.jsonl' }
  });
});

it('restores backed-up settings to their original user values', () => {
  const actions = planCopilotRestore({
    current: { enabled: true, 'dbSpanExporter.enabled': true, outfile: FEED, exporterType: 'file' },
    backup: {
      enabled: { hadValue: true, value: false, applied: true },
      'dbSpanExporter.enabled': { hadValue: false, applied: true },
      outfile: { hadValue: true, value: '/theirs.jsonl', applied: FEED },
      exporterType: { hadValue: true, value: 'otlp-http', applied: 'file' }
    },
    feedPaths: [FEED],
    collectorConfigured: true
  });
  assert.deepEqual(actions, [
    { key: 'enabled', kind: 'restore', value: false },
    { key: 'dbSpanExporter.enabled', kind: 'remove' },
    { key: 'outfile', kind: 'restore', value: '/theirs.jsonl' },
    { key: 'exporterType', kind: 'restore', value: 'otlp-http' }
  ]);
});

it('leaves settings the user changed after connecting, and skips ones already restored', () => {
  const actions = planCopilotRestore({
    current: { enabled: true, outfile: '/moved-by-user.jsonl' },
    backup: {
      enabled: { hadValue: true, value: true, applied: true },
      outfile: { hadValue: false, applied: FEED }
    },
    feedPaths: [FEED],
    collectorConfigured: false
  });
  assert.deepEqual(actions, [{ key: 'outfile', kind: 'keep', reason: 'changed after Bear in Mind set it' }]);
});

it('without a backup, only resets values Bear in Mind would have written', () => {
  const connected = planCopilotRestore({
    current: { enabled: true, dbSpanExporter: true, outfile: FEED, exporterType: 'file' },
    backup: undefined,
    feedPaths: [FEED],
    collectorConfigured: false
  });
  assert.deepEqual(connected.map((a) => [a.key, a.kind]), [
    ['outfile', 'remove'],
    ['exporterType', 'remove'],
    ['dbSpanExporter', 'remove'],
    ['enabled', 'remove']
  ]);

  const theirs = planCopilotRestore({
    current: { enabled: true, outfile: '/theirs.jsonl', exporterType: 'file' },
    backup: undefined,
    feedPaths: [FEED],
    collectorConfigured: true
  });
  assert.deepEqual(theirs, [
    { key: 'enabled', kind: 'keep', reason: 'an OTLP collector is configured, so it may predate Bear in Mind' }
  ]);

  assert.deepEqual(planCopilotRestore({ current: {}, backup: undefined, feedPaths: [FEED], collectorConfigured: false }), []);
});

it('reconnecting after an upgrade does not record our earlier values as the user originals', () => {
  // Mirrors connectTelemetry: values an earlier version wrote are recorded as "no user value".
  const before = { enabled: true, 'dbSpanExporter.enabled': true, outfile: FEED, exporterType: 'file' };
  const owned = new Set(
    legacyActions({ current: before, backup: undefined, feedPaths: [FEED], collectorConfigured: false })
      .filter((a) => a.kind === 'remove').map((a) => a.key)
  );
  let backup;
  for (const [key, value] of Object.entries(before)) {
    backup = recordBackup(backup, key, owned.has(key) ? undefined : before[key], value);
  }
  const actions = planCopilotRestore({ current: before, backup, feedPaths: [FEED], collectorConfigured: false });
  assert.deepEqual(actions.map((a) => [a.key, a.kind]).sort(), [
    ['dbSpanExporter.enabled', 'remove'],
    ['enabled', 'remove'],
    ['exporterType', 'remove'],
    ['outfile', 'remove']
  ]);
});

it('describes each action for the confirmation dialog', () => {
  const section = 'github.copilot.chat.otel';
  assert.equal(describeAction(section, { key: 'outfile', kind: 'remove' }), 'github.copilot.chat.otel.outfile → default');
  assert.equal(
    describeAction(section, { key: 'enabled', kind: 'restore', value: false }),
    'github.copilot.chat.otel.enabled → false (your previous value)'
  );
  assert.match(describeAction(section, { key: 'enabled', kind: 'keep', reason: 'why' }), /left alone \(why\)/);
});

it('finds contributed settings and the scopes where they are customised', () => {
  const keys = contributedSettings({
    contributes: { configuration: { properties: { 'iceberg.tokenBudget': {}, 'iceberg.bearName': {}, 'iceberg.animate': {} } } }
  });
  assert.deepEqual(keys, ['iceberg.tokenBudget', 'iceberg.bearName', 'iceberg.animate']);
  assert.deepEqual(contributedSettings({ contributes: { configuration: [{ properties: { a: {} } }, { properties: { b: {} } }] } }), ['a', 'b']);
  assert.deepEqual(contributedSettings(undefined), []);

  const plan = planSettingsReset(keys, (key) => ({
    'iceberg.tokenBudget': { globalValue: 5000 },
    'iceberg.bearName': { globalValue: 'Ice', workspaceValue: 'Team bear' },
    'iceberg.animate': {}
  })[key]);
  assert.deepEqual(plan, [
    { key: 'iceberg.tokenBudget', scopes: ['global'] },
    { key: 'iceberg.bearName', scopes: ['global', 'workspace'] }
  ]);
});

it('clears stored state and refuses writes afterwards, including on dispose', async () => {
  const inner = memory({ 'iceberg.usage.v4': { since: 1 }, [BACKUP_KEY]: {}, 'iceberg.otelWatch.v1': {} });
  const store = new SealableMemento(inner);
  await store.update('iceberg.chatCredits.v1', { seeded: true });
  assert.equal(store.keys().length, 4);
  assert.equal(store.isSealed, false);

  await store.clear();
  assert.equal(store.isSealed, true);
  assert.deepEqual(inner.keys(), []);

  await store.update('iceberg.usage.v4', { since: 2 });
  assert.deepEqual(inner.keys(), []);
  assert.equal(store.get('iceberg.usage.v4', 'fallback'), 'fallback');
});

it('publishes the reset marker before deleting anything', async () => {
  const order = [];
  const shared = memory({ a: 1, b: 2 });
  const update = shared.update;
  shared.update = (key, value) => { order.push(key); return update(key, value); };
  await new SealableMemento(shared, RESET_KEY).clear(99);
  assert.equal(order[0], RESET_KEY);
  assert.deepEqual(shared.keys(), [RESET_KEY]);
  assert.equal(shared.get(RESET_KEY), 99);
});

it('other windows sharing global state stop saving after a reset, and new windows start fresh', async () => {
  const shared = memory({ 'iceberg.usage.v4': { since: 1 } });
  const resetter = new SealableMemento(shared, RESET_KEY);
  const other = new SealableMemento(shared, RESET_KEY);
  await other.update('iceberg.chatCredits.v1', { seeded: true });
  assert.equal(shared.values.has('iceberg.chatCredits.v1'), true);

  await resetter.clear(1234);
  assert.deepEqual(shared.keys(), [RESET_KEY]);
  assert.equal(other.isSealed, true);
  await other.update('iceberg.chatCredits.v1', { seeded: true });
  assert.deepEqual(shared.keys(), [RESET_KEY]);

  const reloaded = new SealableMemento(shared, RESET_KEY);
  assert.equal(reloaded.isSealed, false);
  await reloaded.update('iceberg.usage.v4', { since: 2 });
  assert.deepEqual(shared.get('iceberg.usage.v4'), { since: 2 });
  assert.equal(other.isSealed, true, 'a stale window stays sealed once a newer window writes');
});

it('a meter disposed after the reset does not write its ledger back', async () => {
  const { TokenMeter } = require(path.join(build, 'tokenMeter.js'));
  const inner = memory();
  const store = new SealableMemento(inner);
  const meter = new TokenMeter(store);
  meter.observe('otel', 100, 10, 1);
  await store.clear();
  meter.dispose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(inner.keys(), []);
});
