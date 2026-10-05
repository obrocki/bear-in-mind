'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, it } = require('node:test');
const { digestSpans, fileUsageSpan, identityName, mergeUsageSpan, reasoningEffort, repositoryName, usageSpan } = require(path.join(process.env.BEAR_TEST_BUILD, 'spanUsage.js'));
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
  assert.deepEqual(sessions['vscode-session'].users, ['octocat']);
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

it('keeps model-call user attribution time-ordered across account switches', () => {
  const digest = digestSpans([
    span('early', 'chat', { 'copilot_chat.copilot_usage_nano_aiu': 500_000_000 }, -500),
    span('agent-1', 'invoke_agent', { 'user.name': 'mona' }),
    span('before-switch', 'chat', { 'copilot_chat.copilot_usage_nano_aiu': 1_000_000_000 }, 10),
    span('agent-2', 'invoke_agent', { 'user.name': 'hubot' }, 2000),
    span('after-switch', 'chat', { 'copilot_chat.copilot_usage_nano_aiu': 2_000_000_000 }, 2010)
  ]);
  assert.equal(digest.sessions[0].user, 'mona, hubot');
  assert.deepEqual(digest.sessions[0].users, ['mona', 'hubot']);

  const trace = buildTraceCredits(digest);
  assert.equal(trace.userCalls, 2);
  assert.deepEqual(Object.fromEntries(trace.byUser.map((r) => [r.label, [r.calls, r.credits]])), {
    hubot: [1, 2],
    mona: [1, 1],
    'no user identity': [1, 0.5]
  }, 'a call before every identity-bearing agent span is not given a later account');
});

it('reads user.name from file spans, falling back to an explicit resource attribute', () => {
  const record = {
    spanId: 'f', startTime: [start / 1000, 0], endTime: [start / 1000 + 1, 0], ended: true,
    resource: { _rawAttributes: [['user.name', 'resource-user'], ['process.user.name', 'alice'], ['host.name', 'laptop']] },
    attributes: { 'gen_ai.operation.name': 'invoke_agent', 'copilot_chat.chat_session_id': 's' }
  };
  assert.equal(fileUsageSpan(record).user, 'resource-user');
  assert.equal(fileUsageSpan(record).userSource, 'resource');
  assert.equal(fileUsageSpan({ ...record, attributes: { ...record.attributes, 'user.name': 'span-user' } }).user, 'span-user');
  assert.equal(fileUsageSpan({ ...record, resource: { attributes: { 'host.name': 'laptop' } } }).user, undefined);
  assert.doesNotMatch(JSON.stringify(fileUsageSpan(record)), /alice|laptop/);
});

it('keeps configured resource identity provenance when inherited by a model call', () => {
  const agent = fileUsageSpan({
    spanId: 'configured-agent', startTime: [start / 1000, 0], endTime: [start / 1000 + 1, 0],
    resource: { attributes: { 'user.name': 'configured-user' } },
    attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.conversation.id': 'configured' }
  });
  const call = usageSpan('configured-call', { 'gen_ai.operation.name': 'chat', 'gen_ai.conversation.id': 'configured' }, start + 10, start + 100);
  const digest = digestSpans([agent, call]);
  assert.equal(digest.configuredUserCalls, 1);
  assert.equal(buildTraceCredits(digest).configuredUserCalls, 1);
});

it('does not mix typed agent-operation histograms into model-call latency or counts', () => {
  const rollup = new OtelRollup();
  rollup.ingest({ resource: {}, scopeMetrics: [{ metrics: [{
    descriptor: { name: 'gen_ai.client.operation.duration' }, dataPoints: [
      { attributes: { 'gen_ai.operation.name': 'invoke_agent' }, endTime: [1, 0], value: { count: 1, sum: 10, min: 10, max: 10, buckets: { boundaries: [10], counts: [1, 0] } } },
      { attributes: { 'gen_ai.operation.name': 'chat' }, endTime: [1, 0], value: { count: 1, sum: 1, min: 1, max: 1, buckets: { boundaries: [1], counts: [1, 0] } } }
    ]
  }] }] });
  const speed = buildSpeed({ rollup, spans: digestSpans([]) });
  assert.equal(speed.llmCalls, 1);
  assert.ok(speed.llmMedianMs.value <= 1000);
  assert.ok(speed.agentMedianMs.value > speed.llmMedianMs.value);
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

describe('telemetry alignment', () => {
  it('resolves time-appropriate repository and actor context through every correlation key', () => {
    for (const key of ['session', 'conversation', 'parent', 'trace']) {
      const native = key === 'session' || key === 'parent' ? 's' : undefined;
      const conversation = key === 'conversation' ? 'c' : undefined;
      const traceId = key === 'trace' ? 't' : undefined;
      const make = (id, operation, at, attributes = {}) => usageSpan(id, {
        'gen_ai.operation.name': operation,
        'copilot_chat.chat_session_id': operation === 'invoke_agent' || key === 'session' ? native : undefined,
        'gen_ai.conversation.id': conversation,
        'copilot_chat.parent_chat_session_id': key === 'parent' && operation === 'chat' ? 's' : undefined,
        ...attributes
      }, start + at, start + at + 10, undefined, { traceId });
      const digest = digestSpans([
        make('new', 'invoke_agent', 300, { 'github.copilot.git.repository': 'o/new', 'user.name': 'new-user' }),
        make('old', 'invoke_agent', 100, { 'github.copilot.git.repository': 'o/old', 'user.name': 'old-user' }),
        make('early', 'chat', 50, { 'copilot_chat.copilot_usage_nano_aiu': 1e9 }),
        make('before', 'chat', 200, { 'copilot_chat.copilot_usage_nano_aiu': 2e9 }),
        make('after', 'chat', 400, { 'copilot_chat.copilot_usage_nano_aiu': 3e9 }),
      ]);
      assert.deepEqual(Object.fromEntries(digest.byRepository.map((r) => [r.key ?? 'unknown', r.credits])), {
        unknown: 1, 'o/old': 2, 'o/new': 3,
      }, key);
      assert.deepEqual(Object.fromEntries(digest.byUser.map((r) => [r.key ?? 'unknown', r.credits])), {
        unknown: 1, 'old-user': 2, 'new-user': 3,
      }, key);
      if (key === 'trace') assert.equal(digest.sessions.length, 0, 'a trace does not fabricate a session');
    }
  });

  it('does not inherit a different native chat identity through a shared conversation or trace', () => {
    const make = (id, operation, native, attributes, at) => usageSpan(id, {
      'gen_ai.operation.name': operation, 'copilot_chat.chat_session_id': native,
      'gen_ai.conversation.id': 'shared', ...attributes
    }, start + at, start + at + 10, undefined, { traceId: 'shared-trace' });
    const digest = digestSpans([
      make('agent', 'invoke_agent', 'one', { 'user.name': 'mona', 'github.copilot.git.repository': 'o/one' }, 0),
      make('call', 'chat', 'two', {}, 10)
    ]);
    assert.equal(digest.byUser[0].key, null);
    assert.equal(digest.byRepository[0].key, null);
  });

  it('reports unknown token fields and paired cache coverage without changing numeric meter subtotals', () => {
    const make = (id, attributes) => usageSpan(id, { 'gen_ai.operation.name': 'chat', ...attributes }, start, start + 10);
    const digest = digestSpans([
      make('pair', { 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.cache_read.input_tokens': 50, 'gen_ai.usage.output_tokens': 0,
        'gen_ai.usage.cache_creation.input_tokens': 0, 'gen_ai.usage.reasoning.output_tokens': 3 }),
      make('missing-cache', { 'gen_ai.usage.input_tokens': 900 }),
      make('invalid', { 'gen_ai.usage.input_tokens': -1, 'gen_ai.usage.reasoning.output_tokens': 1.5 }),
      make('invalid-pair', { 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.cache_read.input_tokens': 101 })
    ]);
    assert.equal(digest.inputTokens, 1100);
    assert.equal(digest.outputTokens, 0);
    assert.equal(digest.cacheWriteTokens, 0);
    assert.equal(digest.cacheReadRatio, 0.5);
    assert.deepEqual(digest.cacheReadRatioCoverage, { reportedCalls: 1, share: 0.25 });
    assert.deepEqual(digest.tokenCoverage.reasoningTokens, { reportedCalls: 1, share: 0.25 });
    assert.equal(digest.tokenCoverage.cacheWriteTokens.reportedCalls, 1, 'a reported zero is known');
    const unknown = digestSpans([make('unknown', { 'gen_ai.usage.input_tokens': 100 })]);
    assert.equal(unknown.cachedTokens, 0, 'the ledger remains numeric');
    assert.equal(unknown.tokenCoverage.cacheReadTokens.reportedCalls, 0);
    assert.equal(unknown.cacheReadRatio, undefined, 'no paired reports is unknown, not 0%');
  });

  it('keeps canonical first-chunk seconds separate from legacy first-token milliseconds', () => {
    const call = span('timing', 'chat', {
      'gen_ai.response.time_to_first_chunk': 1.5, 'copilot_chat.time_to_first_token': 250
    });
    assert.equal(call.firstChunk, 1500);
    assert.equal(call.ttft, 250);
    const speed = buildSpeed({ spans: digestSpans([call]), rollup: new OtelRollup() });
    assert.equal(speed.firstChunkMedianMs.value, 1500);
    assert.equal(speed.ttftMedianMs.value, 250);
    assert.equal(span('invalid', 'chat', { 'gen_ai.response.time_to_first_chunk': Infinity }).firstChunk, undefined);
  });

  it('counts SDK credits at confirmed root invocation grain, never summing children or adding multipliers', () => {
    const make = (id, operation, parentSpanId, nano, traceId = 'sdk') => usageSpan(id, {
      'gen_ai.operation.name': operation, 'gen_ai.conversation.id': 'sdk-session',
      'github.copilot.nano_aiu': nano, 'github.copilot.cost': 999,
      'enduser.pseudo.id': operation === 'invoke_agent' ? 'opaque-sdk-id' : undefined
    }, start, start + 100, undefined, { traceId, parentSpanId, parentKnown: true });
    const workflow = make('workflow', 'invoke_workflow', undefined, undefined);
    const root = make('root', 'invoke_agent', 'workflow', 5e9);
    const tool = make('tool', 'execute_tool', 'root', undefined);
    const nested = make('nested', 'invoke_agent', 'tool', 3e9);
    const child = make('child', 'chat', 'nested', 3e9);
    const first = make('first', 'chat', 'root', 2e9);
    const zero = make('zero-root', 'invoke_agent', undefined, 0, 'zero');
    const orphan = make('orphan', 'invoke_agent', 'missing', 7e9);
    const digest = digestSpans([workflow, root, root, tool, nested, child, first, zero, orphan, span('legacy', 'chat')]);
    assert.equal(root.credits, undefined);
    assert.equal(root.sdkCredits, 5);
    assert.equal(digest.sdkCredits.invocations, 2);
    assert.equal(digest.sdkCredits.reportedInvocations, 2);
    assert.equal(digest.sdkCredits.credits, 5);
    assert.equal(digest.sdkCredits.unclassifiedInvocations, 1);
    assert.equal(digest.sdkCredits.modelCalls, 2);
    assert.equal(digest.credits, 1.5, 'SDK roots are not added to per-call VS Code credits');
    assert.equal(digest.byUser.find((r) => r.key !== null), undefined, 'pseudonyms are not GitHub logins');
    assert.equal(digest.byActorId.find((r) => r.key === 'opaque-sdk-id').calls, 2);
    assert.equal(digest.sessions.find((s) => s.sessionId === 'sdk-session').credits, undefined);
  });

  it('leaves SDK credits unknown with missing, cyclic or inconsistent ancestry', () => {
    const make = (id, parentSpanId, parentKnown, traceId = 'sdk') => usageSpan(id, {
      'gen_ai.operation.name': 'invoke_agent', 'github.copilot.nano_aiu': 2e9
    }, start, start + 100, undefined, { parentSpanId, parentKnown, traceId });
    const digest = digestSpans([
      make('unknown', undefined, false),
      make('cycle-a', 'cycle-b', true), make('cycle-b', 'cycle-a', true),
      make('foreign', 'other-root', true), make('other-root', undefined, true, 'other')
    ]);
    assert.equal(digest.sdkCredits.credits, 2, 'only the independent confirmed root is counted');
    assert.equal(digest.sdkCredits.unclassifiedInvocations, 4);
    const record = {
      spanId: 'bad-parent', startTime: [start / 1000, 0], endTime: [start / 1000 + 1, 0],
      parentSpanContext: 42, attributes: { 'gen_ai.operation.name': 'invoke_agent', 'github.copilot.nano_aiu': 2e9 }
    };
    assert.equal(fileUsageSpan(record).parentKnown, false);
  });

  it('merges optional file metadata with an older SQLite copy without duplicating usage', () => {
    const record = {
      spanId: 'shared', traceId: 'trace', parentSpanContext: { spanId: 'parent' },
      startTime: [start / 1000, 0], endTime: [start / 1000 + 1, 0],
      attributes: { 'gen_ai.operation.name': 'chat', 'github.copilot.nano_aiu': 2e9,
        'gen_ai.response.time_to_first_chunk': 1.5, 'gen_ai.usage.input_tokens': 100 }
    };
    const file = fileUsageSpan(record);
    const db = usageSpan('shared', { 'gen_ai.operation.name': 'chat', 'gen_ai.usage.input_tokens': 0 }, start, start + 1000);
    const merged = mergeUsageSpan(file, db);
    assert.equal(merged.input, 0, 'known database zero wins');
    assert.equal(merged.traceId, 'trace');
    assert.equal(merged.parentSpanId, 'parent');
    assert.equal(merged.parentKnown, true);
    assert.equal(merged.firstChunk, 1500);
    assert.equal(merged.sdkCredits, 2);
    assert.equal(merged.credits, undefined);
  });

  it('maps SDK tool counters and second-based timings without adding legacy aliases', () => {
    const rollup = new OtelRollup();
    rollup.ingest({ resource: {}, scopeMetrics: [{ metrics: [
      { descriptor: { name: 'github.copilot.tool.call.count' }, dataPoints: [
        { attributes: { success: true }, endTime: [1, 0], value: 3 },
        { attributes: { success: false }, endTime: [1, 0], value: 1 }
      ] },
      { descriptor: { name: 'gen_ai.client.operation.time_to_first_chunk' }, dataPoints: [
        { attributes: {}, endTime: [1, 0], value: { count: 2, sum: 3, min: 1, max: 2, buckets: { boundaries: [1, 2], counts: [1, 1, 0] } } }
      ] },
      { descriptor: { name: 'github.copilot.tool.call.duration' }, dataPoints: [
        { attributes: {}, endTime: [1, 0], value: { count: 1, sum: 2, min: 2, max: 2, buckets: { boundaries: [2], counts: [1, 0] } } }
      ] }
    ] }] });
    const spans = digestSpans([]);
    const quality = buildQuality({ rollup, spans });
    assert.equal(quality.toolCalls, 4);
    assert.equal(quality.toolFailures, 1);
    const speed = buildSpeed({ rollup, spans });
    assert.ok(speed.firstChunkMedianMs.value > 0 && speed.firstChunkMedianMs.value <= 2000);
    assert.ok(speed.toolMedianMs.value > 0 && speed.toolMedianMs.value <= 2000);
    rollup.ingest({ resource: {}, scopeMetrics: [{ metrics: [{
      descriptor: { name: 'copilot_chat.tool.call.count' }, dataPoints: [{ attributes: {}, endTime: [2, 0], value: 0 }]
    }] }] });
    assert.equal(buildQuality({ rollup, spans }).toolCalls, 0, 'measured legacy zero wins; overlapping aliases are not added');
  });
});
