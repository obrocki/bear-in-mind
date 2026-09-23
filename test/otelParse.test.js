'use strict';

/**
 * Tests for the OpenTelemetry parsing and aggregation.
 *
 * The fixture in `fixtures/otel-feed.jsonl` is not hand-written. It was produced
 * by driving the real OpenTelemetry SDK through exporters that replicate
 * Copilot Chat's `fileExporters.ts` byte for byte, so the record shapes here are
 * the shapes the extension will actually meet — including the awkward one where
 * every span serialises to `{}`.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const build = process.env.BEAR_TEST_BUILD;
if (!build) {
  throw new Error('Run these through `npm test`, which bundles the modules first.');
}

const {
  OtelRollup,
  classify,
  hrToMs,
  resourceAttributes,
  toLogEvent,
  TOKEN_USAGE,
  EDIT_ACCEPTANCE,
  LINES_OF_CODE,
  TOOL_CALL_COUNT
} = require(path.join(build, 'otelParse.js'));

const { computeDrift, percentile, buildQuality, buildSpeed, buildCost } = require(
  path.join(build, 'otelSummary.js')
);

const FIXTURE = path.join(__dirname, 'fixtures', 'otel-feed.jsonl');
const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);

function loaded() {
  const rollup = new OtelRollup();
  for (const line of lines) {
    rollup.ingestLine(line);
  }
  return rollup;
}

describe('record classification', () => {
  it('tells the three record shapes apart', () => {
    const kinds = lines.map((l) => classify(JSON.parse(l)));
    assert.ok(kinds.includes('metrics'), 'expected metrics records');
    assert.ok(kinds.includes('log'), 'expected log records');
    assert.ok(kinds.includes('span'), 'expected span records');
  });

  it('treats an empty object as a span rather than as unknown', () => {
    // SDK v2 keeps span state in private fields, so JSON.stringify yields `{}`.
    // Recognising that is what lets the dashboard explain the missing timings.
    assert.equal(classify({}), 'span');
  });

  it('does not mistake a metrics record for a log record', () => {
    assert.equal(classify({ resource: {}, scopeMetrics: [], attributes: {} }), 'metrics');
  });

  it('converts hrtime pairs to milliseconds', () => {
    assert.equal(hrToMs([2, 500000000]), 2500);
    assert.equal(hrToMs(undefined), 0);
    assert.equal(hrToMs(['nope']), 0);
  });

  it('reads resource attributes out of the raw pair array', () => {
    const attrs = resourceAttributes(JSON.parse(lines[0]));
    assert.equal(attrs['service.name'], 'copilot-chat');
    assert.ok(attrs['session.id']);
  });
});

describe('ingestion', () => {
  it('counts every line it sees', () => {
    const rollup = loaded();
    const { metrics, logs, spans, unknown, malformed } = rollup.stats;
    assert.equal(metrics + logs + spans + unknown + malformed, lines.length);
    assert.equal(malformed, 0);
    assert.equal(unknown, 0);
  });

  it('records freshness only from token-usage metrics', () => {
    const rollup = new OtelRollup();
    rollup.ingest({
      resource: {},
      scopeMetrics: [
        {
          metrics: [
            {
              descriptor: { name: 'copilot_chat.edit.acceptance' },
              dataPoints: [{ endTime: [1, 0], value: 1 }]
            }
          ]
        }
      ]
    });
    assert.equal(rollup.stats.lastTokenUsageAtMs, 0);

    rollup.ingest({
      resource: {},
      scopeMetrics: [
        {
          metrics: [
            {
              descriptor: { name: TOKEN_USAGE },
              dataPoints: [{ endTime: [2, 0], value: { sum: 1, count: 1 } }]
            }
          ]
        }
      ]
    });
    assert.equal(rollup.stats.lastTokenUsageAtMs, 2000);
  });

  it('counts unreadable lines instead of silently dropping them', () => {
    const rollup = new OtelRollup();
    rollup.ingestLine('{"broken": ');
    assert.equal(rollup.stats.malformed, 1);
  });

  it('ignores blank and non-JSON lines', () => {
    const rollup = new OtelRollup();
    rollup.ingestLine('');
    rollup.ingestLine('not json at all');
    assert.equal(rollup.stats.malformed, 0);
    assert.equal(rollup.stats.unknown, 0);
  });
});

describe('cumulative metrics', () => {
  it('reads token totals from the histogram sums', () => {
    const totals = loaded().tokenTotals();
    // 1500 + 880 input to gpt-4o, plus 4200 to claude; 250 + 140 output.
    assert.equal(totals.input, 6580);
    assert.equal(totals.output, 390);
  });

  it('takes the latest snapshot rather than summing successive exports', () => {
    const rollup = new OtelRollup();
    const line = lines.find((l) => JSON.parse(l).scopeMetrics);
    rollup.ingestLine(line);
    const once = rollup.tokenTotals();
    // The exporter is CUMULATIVE, so re-ingesting the same export must not
    // double the figure. This is the single easiest way to get it wrong.
    rollup.ingestLine(line);
    rollup.ingestLine(line);
    assert.deepEqual(rollup.tokenTotals(), once);
  });

  it('banks the previous run when a counter restarts', () => {
    const rollup = new OtelRollup();
    const make = (sum) => ({
      resource: { _rawAttributes: [['session.id', 's1']] },
      scopeMetrics: [
        {
          metrics: [
            {
              descriptor: { name: TOKEN_USAGE },
              dataPoints: [
                {
                  attributes: { 'gen_ai.token.type': 'input' },
                  endTime: [1, 0],
                  value: { sum, count: 1, buckets: { boundaries: [], counts: [] } }
                }
              ]
            }
          ]
        }
      ]
    });
    rollup.ingest(make(1000));
    rollup.ingest(make(2500));
    assert.equal(rollup.tokenTotals().input, 2500);
    // A drop means the exporting process restarted; the earlier peak is history
    // that still happened, so it is banked rather than lost.
    rollup.ingest(make(300));
    assert.equal(rollup.tokenTotals().input, 2800);
  });

  it('keeps separate VS Code windows apart and adds them', () => {
    const rollup = new OtelRollup();
    const make = (session, sum) => ({
      resource: { _rawAttributes: [['session.id', session]] },
      scopeMetrics: [
        {
          metrics: [
            {
              descriptor: { name: TOKEN_USAGE },
              dataPoints: [
                { attributes: { 'gen_ai.token.type': 'input' }, endTime: [1, 0], value: { sum, count: 1 } }
              ]
            }
          ]
        }
      ]
    });
    rollup.ingest(make('window-a', 1000));
    rollup.ingest(make('window-b', 700));
    assert.equal(rollup.tokenTotals().input, 1700);
  });

  it('keeps evicted series separated by their attributes', () => {
    // Regression: folding evicted series under the metric name alone added the
    // evicted input tokens to the output query as well, and vice versa, so both
    // sides of tokenTotals() were inflated by the other's evictions.
    const rollup = new OtelRollup();
    const point = (session, type, sum) => ({
      resource: { _rawAttributes: [['session.id', session]] },
      scopeMetrics: [
        {
          metrics: [
            {
              descriptor: { name: TOKEN_USAGE },
              dataPoints: [
                { attributes: { 'gen_ai.token.type': type }, endTime: [1, 0], value: { sum, count: 1 } }
              ]
            }
          ]
        }
      ]
    });
    // Comfortably past MAX_SERIES (4000) so eviction is forced.
    for (let i = 0; i < 2100; i++) {
      rollup.ingest(point('s' + i, 'input', 100));
      rollup.ingest(point('s' + i, 'output', 10));
    }
    const totals = rollup.tokenTotals();
    assert.equal(totals.input, 2100 * 100);
    assert.equal(totals.output, 2100 * 10);
  });

  it('keeps folded series visible to every query, not just total()', () => {
    const rollup = new OtelRollup();
    const point = (session, model, sum) => ({
      resource: { _rawAttributes: [['session.id', session]] },
      scopeMetrics: [
        {
          metrics: [
            {
              descriptor: { name: TOKEN_USAGE },
              dataPoints: [
                {
                  attributes: { 'gen_ai.token.type': 'input', 'gen_ai.request.model': model },
                  endTime: [1, 0],
                  value: { sum, count: 1 }
                }
              ]
            }
          ]
        }
      ]
    });
    for (let i = 0; i < 4200; i++) {
      rollup.ingest(point('s' + i, 'gpt-4o', 50));
    }
    const byModel = rollup.tokensByModel();
    assert.equal(byModel.length, 1);
    // tokensByModel() used to ignore folded series entirely, so it disagreed
    // with total() on the same data.
    assert.equal(byModel[0].input, rollup.total(TOKEN_USAGE, { 'gen_ai.token.type': 'input' }));
    assert.equal(byModel[0].input, 4200 * 50);
  });

  it('rebases a series that reappears after eviction instead of adding to it', () => {
    // Regression: an evicted series was folded away, and a later export for the
    // same key created a fresh series from zero. The incoming value is
    // cumulative and already contains the folded history, so total() counted
    // that history twice.
    const rollup = new OtelRollup();
    const point = (session, sum) => ({
      resource: { _rawAttributes: [['session.id', session]] },
      scopeMetrics: [
        {
          metrics: [
            {
              descriptor: { name: TOKEN_USAGE },
              dataPoints: [
                { attributes: { 'gen_ai.token.type': 'input' }, endTime: [1, 0], value: { sum, count: 1 } }
              ]
            }
          ]
        }
      ]
    });

    rollup.ingest(point('victim', 500));
    // Force the victim out by filling the map well past MAX_SERIES.
    for (let i = 0; i < 4200; i++) {
      rollup.ingest(point('filler' + i, 1));
    }
    const afterEviction = rollup.tokenTotals().input;

    // The victim exports again, cumulatively: 500 already burned plus 300 more.
    rollup.ingest(point('victim', 800));
    const afterReturn = rollup.tokenTotals().input;

    assert.equal(afterReturn - afterEviction, 300, 'only the growth should be added');
  });

  it('keeps pre-restart samples in quantile estimates', () => {
    const rollup = new OtelRollup();
    const histogram = (sum, count, counts) => ({
      resource: { _rawAttributes: [['session.id', 's1']] },
      scopeMetrics: [
        {
          metrics: [
            {
              descriptor: { name: 'copilot_chat.tool.call.duration' },
              dataPoints: [
                {
                  attributes: {},
                  endTime: [1, 0],
                  value: { sum, count, buckets: { boundaries: [0, 50, 100, 200], counts } }
                }
              ]
            }
          ]
        }
      ]
    });

    // Ten slow samples, then the exporter restarts with one fast sample.
    rollup.ingest(histogram(2000, 10, [0, 0, 0, 10, 0]));
    rollup.ingest(histogram(10, 1, [0, 1, 0, 0, 0]));

    const median = rollup.quantile('copilot_chat.tool.call.duration', 0.5);
    // With the pre-restart buckets banked, the median still sits in the slow
    // bucket. Dropping them would move it into the 0–50 bucket.
    assert.ok(median > 100, `expected the slow bucket to survive the restart, got ${median}`);
  });

  it('filters totals by attribute', () => {
    const rollup = loaded();
    assert.equal(rollup.total(EDIT_ACCEPTANCE, { 'copilot_chat.edit.outcome': 'accepted' }), 3);
    assert.equal(rollup.total(EDIT_ACCEPTANCE, { 'copilot_chat.edit.outcome': 'rejected' }), 1);
    assert.equal(rollup.total(LINES_OF_CODE, { type: 'added' }), 142);
    assert.equal(rollup.total(LINES_OF_CODE, { type: 'removed' }), 37);
  });

  it('splits tokens by model', () => {
    const byModel = loaded().tokensByModel();
    const gpt = byModel.find((m) => m.model === 'gpt-4o');
    const claude = byModel.find((m) => m.model === 'claude-sonnet-4.6');
    assert.equal(gpt.input, 2380);
    assert.equal(gpt.output, 390);
    assert.equal(claude.input, 4200);
    // Sorted by total burn, so the biggest consumer leads.
    assert.equal(byModel[0].model, 'claude-sonnet-4.6');
  });

  it('estimates quantiles from histogram buckets', () => {
    const rollup = new OtelRollup();
    rollup.ingest({
      resource: { _rawAttributes: [] },
      scopeMetrics: [
        {
          metrics: [
            {
              descriptor: { name: 'copilot_chat.tool.call.duration' },
              dataPoints: [
                {
                  attributes: {},
                  endTime: [1, 0],
                  value: {
                    sum: 300,
                    count: 4,
                    buckets: { boundaries: [0, 50, 100, 200], counts: [0, 4, 0, 0, 0] }
                  }
                }
              ]
            }
          ]
        }
      ]
    });
    const median = rollup.quantile('copilot_chat.tool.call.duration', 0.5);
    assert.ok(median > 0 && median <= 50, `expected the 0–50 bucket, got ${median}`);
  });

  it('returns nothing rather than zero when a metric was never recorded', () => {
    assert.equal(loaded().quantile('copilot_chat.nonexistent', 0.5), undefined);
    assert.equal(loaded().mean('copilot_chat.nonexistent'), undefined);
  });
});

describe('log events', () => {
  it('never retains prompt or response content', () => {
    // SECURITY.md promises these are never read. captureContent puts them in
    // the feed, so they have to be dropped at the parser boundary rather than
    // kept on the event and merely not displayed.
    const event = toLogEvent({
      attributes: {
        'event.name': 'gen_ai.client.inference.operation.details',
        'gen_ai.usage.input_tokens': 1500,
        'gen_ai.input.messages': '[{"role":"user","content":"my secret prompt"}]',
        'gen_ai.output.messages': '[{"role":"assistant","content":"the answer"}]',
        'gen_ai.system_instructions': 'you are a helpful assistant',
        'gen_ai.tool.definitions': '[{"type":"function"}]',
        'gen_ai.tool.call.arguments': '{"filePath":"/src/secrets.ts"}',
        'gen_ai.tool.call.result': 'const apiKey = "sk-live-123"'
      }
    });
    assert.equal(event.attributes['gen_ai.usage.input_tokens'], 1500);
    for (const key of [
      'gen_ai.input.messages',
      'gen_ai.output.messages',
      'gen_ai.system_instructions',
      'gen_ai.tool.definitions',
      'gen_ai.tool.call.arguments',
      'gen_ai.tool.call.result'
    ]) {
      assert.ok(!(key in event.attributes), `${key} must not be retained`);
    }
    assert.ok(
      !JSON.stringify(event).includes('sk-live-123'),
      'no content value should survive anywhere on the event'
    );
  });

  it('drops oversized string attributes it does not recognise', () => {
    const event = toLogEvent({
      attributes: { 'event.name': 'x', 'some.future.content': 'a'.repeat(5000), keep: 'short' }
    });
    assert.equal(event.attributes.keep, 'short');
    assert.ok(!('some.future.content' in event.attributes));
  });

  it('names an event from its attribute, falling back to the body', () => {
    assert.equal(toLogEvent({ attributes: { 'event.name': 'a' }, _body: 'b' }).name, 'a');
    assert.equal(toLogEvent({ attributes: {}, _body: 'b' }).name, 'b');
    assert.equal(toLogEvent({ attributes: {} }), undefined);
  });

  it('collects the events from the feed', () => {
    const rollup = loaded();
    assert.equal(rollup.countEvents('copilot_chat.edit.feedback'), 1);
    assert.equal(rollup.countEvents('copilot_chat.user.feedback'), 1);
    const [survival] = rollup.recentEvents('copilot_chat.edit.survival');
    assert.equal(survival.attributes.survival_rate_four_gram, 0.82);
  });
});

describe('summary sections', () => {
  const base = (rollup) => ({
    rollup,
    spans: {
      available: false,
      sessions: [],
      agentDurationsMs: [],
      llmDurationsMs: [],
      ttftMs: [],
      turnCounts: [],
      toolDurationsMs: new Map(),
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0
    },
    feed: {},
    bearName: 'Nanuq',
    budget: 1000000,
    health: 0.5,
    totals: { input: 6580, output: 390, credits: 2 },
    source: 'otel',
    drift: computeDrift(0, 0)
  });

  it('builds cost from the telemetry totals', () => {
    const cost = buildCost(base(loaded()));
    assert.equal(cost.totalTokens, 6970);
    assert.ok(cost.available);
    assert.equal(cost.credits, 2);
    assert.equal(cost.byModel.length, 2);
  });

  it('falls back to the meter totals when transcripts hold the meter', () => {
    const input = base(new OtelRollup());
    input.source = 'transcripts';
    const cost = buildCost(input);
    assert.equal(cost.inputTokens, 6580);
    assert.equal(cost.source, 'transcripts');
  });

  it('marks histogram-derived timings as estimates', () => {
    const speed = buildSpeed(base(loaded()));
    assert.equal(speed.sessionMedianMs.source, 'metrics');
  });

  it('prefers exact span timings when they exist', () => {
    const input = base(loaded());
    input.spans.available = true;
    input.spans.sessions = [
      { sessionId: 'a', agentName: null, model: null, startedAt: 0, endedAt: 0, durationMs: 12000, llmCalls: 3, toolCalls: 2, inputTokens: 0, outputTokens: 0, cachedTokens: 0 }
    ];
    const speed = buildSpeed(input);
    assert.equal(speed.sessionMedianMs.source, 'spans');
    assert.equal(speed.sessionMedianMs.value, 12000);
    assert.equal(speed.sessions, 1);
  });

  it('derives the accept rate and names what is still missing', () => {
    const quality = buildQuality(base(loaded()));
    assert.equal(quality.editsAccepted, 3);
    assert.equal(quality.editsRejected, 1);
    assert.equal(quality.acceptRate, 0.75);
    assert.equal(quality.pullRequests, 1);
    assert.equal(quality.linesAdded, 142);
    assert.equal(quality.survivalFourGram, 0.82);
    assert.ok(quality.toolSuccessRate < 1, 'one tool call failed in the fixture');
    // The fixture exercises every quality instrument, so nothing is outstanding.
    assert.deepEqual(quality.missing, []);
  });

  it('names the signals a partial feed has not produced', () => {
    const rollup = new OtelRollup();
    rollup.ingest({
      resource: { _rawAttributes: [] },
      scopeMetrics: [
        {
          metrics: [
            {
              descriptor: { name: LINES_OF_CODE },
              dataPoints: [{ attributes: { type: 'added' }, endTime: [1, 0], value: 12 }]
            }
          ]
        }
      ]
    });
    const quality = buildQuality(base(rollup));
    assert.ok(quality.available, 'lines of code alone is still something to show');
    assert.ok(quality.missing.includes('edit accept / reject'));
    assert.ok(quality.missing.includes('edit survival'));
    assert.ok(quality.missing.includes('pull requests'));
  });

  it('reports nothing as unavailable rather than as zero', () => {
    const quality = buildQuality(base(new OtelRollup()));
    assert.equal(quality.available, false);
    assert.equal(quality.acceptRate, undefined);
  });
});

describe('drift', () => {
  it('is pending until both sources have seen something', () => {
    assert.equal(computeDrift(0, 0).pending, true);
  });

  it('tolerates the difference cache and reasoning tokens create', () => {
    assert.equal(computeDrift(1000, 990).agreeing, true);
    assert.equal(computeDrift(1000, 800).agreeing, false);
  });

  it('signs the delta from the telemetry side', () => {
    assert.equal(computeDrift(1200, 1000).deltaTokens, 200);
    assert.equal(computeDrift(800, 1000).deltaTokens, -200);
  });
});

describe('percentile', () => {
  it('interpolates between samples', () => {
    assert.equal(percentile([10, 20, 30, 40], 0.5), 25);
    assert.equal(percentile([5], 0.95), 5);
    assert.equal(percentile([], 0.5), undefined);
  });
});

describe('tool metrics', () => {
  it('counts calls and failures separately', () => {
    const rollup = loaded();
    assert.equal(rollup.total(TOOL_CALL_COUNT), 2);
    assert.equal(rollup.total(TOOL_CALL_COUNT, { success: 'false' }), 1);
  });
});
