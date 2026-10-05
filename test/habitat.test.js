'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { it } = require('node:test');
const { createScene } = require('../tools/scene-harness');
const { TokenMeter } = require(path.join(process.env.BEAR_TEST_BUILD, 'tokenMeter.js'));

it('keeps the habitat percentage and token fraction on the same basis', () => {
  globalThis.__BEAR_SETTINGS__ = { 'iceberg.tokenBudget': 5000000 };
  const m = new TokenMeter({ get: () => undefined, update: () => Promise.resolve() });
  const scene = createScene(path.resolve(__dirname, '..'), 330, 300);
  try {
    m.observe('otel', 2000000, 100000, 1);
    scene.setState(m.snapshot());
    assert.equal(scene.els.pct.textContent, '58%');
    assert.equal(scene.els.tokens.textContent, 'Counted 2,100,000 / target 5,000,000 tokens');
    assert.equal(scene.els.basis.textContent, 'local budget remaining');

    m.setContext({ used: 136600, limit: 1000000, model: 'gpt-5.6-sol', atMs: Date.now() });
    scene.setState(m.snapshot());
    assert.equal(scene.els.pct.textContent, '86%');
    assert.equal(scene.els.tokens.textContent, 'Prompt used 136,600 / limit 1,000,000 tokens');
    assert.equal(scene.els.basis.textContent, 'latest prompt free');
    assert.match(scene.els.source.textContent, /comparison session/);
    assert.match(scene.els.split.textContent, /local in 2\.0M/);

    m.setContext({ used: 136600, limit: 1000000, model: null, atMs: Date.now() - 3600000 });
    scene.setState(m.snapshot());
    assert.equal(scene.els.pct.textContent, '58%');
    assert.equal(scene.els.tokens.textContent, 'Counted 2,100,000 / target 5,000,000 tokens');
    assert.equal(scene.els.basis.textContent, 'local budget remaining');
  } finally {
    m.dispose();
    delete globalThis.__BEAR_SETTINGS__;
  }
});

it('never shows a percentage or 5M target when the gauge has no measured denominator', () => {
  const m = new TokenMeter({ get: () => undefined, update: async () => {} });
  const scene = createScene(path.resolve(__dirname, '..'), 330, 300);
  try {
    m.observe('otel', 9000000, 1000000);
    scene.setState(m.snapshot());
    assert.equal(scene.els.pct.textContent, '—');
    assert.equal(scene.els.basis.textContent, 'ice unscaled');
    assert.equal(scene.els.fill.style.width, '0%');
    assert.doesNotMatch(scene.els.tokens.textContent, /5,000,000/);
  } finally {
    m.dispose();
  }
});

it('shows combined account consumption against its plan allowance, not local tokens or one chat', () => {
  const m = new TokenMeter({ get: () => undefined, update: async () => {} });
  const scene = createScene(path.resolve(__dirname, '..'), 330, 300);
  try {
    m.observe('otel', 80000, 20000);
    m.setAccountUsage({ status: 'ready', quota: {
      login: 'octocat', plan: 'pro', unit: 'credits', unlimited: false,
      allowance: 1000, used: 250, percentRemaining: 75, approximate: false, fetchedAtMs: Date.now()
    } });
    scene.setState(m.snapshot());
    assert.equal(scene.els.pct.textContent, '75%');
    assert.equal(scene.els.tokens.textContent, '250 used / 1,000 credits allowance');
    assert.equal(scene.els.basis.textContent, 'plan allowance remaining');
    assert.equal(scene.els.source.textContent, 'all sessions · GitHub account');
    m.setAccountUsage({ status: 'error', message: 'GitHub quota lookup failed' });
    scene.setState(m.snapshot());
    assert.equal(scene.els.pct.textContent, '—');
    assert.equal(scene.els.source.textContent, 'account usage unavailable');
    assert.equal(scene.els.source.title, 'GitHub quota lookup failed');
    m.setSessionSelected(true);
    m.setContext({ used: 300, limit: 1000, atMs: Date.now(), model: 'test', sessionId: 's' });
    scene.setState(m.snapshot());
    assert.equal(scene.els.pct.textContent, '70%');
    assert.equal(scene.els.source.textContent, 'comparison session · prompt', 'an account error must not mislabel selected-chat context');
    m.setSessionSelected(false);
    scene.setState(m.snapshot());
    assert.equal(scene.els.pct.textContent, '—', 'All sessions must not retain a pinned chat context');
  } finally {
    m.dispose();
  }
});
