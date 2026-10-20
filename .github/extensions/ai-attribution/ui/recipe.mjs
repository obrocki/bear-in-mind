// Recipe tab: one AI-assisted delivery cycle from work item to merged PR.
// Rendering only; lib/recipe.mjs decides steps, evidence and counts.

import { h, s } from './dom.js';

export const STEP_NAMES = {
  workItem: 'Work item',
  branch: 'Branch',
  aiWork: 'AI work',
  commits: 'Commits',
  pullRequest: 'Pull request',
  review: 'Review',
  close: 'Merge & close',
};
const STEP_CONCEPT = {
  workItem: 'issue_task',
  branch: 'branch_commit',
  aiWork: 'credits',
  commits: 'branch_commit',
  pullRequest: 'pull_request',
  review: 'acceptance',
  close: 'delivery',
};
const SOURCE_SHORT = { sessionStore: 'CLI / app', traces: 'VS Code', agentHost: 'VS Code harness' };
const EVIDENCE_ORDER = ['verified', 'recorded', 'convention', 'observed'];
const STATUS_TEXT = {
  ok: 'connected',
  partial: 'partly verified',
  error: 'failed',
  unavailable: 'unavailable',
  'not-configured': 'not configured',
  skipped: 'nothing to verify',
};
const MAX_LANES = 12;

const fmtCredits = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
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

function sourceChips(sources, title = (x) => `${x.calls} calls · ${x.creditedCalls} reporting credits`) {
  return h(
    'span',
    { class: 'source-chips' },
    sources.map((x) =>
      h('span', { class: `src src-${x.id}`, title: title(x) }, `${SOURCE_SHORT[x.id] ?? x.id} ${fmtCredits.format(x.credits)} cr`),
    ),
  );
}

const cycleCredits = (list) => sourceChips(list, (x) => `Reported credits in ${x.cycles} cycle${x.cycles === 1 ? '' : 's'} from ${SOURCE_SHORT[x.id] ?? x.id}`);

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
    default:
      return g(s('path', { d: 'M-6 0 L-2 4.5 L6.5 -5' }));
  }
}

// ----------------------------------------------------------- recipe strip ---

const STRIP = {
  width: 1200,
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
          s('text', { x: dx, y: 306, 'text-anchor': 'middle' }, `−${dropped} stopped`),
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
      { viewBox: `0 0 ${STRIP.width} ${STRIP.height}`, role: 'img', 'aria-label': 'Recipe: cycles reaching each step from work item to merged pull request' },
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
            `Evidence: ${EVIDENCE_ORDER.filter((e) => st.evidence[e]).map((e) => `${st.evidence[e]} ${e}`).join(', ') || 'none'}`,
            `Local: ${spec.local}`,
            `Verified: ${spec.verified}`,
          ].join('\n')),
          s('text', { x, y: 92, class: 'station-name', 'text-anchor': 'middle' }, STEP_NAMES[st.id]),
          s('circle', { cx: x, cy: STRIP.center, r: 25, class: 'station-ring' }),
          s('g', { transform: `translate(${x} ${STRIP.center})` }, icon(st.id)),
          s('text', { x, y: 208, class: 'station-count', 'text-anchor': 'middle' }, `${st.any} / ${total}`),
          s('rect', { x: x - 45, y: 226, width: 90, height: 6, rx: 3, class: 'ev-track' }),
          segments,
          s('text', { x, y: 250, class: 'station-any', 'text-anchor': 'middle' }, `${st.strict} in order${st.unknown ? ` · ${st.unknown} unknown` : ''}`),
        );
      }),
    ),
    h('figcaption', { class: 'legend' },
      h('span', {}, h('i', { class: 'swatch ribbon' }), 'Followed the recipe in order'),
      h('span', {}, h('i', { class: 'swatch ribbon-any' }), 'Has this step (any order)'),
      h('span', {}, h('i', { class: 'swatch pending' }), 'Unknown until verified'),
      EVIDENCE_ORDER.map((e) => h('span', { title: model.recipe.evidence.find((x) => x.id === e)?.description }, h('i', { class: `swatch ev-${e}` }), model.recipe.evidence.find((x) => x.id === e)?.label ?? e)),
      h('span', {}, h('i', { class: 'swatch drop' }), 'Stopped here'),
    ),
  );
}

// ------------------------------------------------------------------- KPIs ---

function kpiCards(view) {
  const k = view.kpis;
  const verified = Boolean(view.verification);
  const pending = (value) => (verified ? value : h('span', { class: 'muted' }, 'verify'));
  return h('div', { class: 'grid kpis recipe-kpis' }, [
    ['Cycles (repository branches)', fmtInt.format(view.totals.cycles), `${view.totals.github} on github.com`],
    ['Verified with GitHub', `${k.verifiedCycles} / ${view.totals.github}`, verified ? `at ${when(view.verification.at)}` : 'Not verified yet'],
    ['PR opened', fmtInt.format(k.prOpened), verified ? 'Verified or recorded' : 'Recorded references only'],
    ['Reviewed', pending(fmtInt.format(k.reviewed)), 'At least one submitted review'],
    ['Merged', pending(fmtInt.format(k.merged)), 'PR state MERGED'],
    ['Merged & work item closed', pending(fmtInt.format(k.closed)), 'The whole recipe served'],
    ['Median pickup → done', pending(formatHours(k.medianPickupToDoneHours)), 'First AI work or activation → merge and closure'],
    ['Median PR open → merge', pending(formatHours(k.medianOpenToMergeHours)), 'Verified PRs'],
    ['Median PR open → first review', pending(formatHours(k.medianOpenToFirstReviewHours)), 'Verified PRs'],
  ].map(([label, value, note]) =>
    h('div', { class: 'card kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), h('div', { class: 'who' }, note)),
  ));
}

// ------------------------------------------------------------ adherence ---

function donut(segments, total) {
  const r = 46;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return s('svg', { viewBox: '0 0 120 120', class: 'donut', role: 'img', 'aria-label': 'Branch convention adherence' },
    s('circle', { cx: 60, cy: 60, r, class: 'donut-track' }),
    segments.map((seg) => {
      const len = total ? (c * seg.value) / total : 0;
      const el = len > 0
        ? s('circle', { cx: 60, cy: 60, r, class: `donut-seg ${seg.cls}`, 'stroke-dasharray': `${len} ${c - len}`, 'stroke-dashoffset': -offset, transform: 'rotate(-90 60 60)' }, s('title', {}, `${seg.label}: ${seg.value}`))
        : null;
      offset += len;
      return el;
    }),
  );
}

function adherenceCard(view, model) {
  const a = view.adherence;
  const conforming = a.azureBoards + a.github;
  const share = a.cycles ? Math.round((100 * conforming) / a.cycles) : null;
  const segments = [
    { cls: 'seg-ab', label: 'prefix/AB123-slug (Azure Boards)', value: a.azureBoards },
    { cls: 'seg-gh', label: 'prefix/123-slug (GitHub issue)', value: a.github },
    { cls: 'seg-non', label: 'Other branch names', value: a.nonConforming },
    { cls: 'seg-none', label: 'No branch recorded', value: a.noBranch },
  ];
  const credits = (list) => (list.length ? cycleCredits(list) : h('span', { class: 'muted' }, '—'));
  return h('section', { class: 'card adherence' },
    h('h3', {}, 'Branch convention'),
    h('div', { class: 'adherence-body' },
      h('div', { class: 'donut-wrap' }, donut(segments, a.cycles), h('div', { class: 'donut-center' }, h('strong', {}, share === null ? '—' : `${share}%`), h('span', {}, 'follow it'))),
      h('ul', { class: 'legend-list' }, segments.map((seg) => h('li', {}, h('i', { class: `swatch ${seg.cls}` }), seg.label, h('strong', {}, ` ${seg.value}`)))),
    ),
    h('table', { class: 'compact' },
      h('tbody', {},
        h('tr', {}, h('td', {}, 'Credits on conforming branches'), h('td', {}, credits(a.credits.conforming))),
        h('tr', {}, h('td', {}, 'Credits elsewhere'), h('td', {}, credits(a.credits.nonConforming))),
      ),
    ),
    h('p', { class: 'muted small' }, model.recipe.convention.branch),
    h('details', { class: 'hook' },
      h('summary', {}, 'Add the work item to every commit (opt-in hook)'),
      h('p', { class: 'small' }, model.recipe.convention.hook),
      h('pre', {}, h('code', {}, 'git config core.hooksPath .github/extensions/ai-attribution/hooks')),
      h('p', { class: 'muted small' }, 'Or copy hooks/commit-msg into another repository\u2019s .git/hooks/. Requires Node on PATH. Set AI_ATTRIBUTION_HOOK=off to skip once.'),
    ),
  );
}

// ------------------------------------------------------------ ingredients ---

function ingredientsCard(view) {
  const max = Math.max(1, ...view.ingredients.map((i) => i.cycles));
  return h('section', { class: 'card pantry' },
    h('h3', {}, 'Ingredients · what the AI work went into'),
    view.ingredients.length
      ? h('div', { class: 'pantry-grid' }, view.ingredients.map((i) =>
          h('div', { class: `jar jar-${i.provider ?? 'none'}` },
            h('div', { class: 'jar-head' }, h('strong', {}, i.label), h('span', { class: 'muted small' }, `${i.cycles} cycle${i.cycles === 1 ? '' : 's'}${i.provider ? ` · ${i.closed} served` : ''}`)),
            h('div', { class: 'jar-bar' }, h('div', { style: { width: `${(100 * i.cycles) / max}%` } })),
            i.credits.length ? cycleCredits(i.credits) : null,
          ),
        ))
      : h('p', { class: 'muted' }, 'No cycles in this window.'),
    h('p', { class: 'muted small' }, 'Types come from GitHub issue types and Azure Boards work item types after verification. Credits are reported consumption per source, never summed across sources.'),
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
    cycle.events.filter((e) => Date.parse(e.at) >= start).map((e) => marker(e.kind, xOf(e.at), e.evidence, `${e.label} · ${when(e.at)} · ${e.evidence}`)),
  );
}

function stepDots(cycle) {
  return h('span', { class: 'dots', title: 'Recipe steps: filled = done, ring = not done, dashed = unknown' },
    Object.entries(cycle.steps).map(([id, st]) => h('i', { class: `dot ${st.state}`, title: `${STEP_NAMES[id]}: ${st.state}${st.detail ? ` · ${st.detail}` : ''}` })),
  );
}

function recipeCard(cycle, model) {
  return h('ol', { class: 'recipe-card' },
    Object.entries(cycle.steps).map(([id, st]) => {
      const spec = model.recipe.steps.find((x) => x.id === id);
      return h('li', { class: `rc-step ${st.state}` },
        h('span', { class: 'rc-icon' }, s('svg', { viewBox: '-12 -12 24 24', width: 22, height: 22 }, icon(id))),
        h('div', {},
          h('div', { class: 'rc-head' }, h('strong', {}, spec?.name ?? STEP_NAMES[id])),
          h('div', { class: 'rc-meta' },
            badge(st.state === 'yes' ? 'native' : st.state === 'no' ? 'missing' : 'unverified', st.state === 'yes' ? 'done' : st.state === 'no' ? 'not done' : 'unknown'),
            st.evidence ? badge(`ev-${st.evidence}`, st.evidence) : null,
            st.at ? h('span', { class: 'muted small' }, when(st.at)) : null,
          ),
          h('div', { class: 'small' }, st.detail),
        ),
      );
    }),
  );
}

function workItemChip(w) {
  const state = w.found === false ? 'not found' : w.closed ? 'closed' : w.state ? w.state.toLowerCase() : null;
  return h('span', { class: `chip wi wi-${w.provider}`, title: `${w.provider === 'azure-boards' ? 'Azure Boards' : 'GitHub'} ${w.reference} · ${w.evidence}${w.type ? ` · ${w.type}` : ''}${state ? ` · ${state}` : ''} · via ${w.via.join(', ')}` },
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
      h('span', {}, h('i', { class: 'swatch bar' }), 'credits per source (side by side, not summed)'),
      h('span', {}, 'Hollow = recorded or observed, filled = verified'),
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

function surfaceMatrix(model) {
  return h('div', { class: 'matrix-wrap' },
    h('table', { class: 'matrix' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Step'), model.surfaces.map((x) => h('th', { title: x.collection }, x.name)))),
      h('tbody', {}, model.recipe.steps.map((step) => {
        const concept = model.concepts.find((c) => c.id === STEP_CONCEPT[step.id]);
        return h('tr', {},
          h('td', { class: 'concept' }, h('strong', {}, step.name), h('span', { class: 'mono' }, concept?.name ?? '')),
          model.surfaces.map((x) => {
            const cell = concept?.surfaces[x.id];
            return h('td', { class: 'cell', title: cell?.note ?? '' },
              cell ? badge(cell.availability, model.availabilityLevels.find((l) => l.id === cell.availability)?.label) : '—',
              cell ? h('span', { class: 'mono' }, cell.field) : null,
            );
          }),
        );
      })),
    ),
  );
}

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
      placeholder: 'Azure DevOps org (optional)',
      'aria-label': 'Azure DevOps organization',
      'data-focus-key': 'recipe-org',
      value: ui.org ?? '',
      oninput: (e) => ui.setOrg(e.target.value),
    }),
    h('button', { class: 'primary', 'data-focus-key': 'recipe-verify', onclick: () => ui.verify(), 'aria-disabled': ui.verifying ? 'true' : undefined },
      ui.verifying ? 'Verifying…' : v ? 'Verify again' : 'Verify with GitHub & Azure Boards'),
    statusChip('GitHub', v?.github),
    statusChip('Azure Boards', v?.azureBoards),
  );
}

// ------------------------------------------------------------------ view ---

export function renderRecipe(view, model, ui) {
  if (!view) return h('p', { class: 'muted' }, 'Loading recipe…');
  const notes = [
    ...view.totals.unlinked.filter((u) => u.calls).map((u) => `${SOURCE_SHORT[u.id] ?? u.id}: ${fmtInt.format(u.calls)} model calls (${fmtCredits.format(u.credits)} credits) had no repository, so they belong to no cycle.`),
    view.totals.droppedRefs ? `${view.totals.droppedRefs} recorded references were not a number or commit ID of the session's own repository and were ignored.` : null,
    view.totals.truncated ? `Only the ${view.totals.cycles} most recent cycles are shown; ${view.totals.truncated} older ones are not.` : null,
    view.verification?.truncated ? `Verification covered the most recent cycles only; ${view.verification.truncated} github.com cycles were not checked.` : null,
  ].filter(Boolean);
  return [
    h('p', { class: 'lede' }, model.recipe.summary),
    toolbar(view, ui),
    view.verification
      ? null
      : h('div', { class: 'callout' }, h('strong', {}, 'Local evidence only. '), 'Review, merge and work-item closure are not recorded on this machine. Verify asks GitHub (gh CLI) and Azure Boards (az CLI) about the branches and numbers already found here; titles, descriptions and commit messages are never requested.'),
    recipeStrip(view, model),
    kpiCards(view),
    h('div', { class: 'grid two recipe-pair' }, adherenceCard(view, model), ingredientsCard(view)),
    h('h2', {}, `Cycles · ${view.cycles.length ? 'one lane per repository branch' : 'none in this window'}`),
    view.cycles.length ? lanes(view, model, ui) : h('p', { class: 'muted' }, 'No model calls with a repository in this window.'),
    h('h2', {}, 'Which surface records each step'),
    surfaceMatrix(model),
    h('h2', {}, 'Guardrails'),
    h('ul', { class: 'small' }, model.recipe.guardrails.map((g) => h('li', {}, g))),
    notes.length ? h('ul', { class: 'small muted' }, notes.map((n) => h('li', {}, n))) : null,
  ];
}
