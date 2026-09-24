'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { it } = require('node:test');
const { OtelRollup } = require(path.join(process.env.BEAR_TEST_BUILD, 'otelParse.js'));
const { buildQuality } = require(path.join(process.env.BEAR_TEST_BUILD, 'otelSummary.js'));

function event(rollup, name, attributes = {}) {
  rollup.ingestLine(JSON.stringify({ _body: name, attributes }));
}

function metric(rollup, name, attributes, value) {
  rollup.ingest({
    resource: {},
    scopeMetrics: [{ metrics: [{
      descriptor: { name },
      dataPoints: [{ attributes, endTime: [1, 0], value }]
    }] }]
  });
}

const quality = (rollup) => buildQuality({ rollup });

it('builds Quality from SDK fixture logs without any metric exports', () => {
  const rollup = new OtelRollup();
  const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'otel-feed.jsonl'), 'utf8')
    .split('\n').filter(Boolean);
  for (const line of lines) {
    if (!JSON.parse(line).scopeMetrics) rollup.ingestLine(line);
  }
  const q = quality(rollup);
  assert.equal(rollup.stats.metrics, 0);
  assert.equal(q.available, true);
  assert.equal(q.editsAccepted, 1);
  assert.equal(q.feedbackPositive, 1);
  assert.equal(q.survivalFourGram, 0.82);
  assert.equal(q.survivalNoRevert, 0.95);
});

it('handles documented edit outcomes without mistaking rejected lines for accepted changes', () => {
  const rollup = new OtelRollup();
  event(rollup, 'copilot_chat.edit.feedback', { outcome: 'accepted' });
  event(rollup, 'copilot_chat.edit.feedback', { outcome: 'rejected' });
  event(rollup, 'copilot_chat.edit.hunk.action', { outcome: 'accepted', lines_added: 12, lines_removed: 4 });
  event(rollup, 'copilot_chat.edit.hunk.action', { outcome: 'rejected', lines_added: 500, lines_removed: 200 });
  event(rollup, 'copilot_chat.inline.done', { accepted: true, edit_count: 20, edit_line_count: 100 });
  event(rollup, 'copilot_chat.inline.done', { accepted: 'false' });
  const q = quality(rollup);
  assert.equal(q.editsAccepted, 3);
  assert.equal(q.editsRejected, 3);
  assert.equal(q.acceptRate, 0.5);
  assert.equal(q.linesAdded, 12);
  assert.equal(q.linesRemoved, 4);
});

it('aggregates feedback, cloud invocations and explicit tool success/failure', () => {
  const rollup = new OtelRollup();
  event(rollup, 'copilot_chat.user.feedback', { rating: 'positive' });
  event(rollup, 'copilot_chat.user.feedback', { rating: 'negative' });
  event(rollup, 'copilot_chat.cloud.session.invoke', { partner_agent: 'copilot' });
  event(rollup, 'copilot_chat.tool.call', { success: true });
  event(rollup, 'copilot_chat.tool.call', { success: 'false' });
  const q = quality(rollup);
  assert.equal(q.feedbackPositive, 1);
  assert.equal(q.feedbackNegative, 1);
  assert.equal(q.feedbackRate, 0.5);
  assert.equal(q.cloudSessions, 1);
  assert.equal(q.toolCalls, 2);
  assert.equal(q.toolFailures, 1);
  assert.equal(q.toolSuccessRate, 0.5);
});

it('does not infer line counts from invalid or missing hunk measurements', () => {
  const rollup = new OtelRollup();
  for (const value of [-1, 1.5, '10', null, {}, []]) {
    event(rollup, 'copilot_chat.edit.hunk.action', {
      outcome: 'accepted', lines_added: value, lines_removed: value
    });
  }
  assert.equal(quality(rollup).linesAdded, 0);
  assert.equal(quality(rollup).linesRemoved, 0);
});

it('averages valid survival observations, including zero, excluding branch changes', () => {
  const rollup = new OtelRollup();
  event(rollup, 'copilot_chat.edit.survival', { survival_rate_four_gram: 0, survival_rate_no_revert: 0.5 });
  event(rollup, 'copilot_chat.edit.survival', { survival_rate_four_gram: 1, survival_rate_no_revert: 1 });
  for (const did_branch_change of [true, 'true']) {
    event(rollup, 'copilot_chat.edit.survival', {
      did_branch_change, survival_rate_four_gram: 0, survival_rate_no_revert: 0
    });
  }
  assert.equal(quality(rollup).survivalFourGram, 0.5);
  assert.equal(quality(rollup).survivalNoRevert, 0.75);
});

it('keeps zero survival visible when it is the only signal', () => {
  const rollup = new OtelRollup();
  event(rollup, 'copilot_chat.edit.survival', { survival_rate_four_gram: 0 });
  assert.equal(quality(rollup).available, true);
  assert.equal(quality(rollup).survivalFourGram, 0);
  assert.equal(quality(rollup).survivalNoRevert, undefined);
});

it('does not fabricate quality from inference, unknown outcomes or invalid measurements', () => {
  const rollup = new OtelRollup();
  event(rollup, 'gen_ai.client.inference.operation.details', { 'gen_ai.usage.input_tokens': 500 });
  event(rollup, 'copilot_chat.session.start');
  event(rollup, 'copilot_chat.edit.feedback', { outcome: 'unknown' });
  event(rollup, 'copilot_chat.edit.hunk.action', { lines_added: 100 });
  event(rollup, 'copilot_chat.inline.done', { accepted: 'yes' });
  event(rollup, 'copilot_chat.user.feedback', { rating: 'neutral' });
  event(rollup, 'copilot_chat.tool.call', { success: 'unknown' });
  for (const value of [-1, 2, null, '0.5', {}, []]) {
    event(rollup, 'copilot_chat.edit.survival', {
      survival_rate_four_gram: value, survival_rate_no_revert: value
    });
  }
  const q = quality(rollup);
  assert.equal(q.available, false);
  assert.equal(q.survivalFourGram, undefined);
  assert.equal(q.toolSuccessRate, undefined);
});

it('retains compact event totals beyond the recent-event cap without retaining content', () => {
  const rollup = new OtelRollup();
  for (let i = 0; i < 2100; i++) {
    event(rollup, 'copilot_chat.user.feedback', {
      rating: 'positive', request_id: `request-${i}`, 'gen_ai.input.messages': 'PRIVATE-CONTENT'
    });
  }
  assert.equal(rollup.recentEvents(undefined, 5000).length, 2000);
  assert.equal(quality(rollup).feedbackPositive, 2100);
  assert.equal(rollup.eventSeries.size, 1, 'request IDs must not expand the aggregate key space');
  assert.equal(JSON.stringify(rollup).includes('PRIVATE-CONTENT'), false);
});

it('keeps folded metrics authoritative over event fallbacks', () => {
  const rollup = new OtelRollup();
  metric(rollup, 'copilot_chat.user.feedback.count', { rating: 'positive' }, 3);
  event(rollup, 'copilot_chat.user.feedback', { rating: 'positive' });
  for (let i = 0; i < 4001; i++) {
    metric(rollup, 'unrelated.counter', { bucket: String(i) }, 1);
  }
  assert.equal(quality(rollup).feedbackPositive, 3);
});

it('uses metrics instead of matching events regardless of arrival order', () => {
  for (const metricFirst of [true, false]) {
    const rollup = new OtelRollup();
    const ingestMetric = () => metric(rollup, 'copilot_chat.user.feedback.count', { rating: 'positive' }, 3);
    if (metricFirst) ingestMetric();
    event(rollup, 'copilot_chat.user.feedback', { rating: 'positive' });
    if (!metricFirst) ingestMetric();
    ingestMetric();
    event(rollup, 'copilot_chat.user.feedback', { rating: 'positive' });
    assert.equal(quality(rollup).feedbackPositive, 3, 'do not sum logs and cumulative exports');
  }
});

it('selects fallback per instrument, not per outcome, and respects measured zero', () => {
  const rollup = new OtelRollup();
  event(rollup, 'copilot_chat.user.feedback', { rating: 'negative' });
  event(rollup, 'copilot_chat.edit.feedback', { outcome: 'accepted' });
  event(rollup, 'copilot_chat.edit.survival', { survival_rate_four_gram: 1 });
  metric(rollup, 'copilot_chat.user.feedback.count', { rating: 'positive' }, 0);
  metric(rollup, 'copilot_chat.edit.survival.four_gram', {}, { sum: 0, count: 1 });
  const q = quality(rollup);
  assert.equal(q.feedbackPositive, 0);
  assert.equal(q.feedbackNegative, 0, 'do not mix a metric family with event-only outcomes');
  assert.equal(q.editsAccepted, 1, 'an unrelated metric must not suppress edit events');
  assert.equal(q.survivalFourGram, 0, 'a measured zero is not a missing histogram');
});

it('uses event survival until a histogram has actual observations', () => {
  const rollup = new OtelRollup();
  event(rollup, 'copilot_chat.edit.survival', { survival_rate_four_gram: 0.75 });
  metric(rollup, 'copilot_chat.edit.survival.four_gram', {}, { sum: 0, count: 0 });
  assert.equal(quality(rollup).survivalFourGram, 0.75);
  metric(rollup, 'copilot_chat.edit.survival.four_gram', {}, { sum: 1, count: 2 });
  assert.equal(quality(rollup).survivalFourGram, 0.5);
});
