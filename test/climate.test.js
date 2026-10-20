'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { it } = require('node:test');
const build = (name) => require(path.join(process.env.BEAR_TEST_BUILD, name));
const {
  CLIMATE_MIN_CREDIT_CALLS, CLIMATE_STALE_MS, CREDITS_PER_CALL_HIGH, CREDITS_PER_CALL_LOW,
  climateFor, contextLevel, creditWeight, effortLevel
} = build('climate.js');
const { digestSpans, usageSpan } = build('spanUsage.js');
const { TokenMeter } = build('tokenMeter.js');

const now = Date.UTC(2026, 9, 20, 12);
const call = (model, extra = {}) => ({ model, atMs: now - 60_000, sessionId: 's', ...extra });
const tally = (key, credits, creditCalls, calls = creditCalls) => ({ key, calls, creditCalls, credits });

it('maps credits per call onto a fixed log scale between the calibrated anchors', () => {
  assert.equal(creditWeight(0), 0, 'a measured zero is the lightest pace');
  assert.equal(creditWeight(CREDITS_PER_CALL_LOW), 0);
  assert.equal(creditWeight(CREDITS_PER_CALL_HIGH), 1);
  assert.equal(creditWeight(1000), 1);
  assert.equal(creditWeight(Number.NaN), 0);
  assert.ok(Math.abs(creditWeight(Math.sqrt(CREDITS_PER_CALL_LOW * CREDITS_PER_CALL_HIGH)) - 0.5) < 1e-12);
  assert.ok(creditWeight(0.6) < creditWeight(8) && creditWeight(8) < creditWeight(19));
});

it('puts calibrated light, mid and heavy models in snowy, mild and thawing bands', () => {
  const byModel = [
    tally('gpt-4o-mini', 0, 40), tally('gpt-5.6-luna', 0.106 * 18, 18), tally('gpt-5.3-codex', 0.608 * 4, 4),
    tally('gpt-5.6-sol', 8.1 * 10, 10), tally('claude-opus-5.5', 19.2 * 10, 10)
  ];
  const band = (model) => climateFor(call(model), byModel, now).band;
  assert.equal(band('gpt-4o-mini'), 'snowy');
  assert.equal(band('gpt-5.6-luna'), 'snowy');
  assert.equal(band('gpt-5.3-codex'), 'mild');
  assert.equal(band('gpt-5.6-sol'), 'thawing');
  assert.equal(band('claude-opus-5.5'), 'thawing');
});

it('averages only calls that reported credits and treats too few as unknown, never as light', () => {
  const average = climateFor(call('m'), [tally('m', 30, 3, 10)], now);
  assert.equal(average.creditsPerCall, 10, 'calls without credits are excluded, not zero');
  assert.equal(average.sampleCalls, 3);

  assert.equal(climateFor(call('m'), [tally('m', 30, CLIMATE_MIN_CREDIT_CALLS - 1, 50)], now), undefined);
  assert.equal(climateFor(call('m'), [tally('m', 0, 0, 50)], now), undefined, 'no reported credits is unknown, not zero');
  assert.equal(climateFor(call('other'), [tally('m', 30, 3)], now), undefined);
  assert.equal(climateFor(call(null), [tally(null, 30, 3)], now), undefined);
  assert.equal(climateFor(undefined, [tally('m', 30, 3)], now), undefined);
  assert.equal(climateFor(call('m'), [tally('m', -3, 3)], now), undefined);
});

it('expires with the latest call and rejects calls from the future', () => {
  const byModel = [tally('m', 3, 3)];
  assert.ok(climateFor(call('m', { atMs: now - CLIMATE_STALE_MS }), byModel, now));
  assert.equal(climateFor(call('m', { atMs: now - CLIMATE_STALE_MS - 1 }), byModel, now), undefined);
  assert.equal(climateFor(call('m', { atMs: now + 1 }), byModel, now), undefined);
});

it('maps reasoning effort and prompt limits, leaving unreported values absent', () => {
  assert.equal(effortLevel('low'), 0.2);
  assert.equal(effortLevel('high'), 0.8);
  assert.equal(effortLevel('max'), 1);
  assert.equal(effortLevel('turbo'), undefined);
  assert.equal(effortLevel('constructor'), undefined);
  assert.equal(effortLevel(undefined), undefined);
  assert.equal(contextLevel(32_000), 0);
  assert.equal(contextLevel(1_000_000), 1);
  assert.equal(contextLevel(8_000), 0);
  assert.ok(contextLevel(128_000) > 0.35 && contextLevel(128_000) < 0.45);
  assert.equal(contextLevel(undefined), undefined);
  assert.equal(contextLevel(0), undefined);

  const climate = climateFor(call('m', { effort: 'high', promptLimit: 1_000_000 }), [tally('m', 3, 3)], now);
  assert.equal(climate.effortLevel, 0.8);
  assert.equal(climate.contextLevel, 1);
  const bare = climateFor(call('m'), [tally('m', 3, 3)], now);
  assert.equal(bare.effortLevel, undefined);
  assert.equal(bare.contextLevel, undefined);
});

it('takes the latest call from chat sessions, not from sessionless helpers or subagents', () => {
  const start = now - 10_000;
  const span = (id, extra, offset) => usageSpan(id, {
    'gen_ai.operation.name': 'chat',
    'copilot_chat.chat_session_id': 'chat-a',
    'gen_ai.response.model': 'heavy',
    'copilot_chat.copilot_usage_nano_aiu': 8e9,
    'copilot_chat.request.max_prompt_tokens': 200_000,
    ...extra
  }, start + offset, start + offset + 500);
  const noSession = { 'copilot_chat.chat_session_id': undefined };
  const digest = digestSpans([
    span('a1', { 'copilot_chat.request.options': JSON.stringify({ reasoning: { effort: 'high' } }) }, 0),
    span('b1', { 'copilot_chat.chat_session_id': 'chat-b', 'gen_ai.response.model': 'light', 'copilot_chat.copilot_usage_nano_aiu': 1e8 }, 100),
    span('a2', {}, 200),
    span('a3', {}, 300),
    span('title', { ...noSession, 'gen_ai.response.model': 'mini', 'copilot_chat.copilot_usage_nano_aiu': 0 }, 400),
    span('sub', { ...noSession, 'copilot_chat.parent_chat_session_id': 'chat-a', 'gen_ai.response.model': 'mini' }, 500)
  ]);
  assert.deepEqual(digest.latestCall, { model: 'heavy', effort: undefined, promptLimit: 200_000, atMs: start + 300, sessionId: 'chat-a' });
  const sessions = Object.fromEntries(digest.sessions.map((s) => [s.sessionId, s]));
  assert.equal(sessions['chat-b'].latestCall.model, 'light');
  assert.equal(sessions['chat-a'].latestCall.atMs, start + 300);

  const climate = climateFor(digest.latestCall, digest.byModel, now);
  assert.equal(climate.model, 'heavy');
  assert.equal(climate.creditsPerCall, 8);
  assert.equal(climate.band, 'thawing');
  assert.equal(climateFor(sessions['chat-b'].latestCall, digest.byModel, now), undefined, 'one credited call is too few');
});

it('publishes a live climate on the snapshot without changing the ice', () => {
  const m = new TokenMeter({ get: () => undefined, update: async () => {} });
  try {
    const climate = climateFor(call('m', { atMs: Date.now() - 1000 }), [tally('m', 30, 3)], Date.now());
    const before = m.snapshot();
    m.setClimate(climate);
    const after = m.snapshot();
    assert.deepEqual(after.climate, climate);
    assert.equal(after.health, before.health);
    assert.equal(after.basis, before.basis);

    globalThis.__BEAR_SETTINGS__ = { 'iceberg.climate.enabled': false };
    assert.equal(m.snapshot().climate, undefined, 'the setting turns the weather neutral');
    delete globalThis.__BEAR_SETTINGS__;

    m.toggleDemo();
    assert.equal(m.snapshot().climate, undefined, 'the demo never shows a model climate');
    m.toggleDemo();
    assert.deepEqual(m.snapshot().climate, climate);

    m.setClimate({ ...climate, atMs: Date.now() - CLIMATE_STALE_MS - 1000 });
    assert.equal(m.snapshot().climate, undefined, 'a stale climate is neutral');
    m.setClimate(undefined);
    assert.equal(m.snapshot().climate, undefined);
  } finally {
    delete globalThis.__BEAR_SETTINGS__;
    m.dispose();
  }
});
