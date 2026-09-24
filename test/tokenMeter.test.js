'use strict';

/**
 * Tests for the token accounting.
 *
 * Every scenario here is one that previously produced a wrong number: the same
 * request billed twice at handover, a delta dropped and lost for good, usage
 * suppressed while one watcher was stale. The meter is the only place in this
 * extension where being quietly wrong costs the user something, so the cases
 * are written from the failure rather than from the implementation.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { beforeEach, describe, it } = require('node:test');

const build = process.env.BEAR_TEST_BUILD;
if (!build) {
  throw new Error('Run these through `npm test`, which bundles the modules first.');
}

const { TokenMeter } = require(path.join(build, 'tokenMeter.js'));

/** The bundled `vscode` stub reads settings from this global. */
function settings(next) {
  globalThis.__BEAR_SETTINGS__ = next || {};
}

/** A `vscode.Memento` that just holds a value. */
function memento() {
  const store = new Map();
  return {
    get: (key) => store.get(key),
    update: (key, value) => {
      store.set(key, JSON.parse(JSON.stringify(value)));
      return Promise.resolve();
    },
    /** Same backing store, so a new meter resumes where the old one left off. */
    store
  };
}

function meter(mem = memento()) {
  return { meter: new TokenMeter(mem), mem };
}

describe('charging one stream of traffic', () => {
  beforeEach(() => {
    // Settings live on a global, so a failing test must not leak into the next.
    settings({});
  });

  it('charges transcripts before telemetry is connected', () => {
    const { meter: m } = meter();
    m.observe('transcripts', 1000, 200);
    assert.equal(m.snapshot().total, 1200);
    assert.equal(m.snapshot().source, 'transcripts');
  });

  it('does not bill the same request twice at handover', () => {
    const { meter: m } = meter();
    // The transcripts see the request first; telemetry lags by an export
    // interval and reports the very same tokens a moment later.
    m.observe('transcripts', 3000, 500);
    m.observe('otel', 3000, 500);
    assert.equal(m.snapshot().total, 3500, 'one request, one charge');
  });

  it('lets telemetry take over and keep charging', () => {
    const { meter: m } = meter();
    m.observe('transcripts', 1000, 0);
    m.observe('otel', 1000, 0);
    // From here telemetry reports a request the transcripts have not caught up
    // with yet. It must still be charged.
    m.observe('otel', 400, 0);
    assert.equal(m.snapshot().total, 1400);
    assert.equal(m.snapshot().source, 'otel');
  });

  it('does not lose telemetry the transcripts never report', () => {
    const { meter: m } = meter();
    m.observe('transcripts', 500, 0);
    m.observe('otel', 500, 0);
    // The transcript watcher goes quiet — restarting, disabled, whatever.
    // Telemetry keeps reporting and every token still has to land.
    m.observe('otel', 200, 0);
    m.observe('otel', 300, 0);
    assert.equal(m.snapshot().total, 1000);
  });

  it('does not lose transcripts after telemetry goes quiet', () => {
    const { meter: m } = meter();
    m.observe('transcripts', 1000, 0);
    m.observe('otel', 1000, 0);
    m.observe('otel', 500, 0);
    assert.equal(m.snapshot().total, 1500);

    // Telemetry stops. The transcripts carry on and must overtake rather than
    // being suppressed by a stale reading.
    m.observe('transcripts', 400, 0);
    m.observe('transcripts', 400, 0);
    assert.equal(m.snapshot().total, 1800);
    assert.equal(m.snapshot().source, 'transcripts');
  });

  it('never goes backwards', () => {
    const { meter: m } = meter();
    let last = 0;
    const steps = [
      ['transcripts', 900],
      ['otel', 900],
      ['otel', 300],
      ['transcripts', 300],
      ['transcripts', 700],
      ['otel', 100],
      ['otel', 900]
    ];
    for (const [from, n] of steps) {
      m.observe(from, n, 0);
      const now = m.snapshot().total;
      assert.ok(now >= last, `total fell from ${last} to ${now} after ${from} +${n}`);
      last = now;
    }
  });

  it('hands back to the transcripts when the feed stops, without moving the figure', () => {
    const { meter: m } = meter();
    m.observe('transcripts', 1000, 0);
    m.observe('otel', 1000, 0);
    m.observe('otel', 800, 0);
    assert.equal(m.snapshot().total, 1800);
    assert.equal(m.snapshot().source, 'otel');

    // The feed goes quiet. The transcripts must resume charging immediately,
    // not after climbing back up to telemetry's total.
    m.noteOtelAlive(false);
    assert.equal(m.snapshot().total, 1800, 'handing back must not move the figure');
    assert.equal(m.snapshot().source, 'transcripts');

    m.observe('transcripts', 100, 0);
    assert.equal(m.snapshot().total, 1900, 'the next transcript delta lands on top');
  });

  it('keeps the first telemetry delta when the transcript watcher is off', () => {
    const mem = memento();
    // Historical transcript usage exists, but the watcher is disabled now, so
    // it cannot have observed this request.
    mem.store.set('iceberg.usage.v3', {
      otel: { input: 0, output: 0, requests: 0 },
      transcripts: { input: 5000, output: 0, requests: 2 },
      promoted: false,
      manual: { input: 0, output: 0, requests: 0 },
      credits: 0,
      since: 1,
      sinceHandover: { otel: 0, transcripts: 0 }
    });
    settings({ 'iceberg.trackCopilotChat': false });
    const m = new TokenMeter(mem);
    m.observe('otel', 700, 0);
    assert.equal(m.snapshot().total, 5700, 'nobody else could have counted it');
    settings({});
  });

  it('charges the first telemetry export when the transcripts are not overlapping', () => {
    // Historical transcript usage plus a feed that only starts producing later:
    // the transcripts cannot have seen this request, so absorbing it would lose
    // real usage. Only recent transcript activity is evidence of overlap.
    const mem = memento();
    mem.store.set('iceberg.usage.v3', {
      otel: { input: 0, output: 0, requests: 0 },
      transcripts: { input: 1000, output: 0, requests: 3 },
      promoted: false,
      manual: { input: 0, output: 0, requests: 0 },
      credits: 0,
      since: 1,
      sinceHandover: { otel: 0, transcripts: 0 }
    });
    const m = new TokenMeter(mem);
    m.observe('otel', 500, 0);
    assert.equal(m.snapshot().total, 1500, 'a genuinely new request must be charged');
  });

  it('still absorbs when the transcripts just reported the same request', () => {
    const { meter: m } = meter();
    m.observe('transcripts', 3000, 500);
    m.observe('otel', 3000, 500);
    assert.equal(m.snapshot().total, 3500, 'one request, one charge');
  });

  it('reports each dimension from whichever watcher is ahead on it', () => {
    // Selecting one ledger wholesale by combined total could show the loser's
    // split. total must stay equal to input + output.
    const { meter: m } = meter();
    m.observe('transcripts', 1000, 0);
    m.observe('otel', 1000, 0);
    m.observe('otel', 0, 400);
    m.observe('transcripts', 300, 0);
    const s = m.snapshot();
    assert.equal(s.input, 1300);
    assert.equal(s.output, 400);
    assert.equal(s.total, s.input + s.output);
  });

  it('charges the part of a handover delta the transcripts cannot account for', () => {
    // Telemetry reports growth since its own baseline, which can span more than
    // the transcripts just reported. Absorbing the whole delta would lose the
    // difference permanently.
    const { meter: m } = meter();
    m.observe('transcripts', 1000, 0);
    // Telemetry's first export covers that request plus 400 the transcripts
    // never reported.
    m.observe('otel', 1400, 0);
    assert.equal(m.snapshot().total, 1400, 'the unmatched 400 must still be charged');
  });

  it('absorbs each dimension against its own evidence', () => {
    // A scalar budget would absorb 100 of a 100-in/100-out delta and split the
    // surplus by ratio, landing 150 in / 50 out instead of 100 / 100.
    const { meter: m } = meter();
    m.observe('transcripts', 100, 0);
    m.observe('otel', 100, 100);
    const s = m.snapshot();
    assert.equal(s.input, 100, 'the input half was already counted');
    assert.equal(s.output, 100, 'the output half was not');
  });

  it('does not refreeze the ice when telemetry is switched off', () => {
    const { meter: m } = meter();
    m.observe('transcripts', 1000, 0);
    m.observe('otel', 1000, 0);
    m.observe('otel', 400, 0);
    assert.equal(m.snapshot().total, 1400);

    // Disabling telemetry must hand the figure over, not fall back to the
    // smaller transcript ledger and grow the berg back.
    settings({ 'iceberg.otel.enabled': false });
    assert.equal(m.snapshot().total, 1400, 'the meter must never go backwards');
    settings({});
  });

  it('survives a restart mid-handover', () => {
    const mem = memento();
    const a = new TokenMeter(mem);
    a.observe('transcripts', 2000, 0);
    a.observe('otel', 2000, 0);
    a.observe('otel', 600, 0);
    const before = a.snapshot().total;
    a.dispose();

    // Nothing held only in memory may be lost across a restart.
    const b = new TokenMeter(mem);
    assert.equal(b.snapshot().total, before);
    b.observe('otel', 100, 0);
    assert.equal(b.snapshot().total, before + 100);
  });
});

describe('manual reports', () => {
  it('are added on top, because neither watcher can see them', () => {
    const { meter: m } = meter();
    m.observe('transcripts', 1000, 0);
    m.report(250, 50);
    assert.equal(m.snapshot().total, 1300);
  });

  it('are not cancelled out by the max over watchers', () => {
    const { meter: m } = meter();
    m.report(500, 0);
    m.observe('transcripts', 1000, 0);
    m.observe('otel', 1000, 0);
    assert.equal(m.snapshot().total, 1500);
  });
});

describe('credits', () => {
  it('always come from the transcripts, whichever source leads', () => {
    const { meter: m } = meter();
    m.observe('transcripts', 100, 0, 1, 2.5);
    m.observe('otel', 100, 0);
    m.observe('otel', 900, 0);
    assert.equal(m.snapshot().source, 'otel');
    assert.equal(m.snapshot().credits, 2.5, 'telemetry does not emit credits');
  });
});

describe('drift', () => {
  it('is pending until both have seen the same window', () => {
    const { meter: m } = meter();
    m.observe('transcripts', 5000, 0);
    m.observe('otel', 5000, 0);
    assert.equal(m.snapshot().drift.pending, true);
  });

  it('stays pending when only telemetry has observed the overlap window', () => {
    const { meter: m } = meter();
    m.observe('otel', 5000, 0);
    assert.equal(m.snapshot().drift.pending, true);
  });

  it('reports agreement when both see the same traffic', () => {
    const { meter: m } = meter();
    m.observe('transcripts', 1000, 0);
    m.observe('otel', 1000, 0);
    m.observe('transcripts', 800, 0);
    m.observe('otel', 800, 0);
    const d = m.snapshot().drift;
    assert.equal(d.pending, false);
    assert.equal(d.agreeing, true);
    assert.equal(d.deltaTokens, 0);
  });
});

describe('health', () => {
  it('tracks the context window when one is reported', () => {
    const { meter: m } = meter();
    m.setContext({ used: 32000, limit: 128000, model: 'gpt-4o', atMs: Date.now() });
    const s = m.snapshot();
    assert.equal(s.basis, 'context');
    assert.equal(Math.round(s.health * 100), 75);
  });

  it('ignores a context reading that has gone stale', () => {
    const { meter: m } = meter();
    m.setContext({ used: 120000, limit: 128000, model: null, atMs: Date.now() - 60 * 60 * 1000 });
    assert.equal(m.snapshot().basis, 'budget');
  });
});

describe('migration', () => {
  it('drops invalid and caps persisted overlap evidence', () => {
    const mem = memento();
    const now = Date.now();
    mem.store.set('iceberg.usage.v3', {
      otel: {},
      transcripts: {},
      manual: {},
      recentTranscript: [
        ...Array.from({ length: 1002 }, () => ({ at: now, input: 1, output: 0 })),
        { at: now, input: 1, output: 0 },
        { at: 'bad', input: 1, output: 0 },
        { at: now, input: -1, output: 0 },
        { at: now - 10 * 60 * 1000, input: 1, output: 0 }
      ]
    });
    const m = new TokenMeter(mem);
    m.observe('otel', 1001, 0);
    assert.equal(m.snapshot().total, 1, 'only the capped recent transcript evidence is absorbed');
  });

  it('carries a v2 meter forward without losing or re-charging anything', () => {
    const mem = memento();
    mem.store.set('iceberg.usage.v2', {
      auto: { input: 1_000_000, output: 100_000, requests: 40 },
      manual: { input: 5000, output: 0, requests: 1 },
      credits: 12,
      since: 1
    });
    const m = new TokenMeter(mem);
    const s = m.snapshot();
    assert.equal(s.total, 1_105_000);
    assert.equal(s.credits, 12);

    // Telemetry connecting must not re-charge the carried history...
    m.observe('otel', 1000, 0);
    assert.equal(
      m.snapshot().total,
      1_106_000,
      'with no recent transcript activity there is no evidence of overlap, so the delta is charged'
    );
    // ...and the carried figure itself is still intact underneath it.
    assert.ok(m.snapshot().total > 1_105_000);
  });

  it('carries a v1 meter forward', () => {
    const mem = memento();
    mem.store.set('iceberg.usage.v1', { input: 900, output: 100, requests: 3, credits: 1, since: 1 });
    assert.equal(new TokenMeter(mem).snapshot().total, 1000);
  });
});
