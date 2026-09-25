'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { it } = require('node:test');
const build = process.env.BEAR_TEST_BUILD;
const { OtelRollup } = require(path.join(build, 'otelParse.js'));
const { buildSnapshot, buildPeriod, emptySpanDigest, computeDrift, periodStart, sessionLabel } = require(path.join(build, 'otelSummary.js'));
const renderer = fs.readFileSync(path.join(__dirname, '..', 'media', 'dashboard.js'), 'utf8');

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.text = '';
  }
  set textContent(text) { this.text = text; this.children = []; }
  get textContent() { return this.text + this.children.map((child) => child.textContent ?? child).join(' '); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  setAttribute() {}
  addEventListener(type, listener) { this.listeners[type] = listener; }
  find(tag) {
    return this.tag === tag ? this : this.children.find((child) => child.find?.(tag))?.find(tag);
  }
}

function dashboard() {
  const nodes = Object.fromEntries(['sections', 'banner', 'provenance'].map((id) => [id, new Element('div')]));
  const messages = [];
  let receive;
  vm.runInNewContext(renderer, {
    document: {
      getElementById: (id) => nodes[id],
      createElement: (tag) => new Element(tag),
      createElementNS: (_, tag) => new Element(tag)
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(message.type) }),
    window: { addEventListener: (_, listener) => { receive = listener; } }
  });
  return {
    messages,
    nodes,
    render(feed, rollup = new OtelRollup(), drift = computeDrift(0, 0), usage = {}) {
      const snapshot = buildSnapshot({
        rollup, spans: emptySpanDigest(), bearName: 'Nanuq', budget: 5000000, health: 1,
        totals: { input: 100, output: 10, credits: 0 }, source: 'otel', basis: 'budget',
        countedTokens: 110, meterSinceMs: Date.UTC(2026, 8, 24, 12), drift, ...usage,
        feed: {
          watching: true, copilotOtelEnabled: true, jsonlActive: false, sqliteActive: false,
          lastRecordAtMs: 0, records: { metrics: 0, logs: 0, spans: 0, unknown: 0, malformed: 0 },
          notes: [], ...feed
        }
      });
      receive({ data: { type: 'snapshot', snapshot } });
      return nodes.sections.children.find((section) => section.dataset.key === 'quality');
    }
  };
}

it('distinguishes local tokens, reported credits and unavailable account limits', () => {
  const d = dashboard();
  d.render({}, new OtelRollup(), computeDrift(2100000, 694000), {
    totals: { input: 2000000, output: 100000, credits: 293.2 },
    countedTokens: 2100000, health: 0.58
  });
  const cost = d.nodes.sections.children.find((section) => section.dataset.key === 'cost');
  assert.match(cost.textContent, /2\.1M local tokens/);
  assert.match(cost.textContent, /across sessions and workspaces/);
  assert.match(cost.textContent, /not the selected chat/);
  assert.match(cost.textContent, /since 2026-09-24 12:00 UTC/);
  assert.match(cost.textContent, /Reported credits 293\.2/);
  assert.match(cost.textContent, /Account credit limit Not read/);
  assert.match(cost.textContent, /Account usage and monthly credit allowance are not read/);
  assert.match(cost.textContent, /not a Copilot spending cap/);
  assert.doesNotMatch(cost.textContent, /Premium credits/);
});

it('uses only enabled token dimensions for the local budget gauge', () => {
  const d = dashboard();
  d.render({}, new OtelRollup(), undefined, {
    totals: { input: 2000000, output: 100000, credits: 0 },
    countedTokens: 100000, health: 0.98
  });
  assert.match(d.nodes.sections.textContent, /2\.1M local tokens/);
  assert.match(d.nodes.sections.textContent, /Counted tokens 100,000 Visual target 5,000,000/);
  assert.match(d.nodes.sections.textContent, /98% local budget remaining/);
  assert.doesNotMatch(d.nodes.sections.textContent, /2\.1M \/ 5\.0M/);
});

it('labels context as the latest observed prompt, not current-chat occupancy or quota', () => {
  const d = dashboard();
  d.render({}, new OtelRollup(), undefined, {
    basis: 'context', health: 0.8634,
    context: { used: 136600, limit: 1000000, model: 'gpt-5.6-sol', atMs: Date.now() }
  });
  const text = d.nodes.sections.textContent;
  assert.match(text, /86%.*latest prompt allowance free/);
  assert.match(text, /Prompt used 136,600 Prompt limit 1,000,000/);
  assert.match(text, /max_prompt_tokens/);
  assert.match(text, /not the selected chat's full context window/);
  assert.doesNotMatch(text, /5\.0M.*remains/);
});

it('shows credit-only observations without requiring token counts', () => {
  const d = dashboard();
  d.render({}, new OtelRollup(), undefined, {
    totals: { input: 0, output: 0, credits: 293.2 }, countedTokens: 0
  });
  assert.match(d.nodes.sections.textContent, /Reported credits 293\.2/);
  assert.doesNotMatch(d.nodes.sections.textContent, /No new token counts/);
});

it('shows a recent prompt gauge before any new tokens have been charged', () => {
  const d = dashboard();
  d.render({}, new OtelRollup(), undefined, {
    totals: { input: 0, output: 0, credits: 0 }, countedTokens: 0,
    basis: 'context', health: 0.75,
    context: { used: 32000, limit: 128000, model: 'gpt-4o', atMs: Date.now() }
  });
  assert.match(d.nodes.sections.textContent, /75% latest prompt allowance free/);
  assert.match(d.nodes.sections.textContent, /Prompt used 32,000 Prompt limit 128,000/);
  assert.doesNotMatch(d.nodes.sections.textContent, /No new token counts/);
});

it('explains billing limitations even before local observations arrive', () => {
  const d = dashboard();
  d.render({}, new OtelRollup(), undefined, {
    totals: { input: 0, output: 0, credits: 0 }, countedTokens: 0
  });
  assert.match(d.nodes.sections.textContent, /Account usage and monthly credit allowance are not read/);
  assert.match(d.nodes.sections.textContent, /No new token counts/);
  assert.match(d.nodes.sections.textContent, /Visual target 5,000,000/);
});

it('does not round a prompt limit into an indistinguishable 1M label', () => {
  const d = dashboard();
  d.render({}, new OtelRollup(), undefined, {
    basis: 'context', health: 1 - 136600 / 1048576,
    context: { used: 136600, limit: 1048576, model: null, atMs: Date.now() }
  });
  assert.match(d.nodes.sections.textContent, /Prompt limit 1,048,576/);
  assert.doesNotMatch(d.nodes.sections.textContent, /Visual target/);
});

it('does not turn missing transcript credits into a zero-cost claim', () => {
  const d = dashboard();
  d.render({});
  assert.match(d.nodes.sections.textContent, /Reported credits —/);
  assert.doesNotMatch(d.nodes.sections.textContent, /Reported credits 0/);
});

it('shows unscaled ice without inventing a denominator and preserves the old meter warning', () => {
  const d = dashboard();
  d.render({}, new OtelRollup(), undefined, {
    basis: 'unavailable', budget: 0, legacyTokens: 5000000,
    totals: { input: 0, output: 0, credits: 0 }
  });
  assert.match(d.nodes.sections.textContent, /Ice gauge · unscaled/);
  assert.match(d.nodes.sections.textContent, /No default token target/);
  assert.match(d.nodes.sections.textContent, /not a measurement of energy, CO2 or ice loss/);
  assert.match(d.nodes.sections.textContent, /pre-upgrade estimated tokens preserved separately/);
  assert.doesNotMatch(d.nodes.sections.textContent, /100%|Visual target/);
});

it('shows the chosen session cost separately from trace credits and account allowance', () => {
  const d = dashboard();
  d.render({}, new OtelRollup(), undefined, {
    selectedSessionId: 's',
    transcripts: [{ sessionId: 's', updatedAt: 1000, credits: 293.2 }],
    spans: { ...emptySpanDigest(), sessions: [{
      sessionId: 's', endedAt: 1000, durationMs: 13000, llmCalls: 2, toolCalls: 1,
      inputTokens: 100000, outputTokens: 1000, credits: 12.5, creditCalls: 1
    }] }
  });
  const text = d.nodes.sections.textContent;
  assert.match(text, /Pinned: s/);
  assert.match(text, /Session Cost · transcript 293\.2/);
  assert.match(text, /Model-call credits · traces 12\.5/);
  assert.match(text, /1 \/ 2 model calls reported credits/);
  assert.match(text, /never added/);
});

it('names the session when the user named it and keeps the ID visible', () => {
  const d = dashboard();
  d.render({}, new OtelRollup(), undefined, {
    selectedSessionId: '3f7c9b21-5d44-4f2e-9a11-77c0d1f2e3b4',
    transcripts: [{
      sessionId: '3f7c9b21-5d44-4f2e-9a11-77c0d1f2e3b4', title: 'Rate limiter rewrite',
      updatedAt: 1000, credits: 12
    }],
    spans: emptySpanDigest()
  });
  const text = d.nodes.sections.textContent;
  assert.match(text, /Pinned: Rate limiter rewrite \(3f7c9b21…\)/);
  assert.equal(sessionLabel({ sessionId: '3f7c9b21-5d44-4f2e-9a11-77c0d1f2e3b4' }), '3f7c9b21…');
  assert.equal(sessionLabel({ sessionId: 'short', name: 'Named' }), 'Named');
});

it('falls back to the billing-period roll-up when no session is selected or observed', () => {
  const d = dashboard();
  d.render({}, new OtelRollup(), undefined, { spans: emptySpanDigest(), transcripts: [] });
  const text = d.nodes.sections.textContent;
  assert.match(text, /showing the period roll-up instead/);
  assert.match(text, /No session metadata yet/);
});

it('rolls observed credits and tokens up over the billing period', () => {
  const now = Date.UTC(2026, 8, 25, 6, 0, 0);
  const spans = emptySpanDigest();
  spans.sessions = [{
    sessionId: 'traced', endedAt: Date.UTC(2026, 8, 20), durationMs: 10, llmCalls: 1, toolCalls: 0,
    inputTokens: 90000, outputTokens: 1000, credits: 4
  }];
  const period = buildPeriod({
    spans,
    transcripts: [
      { sessionId: 'traced', updatedAt: Date.UTC(2026, 8, 20), credits: 10 },
      { sessionId: 'last-month', updatedAt: Date.UTC(2026, 7, 20), credits: 99 },
      { sessionId: 'no-credits', updatedAt: Date.UTC(2026, 8, 24) }
    ]
  }, now);
  assert.equal(period.sessions, 2);
  assert.equal(period.credits, 10);
  assert.equal(period.creditSessions, 1);
  assert.equal(period.inputTokens, 90000);
  assert.equal(period.outputTokens, 1000);
  assert.equal(period.sinceMs, periodStart(now));
});

it('identifies speed as aggregate telemetry rather than the selected session', () => {
  const d = dashboard();
  const spans = emptySpanDigest();
  spans.sessions = [{
    sessionId: 'one', durationMs: 13000, llmCalls: 32, toolCalls: 37,
    inputTokens: 2100000, outputTokens: 0, cachedTokens: 0
  }];
  d.render({}, new OtelRollup(), undefined, { spans });
  const speed = d.nodes.sections.children.find((section) => section.dataset.key === 'speed');
  assert.match(speed.textContent, /1 observed session/);
  assert.match(speed.textContent, /not the selected chat/);
});

it('shows waiting, not connect, for a flowing feed with no quality events', () => {
  const d = dashboard();
  const quality = d.render({
    jsonlPath: 'feed.jsonl', jsonlActive: true,
    records: { metrics: 6, logs: 8, spans: 0, unknown: 0, malformed: 0 }
  });
  assert.match(quality.textContent, /Telemetry is connected/);
  assert.match(quality.textContent, /Accept or reject a Copilot edit/);
  assert.doesNotMatch(quality.textContent, /Connect telemetry/);
  quality.find('button').listeners.click();
  assert.equal(d.messages.at(-1), 'diagnostics');
});

it('waits for a configured file feed before its first record', () => {
  const quality = dashboard().render({ jsonlPath: 'feed.jsonl' });
  assert.match(quality.textContent, /File feed configured/);
  assert.doesNotMatch(quality.textContent, /Connect telemetry/);
});

it('offers a connection for missing, trace-only or disabled Copilot telemetry', () => {
  for (const feed of [{}, { sqliteActive: true }, { copilotOtelEnabled: false, jsonlPath: 'feed.jsonl' }]) {
    const d = dashboard();
    const quality = d.render(feed);
    assert.match(quality.textContent, /Connect telemetry/);
    quality.find('button').listeners.click();
    assert.equal(d.messages.at(-1), 'connect');
  }
});

it('does not offer to reconnect when local telemetry reading is disabled', () => {
  const quality = dashboard().render({ watching: false, jsonlActive: true, jsonlPath: 'feed.jsonl' });
  assert.match(quality.textContent, /Telemetry reading is off/);
  assert.doesNotMatch(quality.textContent, /Connect telemetry/);
});

it('replaces waiting with quality data when a relevant metric arrives', () => {
  const d = dashboard();
  const feed = { jsonlPath: 'feed.jsonl', jsonlActive: true };
  d.render(feed);
  const rollup = new OtelRollup();
  rollup.ingest({
    resource: {},
    scopeMetrics: [{ metrics: [{
      descriptor: { name: 'copilot_chat.user.feedback.count' },
      dataPoints: [{ attributes: { rating: 'positive' }, endTime: [1, 0], value: 1 }]
    }] }]
  });
  const quality = d.render(feed, rollup);
  assert.doesNotMatch(quality.textContent, /No quality signals|Connect telemetry/);
  assert.match(quality.textContent, /100% positive/);
});

it('replaces waiting with feedback from a standalone log event', () => {
  const d = dashboard();
  const feed = { jsonlPath: 'feed.jsonl', jsonlActive: true };
  d.render(feed);
  const rollup = new OtelRollup();
  rollup.ingestLine(JSON.stringify({
    _body: 'copilot_chat.user.feedback',
    attributes: { rating: 'positive' }
  }));
  const section = d.render(feed, rollup);
  assert.match(section.textContent, /100% positive/);
  assert.doesNotMatch(section.textContent, /No quality signals|Connect telemetry/);
});

it('shows one-sided reconciliation as pending and later surfaces real divergence', () => {
  const d = dashboard();
  const feed = { jsonlPath: 'feed.jsonl', jsonlActive: true };
  d.render(feed, new OtelRollup(), computeDrift(9961, 0));
  assert.match(d.nodes.sections.textContent, /Reconciliation pending/);
  assert.doesNotMatch(d.nodes.sections.textContent, /metrics differ from spans/);
  d.render(feed, new OtelRollup(), computeDrift(9961, 100));
  assert.match(d.nodes.sections.textContent, /metrics differ from spans/);
});

it('renders standalone quality metrics instead of the empty state, including zero survival', () => {
  for (const [name, attributes, value, label] of [
    ['copilot_chat.edit.survival.four_gram', {}, { sum: 0, count: 1 }, 'Code survives'],
    ['copilot_chat.edit.survival.no_revert', {}, { sum: 0, count: 1 }, 'Not reverted'],
    ['copilot_chat.cloud.session.count', {}, 1, 'Cloud sessions'],
    ['copilot_chat.agent.edit_response.count', { outcome: 'error' }, 1, 'Edit errors'],
    ['copilot_chat.agent.summarization.count', { outcome: 'applied' }, 1, 'Summarisations'],
    ['copilot_chat.agent.summarization.count', { outcome: 'failed' }, 1, 'Summarisations']
  ]) {
    const rollup = new OtelRollup();
    rollup.ingest({
      resource: {},
      scopeMetrics: [{ metrics: [{
        descriptor: { name }, dataPoints: [{ attributes, endTime: [1, 0], value }]
      }] }]
    });
    const quality = dashboard().render({ jsonlPath: 'feed.jsonl', jsonlActive: true }, rollup);
    assert.ok(quality.textContent.includes(label), name);
    assert.doesNotMatch(quality.textContent, /No quality signals|Connect telemetry/);
  }
});
