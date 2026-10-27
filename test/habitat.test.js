'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { it } = require('node:test');
const { createScene } = require('../tools/scene-harness');
const { TokenMeter } = require(path.join(process.env.BEAR_TEST_BUILD, 'tokenMeter.js'));
const { CLIMATE_STALE_MS, climateFor } = require(path.join(process.env.BEAR_TEST_BUILD, 'climate.js'));

/** A model whose retained calls averaged `credits` per call, observed a minute ago. */
function climateOf(model, credits, extra = {}) {
  return climateFor({ model, atMs: Date.now() - 60_000, sessionId: 's', ...extra },
    [{ key: model, calls: 6, creditCalls: 5, credits: credits * 5 }]);
}

function render(climate, health = 1) {
  const scene = createScene(path.resolve(__dirname, '..'), 480, 300);
  scene.step(16);
  scene.setState({ health, input: 0, output: 0, total: 0, budget: 0, basis: 'demo', source: 'otel',
    bearName: 'Nanuq', animate: true, pixelScale: 2, climate });
  for (let i = 0; i < 90; i++) scene.step(33);
  return scene;
}

/** Mean of one channel over the sky above the horizon. */
function skyMean(scene, channel) {
  const { width, data } = scene.canvas;
  const rows = Math.round(scene.canvas.height * 0.6);
  let sum = 0;
  for (let i = 0; i < width * rows; i++) sum += data[i * 4 + channel];
  return sum / (width * rows);
}

it('weathers the scene by model pace without touching the ice or the neutral HUD', () => {
  const neutral = render(undefined);
  const light = render(climateOf('gpt-5.6-luna', 0.1));
  const heavy = render(climateOf('claude-opus-5.5', 19, { effort: 'high', promptLimit: 1_000_000 }));

  assert.equal(neutral.els.climateRow.hidden, true);
  assert.equal(neutral.els.climate.textContent, '');
  for (const scene of [light, heavy]) {
    assert.equal(scene.els.pct.textContent, neutral.els.pct.textContent, 'weather never changes the ice');
    assert.equal(scene.els.climateRow.hidden, false);
  }
  assert.equal(light.els.climate.textContent, 'snowy weather · gpt-5.6-luna · ~0.10 credits/call');
  assert.equal(heavy.els.climate.textContent, 'thawing weather · claude-opus-5.5 · ~19 credits/call');
  assert.match(heavy.els.climate.title, /across 5 retained calls that reported credits/);
  assert.match(heavy.els.climate.title, /Reasoning effort: high\. Prompt limit: 1,000,000 tokens/);
  assert.match(heavy.els.climate.title, /not energy or emissions/);
  assert.match(light.els.climate.title, /Reasoning effort: not reported\. Prompt limit: not reported/);

  assert.ok(skyMean(heavy, 0) > skyMean(neutral, 0) + 10, 'a heavy model warms the sky');
  let changed = 0;
  for (let i = 0; i < light.canvas.data.length; i += 4) {
    if (Math.abs(light.canvas.data[i + 2] - neutral.canvas.data[i + 2]) > 24) changed++;
  }
  assert.ok(changed > light.canvas.data.length / 4 * 0.05, 'a light model clouds and snows the sky');
});

/** Pixels in the sky that read as aurora green. */
function auroraPixels(scene) {
  const { width, data } = scene.canvas;
  const rows = Math.round(scene.canvas.height * 0.6);
  let n = 0;
  for (let i = 0; i < width * rows; i++) {
    if (data[i * 4 + 1] > data[i * 4] + 50 && data[i * 4 + 1] > 70) n++;
  }
  return n;
}

it('brings a clear aurora night and a happy bear for a local model, without touching the ice', () => {
  const local = climateFor({ model: 'qwen3-coder:30b', host: 'localhost', atMs: Date.now() - 60_000, sessionId: 's' }, []);
  const neutral = render(undefined, 0.3);
  const aurora = render(local, 0.3);

  assert.equal(aurora.els.pct.textContent, neutral.els.pct.textContent, 'the local weather never changes the ice');
  assert.equal(aurora.els.climateRow.hidden, false);
  assert.equal(aurora.els.climate.textContent, 'aurora weather · qwen3-coder:30b · on this machine');
  assert.equal(aurora.els.climate.dataset.local, 'true');
  assert.equal(neutral.els.climate.dataset.local, 'false');
  assert.match(aurora.els.climate.title, /went to localhost, an endpoint on this machine/);
  assert.match(aurora.els.climate.title, /Copilot reported no AI credits for qwen3-coder:30b/);
  assert.match(aurora.els.climate.title, /A local proxy to a cloud service looks the same/);
  assert.match(aurora.els.climate.title, /not energy or emissions/);

  assert.ok(skyMean(aurora, 0) < skyMean(neutral, 0) - 30, 'low ice does not warm the aurora sky');
  assert.ok(auroraPixels(aurora) > 1000 && auroraPixels(neutral) === 0, 'the aurora fills the sky');

  const configured = render(climateFor(
    { model: 'llama3.3:70b', host: 'gpu-box.lan', atMs: Date.now() - 60_000, sessionId: 's' }, [], Date.now(), ['gpu-box.lan']
  ));
  assert.equal(configured.els.climate.textContent, 'aurora weather · llama3.3:70b · on gpu-box.lan');
  assert.match(configured.els.climate.title, /listed in iceberg\.climate\.localHosts/);

  const shrinking = render(local, 0);
  assert.equal(shrinking.els.pct.textContent, '0%', 'no ice is still no ice');
});

it('returns to the neutral scene when the climate goes stale, is disabled or the demo runs', () => {
  const m = new TokenMeter({ get: () => undefined, update: async () => {} });
  const scene = createScene(path.resolve(__dirname, '..'), 330, 300);
  try {
    m.setClimate(climateOf('gpt-5.3-codex', 0.6));
    scene.setState(m.snapshot());
    assert.equal(scene.els.climateRow.hidden, false);
    assert.match(scene.els.climate.textContent, /^mild weather · gpt-5\.3-codex · ~0\.60 credits\/call$/);

    globalThis.__BEAR_SETTINGS__ = { 'iceberg.climate.enabled': false };
    scene.setState(m.snapshot());
    assert.equal(scene.els.climateRow.hidden, true);
    delete globalThis.__BEAR_SETTINGS__;

    m.toggleDemo();
    scene.setState(m.snapshot());
    assert.equal(scene.els.climateRow.hidden, true);
    m.toggleDemo();

    m.setClimate({ ...climateOf('gpt-5.3-codex', 0.6), atMs: Date.now() - CLIMATE_STALE_MS - 1000 });
    scene.setState(m.snapshot());
    assert.equal(scene.els.climateRow.hidden, true);
    assert.equal(scene.els.climate.textContent, '');

    const local = climateFor({ model: 'qwen3-coder:30b', host: '::1', atMs: Date.now() - 1000, sessionId: 's' }, []);
    m.setClimate(local);
    scene.setState(m.snapshot());
    assert.match(scene.els.climate.textContent, /^aurora weather/);
    globalThis.__BEAR_SETTINGS__ = { 'iceberg.climate.enabled': false };
    scene.setState(m.snapshot());
    assert.equal(scene.els.climateRow.hidden, true, 'the setting also turns the local aurora off');
    assert.equal(scene.els.climate.dataset.local, 'false');
    delete globalThis.__BEAR_SETTINGS__;
    m.toggleDemo();
    scene.setState(m.snapshot());
    assert.equal(scene.els.climateRow.hidden, true, 'the demo never shows the local aurora');
    m.toggleDemo();
  } finally {
    delete globalThis.__BEAR_SETTINGS__;
    m.dispose();
  }
});

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
