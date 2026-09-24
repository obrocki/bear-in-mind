'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { it } = require('node:test');
const build = process.env.BEAR_TEST_BUILD;
const { OtelRollup } = require(path.join(build, 'otelParse.js'));
const { buildSnapshot, emptySpanDigest, computeDrift } = require(path.join(build, 'otelSummary.js'));
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
    render(feed, rollup = new OtelRollup(), drift = computeDrift(0, 0)) {
      const snapshot = buildSnapshot({
        rollup, spans: emptySpanDigest(), bearName: 'Nanuq', budget: 5000000, health: 1,
        totals: { input: 100, output: 10, credits: 0 }, source: 'otel', basis: 'budget',
        drift,
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
  assert.doesNotMatch(d.nodes.sections.textContent, /differs from the chat transcripts/);
  d.render(feed, new OtelRollup(), computeDrift(9961, 100));
  assert.match(d.nodes.sections.textContent, /differs from the chat transcripts/);
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
