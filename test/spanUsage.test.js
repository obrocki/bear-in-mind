'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { it } = require('node:test');
const { digestSpans, fileUsageSpan, usageSpan } = require(path.join(process.env.BEAR_TEST_BUILD, 'spanUsage.js'));
const { buildSpeed, selectedSession, sessionComparisons } = require(path.join(process.env.BEAR_TEST_BUILD, 'otelSummary.js'));
const { OtelRollup, classify } = require(path.join(process.env.BEAR_TEST_BUILD, 'otelParse.js'));
const start = Date.UTC(2026, 8, 24, 12);

function span(id, operation, extra = {}, offset = 0) {
  return usageSpan(id, {
    'gen_ai.operation.name': operation,
    'gen_ai.conversation.id': 'conversation',
    'copilot_chat.chat_session_id': 'vscode-session',
    'gen_ai.request.model': 'auto',
    'gen_ai.response.model': 'resolved-model',
    'gen_ai.usage.input_tokens': 10000,
    'gen_ai.usage.output_tokens': 200,
    'gen_ai.usage.cache_read.input_tokens': 8000,
    'gen_ai.usage.reasoning_tokens': 50,
    'gen_ai.usage.reasoning.output_tokens': 100,
    'copilot_chat.copilot_usage_nano_aiu': 1500000000,
    ...extra
  }, start + offset, start + offset + 1000);
}

it('counts only chat leaves, deduplicates span IDs and converts reported credits exactly', () => {
  const call = span('a', 'chat');
  const digest = digestSpans([span('root', 'invoke_agent'), call, call, span('b', 'chat')]);
  assert.equal(digest.inputTokens, 20000);
  assert.equal(digest.outputTokens, 400);
  assert.equal(digest.cachedTokens, 16000);
  assert.equal(digest.reasoningTokens, 200, 'preferred reasoning alias, not both');
  assert.equal(digest.sessions[0].credits, 3);
  assert.equal(digest.sessions[0].creditCalls, 2);
  assert.equal(digest.sessions[0].sessionId, 'vscode-session');
  assert.equal(digest.sessions[0].model, 'resolved-model');
});

it('retains zero reported credits and leaves missing or negative credits unknown', () => {
  const digest = digestSpans([
    span('a', 'chat', { 'copilot_chat.copilot_usage_nano_aiu': 0 }),
    span('b', 'chat', { 'copilot_chat.copilot_usage_nano_aiu': undefined }),
    span('c', 'chat', { 'copilot_chat.copilot_usage_nano_aiu': -1 })
  ]);
  assert.equal(digest.sessions[0].credits, 0);
  assert.equal(digest.sessions[0].creditCalls, 1);
});

it('uses explicit agent round-trip counts, never the user turn index', () => {
  const digest = digestSpans([
    span('a', 'invoke_agent', { 'copilot_chat.turn.index': 99, 'copilot_chat.turn_count': 3 }),
    span('b', 'invoke_agent', { 'copilot_chat.turn.index': 0 })
  ]);
  assert.deepEqual(digest.turnCounts, [3]);
});

it('does not replace main prompt headroom with title or subagent prompts', () => {
  const digest = digestSpans([
    span('a', 'chat', { 'copilot_chat.request.max_prompt_tokens': 128000 }),
    span('b', 'chat', { 'copilot_chat.request.max_prompt_tokens': 50000, 'copilot_chat.parent_chat_session_id': 'vscode-session' }, 2000)
  ]);
  assert.equal(digest.context.limit, 128000);
  assert.equal(digest.context.sessionId, 'vscode-session');
});

it('clears old prompt headroom when the latest model call has no reported limit', () => {
  const digest = digestSpans([
    span('a', 'chat', { 'copilot_chat.request.max_prompt_tokens': 128000 }),
    span('b', 'chat', {}, 2000)
  ]);
  assert.equal(digest.sessions[0].context, undefined);
});

it('parses modern file spans while stripping all content from retained metadata', () => {
  const record = {
    spanId: 's', startTime: [start / 1000, 0], endTime: [start / 1000 + 1, 0], ended: true,
    attributes: {
      'gen_ai.operation.name': 'chat', 'gen_ai.input.messages': 'secret',
      'gen_ai.usage.input_tokens': 100, 'copilot_chat.copilot_usage_nano_aiu': 293200000000
    },
    events: [{ private: 'secret' }]
  };
  assert.equal(classify(record), 'span');
  assert.equal(fileUsageSpan(record).credits, 293.2);
  assert.doesNotMatch(JSON.stringify(fileUsageSpan(record)), /secret|events/);
  assert.equal(fileUsageSpan({ ...record, ended: false }), undefined);
});

it('keeps elapsed session duration, invocation latency and output throughput distinct', () => {
  const spans = digestSpans([
    span('a', 'chat'),
    span('b', 'chat', {}, 3600000),
    span('c', 'invoke_agent', { 'copilot_chat.turn_count': 2 })
  ]);
  const speed = buildSpeed({ spans, rollup: new OtelRollup(), totals: { input: 999999999, output: 999999999 } });
  assert.equal(speed.sessionMedianMs.value, 3601000);
  assert.equal(speed.agentMedianMs.value, 1000);
  assert.equal(speed.llmMedianMs.value, 1000);
  assert.equal(speed.tokensPerMinute, 12000, '400 output tokens / 2 seconds, not lifetime tokens or idle hour');
  assert.equal(speed.turnsPerInvocation.value, 2);
});

it('matches transcript and trace sessions by ID, never adds their credit totals', () => {
  const spans = digestSpans([span('a', 'chat')]);
  const transcripts = [{ sessionId: 'vscode-session', credits: 3, updatedAt: start + 2000 }];
  const sessions = sessionComparisons(transcripts, spans.sessions);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].transcript.credits, 3);
  assert.equal(sessions[0].trace.credits, 1.5);
  const selected = selectedSession({ transcripts, spans, selectedSessionId: 'expired' });
  assert.equal(selected.sessionId, 'expired');
  assert.equal(selected.trace, undefined, 'a stale pin must not silently switch to another session');
  assert.equal(selected.pinned, true);
});
