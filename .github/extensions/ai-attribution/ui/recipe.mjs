// Recipe tab: one AI-assisted delivery cycle from work item to merged PR.
// Rendering only; lib/recipe.mjs decides steps, evidence and counts.

import { h, s, disclosure } from './dom.js';
import { usageLabels, evidenceLabels, sourceLabels as SOURCE_SHORT } from './format.mjs';

export const STEP_NAMES = {
  workItem: 'Work item',
  branch: 'Branch',
  aiWork: 'AI work',
  commits: 'Commits',
  pullRequest: 'Pull request',
  review: 'Review',
  close: 'Merge & close',
};
const EVIDENCE_ORDER = ['verified', 'recorded', 'convention', 'observed'];
const STATUS_TEXT = {
  ok: 'connected',
  partial: 'partly checked',
  error: 'failed',
  unavailable: 'unavailable',
  'not-configured': 'not configured',
  skipped: 'nothing to check',
};
const MAX_LANES = 12;

const fmtCredits = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const fmtAmount = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const fmtInt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const fmtDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const fmtStamp = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function formatHours(hours) {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return '—';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} d`;
}

const when = (value) => (value ? fmtStamp.format(new Date(value)) : '—');
const badge = (kind, text) => h('span', { class: `badge ${kind}` }, text ?? kind);

function sourceChips(sources, title = (x) => `${x.calls} requests · ${x.creditedCalls} with credit counts`) {
  return h(
    'span',
    { class: 'source-chips' },
    sources.map((x) =>
      h('span', { class: `src src-${x.id}`, title: title(x) }, `${SOURCE_SHORT[x.id] ?? x.id} ${fmtCredits.format(x.credits)} credits`),
    ),
  );
}

const creditValue = (usage) => usage?.credits === null || usage?.credits === undefined ? '—' : fmtCredits.format(usage.credits);

export function developerSelection(view, ui) {
  const sources = view.developers.sources;
  const source = sources.find((entry) => entry.id === ui.sourceId) ??
    sources.find((entry) => entry.measured.calls > 0) ?? sources[0];
  const person = source?.actors.find((actor) => actor.key === ui.actorKey);
  const owned = ui.perspective === 'ownership';
  const summary = ui.actorKey === '__unknown' ? source?.[owned ? 'unowned' : 'unknown'] :
    ui.actorKey ? person?.[owned ? 'ownership' : 'usage'] : owned ? source?.ownership : source;
  return { source, summary, actor: view.developers.actors.find((a) => a.key === ui.actorKey) };
}

function developerPanel(view, ui) {
  const { source, summary, actor } = developerSelection(view, ui);
  const select = (label, key, value, choices) => h('select', {
    'aria-label': label, 'data-focus-key': key, onchange: (event) => ui.setDeveloper(key, event.target.value),
  }, choices.map(([id, text]) => h('option', { value: id, selected: value === id }, text)));
  const total = summary?.total;
  const workRows = summary?.work ?? [];
  const displayed = ui.allWork ? workRows : workRows.slice(0, 5);
  return h('section', { class: 'card developer-report' },
    h('div', { class: 'toolbar' },
      h('h3', {}, 'Developer → work'),
      select('Usage source', 'developer-source', source?.id, view.developers.sources.map((entry) => [entry.id, SOURCE_SHORT[entry.id] ?? entry.id])),
      select('Developer', 'developer-actor', ui.actorKey ?? '', [
        ['', 'All accounts'], ['__unknown', ui.perspective === 'ownership' ? 'No known owner' : 'Account unknown'],
        ...view.developers.actors.map((a) => [a.key, `${a.label} · ${{ github: 'GitHub', 'azure-boards': 'Azure Boards', telemetry: 'local record' }[a.provider] ?? a.provider}`]),
      ]),
      select('Show usage or owned work', 'developer-perspective', ui.perspective ?? 'usage', [
        ['usage', 'Credits used'], ['ownership', 'Work owned'],
      ]),
    ),
    h('div', { class: 'actor-balance' },
      h('strong', { title: total ? `${total.creditedCalls}/${total.calls} requests include credit counts` : 'No usage matches this selection' }, `${creditValue(total)} credits`),
      ...['measured', 'inferred', 'unattributed'].map((method) =>
        h('span', { class: method }, `${usageLabels[method]} `, h('strong', {}, creditValue(summary?.[method]))),
      ),
    ),
    h('div', { class: 'actor-credit-bar', role: 'img', 'aria-label': 'Credits from recorded users, estimates based on owners and unknown users' },
      ...['measured', 'inferred', 'unattributed'].map((method) => h('span', {
        class: method, style: { width: `${total?.credits > 0 ? ((summary[method].credits ?? 0) / total.credits) * 100 : 0}%` },
      })),
    ),
    h('p', { class: 'muted small' }, ui.perspective === 'ownership'
      ? `Work owned by ${actor?.label ?? 'selected accounts'}; includes other contributors, not just this person’s AI use.`
      : 'Recorded accounts show who used AI. An owner-based estimate is not proof. This machine may have only part of the history.'),
    displayed.length ? h('div', { class: 'matrix-wrap' }, h('table', { class: 'actor-work' },
      h('thead', {}, h('tr', {}, ...['Work / pull request', ...Object.values(usageLabels)].map((label) => h('th', {}, label)))),
      h('tbody', {}, displayed.map((row) => {
        const cycle = view.cycles.find((c) => c.key === row.cycleKey);
        return h('tr', {},
          h('td', {}, cycle
            ? h('span', {}, h('strong', {}, cycle.workItems.map((w) => w.reference).join(', ') || 'No work item'),
                cycle.pullRequest ? ` → PR #${cycle.pullRequest.number}` : '',
                h('span', { class: 'mono muted' }, `${cycle.repository} · ${cycle.branch ?? 'no branch'}`))
            : 'No repository, or work outside this list'),
          ...['measured', 'inferred', 'unattributed'].map((method) => h('td', { class: 'num' }, creditValue(row[method]))),
        );
      })),
    )) : h('p', { class: 'muted' }, 'No usage for this selection.'),
    workRows.length > 5 ? h('button', { class: 'more', onclick: () => ui.toggleWork(), 'data-focus-key': 'actor-work-more' },
      ui.allWork ? 'Show less' : `All ${workRows.length} work groups`) : null,
    total ? h('span', { class: 'muted small' }, `${total.creditedCalls}/${total.calls} requests include credit counts`) : null,
  );
}

function identityPanel(view, ui) {
  const identities = [...new Map(view.cycles.flatMap((cycle) => cycle.ownership.roles)
    .filter((role) => role.identity.provider === 'azure-boards').map((role) => [role.identity.key, role.identity])).values()];
  if (!identities.length) return null;
  const choices = h('select', { 'aria-label': 'Azure Boards identity' },
    identities.map((identity) => h('option', { value: identity.key }, `${identity.label} · ${identity.key}`)));
  const login = h('input', { 'aria-label': 'GitHub login', placeholder: 'GitHub login', required: true, maxLength: 39 });
  return disclosure('identity-links', 'Link accounts across tools',
    h('p', { class: 'small' }, 'Tell us which accounts belong together. The link lasts only in this panel; we never match names or emails automatically.'),
    h('form', { class: 'toolbar', onsubmit: (event) => {
      event.preventDefault();
      ui.linkIdentity(choices.value, login.value);
    } }, choices, login, h('button', { type: 'submit', disabled: ui.verifying }, 'Link accounts')),
    h('ul', { class: 'small' }, view.developers.identityLinks.map((link) => h('li', {},
      `${link.boardsKey} → ${link.githubLogin}`, ' ',
      h('button', { type: 'button', onclick: () => ui.unlinkIdentity(link.boardsKey) }, 'Remove'),
    ))),
  );
}

// ------------------------------------------------------------------ icons ---

function icon(step) {
  const g = (...children) => s('g', { class: 'icon' }, ...children);
  switch (step) {
    case 'workItem':
      return g(s('rect', { x: -7, y: -9, width: 14, height: 18, rx: 2 }), s('path', { d: 'M-3 -4 H4 M-3 0 H4 M-3 4 H2' }));
    case 'branch':
      return g(
        s('circle', { cx: -4, cy: -7, r: 2.4 }),
        s('circle', { cx: -4, cy: 7, r: 2.4 }),
        s('circle', { cx: 5, cy: -3, r: 2.4 }),
        s('path', { d: 'M-4 -4.6 V4.6 M5 -0.6 C5 3 -4 1 -4 4.6' }),
      );
    case 'aiWork':
      return g(s('path', { d: 'M0 -9 L2.4 -2.4 L9 0 L2.4 2.4 L0 9 L-2.4 2.4 L-9 0 L-2.4 -2.4 Z' }));
    case 'commits':
      return g(s('path', { d: 'M-10 0 H-4 M4 0 H10' }), s('circle', { cx: 0, cy: 0, r: 4 }));
    case 'pullRequest':
      return g(
        s('circle', { cx: -5, cy: -7, r: 2.4 }),
        s('circle', { cx: -5, cy: 7, r: 2.4 }),
        s('circle', { cx: 5, cy: 7, r: 2.4 }),
        s('path', { d: 'M-5 -4.6 V4.6 M5 4.6 V-2 C5 -5 3 -6 0 -6 M2 -8 L0 -6 L2 -4' }),
      );
    case 'review':
      return g(s('path', { d: 'M-9 0 C-5 -7 5 -7 9 0 C5 7 -5 7 -9 0 Z' }), s('circle', { cx: 0, cy: 0, r: 2.6 }));
    case 'billing':
      return g(s('rect', { x: -8, y: -9, width: 16, height: 18, rx: 2 }),
        s('path', { d: 'M-4 -4 H4 M-4 0 H1 M-4 4 H4' }));
    default:
      return g(s('path', { d: 'M-6 0 L-2 4.5 L6.5 -5' }));
  }
}

// ----------------------------------------------------------- recipe strip ---

const STRIP = {
  width: 1480,
  height: 330,
  center: 158,
  maxHalf: 34,
  x: { workItem: 100, branch: 262, aiWork: 452, commits: 612, pullRequest: 802, review: 962, close: 1112 },
  bands: [
    { id: 'ingredients', x: 18, w: 326 },
    { id: 'method', x: 364, w: 330 },
    { id: 'serve', x: 714, w: 468 },
  ],
};

function ribbonPath(points) {
  const c = STRIP.center;
  const top = points.map((p) => [p.x, c - p.half]);
  const bottom = points.map((p) => [p.x, c + p.half]).reverse();
  const curve = (pts) =>
    pts
      .slice(1)
      .map(([x, y], i) => {
        const [px, py] = pts[i];
        const mx = (px + x) / 2;
        return `C ${mx} ${py} ${mx} ${y} ${x} ${y}`;
      })
      .join(' ');
  return `M ${top[0][0]} ${top[0][1]} ${curve(top)} L ${bottom[0][0]} ${bottom[0][1]} ${curve(bottom)} Z`;
}

function recipeStrip(view, model) {
  const total = view.totals.cycles;
  const half = (n) => (total ? Math.max(n ? 3 : 1.2, (STRIP.maxHalf * n) / total) : 1.2);
  const steps = model.recipe.steps;
  const stations = view.stations;
  const billingStatus = view.billing?.status === 'ok' ? 'Report loaded' :
    view.billing?.status === 'error' ? 'Read failed' :
      view.billing?.status === 'loading' ? 'Reading…' : 'Not read';
  const start = { x: STRIP.bands[0].x, half: half(total) };
  const end = (n) => ({ x: STRIP.bands[2].x + STRIP.bands[2].w, half: half(n) });

  const core = [start];
  const reach = [start];
  const hatched = [start];
  for (const st of stations) {
    core.push({ x: STRIP.x[st.id], half: half(st.strict) });
    reach.push({ x: STRIP.x[st.id], half: half(st.any) });
    hatched.push({ x: STRIP.x[st.id], half: half(Math.min(total, st.any + st.unknown)) });
  }
  const last = stations.at(-1);
  core.push(end(last.strict));
  reach.push(end(last.any));
  hatched.push(end(Math.min(total, last.any + last.unknown)));

  const drops = [];
  let previous = total;
  let previousX = STRIP.bands[0].x;
  for (const st of stations) {
    const dropped = previous - st.strict - st.stoppedUnknown;
    const x = STRIP.x[st.id];
    if (dropped > 0) {
      const dx = (previousX + x) / 2 + 8;
      const y0 = STRIP.center + half(previous) * 0.7;
      drops.push(
        s('g', { class: 'drop' },
          s('title', {}, `${dropped} cycle${dropped === 1 ? '' : 's'} left the in-order recipe at ${STEP_NAMES[st.id]}`),
          s('path', { d: `M ${dx - 26} ${y0} C ${dx - 6} ${y0 + 6} ${dx} ${y0 + 30} ${dx} 282` }),
          s('circle', { cx: dx, cy: 286, r: 3 }),
          s('text', { x: dx, y: 306, 'text-anchor': 'middle' }, `−${dropped} missing step`),
        ),
      );
    }
    previous = st.strict;
    previousX = x;
  }

  return h(
    'figure',
    { class: 'recipe-strip card' },
    s(
      'svg',
      { viewBox: `0 0 ${STRIP.width} ${STRIP.height}`, role: 'img', 'aria-label': 'Recipe: work item to merge and closure, followed visually by a separate bill comparison, not another delivery step' },
      s('defs', {},
        s('pattern', { id: 'recipe-hatch', width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
          s('rect', { width: 7, height: 7, class: 'hatch-bg' }),
          s('line', { x1: 0, y1: 0, x2: 0, y2: 7, class: 'hatch-line' }),
        ),
      ),
      STRIP.bands.map((band) => {
        const phase = model.recipe.phases.find((p) => p.id === band.id);
        return s('g', { class: `band band-${band.id}` },
          s('rect', { x: band.x, y: 10, width: band.w, height: 310, rx: 14 }),
          s('text', { x: band.x + 16, y: 34, class: 'band-label' }, phase.label.toUpperCase()),
          s('text', { x: band.x + 16, y: 52, class: 'band-detail' }, phase.detail),
        );
      }),
      s('g', { class: 'band band-billing billing-endpoint', 'data-billing-checkpoint': 'true' },
        s('title', {}, 'Compare the bill by account, day in UTC and model, independently of merge. GitHub does not bill by pull request or session. This is not another delivery step.'),
        s('rect', { x: 1202, y: 10, width: 260, height: 310, rx: 14 }),
        s('text', { x: 1218, y: 34, class: 'band-label' }, 'CHECK THE BILL'),
        s('text', { x: 1218, y: 52, class: 'band-detail' }, 'Separate from delivery'),
        s('text', { x: 1332, y: 92, class: 'station-name', 'text-anchor': 'middle' }, 'Compare usage and bill'),
        s('path', { d: 'M1184 158 H1305 M1297 153 L1305 158 L1297 163', class: 'billing-connector' }),
        s('circle', { cx: 1332, cy: STRIP.center, r: 25, class: 'station-ring' }),
        s('g', { transform: `translate(1332 ${STRIP.center})` }, icon('billing')),
        s('text', { x: 1332, y: 208, class: 'station-count', 'text-anchor': 'middle' }, billingStatus),
        s('text', { x: 1332, y: 250, class: 'station-any', 'text-anchor': 'middle' }, 'User · UTC day · model'),
        s('text', { x: 1332, y: 286, class: 'station-any', 'text-anchor': 'middle' }, 'Not a bill for each change'),
      ),
      s('path', { d: ribbonPath(hatched), class: 'ribbon-pending' }, s('title', {}, 'Cycles that may have this step: unknown until verified')),
      s('path', { d: ribbonPath(reach), class: 'ribbon-any' }, s('title', {}, 'Cycles that have this step, in any order')),
      s('path', { d: ribbonPath(core), class: 'ribbon' }, s('title', {}, 'Cycles that followed the recipe in order up to this step')),
      drops,
      stations.map((st) => {
        const x = STRIP.x[st.id];
        const spec = steps.find((p) => p.id === st.id);
        const measured = st.evidence.verified + st.evidence.observed > 0;
        const cls = st.any === 0 && st.unknown > 0 ? 'unknown' : measured ? 'measured' : st.any ? 'referenced' : 'empty';
        let offset = 0;
        const segments = EVIDENCE_ORDER.map((e) => {
          const w = st.any ? (90 * st.evidence[e]) / st.any : 0;
          const seg = w > 0 ? s('rect', { x: x - 45 + offset, y: 226, width: w, height: 6, class: `ev ev-${e}` }) : null;
          offset += w;
          return seg;
        });
        return s('g', { class: `station ${cls}`, 'data-step': st.id },
          s('title', {}, [
            `${spec.name}`,
            `${st.any} of ${total} cycles have this step; ${st.strict} followed the recipe in order up to here; ${st.unknown} unknown`,
            `Evidence: ${EVIDENCE_ORDER.filter((e) => st.evidence[e]).map((e) => `${st.evidence[e]} ${evidenceLabels[e]}`).join(', ') || 'none'}`,
            `Local: ${spec.local}`,
            `Verified: ${spec.verified}`,
          ].join('\n')),
          s('text', { x, y: 92, class: 'station-name', 'text-anchor': 'middle' }, STEP_NAMES[st.id]),
          s('circle', { cx: x, cy: STRIP.center, r: 25, class: 'station-ring' }),
          s('g', { transform: `translate(${x} ${STRIP.center})` }, icon(st.id)),
          s('text', { x, y: 208, class: 'station-count', 'text-anchor': 'middle' }, `${st.any} / ${total}`),
          s('rect', { x: x - 45, y: 226, width: 90, height: 6, rx: 3, class: 'ev-track' }),
          segments,
          s('text', { x, y: 250, class: 'station-any', 'text-anchor': 'middle' }, `${st.strict} no gaps${st.unknown ? ` · ${st.unknown} unknown` : ''}`),
        );
      }),
    ),
    h('figcaption', { class: 'legend' },
      h('span', {}, h('i', { class: 'swatch ribbon' }), 'No missing steps'),
      h('span', {}, h('i', { class: 'swatch ribbon-any' }), 'Step present'),
      h('span', {}, h('i', { class: 'swatch pending' }), 'Unknown'),
      EVIDENCE_ORDER.map((e) => h('span', { title: model.recipe.evidence.find((x) => x.id === e)?.description }, h('i', { class: `swatch ev-${e}` }), model.recipe.evidence.find((x) => x.id === e)?.label ?? e)),
      h('span', {}, h('i', { class: 'swatch drop' }), 'Missing a step'),
    ),
  );
}

function medianTimes(view) {
  const k = view.kpis;
  return h('div', { class: 'timing-row small', 'aria-label': 'Median cycle times' }, [
    ['Pickup → done', k.medianPickupToDoneHours, 'First AI work or activation to merge and closure'],
    ['Pull request → merge', k.medianOpenToMergeHours, 'Pull request opened to merged'],
    ['Pull request → review', k.medianOpenToFirstReviewHours, 'Pull request opened to first review'],
  ].map(([label, value, title]) => h('span', { title }, label, ' ',
    h('strong', {}, view.verification ? formatHours(value) : h('span', { class: 'muted' }, '—')),
  )),
    h('span', { class: 'muted', title: 'Half of measured changes took less time; half took more.' }, 'Typical times (median)'),
  );
}

// -------------------------------------------------------------- swimlanes ---

const LANE = { width: 640, height: 58, left: 12, right: 628, axis: 22, barBase: 54, barTop: 32 };

function marker(kind, x, evidence, label, y = LANE.axis) {
  const g = (cls, ...children) => s('g', { class: `mk mk-${cls} ev-${evidence}` }, s('title', {}, label), ...children);
  switch (kind) {
    case 'workItemCreated':
    case 'workItemActivated':
    case 'workItemReferenced':
      return g('work', s('path', { d: `M ${x} ${y - 6} L ${x + 6} ${y} L ${x} ${y + 6} L ${x - 6} ${y} Z` }));
    case 'branch':
      return g('branch', s('circle', { cx: x, cy: y, r: 4.5 }));
    case 'commit':
      return g('commit', s('circle', { cx: x, cy: y, r: 3.4 }));
    case 'pullRequest':
      return g('pr', s('rect', { x: x - 5, y: y - 5, width: 10, height: 10, rx: 2 }));
    case 'review':
      return g('review', s('path', { d: `M ${x - 6} ${y} C ${x - 3} ${y - 5} ${x + 3} ${y - 5} ${x + 6} ${y} C ${x + 3} ${y + 5} ${x - 3} ${y + 5} ${x - 6} ${y} Z` }));
    case 'merged':
      return g('merged', s('circle', { cx: x, cy: y, r: 6 }), s('path', { d: `M ${x - 3} ${y} L ${x - 0.8} ${y + 2.4} L ${x + 3.2} ${y - 2.6}`, class: 'tick' }));
    case 'prClosed':
      return g('closed', s('path', { d: `M ${x - 4} ${y - 4} L ${x + 4} ${y + 4} M ${x + 4} ${y - 4} L ${x - 4} ${y + 4}` }));
    default:
      return g('done', s('path', { d: `M ${x - 5} ${y} L ${x - 1.5} ${y + 4} L ${x + 6} ${y - 5}` }));
  }
}

function laneTrack(cycle) {
  const start = Date.parse(cycle.span.start ?? '');
  const end = Date.parse(cycle.span.end ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return s('svg', { viewBox: `0 0 ${LANE.width} ${LANE.height}`, class: 'lane-track' });
  const span = Math.max(end - start, 3_600_000);
  const xOf = (iso) => LANE.left + ((LANE.right - LANE.left) * (Date.parse(iso) - start)) / span;
  const sources = [...new Set(cycle.activity.flatMap((b) => Object.keys(b.credits)))];
  const max = Math.max(0, ...cycle.activity.flatMap((b) => Object.values(b.credits)));
  const binWidth = (LANE.right - LANE.left) / Math.max(1, cycle.activity.length);
  const bars = max > 0
    ? cycle.activity.flatMap((bin, i) =>
        sources.map((id, j) => {
          const v = bin.credits[id] ?? 0;
          if (v <= 0) return null;
          const hgt = Math.max(1.5, ((LANE.barBase - LANE.barTop) * v) / max);
          const w = Math.max(1, (binWidth - 1) / sources.length);
          return s('rect', { x: LANE.left + i * binWidth + j * w, y: LANE.barBase - hgt, width: w, height: hgt, class: `bar src-${id}` }, s('title', {}, `${SOURCE_SHORT[id] ?? id}: ${fmtCredits.format(v)} credits`));
        }),
      )
    : [];
  const earlier = cycle.events.filter((e) => Date.parse(e.at) < start);
  return s('svg', { viewBox: `0 0 ${LANE.width} ${LANE.height}`, class: 'lane-track', role: 'img', 'aria-label': `Timeline for ${cycle.branch ?? cycle.repository}` },
    s('line', { x1: LANE.left, y1: LANE.axis, x2: LANE.right, y2: LANE.axis, class: 'axis' }),
    s('line', { x1: LANE.left, y1: LANE.barBase, x2: LANE.right, y2: LANE.barBase, class: 'axis faint' }),
    bars,
    earlier.length
      ? s('g', { class: 'mk mk-earlier' }, s('title', {}, earlier.map((e) => `${e.label}: ${when(e.at)}`).join('\n')), s('path', { d: `M ${LANE.left + 6} ${LANE.axis - 5} L ${LANE.left} ${LANE.axis} L ${LANE.left + 6} ${LANE.axis + 5}` }))
      : null,
    cycle.events.filter((e) => Date.parse(e.at) >= start).map((e) => marker(e.kind, xOf(e.at), e.evidence, `${e.label} · ${when(e.at)} · ${evidenceLabels[e.evidence]}`)),
  );
}

function stepDots(cycle) {
  return h('span', { class: 'dots', title: 'Recipe steps: filled = done, ring = not done, dashed = unknown' },
    Object.entries(cycle.steps).map(([id, st]) => h('i', { class: `dot ${st.state}`, title: `${STEP_NAMES[id]}: ${st.state}${st.detail ? ` · ${st.detail}` : ''}` })),
  );
}

function recipeCard(cycle, model) {
  return h('div', { class: 'recipe-card' },
    h('div', { class: 'actor-roles' },
      ...cycle.ownership.roles.map((role) => h('span', { class: 'chip', title: `${role.identity.key} · ${role.at ?? 'date unknown'}` },
        `${{ 'PR author': 'Pull request author', 'Assigned at pickup': 'Assigned at first AI use' }[role.role] ?? role.role}: ${role.actor.label}${role.reference ? ` · ${role.reference}` : ''}`)),
      ...cycle.attribution.map((entry) => h('span', { class: `chip ${entry.method}` },
        `${entry.actor?.label ?? 'Account unknown'} · ${creditValue(entry)} credits · ${usageLabels[entry.method]} · ${SOURCE_SHORT[entry.source]}`)),
    ),
    h('ol', { class: 'recipe-steps' },
    Object.entries(cycle.steps).map(([id, st]) => {
      const spec = model.recipe.steps.find((x) => x.id === id);
      return h('li', { class: `rc-step ${st.state}` },
        h('span', { class: 'rc-icon' }, s('svg', { viewBox: '-12 -12 24 24', width: 22, height: 22 }, icon(id))),
        h('div', {},
          h('div', { class: 'rc-head' }, h('strong', {}, spec?.name ?? STEP_NAMES[id])),
          h('div', { class: 'rc-meta' },
            badge(st.state === 'yes' ? 'native' : st.state === 'no' ? 'missing' : 'unverified', st.state === 'yes' ? 'done' : st.state === 'no' ? 'not done' : 'unknown'),
            st.evidence ? badge(`ev-${st.evidence}`, evidenceLabels[st.evidence]) : null,
            st.at ? h('span', { class: 'muted small' }, when(st.at)) : null,
          ),
          h('div', { class: 'small' }, st.detail),
        ),
      );
    })),
  );
}

function workItemChip(w) {
  const state = w.found === false ? 'not found' : w.closed ? 'closed' : w.state ? w.state.toLowerCase() : null;
  return h('span', { class: `chip wi wi-${w.provider}`, title: `${w.provider === 'azure-boards' ? 'Azure Boards' : 'GitHub'} ${w.reference} · ${evidenceLabels[w.evidence]}${w.type ? ` · ${w.type}` : ''}${state ? ` · ${state}` : ''} · via ${w.via.map((e) => evidenceLabels[e]).join(', ')}` },
    w.reference, w.type ? ` ${w.type}` : '', state ? h('span', { class: 'muted' }, ` · ${state}`) : null);
}

const LEGEND = [
  ['workItemCreated', 'work item'],
  ['branch', 'first AI work'],
  ['commit', 'commit'],
  ['pullRequest', 'PR opened'],
  ['review', 'review'],
  ['merged', 'merged'],
  ['workItemClosed', 'work item closed'],
];

function lanes(view, model, ui) {
  const list = ui.showAll ? view.cycles : view.cycles.slice(0, MAX_LANES);
  return h('section', { class: 'lanes' },
    h('div', { class: 'lane-legend small muted' },
      LEGEND.map(([kind, label]) => h('span', {}, s('svg', { viewBox: '-8 -8 16 16', width: 14, height: 14 }, marker(kind, 0, 'verified', label, 0)), ' ', label)),
      h('span', {}, h('i', { class: 'swatch bar' }), 'credits / source'),
    ),
    list.map((cycle) => {
      const open = ui.expanded.has(cycle.key);
      return h('div', { class: `lane${open ? ' open' : ''}` },
        h('button', { class: 'lane-meta', 'aria-expanded': String(open), 'data-focus-key': `lane-${cycle.key}`, onclick: () => ui.toggle(cycle.key) },
          h('span', { class: 'repo small muted' }, cycle.repository),
          h('span', { class: 'branch mono' }, cycle.branch ?? '(no branch recorded)'),
          h('span', { class: 'chips-row' },
            cycle.workItems.filter((w) => w.found !== false).map(workItemChip),
            cycle.pullRequest
              ? h('span', { class: `chip pr pr-${String(cycle.pullRequest.state).toLowerCase()}` }, `PR #${cycle.pullRequest.number} ${cycle.pullRequest.isDraft ? 'draft' : String(cycle.pullRequest.state).toLowerCase()}`)
              : null,
            stepDots(cycle),
            [...new Set(cycle.attribution.filter((entry) => entry.actor).map((entry) => `${entry.actor.label} · ${usageLabels[entry.method]}`))]
              .slice(0, 2).map((label) => h('span', { class: 'small muted' }, label)),
          ),
        ),
        laneTrack(cycle),
        h('div', { class: 'lane-side' },
          h('span', { class: 'lead', title: cycle.leadTimeHours === null ? 'Recipe steps done, in any order' : 'Pickup → merged and work item closed' },
            cycle.leadTimeHours === null ? `${Object.values(cycle.steps).filter((x) => x.state === 'yes').length}/7 steps` : formatHours(cycle.leadTimeHours)),
          h('span', { class: 'small muted' }, cycle.span.start ? `${fmtDay.format(new Date(cycle.span.start))} → ${fmtDay.format(new Date(cycle.span.end))}` : '—'),
          sourceChips(cycle.sources),
        ),
        open ? recipeCard(cycle, model) : null,
      );
    }),
    view.cycles.length > MAX_LANES
      ? h('button', { class: 'more', 'data-focus-key': 'lanes-more', onclick: () => ui.toggleAll() }, ui.showAll ? 'Show fewer cycles' : `Show all ${view.cycles.length} cycles`)
      : null,
  );
}

// ------------------------------------------------------------ surface map ---

// -------------------------------------------------------------- toolbar ---

function statusChip(label, status) {
  if (!status) return h('span', { class: 'status-chip pending' }, `${label}: not checked`);
  return h('span', { class: `status-chip ${status.status}`, title: status.reason ?? '' },
    `${label}: ${STATUS_TEXT[status.status] ?? status.status}`,
    status.organization ? h('span', { class: 'muted' }, ` · ${status.organization.replace(/^https:\/\//, '')}`) : null,
    status.reason && status.status !== 'ok' ? h('span', { class: 'muted' }, ` · ${status.reason}`) : null,
  );
}

function toolbar(view, ui) {
  const v = view.verification;
  return h('div', { class: 'toolbar recipe-toolbar' },
    ui.windowSelect,
    h('button', { 'data-focus-key': 'recipe-refresh', onclick: () => ui.refresh(), 'aria-disabled': ui.busy ? 'true' : undefined }, ui.busy ? 'Refreshing…' : 'Refresh'),
    h('input', {
      type: 'text',
      class: 'org',
      placeholder: 'Azure DevOps organization (optional)',
      'aria-label': 'Azure DevOps organization',
      'data-focus-key': 'recipe-org',
      value: ui.org ?? '',
      oninput: (e) => ui.setOrg(e.target.value),
    }),
    h('button', { class: 'primary', title: 'Check delivery with GitHub & Azure Boards', 'aria-label': 'Check delivery with GitHub & Azure Boards', 'data-focus-key': 'recipe-verify', onclick: () => ui.verify(), 'aria-disabled': ui.verifying ? 'true' : undefined },
      ui.verifying ? 'Checking…' : v ? 'Check again' : 'Check delivery'),
    statusChip('GitHub', v?.github),
    statusChip('Azure Boards', v?.azureBoards),
  );
}

// ------------------------------------------------------------------ view ---

function setupSection(view, ui) {
  const rows = [
    ['Local usage',
      h('span', {}, 'Node 22+ and readable Copilot usage files. Use Connect Copilot Telemetry and choose whether to record the GitHub account.'),
      h('span', {}, 'VS Code Local: ', h('code', {}, 'github.copilot.chat.otel.captureIdentity'),
        '. Copilot Agent Host harness: managed ', h('code', {}, 'telemetry.capture.identity'),
        '. Without a recorded account, usage is estimated from ownership or left unknown; a computer name is not a person.')],
    ['Work links',
      h('span', {}, h('code', {}, 'alex/123-feature'), ' → GitHub issue; ', h('code', {}, 'alex/AB123-feature'), ' → Azure Boards.'),
      h('span', {}, 'Put the work-item number immediately after the last slash. The optional ', h('code', {}, 'hooks/commit-msg'),
        ' adds a Refs line to commits. Keep existing hooks: copy or run this hook alongside them instead of replacing hooksPath.')],
    ['GitHub checks',
      h('span', {}, h('code', {}, 'gh auth login'), '; repository read access, including private repositories and SSO where required.'),
      'Check delivery reads pull requests, reviews and assignments only. It does not need permission to change them.'],
    ['Azure Boards',
      'Set the organization here. Use az login with project access, or AZURE_DEVOPS_EXT_PAT with Work Items (Read).',
      'We check who was assigned when AI use began. Connect Azure Boards to GitHub if commit mentions should create links automatically.'],
    ['Billing',
      'Personal: account holder. Organization: billing/admin access. Enterprise: a billing-authorized role or billing-read GitHub App. Repository read access alone is insufficient.',
      h('span', {}, 'If an organization pays for the license, use its bill, not the personal account’s bill. Choose a completed UTC day and GitHub username. ',
        h('a', { href: 'https://docs.github.com/en/rest/billing/usage', target: '_blank', rel: 'noopener noreferrer' }, 'API permissions'))],
  ];
  return disclosure('recipe-setup', 'Setup & permissions',
    h('div', { class: 'matrix-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ...['Step', 'Required', 'Naming rules / assumptions'].map((label) => h('th', {}, label)))),
      h('tbody', {}, rows.map(([label, required, assumption]) => h('tr', {},
        h('th', { scope: 'row' }, label), h('td', {}, required), h('td', {}, assumption)))),
    )),
    h('p', { class: 'small' }, 'Check delivery and Read billing contact the services only when you ask. We do not read prompts, descriptions or commit text. Access tokens and account links are not saved; screenshots use invented data.'),
    h('p', { class: 'small' }, 'Only you can link accounts across tools. Billing comparisons use recorded users, not guessed owners. Local usage does not prove which account paid.'),
    h('p', { class: 'small' }, 'GitHub does not provide a bill for each pull request or session. Work costs are estimates. Usage and charges we cannot explain stay separate.'),
    identityPanel(view, ui),
  );
}

function billingPanel(view, ui) {
  const report = view.billing;
  const { source, actor } = developerSelection(view, ui);
  const result = report?.sources?.find((entry) => entry.sourceId === source?.id);
  const form = ui.billingForm ?? {};
  const input = (field, label, value, extra = {}) => h('label', { class: 'billing-field' }, label,
    h('input', { name: field, 'aria-label': label, 'data-focus-key': `billing-${field}`, value, required: true, ...extra,
      oninput: (event) => ui.setBilling(field, event.target.value) }));
  const level = h('label', { class: 'billing-field' }, 'Who pays?',
    h('select', { name: 'level', 'aria-label': 'Billing level', 'data-focus-key': 'billing-level', onchange: (event) => ui.setBilling('level', event.target.value) },
      [['organization', 'Organization'], ['enterprise', 'Enterprise'], ['user', 'Personal']].map(([value, label]) =>
        h('option', { value, selected: (form.level ?? 'organization') === value }, label))),
  );
  return h('section', { class: 'card billing-panel' },
    h('h3', {}, 'Compare usage with the bill'),
    h('p', { class: 'muted small' }, 'Same account, day in UTC and model. Billing does not wait for merge and is not a bill for each pull request.'),
    h('form', { class: 'toolbar billing-form', onsubmit: (event) => {
      event.preventDefault();
      ui.readBilling(Object.fromEntries(new FormData(event.currentTarget)));
    } },
      level,
      input('account', 'Paying account', form.account ?? '', { maxLength: 100, placeholder: 'organization or account name' }),
      input('user', 'Person on the bill', form.user ?? (actor?.provider === 'github' ? actor.label : ''), { maxLength: 45, placeholder: 'GitHub username' }),
      input('day', 'Day (UTC)', form.day ?? ui.lastCompleteDay, { type: 'date', max: ui.lastCompleteDay, title: 'A completed day in UTC, not your local time zone' }),
      h('button', { type: 'submit', disabled: ui.readingBilling || !report, class: 'primary' }, ui.readingBilling ? 'Reading…' : 'Read billing'),
    ),
    !report ? h('p', { role: 'alert' }, 'Reload the extension to enable billing.') : null,
    report?.status === 'error' ? h('p', { role: 'alert' }, report.reason) : null,
    report?.status === 'ok' && result ? [
      h('p', { class: 'small' }, `${report.scope.user} · ${report.scope.day} UTC · ${report.scope.level}/${report.scope.account} · ${SOURCE_SHORT[result.sourceId]}`),
      h('div', { class: 'grid billing-stats' }, [
        ['Credits on bill', result.grossQuantity],
        ['Recorded for this account', result.observed],
        ['Bill minus recorded', result.difference],
        ['Charge after discounts', result.netAmount, true],
      ].map(([label, value, amount]) => h('div', { class: 'kpi' },
        h('div', { class: 'label' }, label),
        h('div', { class: 'value' }, value === null ? '—' : (amount ? fmtAmount : fmtCredits).format(value))))),
      h('p', { class: 'muted small' }, `Before discounts ${fmtAmount.format(result.grossAmount)} · discounts ${fmtCredits.format(result.discountQuantity)} credits / ${fmtAmount.format(result.discountAmount)} · after discounts ${fmtCredits.format(result.netQuantity)} credits. Amounts come from GitHub.`),
      result.localExceedsBilling ? h('p', { role: 'alert' }, 'We recorded more usage than billed for a model. We do not estimate work costs for that model.') : null,
      result.outsideModelScope > 0 ? h('p', { class: 'small' }, `${fmtCredits.format(result.outsideModelScope)} recorded credits do not exactly match a model on the bill.`) : null,
      result.unknownIdentity > 0 ? h('p', { class: 'small' }, `${fmtCredits.format(result.unknownIdentity)} recorded credits have no known user, so they are not assigned to the person on this bill.`) : null,
      h('p', { class: 'small' }, `Billed credits not matched here: ${fmtCredits.format(result.unmatchedBilling)}. Charge not assigned to work: ${fmtAmount.format(result.unallocatedNetAmount)}.`),
      disclosure('billing-detail', 'Models & estimated work costs',
        h('p', {}, 'Model names must match exactly. A difference does not prove a billing error: local history may be incomplete. Estimated work cost = charge after discounts × recorded user’s work credits / credits on the bill, per model.'),
        h('table', {}, h('thead', {}, h('tr', {}, ...['Model', 'Billed credits', 'Recorded credits', 'Difference'].map((label) => h('th', {}, label)))),
          h('tbody', {}, result.models.map((row) => h('tr', {}, h('td', {}, row.model),
            ...[row.grossQuantity, row.observed, row.difference].map((value) => h('td', { class: 'num' }, value === null ? '—' : fmtCredits.format(value))))))),
        h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Work · estimated cost'), h('th', {}, 'Credits'), h('th', {}, 'Charge after discounts'))),
          h('tbody', {}, result.work.map((row) => {
            const cycle = view.cycles.find((entry) => entry.key === row.cycleKey);
            return h('tr', {}, h('td', {}, cycle ? `${cycle.repository} · ${cycle.branch}` : 'Outside displayed cycles'),
              h('td', { class: 'num' }, fmtCredits.format(row.grossQuantity)), h('td', { class: 'num' }, fmtAmount.format(row.netAmount)));
          }))),
      ),
    ] : null,
  );
}

function handoffEntry(id, [title, handoff, assumption], tag = 'li') {
  return h(tag, { class: `handoff-card${id === 'billing' ? ' billing-handoff' : ''}`, 'data-handoff': id },
    h('div', { class: 'handoff-title' },
      s('svg', { viewBox: '-12 -12 24 24', width: 20, height: 20, 'aria-hidden': 'true' }, icon(id)),
      h('h3', {}, title),
    ),
    h('p', {}, h('strong', {}, 'Handoff: '), handoff),
    h('p', { class: 'muted' }, h('strong', {}, 'Assumption: '), assumption),
  );
}

function readingFlow(model) {
  const handoffs = {
    workItem: [
      'Work item → branch',
      'The issue number or AB# ID connects planned work to a branch.',
      'Being assigned the work does not prove who used AI.',
    ],
    branch: [
      'Branch → AI session',
      'Repository + branch group local sessions into one cycle.',
      'First activity is not branch creation; reused branches can mix efforts.',
    ],
    aiWork: [
      'Session → credit record',
      'AI requests supply credit counts and, when enabled, the account that used AI. The developer view links those credits to work.',
      'A recorded account takes priority. Without one, a single owner can support an estimate, not a measured user.',
    ],
    commits: [
      'AI work → commits',
      'Local commit references and PR commits link the change.',
      'A matching commit does not prove AI wrote it or tell us its exact credit use.',
    ],
    pullRequest: [
      'Branch → pull request',
      'Check delivery finds the pull request and the issues it closes.',
      'Mentioning a pull request does not prove ownership. Its author may not be the person who used AI.',
    ],
    review: [
      'PR author → review',
      'Submitted review states and dates show when the change entered review.',
      'A review does not necessarily mean approval, correct code or time spent by a person.',
    ],
    close: [
      'Merge → work-item closure',
      'Check delivery checks the merge and whether linked work items are closed.',
      'With no linked work item, completion means merged only. It does not prove the change was deployed or created business value.',
    ],
  };
  return disclosure('recipe-guide', 'Reading the flow · handoffs & assumptions',
    h('p', { class: 'small' }, 'Developer filters change the credit breakdown; Lifecycle and Cycles retain all work in the window.'),
    h('ol', { class: 'recipe-handoffs' }, model.recipe.steps.map((step) => handoffEntry(step.id, handoffs[step.id]))),
    handoffEntry('billing', [
      'Separately: recorded usage → bill → estimated work cost',
      'Read billing gets a user’s credits and charges from the selected paying account for one completed UTC day. Compare with recorded usage for the same GitHub account and exact model, one source at a time.',
      'Billing does not wait for merge. Work costs are estimated shares of the charge after discounts, not bills for each work item. Unknown users, unmatched models and unexplained charges stay separate. We do not estimate work costs for a model when recorded usage exceeds billed usage.',
    ], 'section'),
    h('p', { class: 'small' }, 'Dark band: all steps so far are present, not necessarily recorded in date order. Light band: this step is present but earlier steps may be missing. Stripes: unknown. Dotted lines: a missing step.'),
  );
}

export function renderRecipe(view, model, ui) {
  if (!view) return h('p', { class: 'muted' }, 'Loading recipe…');
  if (!view.developers) return h('p', { role: 'alert' }, 'Reload the AI attribution extension to load developer attribution.');
  const notes = [
    ...view.totals.unlinked.filter((u) => u.calls).map((u) => `${SOURCE_SHORT[u.id] ?? u.id}: ${fmtInt.format(u.calls)} calls / ${fmtCredits.format(u.credits)} cr have no repository.`),
    view.totals.droppedRefs ? `${view.totals.droppedRefs} recorded references were not a number or commit ID of the session's own repository and were ignored.` : null,
    view.totals.truncated ? `Only the ${view.totals.cycles} most recent cycles are shown; ${view.totals.truncated} older ones are not.` : null,
    view.verification?.truncated ? `Verification covered the most recent cycles only; ${view.verification.truncated} github.com cycles were not checked.` : null,
  ].filter(Boolean);
  return [
    h('h2', { class: 'recipe-headline' }, "What work is behind this developer's AI credits?"),
    toolbar(view, ui),
    ui.error ? h('p', { role: 'alert' }, ui.error) : null,
    h('p', { class: 'muted small' }, `${view.totals.cycles} branches · ${view.kpis.verifiedCycles}/${view.totals.github} GitHub branches checked. Sources are separate; recorded credits are not a bill.`),
    view.verification ? null : h('div', { class: 'callout' }, 'Local records only. Check delivery to confirm online results; Read billing checks charges separately.'),
    setupSection(view, ui),
    h('h2', {}, 'Lifecycle · all cycles'),
    recipeStrip(view, model),
    developerPanel(view, ui),
    readingFlow(model),
    medianTimes(view),
    billingPanel(view, ui),
    h('h2', {}, 'Cycles'),
    view.cycles.length ? lanes(view, model, ui) : h('p', { class: 'muted' }, 'No model calls with a repository in this window.'),
    notes.length ? h('ul', { class: 'small muted' }, notes.map((n) => h('li', {}, n))) : null,
  ];
}
