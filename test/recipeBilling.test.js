'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { it } = require('node:test');
const { pathToFileURL } = require('node:url');
const load = (file) => import(pathToFileURL(path.join(__dirname, '..', '.github', 'extensions', 'ai-attribution', 'lib', file)).href);
const NOW = Date.UTC(2026, 9, 22, 10);
const DAY = '2026-10-20';
const SCOPE = { level: 'organization', account: 'fable', user: 'alex', day: DAY };
const item = (extra = {}) => ({
  product: 'Copilot', sku: 'Copilot AI credits', model: 'model-a', unitType: 'AI credits', pricePerUnit: 0.01,
  grossQuantity: 100, grossAmount: 1, discountQuantity: 40, discountAmount: 0.4, netQuantity: 60, netAmount: 0.6,
  ...extra,
});
const body = (items = [item()], extra = {}) => ({
  timePeriod: { year: 2026, month: 10, day: 20 }, organization: 'fable', user: 'alex', product: 'Copilot', usageItems: items, ...extra,
});

it('billing validates scope before any network call and only accepts a completed UTC day', async () => {
  const { billingScope, fetchBilling } = await load('billing.mjs');
  assert.deepEqual(billingScope(SCOPE, NOW), { ...SCOPE, product: 'Copilot' });
  for (const input of [
    { ...SCOPE, account: 'fable/../../else' }, { ...SCOPE, user: 'alex&admin=true' },
    { ...SCOPE, day: '2026-02-30' }, { ...SCOPE, day: '2026-10-22' }, { ...SCOPE, day: '2026-10-23' },
    { ...SCOPE, level: 'user' }, { ...SCOPE, level: 'something' },
  ]) {
    await assert.rejects(fetchBilling(input, { now: NOW, run: async () => assert.fail('invalid scope must not run gh') }));
  }
});

it('billing calls only GitHub, with an explicit paying level, user, product and UTC day', async () => {
  const { fetchBilling } = await load('billing.mjs');
  for (const [level, account, prefix] of [['organization', 'fable', 'organizations'], ['enterprise', 'fable', 'enterprises'], ['user', 'alex', 'users']]) {
    const calls = [];
    const report = await fetchBilling({ ...SCOPE, level, account }, {
      now: NOW, env: {},
      run: async (command, args, options) => {
        calls.push(args);
        assert.equal(command, 'gh');
        assert.equal(options.timeout, 30000);
        const response = body();
        delete response.organization;
        response[level === 'organization' ? 'organization' : level === 'enterprise' ? 'enterprise' : 'user'] = account;
        return { code: 0, stdout: JSON.stringify(response) };
      },
    });
    assert.equal(report.status, 'ok');
    assert.equal(calls.length, 1);
    const args = calls[0];
    assert.ok(args.includes(`/${prefix}/${account}/settings/billing/ai_credit/usage`));
    assert.deepEqual(args.slice(0, 5), ['api', '--hostname', 'github.com', '--method', 'GET']);
    for (const field of ['year=2026', 'month=10', 'day=20', 'product=Copilot']) assert.ok(args.includes(field));
    assert.equal(args.includes('user=alex'), level !== 'user');
    assert.equal(report.scope.day, DAY);
  }
});

it('billing preserves gross, discounts, net, SKU and requested scope without retaining arbitrary response fields', async () => {
  const { parseBillingReport, billingScope } = await load('billing.mjs');
  const scope = billingScope(SCOPE, NOW);
  const report = parseBillingReport(body([item({ private: 'do-not-retain' })], { arbitrary: 'do-not-retain' }), scope, new Date(NOW).toISOString());
  assert.equal(report.items[0].grossQuantity, 100);
  assert.equal(report.items[0].discountQuantity, 40);
  assert.equal(report.items[0].netQuantity, 60);
  assert.equal(report.items[0].netAmount, 0.6);
  assert.doesNotMatch(JSON.stringify(report), /do-not-retain/);
  const noEchoedFilters = body();
  delete noEchoedFilters.user;
  delete noEchoedFilters.product;
  assert.deepEqual(parseBillingReport(noEchoedFilters, scope, '').scope, scope, 'request filters carry the grain even when response omits them');
});

it('scope mismatches, missing amounts, unsupported units and malformed reports fail rather than looking like zero usage', async () => {
  const { parseBillingReport, billingScope } = await load('billing.mjs');
  const scope = billingScope(SCOPE, NOW);
  for (const invalid of [
    body([item({ unitType: 'premium requests' })]), body([item({ grossQuantity: '100' })]),
    body([item({ netAmount: undefined })]), body([item({ pricePerUnit: -1 })]),
    body([item({ model: null })]), body([item({ product: 'Other product' })]),
    body([], { user: 'blair' }), body([], { organization: 'other' }),
    body([], { timePeriod: { year: 2026, month: 10 } }),
  ]) assert.throws(() => parseBillingReport(invalid, scope, ''));
  assert.deepEqual(parseBillingReport(body([]), scope, '').items, [], 'an explicit empty valid report is supported');
});

it('reconciliation compares native user/day/model only and allocates a bounded estimated work share', async () => {
  const { CycleCollector, buildRecipe } = await load('recipe.mjs');
  const { parseBillingReport, billingScope, reconcileBilling } = await load('billing.mjs');
  const c = new CycleCollector();
  const add = (credits, extra = {}) => c.addCall('traces', {
    repository: 'fable/widgets', branch: 'alex/1-change', user: 'alex', model: 'model-a',
    at: Date.parse(`${DAY}T12:00:00Z`), credited: true, nano: credits * 1e9, ...extra,
  });
  add(40);
  add(10, { repository: null });
  add(15, { user: null });
  add(99, { user: 'blair' });
  add(900, { at: Date.parse('2026-10-19T12:00:00Z') });
  add(25, { model: 'unmatched-alias' });
  c.addCall('sessionStore', { user: 'alex', model: 'model-a', at: Date.parse(`${DAY}T12:00:00Z`), credited: true, nano: 300e9 });
  const recipe = buildRecipe(c);
  const report = parseBillingReport(body(), billingScope(SCOPE, NOW), '');
  const result = reconcileBilling(report, recipe, 'traces');
  assert.equal(result.observed, 50);
  assert.equal(result.difference, 50);
  assert.equal(result.unmatchedBilling, 50);
  assert.equal(result.outsideModelScope, 25);
  assert.equal(result.unknownIdentity, 15);
  assert.equal(result.work.length, 1);
  assert.equal(result.work[0].grossQuantity, 40);
  assert.equal(result.work[0].netAmount, 0.24);
  assert.equal(result.work[0].method, 'estimated-share');
  assert.equal(result.work[0].tier, undefined);
  assert.equal(result.unallocatedNetAmount, 0.36, 'unlinked work and missing observations keep their unallocated balance');
  const other = reconcileBilling(report, recipe, 'sessionStore');
  assert.equal(other.observed, 300);
  assert.equal(other.localExceedsBilling, true);
  assert.deepEqual(other.work, []);
});

it('model-level mismatches cannot cancel out or manufacture work allocations', async () => {
  const { reconcileBilling, parseBillingReport, billingScope } = await load('billing.mjs');
  const report = parseBillingReport(body([
    item({ model: 'model-a', grossQuantity: 10 }), item({ model: 'model-b', grossQuantity: 10 }),
  ]), billingScope(SCOPE, NOW), '');
  const usage = (model, credits) => ({
    source: 'traces', actor: { key: 'github:alex' }, day: DAY, model, credits, calls: 1, creditedCalls: 1, cycleKey: 'work',
  });
  const result = reconcileBilling(report, { billingUsage: [usage('MODEL-A', 15), usage('model-b', 5)] }, 'traces');
  assert.equal(result.difference, 0);
  assert.equal(result.unmatchedBilling, 5, 'positive and negative per-model gaps do not hide each other');
  assert.equal(result.localExceedsBilling, true);
  assert.equal(result.work[0].grossQuantity, 5, 'only the non-exceeding model is allocated');
});

it('missing identity or credit reports stay unknown, while a reported zero stays zero', async () => {
  const { reconcileBilling, parseBillingReport, billingScope, billingView } = await load('billing.mjs');
  const report = parseBillingReport(body(), billingScope(SCOPE, NOW), '');
  const row = { source: 'traces', day: DAY, model: 'model-a', actor: null, credits: 20, creditedCalls: 1, calls: 1 };
  assert.equal(reconcileBilling(report, { billingUsage: [row] }, 'traces').observed, null);
  row.actor = { key: 'github:alex' }; row.credits = 0; row.creditedCalls = 0;
  assert.equal(reconcileBilling(report, { billingUsage: [row] }, 'traces').observed, null);
  row.creditedCalls = 1;
  assert.equal(reconcileBilling(report, { billingUsage: [row] }, 'traces').observed, 0);
  assert.deepEqual(billingView(null, {}), { status: 'disconnected' });
  assert.deepEqual(billingView({ status: 'error', reason: 'denied' }, {}).sources, []);
});

it('billing failures never leak credential or raw response text', async () => {
  const { fetchBilling } = await load('billing.mjs');
  for (const response of [
    { missing: true, stderr: 'secret' },
    { code: 1, stderr: 'HTTP 403 secret' },
    { code: 1, stderr: 'HTTP 503 secret' },
    { code: 0, stdout: '{"secret": invalid json' },
  ]) {
    const report = await fetchBilling(SCOPE, { now: NOW, run: async () => response });
    assert.equal(report.status, 'error');
    assert.doesNotMatch(JSON.stringify(report), /secret/);
    assert.equal(report.items, undefined);
  }
});
