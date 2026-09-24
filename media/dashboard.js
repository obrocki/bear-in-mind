// @ts-check
/* Bear in Mind — cost / speed / quality dashboard renderer.
 *
 * Plain DOM and inline SVG, no dependencies and no build step, matching the
 * conventions in media/main.js. The extension does all the aggregation; this
 * file only ever formats what it is handed and never computes a metric of its
 * own — if a number looks wrong, it is wrong in src/otelSummary.ts.
 */
(function () {
  'use strict';

  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
  const root = document.getElementById('sections');
  const banner = document.getElementById('banner');
  const provenance = document.getElementById('provenance');

  const SVG = 'http://www.w3.org/2000/svg';

  /** Single source of truth for colour: everything comes from dashboard.css. */
  const palette = (function () {
    const style = getComputedStyle(document.documentElement);
    const read = (name, fallback) => (style.getPropertyValue(name) || '').trim() || fallback;
    return {
      cost: read('--cost', '#9fd8ff'),
      costFrom: read('--cost-from', '#6fc3ff'),
      costTo: read('--cost-to', '#d7f2ff'),
      speed: read('--speed', '#7fe3b4'),
      quality: read('--quality', '#ffcf7a'),
      warn: read('--warn', '#ff8a6b')
    };
  })();

  // ------------------------------------------------------------ formatting ---

  function tokens(n) {
    if (!isFinite(n) || n <= 0) return '0';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
    if (n >= 1e4) return Math.round(n / 1e3) + 'k';
    return Math.round(n).toLocaleString('en-US');
  }

  function count(n) {
    return isFinite(n) ? Math.round(n).toLocaleString('en-US') : '0';
  }

  /** Durations read best in the largest unit that keeps a leading digit. */
  function duration(ms) {
    if (ms === undefined || ms === null || !isFinite(ms) || ms <= 0) return '—';
    if (ms < 1000) return Math.round(ms) + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
    const minutes = ms / 60000;
    if (minutes < 60) return minutes.toFixed(minutes < 10 ? 1 : 0) + 'm';
    return (minutes / 60).toFixed(1) + 'h';
  }

  function percent(ratio, digits) {
    if (ratio === undefined || ratio === null || !isFinite(ratio)) return '—';
    return (ratio * 100).toFixed(digits === undefined ? 0 : digits) + '%';
  }

  function ago(ms) {
    if (!ms) return 'never';
    const delta = Date.now() - ms;
    if (delta < 0 || delta < 15000) return 'just now';
    if (delta < 90000) return Math.round(delta / 1000) + 's ago';
    if (delta < 5400000) return Math.round(delta / 60000) + 'm ago';
    return Math.round(delta / 3600000) + 'h ago';
  }

  // --------------------------------------------------------------- builders --

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function headline(value, unit, note) {
    const wrap = el('div');
    const line = el('div', 'headline');
    line.append(el('span', 'value', value));
    if (unit) line.append(el('span', 'unit', unit));
    wrap.append(line);
    wrap.append(el('p', 'headline-note', note || ''));
    return wrap;
  }

  /**
   * @param {Array<{label:string,value:string,qualifier?:string,estimate?:boolean}>} items
   */
  function stats(items) {
    const grid = el('dl', 'stats');
    for (const item of items) {
      const cell = el('div', 'stat');
      if (item.estimate) cell.dataset.estimate = 'true';
      cell.append(el('dt', null, item.label));
      const dd = el('dd', null, item.value);
      if (item.qualifier) {
        dd.append(' ');
        dd.append(el('span', 'qualifier', item.qualifier));
      }
      cell.append(dd);
      grid.append(cell);
    }
    return grid;
  }

  /** A measure carries where it came from, so estimates can be marked. */
  function measure(m, format) {
    const value = m && m.value !== undefined && m.value !== null ? format(m.value) : '—';
    return { value: value, estimate: !!m && m.source === 'metrics' };
  }

  function emptyState(lines, action) {
    const box = el('div', 'empty');
    for (const line of lines) box.append(el('p', null, line));
    if (action) {
      const actions = el('div', 'actions');
      const button = el('button', 'secondary', action.label);
      button.addEventListener('click', () => post(action.command));
      actions.append(button);
      box.append(actions);
    }
    return box;
  }

  function post(type) {
    if (vscode) vscode.postMessage({ type: type });
  }

  // --------------------------------------------------------------- graphics --

  function svg(width, height) {
    const node = document.createElementNS(SVG, 'svg');
    node.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    node.setAttribute('preserveAspectRatio', 'none');
    node.setAttribute('role', 'img');
    return node;
  }

  function shape(name, attrs) {
    const node = document.createElementNS(SVG, name);
    for (const key in attrs) node.setAttribute(key, String(attrs[key]));
    return node;
  }

  /**
   * Stacked area of input and output tokens per export interval. The series is
   * already bucketed by the extension, so this only has to scale it.
   *
   * The fill uses the same two-stop ice gradient as the melt bar in the habitat
   * HUD, so the burn graph and the berg read as the same material.
   */
  function sparkline(series) {
    const W = 300;
    const H = 56;
    const node = svg(W, H);
    if (!series.length) return node;

    const gradId = 'ice-' + Math.random().toString(36).slice(2, 9);
    const defs = document.createElementNS(SVG, 'defs');
    const grad = shape('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' });
    grad.append(shape('stop', { offset: '0', 'stop-color': palette.costTo, 'stop-opacity': '0.38' }));
    grad.append(shape('stop', { offset: '1', 'stop-color': palette.costFrom, 'stop-opacity': '0.04' }));
    defs.append(grad);
    node.append(defs);

    const peak = series.reduce((max, b) => Math.max(max, b.input + b.output), 0) || 1;
    const step = series.length > 1 ? W / (series.length - 1) : W;

    const line = (pick) => {
      let d = '';
      series.forEach((bucket, i) => {
        const x = i * step;
        const y = H - (pick(bucket) / peak) * (H - 4);
        d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
      });
      return d;
    };

    const totalPath = line((b) => b.input + b.output);
    node.append(
      shape('path', { d: totalPath + ' L' + W + ' ' + H + ' L0 ' + H + ' Z', fill: 'url(#' + gradId + ')' })
    );
    node.append(
      shape('path', { d: totalPath, fill: 'none', stroke: palette.costTo, 'stroke-width': '1.5' })
    );
    node.append(
      shape('path', {
        d: line((b) => b.output),
        fill: 'none',
        stroke: palette.cost,
        'stroke-width': '1',
        'stroke-opacity': '0.5',
        'stroke-dasharray': '3 2'
      })
    );
    return node;
  }

  /**
   * Horizontal bars in HTML rather than SVG.
   *
   * The charts here are stretched to the column width with
   * `preserveAspectRatio="none"`, which distorts any text inside them. Anything
   * with labels is therefore laid out as DOM and only wordless shapes stay SVG.
   */
  function barList(rows, format) {
    const list = el('ul', 'breakdown');
    const peak = rows.reduce((max, r) => Math.max(max, r.value || 0), 0) || 1;
    for (const row of rows) {
      const item = el('li');
      item.append(el('span', 'name', row.label));
      item.append(el('span', 'amount', format(row.value)));
      const track = el('span', 'track');
      const fill = el('span');
      fill.style.width = Math.max(1, ((row.value || 0) / peak) * 100) + '%';
      track.append(fill);
      item.append(track);
      list.append(item);
    }
    return list;
  }

  /** Accept versus reject, as one proportional bar. */
  function splitBar(good, bad) {
    const W = 300;
    const H = 10;
    const node = svg(W, H);
    const total = good + bad;
    if (total === 0) return node;
    const goodW = (good / total) * W;
    node.append(shape('rect', { x: 0, y: 0, width: goodW, height: H, fill: palette.speed, 'fill-opacity': '0.85' }));
    node.append(
      shape('rect', { x: goodW, y: 0, width: W - goodW, height: H, fill: palette.warn, 'fill-opacity': '0.7' })
    );
    return node;
  }

  // --------------------------------------------------------------- sections --

  function section(key, title, measures) {
    const node = el('section', 'section');
    node.dataset.key = key;
    node.append(el('h2', null, title));
    node.append(el('p', 'hypothesis', measures));
    return node;
  }

  /**
   * Says what the ice percentage actually measures.
   *
   * It is the context window when telemetry reports one and the cumulative
   * budget otherwise, and the two mean very different things — so the label has
   * to follow the basis rather than always claiming "budget".
   */
  function headroom(cost) {
    if (cost.basis === 'context' && cost.context) {
      return (
        percent(cost.health) +
        ' of the context window free · ' +
        tokens(cost.context.used) +
        ' / ' +
        tokens(cost.context.limit) +
        (cost.context.model ? ' on ' + cost.context.model : '')
      );
    }
    return percent(cost.health) + ' of the ' + tokens(cost.budget) + '-token iceberg remains';
  }

  function renderCost(cost) {
    const node = section('cost', 'Cost', 'Tokens');

    if (!cost.available) {
      node.append(
        emptyState([
          'No token counts yet. Once Copilot Chat reports usage the iceberg starts melting and this fills in.'
        ])
      );
      return node;
    }

    node.append(
      headline(
        tokens(cost.totalTokens),
        'tokens',
        headroom(cost) +
          ' · ' +
          (cost.source === 'otel' ? 'metered by OpenTelemetry' : 'metered from chat transcripts')
      )
    );

    const rows = [
      { label: 'Input', value: tokens(cost.inputTokens) },
      { label: 'Output', value: tokens(cost.outputTokens) }
    ];
    if (cost.cachedTokens > 0) rows.push({ label: 'Cache read', value: tokens(cost.cachedTokens) });
    if (cost.reasoningTokens > 0) rows.push({ label: 'Reasoning', value: tokens(cost.reasoningTokens) });
    if (cost.credits > 0) rows.push({ label: 'Premium credits', value: cost.credits.toFixed(1) });
    if (cost.burnPerHour > 0) rows.push({ label: 'Burn rate', value: tokens(cost.burnPerHour), qualifier: '/hr' });
    node.append(stats(rows));

    if (cost.series.length > 1) {
      const viz = el('div', 'viz');
      viz.append(sparkline(cost.series));
      viz.append(el('p', 'viz-caption', 'Tokens per export interval. Dashed line is output only.'));
      node.append(viz);
    }

    if (cost.byModel.length) {
      const list = el('ul', 'breakdown');
      list.style.color = palette.cost;
      for (const model of cost.byModel.slice(0, 5)) {
        const item = el('li');
        item.append(el('span', 'name', model.model));
        item.append(el('span', 'amount', tokens(model.total)));
        const track = el('span', 'track');
        const fill = el('span');
        fill.style.width = Math.max(1, model.share * 100) + '%';
        track.append(fill);
        item.append(track);
        list.append(item);
      }
      node.append(list);
      // The split and the sparkline come from the telemetry rollup, which also
      // holds whatever was already in the feed when Bear in Mind first read it.
      // The headline is the charged ledger, which never includes that. Saying so
      // is cheaper than pretending the two cover the same window.
      node.append(
        el('p', 'viz-caption', 'Split across everything telemetry has observed, including history adopted on first run.')
      );
    }

    node.append(driftNote(cost.drift, cost.source));
    return node;
  }

  /** States plainly whether the ice agrees with the telemetry. */
  function driftNote(drift, source) {
    if (source !== 'otel') {
      return el(
        'p',
        'missing',
        'OpenTelemetry is not driving the meter yet, so there is nothing to reconcile against.'
      );
    }
    if (drift.pending) {
      return el('p', 'missing', 'Reconciliation pending: waiting for observations from both sources.');
    }
    const sign = drift.deltaTokens >= 0 ? '+' : '−';
    return el(
      'p',
      'missing',
      (drift.agreeing ? '✓ agrees with the chat transcripts' : '⚠ differs from the chat transcripts') +
        ' — OTel ' +
        tokens(drift.otelObserved) +
        ' vs transcripts ' +
        tokens(drift.transcriptObserved) +
        ' (' +
        sign +
        tokens(Math.abs(drift.deltaTokens)) +
        ', ' +
        Math.abs(drift.deltaPercent).toFixed(1) +
        '%)'
    );
  }

  function renderSpeed(speed) {
    const node = section('speed', 'Speed', 'Session duration');

    if (!speed.available) {
      node.append(
        emptyState([
          'No timings yet. Session duration comes from agent spans, which need the local trace store switched on.',
          'Without it, durations fall back to coarse estimates read off metric histograms.'
        ], { label: 'Connect telemetry…', command: 'connect' })
      );
      return node;
    }

    const median = measure(speed.sessionMedianMs, duration);
    node.append(
      headline(
        median.value,
        'median session',
        count(speed.sessions) +
          ' session' +
          (speed.sessions === 1 ? '' : 's') +
          ' · ' +
          count(speed.llmCalls) +
          ' model calls · ' +
          count(speed.toolCalls) +
          ' tool calls'
      )
    );

    const p95 = measure(speed.sessionP95Ms, duration);
    const llm = measure(speed.llmMedianMs, duration);
    const ttft = measure(speed.ttftMedianMs, duration);
    const turns = measure(speed.turnsPerSession, (v) => v.toFixed(1));
    node.append(
      stats([
        { label: 'Slowest 5%', value: p95.value, estimate: p95.estimate },
        { label: 'Model call', value: llm.value, estimate: llm.estimate },
        { label: 'First token', value: ttft.value, estimate: ttft.estimate },
        { label: 'Turns / session', value: turns.value, estimate: turns.estimate },
        {
          label: 'Throughput',
          value: speed.tokensPerMinute > 0 ? tokens(speed.tokensPerMinute) : '—',
          qualifier: speed.tokensPerMinute > 0 ? '/min busy' : undefined
        },
        {
          label: 'Tool latency',
          value: measure(speed.toolMedianMs, duration).value,
          estimate: measure(speed.toolMedianMs, duration).estimate
        }
      ])
    );

    if (speed.slowestTools.length) {
      const viz = el('div', 'viz');
      const list = barList(
        speed.slowestTools.map((t) => ({ label: t.name + ' ×' + t.calls, value: t.medianMs })),
        duration
      );
      list.style.color = palette.speed;
      viz.append(list);
      viz.append(el('p', 'viz-caption', 'Slowest tools by median execution time.'));
      node.append(viz);
    }

    if (median.estimate) {
      node.append(
        el(
          'p',
          'missing',
          '≈ marks a figure interpolated from histogram buckets. Exact timings need the local trace store.'
        )
      );
    }
    return node;
  }

  function renderQuality(quality, feed) {
    const node = section('quality', 'Quality', 'PR + IDE signals');

    if (!quality.available) {
      if (!feed.watching) {
        node.append(emptyState([
          'Telemetry reading is off. Enable iceberg.otel.enabled to see quality signals.'
        ], { label: 'Diagnostics', command: 'diagnostics' }));
        return node;
      }
      if (feed.jsonlActive || (feed.copilotOtelEnabled && feed.jsonlPath)) {
        node.append(emptyState([
          feed.jsonlActive
            ? 'Telemetry is connected. No quality signals recorded yet.'
            : 'File feed configured. Waiting for quality signals.',
          'Accept or reject a Copilot edit, or rate a response. Signals appear after the next export.'
        ], { label: 'Diagnostics', command: 'diagnostics' }));
        return node;
      }
      node.append(
        emptyState([
          'Quality signals need the file feed; the local trace store alone is not enough.'
        ], { label: 'Connect telemetry…', command: 'connect' })
      );
      return node;
    }

    node.append(
      headline(
        percent(quality.acceptRate),
        'edits accepted',
        count(quality.editsAccepted) +
          ' accepted · ' +
          count(quality.editsRejected) +
          ' rejected' +
          (quality.linesAdded + quality.linesRemoved > 0
            ? ' · +' + count(quality.linesAdded) + ' / −' + count(quality.linesRemoved) + ' lines'
            : '')
      )
    );

    if (quality.editsAccepted + quality.editsRejected > 0) {
      const viz = el('div', 'viz');
      viz.append(splitBar(quality.editsAccepted, quality.editsRejected));
      viz.append(el('p', 'viz-caption', 'Accepted against rejected.'));
      node.append(viz);
    }

    const rows = [];
    if (quality.survivalFourGram !== undefined) {
      rows.push({ label: 'Code survives', value: percent(quality.survivalFourGram) });
    }
    if (quality.survivalNoRevert !== undefined) {
      rows.push({ label: 'Not reverted', value: percent(quality.survivalNoRevert) });
    }
    if (quality.pullRequests > 0) rows.push({ label: 'Pull requests', value: count(quality.pullRequests) });
    if (quality.cloudSessions > 0) rows.push({ label: 'Cloud sessions', value: count(quality.cloudSessions) });
    if (quality.toolSuccessRate !== undefined) {
      rows.push({ label: 'Tool success', value: percent(quality.toolSuccessRate, 1) });
    }
    if (quality.editResponseErrors > 0) {
      rows.push({ label: 'Edit errors', value: count(quality.editResponseErrors) });
    }
    if (quality.summarizationsApplied + quality.summarizationsFailed > 0) {
      rows.push({
        label: 'Summarisations',
        value: count(quality.summarizationsApplied),
        qualifier: quality.summarizationsFailed > 0 ? count(quality.summarizationsFailed) + ' failed' : undefined
      });
    }
    if (rows.length) node.append(stats(rows));

    node.append(renderFeedback(quality));

    if (quality.missing.length) {
      node.append(el('p', 'missing', 'Not reported yet: ' + quality.missing.join(', ') + '.'));
    }
    return node;
  }

  /**
   * Thumbs up/down, plus what the user actually did with the response.
   *
   * Votes are the explicit signal and engagement is the implicit one. Copying or
   * applying an answer costs the user something, so it carries more weight than
   * a vote — both are shown rather than collapsed into one score.
   */
  function renderFeedback(quality) {
    const votes = quality.feedbackPositive + quality.feedbackNegative;
    const engagement =
      quality.actionCopy + quality.actionInsert + quality.actionApply + quality.actionFollowup;
    const block = el('div', 'feedback');

    if (votes === 0 && engagement === 0) {
      block.append(el('p', 'viz-caption', 'No votes yet, and no responses copied or applied.'));
      return block;
    }

    if (votes > 0) {
      const row = el('div', 'votes');

      const up = el('span', 'vote up');
      up.append(el('span', 'glyph', '\u25B2'));
      up.append(el('span', 'tally', count(quality.feedbackPositive)));
      row.append(up);

      const down = el('span', 'vote down');
      down.append(el('span', 'glyph', '\u25BC'));
      down.append(el('span', 'tally', count(quality.feedbackNegative)));
      row.append(down);

      row.append(el('span', 'vote-rate', percent(quality.feedbackRate) + ' positive'));
      block.append(row);

      const bar = el('div', 'viz');
      bar.append(splitBar(quality.feedbackPositive, quality.feedbackNegative));
      bar.append(el('p', 'viz-caption', 'Thumbs up and down on chat responses.'));
      block.append(bar);
    }

    if (engagement > 0) {
      const used = [];
      if (quality.actionApply > 0) used.push({ label: 'Applied', value: count(quality.actionApply) });
      if (quality.actionInsert > 0) used.push({ label: 'Inserted', value: count(quality.actionInsert) });
      if (quality.actionCopy > 0) used.push({ label: 'Copied', value: count(quality.actionCopy) });
      if (quality.actionFollowup > 0) used.push({ label: 'Follow-ups', value: count(quality.actionFollowup) });
      block.append(stats(used));
    }

    return block;
  }

  // ---------------------------------------------------------------- banner ---

  function renderBanner(feed) {
    banner.replaceChildren();
    if (!feed.watching) {
      show('Telemetry reading is off', [
        'Bear in Mind is not reading Copilot telemetry. Turn on iceberg.otel.enabled to use this dashboard.'
      ]);
      return;
    }
    if (!feed.copilotOtelEnabled) {
      show(
        'Copilot Chat telemetry is switched off',
        [
          'Nothing is being emitted, so the iceberg is still metering from chat transcripts. Connecting turns on OpenTelemetry and points it at a local file only this machine can read.'
        ],
        'connect'
      );
      return;
    }
    if (!feed.jsonlPath && !feed.sqliteActive) {
      show(
        'No telemetry source connected',
        [
          'Copilot Chat is emitting telemetry, but not anywhere Bear in Mind can read it. Connect a local source to populate all three sections.'
        ],
        'connect'
      );
      return;
    }
    if (!feed.jsonlPath && feed.sqliteActive) {
      show(
        'Reading spans only',
        [
          'Cost and speed come from the local trace store. Quality signals are emitted as log records, which only reach a file feed — so section 03 stays empty until one is connected.'
        ],
        'connect',
        'warn'
      );
      return;
    }
      if (feed.jsonlPath && !feed.sqliteActive && feed.records.metrics === 0) {
        show(
          'Connected, waiting for the first record',
          [
            'Copilot Chat is exporting to the feed but has not written anything yet. Send a chat request — telemetry is flushed on an interval, so give it a few seconds after that.'
          ],
          undefined
        );
        return;
      }
    if (feed.records.malformed > 0 || feed.records.unknown > 0) {
      show(
        'Some telemetry could not be read',
        [
          count(feed.records.unknown + feed.records.malformed) +
            ' records in the feed were not recognised. That usually means Copilot Chat changed its output format.'
        ],
        undefined,
        'warn'
      );
    }

    function show(title, lines, command, tone) {
      const box = el('div', 'banner');
      if (tone) box.dataset.tone = tone;
      box.append(el('h3', null, title));
      for (const line of lines) box.append(el('p', null, line));
      const actions = el('div', 'actions');
      if (command) {
        const connect = el('button', null, 'Connect telemetry…');
        connect.addEventListener('click', () => post(command));
        actions.append(connect);
      }
      const diagnostics = el('button', 'secondary', 'Diagnostics');
      diagnostics.addEventListener('click', () => post('diagnostics'));
      actions.append(diagnostics);
      box.append(actions);
      banner.append(box);
    }
  }

  function renderProvenance(feed) {
    const parts = [];
    parts.push(feed.sqliteActive ? 'spans: local trace store' : 'spans: unavailable');
    parts.push(feed.jsonlActive ? 'metrics + events: file feed' : 'metrics + events: unavailable');
    parts.push('last record ' + ago(feed.lastRecordAtMs));
    parts.push(
      count(feed.records.metrics) +
        ' metric exports · ' +
        count(feed.records.logs) +
        ' events · ' +
        count(feed.records.spans) +
        ' spans skipped'
    );
    provenance.textContent = parts.join('  ·  ');
  }

  // ------------------------------------------------------------------ apply --

  function apply(snapshot) {
    renderBanner(snapshot.feed);
    root.replaceChildren(
      renderCost(snapshot.cost),
      renderSpeed(snapshot.speed),
      renderQuality(snapshot.quality, snapshot.feed)
    );
    renderProvenance(snapshot.feed);
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg && msg.type === 'snapshot') apply(msg.snapshot);
  });

  post('ready');
})();
