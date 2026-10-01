'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { it } = require('node:test');
const { digestSpans, fileUsageSpan, identityName, reasoningEffort, repositoryName, usageSpan } = require(path.join(process.env.BEAR_TEST_BUILD, 'spanUsage.js'));
const { buildCost, buildQuality, buildSpeed, buildTraceCredits, selectedSession, sessionComparisons } = require(path.join(process.env.BEAR_TEST_BUILD, 'otelSummary.js'));
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

it('groups model-call credits by model, caller, reasoning effort and inherited repository', () => {
  const noSession = { 'copilot_chat.chat_session_id': undefined, 'gen_ai.conversation.id': undefined };
  const digest = digestSpans([
    span('agent', 'invoke_agent', {
      'gen_ai.agent.name': 'GitHub Copilot Chat',
      'github.copilot.git.repository': 'https://user:secret@github.com/o/r.git',
      'github.copilot.git.branch': 'main'
    }),
    span('a', 'chat', {
      'gen_ai.agent.name': 'panel/editAgent',
      'copilot_chat.request.options': JSON.stringify({ stream: true, reasoning: { effort: 'high' } })
    }, 10),
    span('sub', 'chat', {
      ...noSession, 'copilot_chat.parent_chat_session_id': 'vscode-session', 'gen_ai.agent.name': 'executionSubagentTool',
      'copilot_chat.copilot_usage_nano_aiu': 500000000, 'copilot_chat.request.options': { reasoning_effort: 'MAX' }
    }, 20),
    span('title', 'chat', {
      ...noSession, 'gen_ai.agent.name': 'title', 'gen_ai.response.model': 'mini', 'copilot_chat.copilot_usage_nano_aiu': 0
    }, 30),
    span('lm', 'chat', { ...noSession, 'gen_ai.response.model': 'mini', 'copilot_chat.copilot_usage_nano_aiu': undefined }, 40)
  ]);
  assert.equal(digest.chatCalls, 4);
  assert.equal(digest.creditCalls, 3);
  assert.equal(digest.credits, 2);
  assert.equal(digest.sessionlessCalls, 3);
  assert.equal(digest.sessionlessCredits, 0.5);
  assert.equal(digest.sessionlessCreditCalls, 2, 'the uncredited helper call is unknown, not zero');
  const session = digest.sessions[0];
  assert.equal(session.repository, 'o/r', 'credentials never survive');
  assert.equal(session.branch, 'main');
  assert.equal(session.agentName, 'GitHub Copilot Chat');
  assert.doesNotMatch(JSON.stringify(digest.sessions), /secret/);

  const trace = buildTraceCredits(digest);
  assert.deepEqual(trace.byRepository.map((r) => [r.label, r.calls, r.credits]), [['o/r', 2, 2], ['no repository', 2, 0]]);
  assert.deepEqual(trace.byModel.map((r) => [r.label, r.calls, r.creditCalls]), [['resolved-model', 2, 2], ['mini', 2, 1]]);
  assert.deepEqual(trace.byEffort.map((r) => r.label), ['high', 'max', 'not reported']);
  assert.deepEqual(trace.byCaller.map((r) => r.label), ['panel/editAgent', 'executionSubagentTool', 'title', 'unnamed caller']);
});

it('attributes model-call credits to user.name inherited from agent spans, never to the device', () => {
  const noSession = { 'copilot_chat.chat_session_id': undefined, 'gen_ai.conversation.id': undefined };
  const digest = digestSpans([
    span('agent', 'invoke_agent', { 'user.name': ' octocat ' }),
    span('a', 'chat', {}, 10),
    span('sub', 'chat', { ...noSession, 'copilot_chat.parent_chat_session_id': 'vscode-session' }, 20),
    span('other', 'invoke_agent', { 'copilot_chat.chat_session_id': 'other-session', 'user.name': 'x'.repeat(200) }, 30),
    span('other-call', 'chat', {
      'copilot_chat.chat_session_id': 'other-session', 'process.user.name': 'alice', 'host.name': 'laptop'
    }, 40),
    span('title', 'chat', { ...noSession, 'copilot_chat.copilot_usage_nano_aiu': 0 }, 50)
  ]);
  const sessions = Object.fromEntries(digest.sessions.map((s) => [s.sessionId, s]));
  assert.equal(sessions['vscode-session'].user, 'octocat');
  assert.equal(sessions['other-session'].user, undefined, 'an oversized identity is dropped, and the device is not an account');

  const trace = buildTraceCredits(digest);
  assert.equal(trace.userCalls, 2);
  assert.deepEqual(trace.byUser.map((r) => [r.label, r.calls, r.credits]), [['octocat', 2, 3], ['no user identity', 2, 1.5]]);
  assert.doesNotMatch(JSON.stringify(trace), /alice|laptop/);
  assert.equal(buildTraceCredits(digestSpans([span('a', 'chat')])).userCalls, 0);

  assert.equal(identityName('bad\nname'), undefined);
  assert.equal(identityName(42), undefined);
  assert.equal(identityName('  '), undefined);
  assert.equal(identityName('mona_corp'), 'mona_corp');
});

it('reads user.name from file spans, falling back to an explicit resource attribute', () => {
  const record = {
    spanId: 'f', startTime: [start / 1000, 0], endTime: [start / 1000 + 1, 0], ended: true,
    resource: { _rawAttributes: [['user.name', 'resource-user'], ['process.user.name', 'alice'], ['host.name', 'laptop']] },
    attributes: { 'gen_ai.operation.name': 'invoke_agent', 'copilot_chat.chat_session_id': 's' }
  };
  assert.equal(fileUsageSpan(record).user, 'resource-user');
  assert.equal(fileUsageSpan({ ...record, attributes: { ...record.attributes, 'user.name': 'span-user' } }).user, 'span-user');
  assert.equal(fileUsageSpan({ ...record, resource: { attributes: { 'host.name': 'laptop' } } }).user, undefined);
  assert.doesNotMatch(JSON.stringify(fileUsageSpan(record)), /alice|laptop/);
});

it('folds long credit breakdowns into one remainder row', () => {
  const digest = digestSpans(Array.from({ length: 8 }, (_, i) =>
    span('m' + i, 'chat', { 'gen_ai.response.model': 'model-' + i, 'copilot_chat.copilot_usage_nano_aiu': (i + 1) * 1e9 }, i)));
  const rows = buildTraceCredits(digest).byModel;
  assert.equal(rows.length, 6);
  assert.deepEqual(rows[0], { label: 'model-7', calls: 1, creditCalls: 1, credits: 8 });
  assert.deepEqual(rows[5], { label: '3 more', calls: 3, creditCalls: 3, credits: 6 });
});

it('normalises repository names and rejects credential-shaped values', () => {
  assert.equal(repositoryName('o/r'), 'o/r');
  assert.equal(repositoryName('git@github.com:o/r.git'), 'o/r');
  assert.equal(repositoryName('ssh://git@github.com/o/r.git'), 'o/r');
  assert.equal(repositoryName('https://token@ghe.example.com/o/r/'), 'ghe.example.com/o/r');
  assert.equal(repositoryName('user:pass@host/o/r'), undefined);
  for (const local of ['/home/alice/private/repo', 'C:\\Users\\alice\\repo', 'c:/Users/alice/repo', 'file:///home/alice/repo', '~/repo', './repo', 'C:private/repo']) {
    assert.equal(repositoryName(local), undefined, local);
  }
  assert.equal(repositoryName('dev.azure.com/org/project/repo'), 'dev.azure.com/org/project/repo');
  assert.equal(repositoryName(''), undefined);
  assert.equal(repositoryName(42), undefined);
});

it('keeps only a short reasoning-effort word from request options', () => {
  assert.equal(reasoningEffort({ 'copilot_chat.request.options': '{"reasoning":{"effort":"xhigh"}}' }), 'xhigh');
  assert.equal(reasoningEffort({ 'copilot_chat.request.options': '{"reasoning":{"effort":"high; drop table"}}' }), undefined);
  assert.equal(reasoningEffort({ 'copilot_chat.request.options': '{broken' }), undefined);
  assert.equal(reasoningEffort({ 'copilot_chat.request.options': JSON.stringify({ pad: 'x'.repeat(70000) }) }), undefined);
  assert.equal(reasoningEffort({ 'gen_ai.request.reasoning.level': 'low' }), 'low');
  assert.equal(reasoningEffort({ 'copilot_chat.request.options': '{broken', 'gen_ai.request.reasoning.level': 'low' }), 'low',
    'an unusable options blob does not hide the standard attribute');
  assert.equal(reasoningEffort({
    'copilot_chat.request.options': JSON.stringify({ reasoning: { effort: 'not a word!' } }), 'gen_ai.request.reasoning.level': 'medium'
  }), 'medium');
  assert.equal(span('t', 'execute_tool', { 'copilot_chat.request.options': '{"reasoning_effort":"high"}' }).effort, undefined);
});

it('counts tool failures from reported span status only, preferring feed metrics', () => {
  const tool = (id, status) => usageSpan(id, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'read_file' },
    start, start + 10, status);
  const digest = digestSpans([tool('a', 2), tool('b', 0), tool('c', '1'), tool('d', undefined), tool('e', 'nope')]);
  assert.equal(digest.toolStatusCalls, 2, 'UNSET (0), missing and invalid statuses are unknown');
  assert.equal(digest.toolFailures, 1);
  const record = {
    spanId: 'f', startTime: [start / 1000, 0], endTime: [start / 1000 + 1, 0], status: { code: 2 },
    attributes: { 'gen_ai.operation.name': 'execute_tool' }
  };
  assert.equal(fileUsageSpan(record).failed, true);

  const fromSpans = buildQuality({ rollup: new OtelRollup(), spans: digest });
  assert.equal(fromSpans.toolSource, 'spans');
  assert.equal(fromSpans.toolCalls, 2);
  assert.equal(fromSpans.toolSuccessRate, 0.5);
  assert.equal(fromSpans.available, true);

  const rollup = new OtelRollup();
  rollup.ingest({
    resource: {},
    scopeMetrics: [{ metrics: [{
      descriptor: { name: 'copilot_chat.tool.call.count' },
      dataPoints: [{ attributes: { success: 'true' }, endTime: [1, 0], value: 4 }]
    }] }]
  });
  const fromMetrics = buildQuality({ rollup, spans: digest });
  assert.equal(fromMetrics.toolSource, 'metrics');
  assert.equal(fromMetrics.toolCalls, 4);
  assert.equal(fromMetrics.toolSuccessRate, 1);
  assert.equal(buildQuality({ rollup: new OtelRollup(), spans: digestSpans([tool('x', undefined)]) }).toolSource, 'none');

  const zero = new OtelRollup();
  zero.ingest({
    resource: {},
    scopeMetrics: [{ metrics: [{
      descriptor: { name: 'copilot_chat.tool.call.count' },
      dataPoints: [{ attributes: { success: 'true' }, endTime: [1, 0], value: 0 }]
    }] }]
  });
  const measuredZero = buildQuality({ rollup: zero, spans: digest });
  assert.equal(measuredZero.toolSource, 'metrics', 'a measured zero is a feed reading, not a gap');
  assert.equal(measuredZero.toolCalls, 0);
  assert.equal(measuredZero.toolSuccessRate, undefined);
});

it('reports cache-read share from the same retained window as its denominator', () => {
  const cost = buildCost({
    rollup: new OtelRollup(), spans: digestSpans([span('a', 'chat')]),
    totals: { input: 999999, output: 0, credits: 0 }, drift: {}
  });
  assert.equal(cost.cacheReadRatio, 0.8, '8000 cached / 10000 trace input, not the meter total');
  assert.equal(cost.traceCredits.available, true);
  assert.equal(buildCost({ rollup: new OtelRollup(), spans: digestSpans([]), totals: { input: 1, output: 0, credits: 0 } })
    .cacheReadRatio, undefined);
});
