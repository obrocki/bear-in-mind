import { h, s, disclosure } from './dom.js';
import { intersectConcepts } from './intersection.mjs';
import { coverageText, formatTokens, entityLabels, sourceLabels as SOURCE_SHORT } from './format.mjs';
import { renderRecipe } from './recipe.mjs';
import { initializeTheme } from './theme.mjs';

const VIEWS = [
  { id: 'outcomes', label: 'Overview' },
  { id: 'recipe', label: 'Recipe' },
  { id: 'surfaces', label: 'Data sources' },
  { id: 'model', label: 'How it connects' },
  { id: 'gaps', label: 'Missing data' },
  { id: 'coverage', label: 'Local usage' },
  { id: 'research', label: 'Research' },
];
const WINDOWS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
  { days: 0, label: 'All available history' },
];

const state = {
  view: 'outcomes',
  model: null,
  coverage: null,
  group: 'all',
  sharedOnly: false,
  busy: false,
  recipe: null,
  verifying: false,
  org: '',
  expanded: new Set(),
  showAllCycles: false,
  developerSource: '',
  developerActor: '',
  developerPerspective: 'usage',
  allDeveloperWork: false,
  recipeError: null,
  readingBilling: false,
  billingForm: {},
};
const main = document.getElementById('view');

// ------------------------------------------------------------- helpers ---

async function api(path, init) {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.json();
    throw new Error(typeof body.error === 'string' ? body.error : `${path}: ${res.status}`);
  }
  return res.json();
}

const fmtInt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const fmtCredits = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);

function badge(kind, text) {
  return h('span', { class: `badge ${kind}` }, text ?? kind);
}

function surfaceName(id) {
  return state.model?.surfaces.find((s) => s.id === id)?.name ?? id;
}

function shortPath(p) {
  if (!p) return 'not found';
  return p.replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~').replace(/^\/(Users|home)\/[^/]+/, '~');
}

function okSources() {
  return (state.coverage?.sources ?? []).filter((s) => s.status === 'ok');
}

function ratioBar(value, label) {
  const known = value !== null && value !== undefined;
  return h('div', { class: `ratio-bar${known ? '' : ' unknown'}`, role: 'img', 'aria-label': label ?? (known ? pct(value) : 'Not measured') },
    known ? h('span', { style: { width: `${Math.max(0, Math.min(1, value)) * 100}%` } }) : null,
  );
}

function statTiles(items) {
  return h('div', { class: 'grid mini-stats' }, items.map(([label, value, kind = 'neutral']) =>
    h('div', { class: `card stat-${kind}` }, h('strong', {}, value), h('span', { class: 'muted small' }, label)),
  ));
}

// --------------------------------------------------------------- views ---

function overviewMap() {
  const box = ({ id, x, y, w = 320, h = 60, title, lines, kind = '' }) =>
    s('g', { class: `overview-node ${kind}`, 'data-overview-node': id },
      s('rect', { x, y, width: w, height: h, rx: 10 }),
      s('text', { x: x + 14, y: y + 24, class: 'overview-node-title' }, title),
      lines.map((line, index) => s('text', { x: x + 14, y: y + 44 + index * 17, class: 'overview-node-detail' }, line)),
    );
  const edges = [
    ['source-sessionStore', 'usage', 'M340 95 H380 V90 H420', false],
    ['source-traces', 'usage', 'M340 175 H380 V90 H420', false],
    ['source-agentHost', 'usage', 'M340 255 H380 V90 H420', false],
    ['usage', 'recipe', 'M570 123 V190', false],
    ['work-platforms', 'recipe', 'M340 365 H395 V280 H420', true],
    ['recipe', 'work-summary', 'M720 230 H765 V105 H800', false],
    ['recipe', 'delivery-summary', 'M720 285 H780 V250 H800', false],
    ['usage', 'billing-summary', 'M720 105 H740 V400 H780 V460 H800', false],
    ['billing', 'billing-summary', 'M340 460 H800', true],
  ];
  return h('figure', { class: 'card overview-map', 'aria-label': 'Executive summary: data sources, usage records, Recipe and bill comparison' },
    s('svg', { viewBox: '0 0 1200 525', role: 'img', 'aria-label': 'Local Copilot records feed account and usage records, then Recipe links them to work and delivery. Requested GitHub and Azure Boards checks add work details. GitHub billing is compared separately using recorded accounts, dates and models.' },
      s('defs', {}, s('marker', { id: 'overview-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto' },
        s('path', { d: 'M0 0 L10 5 L0 10 Z' }),
      )),
      s('text', { x: 20, y: 34, class: 'overview-group' }, 'LOCAL USAGE RECORDS'),
      s('text', { x: 800, y: 34, class: 'overview-group' }, 'QUESTIONS WE CAN ANSWER'),
      s('text', { x: 20, y: 320, class: 'overview-group' }, 'CHECKS YOU REQUEST'),
      edges.map(([from, to, d, requested]) =>
        s('path', { d, class: `overview-edge${requested ? ' requested' : ''}`, 'marker-end': 'url(#overview-arrow)',
          'data-overview-from': from, 'data-overview-to': to })),
      [
        ['sessionStore', 'Sessions, credits and branches', 65],
        ['traces', 'Requests and account details', 145],
        ['agentHost', 'Requests and account details', 225],
      ].map(([id, detail, y]) => box({ id: `source-${id}`, x: 20, y, title: SOURCE_SHORT[id], lines: [detail] })),
      box({ id: 'usage', x: 420, y: 58, w: 300, h: 65, title: 'Keep each source separate', lines: ['Account, session, requests and credits'] }),
      s('g', { class: 'overview-node recipe', 'data-overview-node': 'recipe' },
        s('rect', { x: 420, y: 190, width: 300, height: 175, rx: 12 }),
        s('text', { x: 438, y: 221, class: 'overview-node-title' }, 'Recipe'),
        s('text', { x: 438, y: 253, class: 'overview-step' }, 'Work item → branch'),
        s('text', { x: 438, y: 282, class: 'overview-step' }, 'AI work → commits'),
        s('text', { x: 438, y: 311, class: 'overview-step' }, 'Pull request → review → merge & close'),
        s('text', { x: 438, y: 344, class: 'overview-node-detail' }, 'One cycle per branch'),
      ),
      box({ id: 'work-platforms', x: 20, y: 335, h: 65, kind: 'requested', title: 'GitHub + Azure Boards',
        lines: ['Work owners and delivery records'] }),
      box({ id: 'billing', x: 20, y: 430, h: 65, kind: 'requested', title: 'GitHub billing',
        lines: ['Daily credits, discounts and charges'] }),
      box({ id: 'work-summary', x: 800, y: 65, w: 380, h: 80, kind: 'answer', title: 'Who worked on what?',
        lines: ['Known accounts, estimates and unknowns'] }),
      box({ id: 'delivery-summary', x: 800, y: 210, w: 380, h: 80, kind: 'answer', title: 'Was the work delivered?',
        lines: ['Review, merge and closure'] }),
      box({ id: 'billing-summary', x: 800, y: 420, w: 380, h: 80, kind: 'answer', title: 'Usage vs bill',
        lines: ['Same account, UTC day and model', 'Estimated costs, not per-change bills'] }),
    ),
    h('figcaption', { class: 'muted small' }, 'Solid: local records. Dashed: checks you request. A source shown here may not be recording data.'),
  );
}

function renderOutcomes() {
  const m = state.model;
  const sources = okSources();
  const live = m.outcomes.filter((o) => o.liveMetric && !['coverage', 'efficiency'].includes(o.id));
  const names = { repo_coverage: 'Linked to a repository', credit_coverage: 'Requests with credit counts', actor_coverage: 'Linked to an account' };
  return [
    h('h2', { class: 'overview-title' }, 'From AI usage to work and cost'),
    h('p', { class: 'lede overview-mission' }, 'Connect people, AI usage, work and cost—with facts, estimates and missing data clearly separated.'),
    overviewMap(),
    h('h2', {}, 'How much recorded AI usage can we link to work?'),
    sources.length
      ? h(
          'div',
          { class: 'grid kpis outcome-kpis' },
          live.map((o) =>
            h(
              'div',
              { class: 'card kpi' },
              h('h3', {}, names[o.id] ?? o.name),
              h(
                'div',
                { class: 'metric-list' },
                sources.map((s) =>
                  h(
                    'div',
                    { title: o.liveMetric === 'cacheReadRatio' ? coverageText(s.metricCoverage?.cacheReadRatio, s.totals.calls) : o.measure },
                    h('div', { class: 'metric-label' },
                      h('span', {}, SOURCE_SHORT[s.id] ?? s.label), h('strong', {}, pct(s.metrics[o.liveMetric])),
                    ),
                    ratioBar(s.metrics[o.liveMetric]),
                  ),
                ),
              ),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'No local usage file could be read. See Local usage for details.'),
    h('p', { class: 'muted small' }, 'Sources stay separate. Missing is unknown; a mention is not proof of delivery.'),
    h('h2', {}, 'Credits linked to a mentioned pull request'),
    sources.length
      ? h(
          'div',
          { class: 'grid two' },
          sources.map((s) => {
            const pr = s.funnel.find((f) => f.id === 'pullRequest');
            const known = pr?.emitted && s.totals.creditedCalls > 0;
            return h(
              'div',
              { class: 'card' },
              h('h3', {}, SOURCE_SHORT[s.id] ?? s.label),
              known
                ? [
                    ratioBar(s.totals.credits > 0 ? pr.credits / s.totals.credits : null),
                    h('div', { class: 'split-labels small' },
                      h('span', {}, `${fmtCredits.format(pr.credits)} credits linked`),
                      h('span', { class: 'muted' }, `${fmtCredits.format(s.totals.credits - pr.credits)} credits not linked`),
                    ),
                  ]
                : h('p', { class: 'muted' }, 'Not measured'),
            );
          }),
        )
      : null,
    h('p', { class: 'callout' }, 'Savings still need evidence of business value, people’s time and similar work without AI.'),
  ];
}

function renderSurfaces(intersection = false) {
  const m = state.model;
  const groups = [{ id: 'all', label: 'All' }, ...m.groups];
  const available = intersection ? intersectConcepts(m) : m.concepts;
  const concepts = available.filter((c) => state.group === 'all' || c.group === state.group);
  const rows = [];
  for (const group of m.groups) {
    const inGroup = concepts.filter((c) => c.group === group.id);
    if (!inGroup.length) continue;
    rows.push(h('tr', { class: 'group-row' }, h('td', { colspan: m.surfaces.length + 1 }, group.label)));
    for (const c of inGroup) {
      rows.push(
        h(
          'tr',
          {},
          h(
            'td',
            { class: 'concept' },
            disclosure(`concept-${c.id}`, h('strong', {}, c.name),
              h('span', { class: 'mono' }, c.canonical),
              h('span', { class: 'mono' }, `OpenTelemetry field: ${c.otel}`),
              c.note ? h('p', { class: 'small muted' }, c.note) : null,
            ),
            intersection
              ? badge(c.intersectionAvailability, c.intersectionAvailability === 'native' ? 'Reported by all' : 'Some limits')
              : null,
          ),
          m.surfaces.map((s) => {
            const cell = c.surfaces[s.id];
            return h(
              'td',
              { class: 'cell' },
              disclosure(`cell-${c.id}-${s.id}`,
                badge(cell.availability, m.availabilityLevels.find((l) => l.id === cell.availability)?.label),
                h('span', { class: 'mono' }, cell.field),
                cell.note ? h('span', { class: 'note' }, cell.note) : null,
              ),
            );
          }),
        ),
      );
    }
  }
  return [
    h(
      'p',
      { class: 'lede' },
      intersection
        ? `${available.length} types of data appear in all five tools or reports. The detail can still differ.`
        : 'What each Copilot tool or report provides. Expand a cell for details.',
    ),
    intersection
      ? statTiles([
          ['Reported by all', available.filter((c) => c.intersectionAvailability === 'native').length, 'native'],
          ['Some limits', available.filter((c) => c.intersectionAvailability !== 'native').length, 'partial'],
          ['Not in every source', m.concepts.length - available.length, 'missing'],
        ])
      : null,
    h('p', { class: 'muted small' }, 'Individual requests, daily totals and screen-only values are not interchangeable. Do not add overlapping sources.'),
    intersection && !concepts.length
      ? h('p', { class: 'muted' }, 'No checked data is shared by every source in this group.')
      : null,
    h(
      'div',
      { class: 'legend' },
      m.availabilityLevels.map((l) =>
        h(
          'span',
          { title: l.description },
          badge(l.id, l.label),
        ),
      ),
    ),
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Which data to show' },
      [[false, 'All data types'], [true, 'Shared by all five']].map(([shared, label]) =>
        h('button', {
          'aria-pressed': String(state.sharedOnly === shared), 'data-focus-key': `scope-${shared}`,
          onclick: () => { state.sharedOnly = shared; render(); },
        }, label),
      ),
    ),
    h(
      'div',
      { class: 'chips', role: 'group', 'aria-label': 'Filter by group' },
      groups.map((g) =>
        h(
          'button',
          {
            'aria-pressed': String(state.group === g.id),
            'data-focus-key': `group-${g.id}`,
            onclick: () => {
              state.group = g.id;
              render();
            },
          },
          g.label,
        ),
      ),
    ),
    h(
      'div',
      { class: 'matrix-wrap' },
      h(
        'table',
        { class: 'matrix' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', {}, 'Data'),
            m.surfaces.map((s) =>
              h('th', { title: s.collection }, s.name),
            ),
          ),
        ),
        h('tbody', {}, rows),
      ),
    ),
    disclosure('matrix-guide', 'How to read this table',
      h('ul', {}, m.availabilityLevels.map((l) => h('li', {}, h('strong', {}, `${l.label}: `), l.description))),
      h('p', {}, 'A tool may support a field without recording it here. “Reported” means the source supplies it, not that every report has the same detail. Shared data excludes fields that are not reported or not checked.'),
      h('ul', {}, m.surfaces.map((surface) => h('li', {}, h('strong', {}, `${surface.name}: `), surface.collection))),
    ),
  ];
}

function modelGraph(m) {
  const positions = {
    actor: [30, 28], ai_session: [300, 28], model_call: [570, 28], tool_call: [570, 150],
    cost_ledger: [30, 410], work_item: [30, 272], attribution: [300, 272], outcome: [840, 272],
    billing_reconciliation: [300, 410], work_allocation: [570, 410],
  };
  const hints = {
    actor: 'Who used AI', ai_session: 'One coding session', model_call: 'One AI request', tool_call: 'One tool action',
    work_item: 'Issue, branch or pull request', attribution: 'Evidence connecting the work', outcome: 'What happened to the change',
    cost_ledger: 'Usage and actual charges', billing_reconciliation: 'Same account, day and model', work_allocation: 'A share of the bill, not proof',
  };
  const routes = {
    'actor:ai_session': 'M220 57 H300',
    'ai_session:model_call': 'M490 57 H570',
    'ai_session:tool_call': 'M490 70 H530 V179 H570',
    'ai_session:attribution': 'M395 86 V272',
    'work_item:attribution': 'M220 301 H300',
    'work_item:outcome': 'M125 330 V365 H935 V330',
    'ai_session:outcome': 'M490 42 H800 V301 H840',
    'cost_ledger:actor': 'M30 439 H10 V100 H125 V86',
    'cost_ledger:billing_reconciliation': 'M220 439 H300',
    'model_call:billing_reconciliation': 'M665 86 V118 H790 V390 H395 V410',
    'billing_reconciliation:work_allocation': 'M490 439 H570',
    'work_allocation:work_item': 'M665 468 V525 H255 V301 H220',
  };
  return h('figure', { class: 'card model-graph' },
    s('svg', { viewBox: '0 0 1060 550', role: 'img', 'aria-label': 'AI usage links to work and results. Separately, compare the bill using the recorded account, day in UTC and model. Costs assigned to work are estimates.' },
      s('defs', {}, s('marker', { id: 'model-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' },
        s('path', { d: 'M0 0 L10 5 L0 10 Z' }),
      )),
      m.relationships.map((r) => s('path', { d: routes[`${r.from}:${r.to}`], class: 'edge', 'marker-end': 'url(#model-arrow)' },
        s('title', {}, `${entityLabels[r.from]} ${r.label} ${entityLabels[r.to]}`),
      )),
      m.entities.map((e) => {
        const [x, y] = positions[e.id];
        return s('g', { class: `model-node node-${e.id}`, 'data-entity': e.id },
          s('title', {}, `${entityLabels[e.id]}: ${hints[e.id]}`),
          s('rect', { x, y, width: 190, height: 58, rx: 9 }),
          s('text', { x: x + 14, y: y + 24, class: 'node-label' }, entityLabels[e.id]),
          s('text', { x: x + 14, y: y + 43, class: 'node-caption' }, hints[e.id]),
        );
      }),
    ),
    h('figcaption', { class: 'muted small' }, 'Compare bills by account, UTC day and model. Unexplained charges stay separate; no per-pull-request bills.'),
  );
}

function renderModel() {
  const m = state.model;
  return [
    h(
      'p',
      { class: 'lede' },
      'How AI usage connects to people, work, results and charges.',
    ),
    modelGraph(m),
    h('h2', {}, 'How strong is the link?'),
    h(
      'div',
      { class: 'grid link-methods' },
      m.linkMethods.map((method) => h('div', { class: 'card' },
        h('h3', {}, method.name),
        h('p', { class: 'small muted' }, method.confidence),
        disclosure(`link-${method.id}`, 'Why', h('p', {}, method.method), h('p', {}, method.example)),
      )),
    ),
    disclosure('entity-fields', 'Records & technical fields',
      h('div', { class: 'grid cards' }, m.entities.map((e) =>
        h('div', { class: 'card entity' }, h('h3', {}, entityLabels[e.id]), h('code', {}, e.name), h('p', { class: 'muted small' }, e.grain),
          h('ul', {}, e.fields.map((f) => h('li', {}, f))),
        ),
      )),
    ),
    disclosure('actor-provenance', 'Where account details come from',
      h('p', {}, 'Supported fields may not have been recorded here. A computer or operating-system account is not proof of who used AI.'),
      h('div', { class: 'matrix-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Field'), h('th', {}, 'How supplied'), h('th', {}, 'Where to find it'), h('th', {}, 'Limits'))),
        h('tbody', {}, m.entities.find((e) => e.id === 'actor').fieldProvenance.map((p) =>
          h('tr', {}, h('td', {}, h('code', {}, p.field)),
            h('td', {}, badge(p.kind === 'native' || p.kind === 'derived' ? p.kind : 'partial', { native: 'Reported', derived: 'Calculated', configured: 'Set up manually', enriched: 'Added from another system' }[p.kind])),
            h('td', {}, p.readPath), h('td', {}, p.conditions),
          ),
        ),
        ),
      )),
    ),
    h('p', { class: 'muted small' }, 'Missing is unknown, not zero. Count each AI request once. Keep usage we cannot link.'),
    disclosure('accounting-rules', 'Counting rules',
      h('ol', {}, m.invariants.map((i) => h('li', {}, i))),
    ),
    disclosure('billing-contract', 'How we compare usage with the bill',
      h('p', {}, m.reconciliation.source),
      h('p', {}, h('strong', {}, 'Compare like for like: '), m.reconciliation.grain),
      h('ul', {}, m.reconciliation.requirements.map((rule) => h('li', {}, rule))),
      h('p', { class: 'muted small' }, m.reconciliation.allocationPolicy),
    ),
  ];
}

function renderGaps() {
  const m = state.model;
  const order = { high: 0, medium: 1, low: 2 };
  const gaps = [...m.gaps].sort((a, b) => order[a.severity] - order[b.severity]);
  return [
    h('p', { class: 'lede' }, 'What is missing. Expand a gap for impact and next steps.'),
    statTiles(['high', 'medium', 'low'].map((severity) =>
      [`${severity} impact`, gaps.filter((g) => g.severity === severity).length, severity],
    )),
    h(
      'div',
      { class: 'grid cards' },
      gaps.map((g) =>
        disclosure(`gap-${g.id}`,
          h('div', { class: 'head' }, h('h3', {}, g.title), badge(g.severity, `${g.severity} impact`)),
          h(
            'div',
            { class: 'chips' },
            g.surfaces.map((s) => badge('neutral', surfaceName(s))),
          ),
          h('p', {}, h('strong', {}, 'Why it matters: '), g.consequence),
          h('p', {}, h('strong', {}, 'What to do: '), g.mitigation),
        ),
      ),
    ),
    h('p', { class: 'muted small' }, 'Research summarizes the evidence and its limits.'),
  ];
}

/** Credit-weighted only when some credits are positive; otherwise the funnel is labelled call-weighted. */
function creditWeighted(source) {
  return source.funnel[0].credits > 0;
}

function funnel(source) {
  const top = source.funnel[0];
  const byCredits = creditWeighted(source);
  const labels = { observed: 'Recorded requests', session: 'Linked to a session', repository: 'Linked to a repository', branch: 'Branch / commit', workRef: 'Work mentioned', pullRequest: 'Pull request mentioned' };
  return h(
    'div',
    { class: 'funnel' },
    source.funnel.map((f) => {
      const ratio = f.emitted ? (byCredits ? f.credits / top.credits : top.calls ? f.calls / top.calls : null) : null;
      return h(
        'div',
        { class: `row${f.emitted ? '' : ' not-emitted'}` },
        h('span', { class: 'label', title: f.label }, labels[f.id] ?? f.label),
        h(
          'div',
          { class: `bar${ratio === null ? ' unknown' : ''}`, title: ratio === null ? 'Not measured' : pct(ratio) },
          ratio === null ? null : h('div', { class: 'fill', style: { width: `${Math.max(0, Math.min(1, ratio)) * 100}%` } }),
        ),
        h(
          'span',
          { class: 'stats', title: f.emitted ? `${fmtCredits.format(f.credits)} credits · ${fmtInt.format(f.calls)} requests · ${fmtInt.format(f.sessions)} sessions` : 'Not reported by this source' },
          f.emitted
            ? pct(ratio)
            : 'Unavailable',
        ),
      );
    }),
  );
}

function funnelCounts(source) {
  return h('div', { class: 'matrix-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ...['Step', 'Sessions', 'Requests', 'Credits'].map((label) => h('th', {}, label)))),
    h('tbody', {}, source.funnel.map((stage) => h('tr', {},
      h('td', {}, stage.label),
      ...[stage.sessions, stage.calls, stage.credits].map((value, i) =>
        h('td', { class: 'num' }, stage.emitted ? (i === 2 ? fmtCredits : fmtInt).format(value) : '—'),
      ),
    ))),
  ));
}

function breakdownTable(title, rows) {
  if (!rows?.length) return null;
  const max = Math.max(...rows.map((r) => r.credits), 0);
  return h(
    'div',
    {},
    h('h3', {}, title),
    h('div', { class: 'breakdown-bars' }, rows.map((r) =>
      h('div', {},
        h('div', { class: 'metric-label' }, h('span', {}, r.key === '(none)' ? 'Not recorded' : r.key),
          h('span', { class: 'muted small' }, `${fmtCredits.format(r.credits)} credits · ${fmtInt.format(r.calls)} requests`),
        ),
        ratioBar(max > 0 ? r.credits / max : 0, `${r.key}: ${fmtCredits.format(r.credits)} credits; scaled to the largest row`),
      ),
    )),
  );
}

function sparkline(daily) {
  if (!daily?.length) return null;
  const max = Math.max(...daily.map((d) => d.credits), 0);
  if (max <= 0) return null;
  return h(
    'div',
    { class: 'spark', title: 'Credits per day' },
    daily.map((d) =>
      h('span', {
        title: `${d.day}: ${fmtCredits.format(d.credits)} credits`,
        style: { height: `${Math.max(4, (d.credits / max) * 100)}%` },
      }),
    ),
  );
}

function sourceCard(s) {
  const head = h(
    'div',
    { class: 'head' },
    h('h2', { title: s.label }, SOURCE_SHORT[s.id] ?? s.label, ' ',
      badge(s.status, { ok: 'Ready', missing: 'Not found', schema: 'Format changed', unavailable: 'Not available', error: 'Read failed' }[s.status] ?? s.status)),
  );
  if (s.status !== 'ok') return h('section', { class: 'card' }, head, h('p', {}, s.reason ?? 'Unavailable.'));
  const t = s.totals;
  const b = s.breakdowns;
  return h(
    'section',
    { class: 'card source-card' },
    head,
    h(
      'p',
      { class: 'muted small' },
      `${s.freshness.first?.slice(0, 10) ?? '—'} → ${s.freshness.last?.slice(0, 10) ?? '—'} UTC`,
    ),
    h(
      'div',
      { class: 'grid kpis' },
      [
        ['AI requests', fmtInt.format(t.calls)],
        ['Reported credits', fmtCredits.format(t.credits)],
        ['Requests with credit counts', pct(s.metrics.creditCoverage)],
        ['Sessions', fmtInt.format(t.sessions)],
        ['Input / output tokens', `${formatTokens(t.inputTokens)} / ${formatTokens(t.outputTokens)}`],
        ['Reused input', pct(s.metrics.cacheReadRatio)],
        s.metrics.subAgentShare !== null ? ['Credits used by helper agents', pct(s.metrics.subAgentShare)] : null,
        s.metrics.creditsToActorShare !== null && s.metrics.creditsToActorShare !== undefined
          ? ['Credits linked to an account', pct(s.metrics.creditsToActorShare)]
          : null,
      ]
        .filter(Boolean)
        .map(([label, value]) =>
          h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value)),
        ),
    ),
    h('p', { class: 'muted small' }, `${t.creditedCalls}/${t.calls} requests include credit counts. `,
      s.metricCoverage?.cacheReadRatio?.share === null || !s.metricCoverage?.cacheReadRatio
        ? 'Input reuse is not measured.'
        : `Input reuse can be measured for ${coverageText(s.metricCoverage.cacheReadRatio, t.calls)}.`,
    ),
    sparkline(s.daily),
    h('h3', {}, `Where ${creditWeighted(s) ? 'credits' : 'requests'} can be linked`),
    funnel(s),
    disclosure(`tokens-${s.id}`, 'Token counts',
      h('p', { class: 'muted small' }, 'Tokens are pieces of text. Totals include only requests that report each count; missing is unknown, not zero.'),
      h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Count'), h('th', { class: 'num' }, 'Tokens'), h('th', {}, 'Requests reporting this count'))),
      h('tbody', {}, [
        ['inputTokens', 'Input'],
        ['outputTokens', 'Output'],
        ['cacheReadTokens', 'Reused input'],
        ['cacheWriteTokens', 'Input saved for reuse'],
        ['reasoningTokens', 'Reasoning'],
      ].map(([key, label]) => h('tr', {},
        h('td', {}, label),
        h('td', { class: 'num' }, formatTokens(t[key])),
        h('td', {}, coverageText(s.tokenCoverage?.[key], t.calls)),
      ))),
      ),
    ),
    disclosure(`breakdowns-${s.id}`, 'Models, repositories & tools',
      h(
      'div',
      { class: 'grid two' },
      breakdownTable('By model', b.model),
      breakdownTable(b.agent ? 'By AI agent' : 'Who started the request', b.agent ?? b.initiator),
      breakdownTable('By reasoning setting', b.reasoningEffort),
      breakdownTable('By repository', b.repository),
      b.user ? breakdownTable('By recorded account', b.user) : null,
      b.link ? breakdownTable('How the repository was linked', b.link) : null,
      s.tools?.length
        ? h(
            'div',
            {},
            h('h3', {}, 'Tool actions · eight most used'),
            h(
              'table',
              {},
              h(
                'thead',
                {},
                h(
                  'tr',
                  {},
                  h('th', {}, 'Tool'),
                  h('th', { class: 'num' }, 'Actions'),
                  h(
                    'th',
                    { class: 'num', title: 'Failed actions / actions with a reported success or failure' },
                    'Failed / known results',
                  ),
                ),
              ),
              h(
                'tbody',
                {},
                s.tools.map((x) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, x.key),
                    h('td', { class: 'num' }, fmtInt.format(x.calls)),
                    h(
                      'td',
                      { class: 'num', title: x.statusCalls ? '' : 'Status not reported' },
                      x.statusCalls ? `${fmtInt.format(x.failed)} / ${fmtInt.format(x.statusCalls)}` : '—',
                    ),
                  ),
                ),
              ),
            ),
          )
        : null,
      ),
    ),
    disclosure(`source-${s.id}`, 'Source & limits',
      h('p', {}, s.label),
      h('p', { class: 'mono' }, shortPath(s.path)),
      funnelCounts(s),
      s.notes?.length ? h('ul', { class: 'small muted' }, s.notes.map((n) => h('li', {}, n))) : null,
    ),
  );
}

function renderCoverage() {
  const c = state.coverage;
  const select = windowSelect();
  return [
    h(
      'p',
      { class: 'lede' },
      'Usage recorded on this machine, shown separately for each source. No prompts or responses are read.',
    ),
    h(
      'div',
      { class: 'toolbar' },
      select,
      h(
        'button',
        { 'data-focus-key': 'refresh', onclick: () => refresh(), 'aria-disabled': state.busy ? 'true' : undefined },
        state.busy ? 'Refreshing…' : 'Refresh',
      ),
      c ? h('span', { class: 'muted small' }, `Generated ${new Date(c.generatedAt).toLocaleString()}`) : null,
    ),
    c?.caveats.some((x) => x.startsWith('Coverage failed:'))
      ? h('p', { role: 'alert' }, c.caveats.join(' '))
      : null,
    c
      ? h('div', { class: 'grid coverage-sources' }, c.sources.map(sourceCard))
      : h('p', { class: 'muted' }, 'Loading coverage…'),
    c ? disclosure('coverage-rules', 'What these numbers include', h('ul', {}, c.caveats.map((x) => h('li', {}, x)))) : null,
  ];
}

function windowSelect() {
  return h(
    'select',
    {
      'aria-label': 'Window',
      'data-focus-key': 'window',
      onchange: (e) => refresh(Number(e.target.value)),
    },
    WINDOWS.map((w) => h('option', { value: w.days, selected: state.coverage?.window.days === w.days }, w.label)),
  );
}

function renderRecipeView() {
  return renderRecipe(state.recipe, state.model, {
    windowSelect: windowSelect(),
    busy: state.busy,
    verifying: state.verifying,
    org: state.org,
    expanded: state.expanded,
    showAll: state.showAllCycles,
    sourceId: state.developerSource,
    actorKey: state.developerActor,
    perspective: state.developerPerspective,
    allWork: state.allDeveloperWork,
    error: state.recipeError,
    readingBilling: state.readingBilling,
    billingForm: state.billingForm,
    lastCompleteDay: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
    setBilling: (key, value) => { state.billingForm[key] = value; },
    readBilling: (scope) => readBilling(scope),
    setDeveloper: (key, value) => {
      if (key === 'developer-source') state.developerSource = value;
      if (key === 'developer-actor') state.developerActor = value;
      if (key === 'developer-perspective') state.developerPerspective = value;
      render();
    },
    toggleWork: () => { state.allDeveloperWork = !state.allDeveloperWork; render(); },
    linkIdentity: (boardsKey, githubLogin) => saveIdentityLinks([
      ...state.recipe.developers.identityLinks.filter((link) => link.boardsKey !== boardsKey),
      { boardsKey, githubLogin },
    ]),
    unlinkIdentity: (boardsKey) => saveIdentityLinks(state.recipe.developers.identityLinks.filter((link) => link.boardsKey !== boardsKey)),
    refresh: () => refresh(),
    verify: () => verify(),
    setOrg: (value) => {
      state.org = value;
    },
    toggle: (key) => {
      if (!state.expanded.delete(key)) state.expanded.add(key);
      render();
    },
    toggleAll: () => {
      state.showAllCycles = !state.showAllCycles;
      render();
    },
  });
}

function renderResearch() {
  const shared = intersectConcepts(state.model);
  const native = shared.filter((concept) => concept.intersectionAvailability === 'native');
  const findings = [
    ['Different sources',
      'VS Code has a Local harness and a Copilot Agent Host harness. Copilot CLI and the app share an engine. Cloud usage is a preview feature; organization reports contain daily totals.',
      'Keep source and reporting period. Never sum overlapping usage.'],
    ['Shared fields are limited',
      `${shared.length} types of data appear in all five tools or reports; ${native.length} are reported directly by all five.`,
      'The same type of data can have different detail. It may not contain the IDs needed to link records.'],
    ['People need evidence',
      'A captured account identifies who used AI. Work-item assignees and pull request authors tell us who owns or submitted the work.',
      'Usage assigned from ownership is an estimate. A device, branch prefix or matching name does not prove who used AI.'],
    ['Work needs verification',
      'Repository, branch and commit records can link usage to work. Online checks add pull requests, reviews, merges and closure.',
      'A mention does not prove who owns the work. A merge or review is not proof of quality or value.'],
    ['Billing is separate',
      'GitHub reports credits, discounts and final charges by account, day and model, but supplies no PR/session billing IDs.',
      'Estimated work cost = final charge × recorded account’s work credits / billed credits, per model. Charges we cannot explain stay separate.'],
  ];
  return [
    h('p', { class: 'lede' }, 'Research in brief · what we can measure and what we cannot conclude.'),
    h('div', { class: 'matrix-wrap research-summary' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Finding'), h('th', {}, 'Evidence'), h('th', {}, 'Limit'))),
      h('tbody', {}, findings.map(([finding, evidence, limit]) => h('tr', {},
        h('th', { scope: 'row' }, finding), h('td', {}, evidence), h('td', {}, limit),
      ))),
    )),
    h('p', { class: 'callout' }, h('strong', {}, 'Before claiming a return on investment: '),
      'measure people’s time, business value and similar work done without AI. Credits alone show usage, not savings.'),
    disclosure('research-sources', `Sources · ${state.model.sources.length}`,
      h(
      'ul',
      {},
      state.model.sources.map((s) =>
        h(
          'li',
          {},
          h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.title),
          ' ',
          badge('neutral', s.kind),
          ),
        ),
      ),
    ),
  ];
}

const RENDERERS = {
  outcomes: renderOutcomes,
  recipe: renderRecipeView,
  surfaces: () => renderSurfaces(state.sharedOnly),
  model: renderModel,
  gaps: renderGaps,
  coverage: renderCoverage,
  research: renderResearch,
};

// ------------------------------------------------------------- shell ---

function renderTabs() {
  const tabs = document.getElementById('tabs');
  // Built once and updated in place, so the focused tab survives a re-render.
  if (!tabs.childElementCount) {
    tabs.append(
      ...VIEWS.map((v) =>
        h(
          'button',
          {
            role: 'tab',
            id: `tab-${v.id}`,
            'aria-controls': 'view',
            'data-view': v.id,
            onclick: () => selectView(v.id, true),
            onkeydown: onTabKey,
          },
          v.label,
        ),
      ),
    );
  }
  for (const button of tabs.children) {
    const selected = button.dataset.view === state.view;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
}

function onTabKey(event) {
  const index = VIEWS.findIndex((v) => v.id === state.view);
  const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: VIEWS.length - 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  const view = VIEWS[(next + VIEWS.length) % VIEWS.length].id;
  selectView(view, true);
  document.getElementById(`tab-${view}`).focus();
}

function render() {
  renderTabs();
  if (!state.model) return;
  // Controls inside the panel are rebuilt; restore focus to the equivalent one.
  const focusKey = main.contains(document.activeElement) ? document.activeElement.dataset.focusKey : undefined;
  try {
    main.replaceChildren(...[RENDERERS[state.view]()].flat().filter(Boolean));
  } catch (err) {
    main.replaceChildren(h('p', {}, `Could not render: ${err.message}`));
  }
  main.setAttribute('aria-labelledby', `tab-${state.view}`);
  if (focusKey) main.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
}

async function selectView(view, fromUser) {
  if (view === 'intersection') {
    state.sharedOnly = true;
    view = 'surfaces';
  }
  if (!RENDERERS[view]) return;
  state.view = view;
  render();
  // Persist before any fetch, so a slower request cannot overwrite a newer selection.
  if (fromUser) {
    api('/api/view', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ view }),
    }).catch(() => {});
  }
  if (view === 'recipe' && !state.recipe) await loadRecipe();
}

async function loadRecipe() {
  try {
    state.recipe = await api('/api/recipe');
  } catch (err) {
    state.recipe = null;
    main.replaceChildren(h('p', {}, `Could not load the recipe: ${err.message}`));
    return;
  }
  render();
}

async function verify() {
  if (state.verifying) return;
  state.verifying = true;
  state.recipeError = null;
  render();
  try {
    state.recipe = await api('/api/recipe/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.org.trim() ? { azureDevOpsOrg: state.org.trim() } : {}),
    });
  } catch (err) {
    state.recipeError = `Verification failed: ${err.message}`;
  } finally {
    state.verifying = false;
    render();
  }
}

async function saveIdentityLinks(links) {
  state.recipeError = null;
  try {
    state.recipe = await api('/api/recipe/identity-links', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ links }),
    });
  } catch (err) {
    state.recipeError = `Identity link failed: ${err.message}`;
  }
  render();
}

async function readBilling(scope) {
  if (state.readingBilling) return;
  state.readingBilling = true;
  state.billingForm = { ...scope };
  state.recipe = { ...state.recipe, billing: { status: 'loading' } };
  render();
  try {
    state.recipe = await api('/api/recipe/billing', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope),
    });
  } catch (err) {
    state.recipe = { ...state.recipe, billing: { status: 'error', reason: `Billing failed: ${err.message}` } };
  } finally {
    state.readingBilling = false;
    render();
  }
}

async function loadCoverage() {
  state.coverage = await api('/api/coverage');
  render();
  if (state.view === 'recipe' || state.recipe) await loadRecipe();
}

async function refresh(windowDays) {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    state.coverage = await api('/api/coverage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(windowDays === undefined ? {} : { windowDays }),
    });
  } finally {
    state.busy = false;
    render();
  }
  if (state.view === 'recipe' || state.recipe) await loadRecipe();
}

async function start() {
  initializeTheme();
  renderTabs();
  state.model = await api('/api/model');
  const { view } = await api('/api/view');
  await selectView(view, false);
  loadCoverage().catch((err) => {
    state.coverage = {
      generatedAt: new Date().toISOString(),
      window: { days: 0 },
      sources: [],
      caveats: [`Coverage failed: ${err.message}`],
    };
    render();
  });

  const events = new EventSource('/events');
  events.addEventListener('view', (e) => selectView(JSON.parse(e.data).view, false));
  events.addEventListener('coverage', () => loadCoverage());
  events.addEventListener('recipe', () => loadRecipe());
}

start().catch((err) => main.replaceChildren(h('p', {}, `Failed to load: ${err.message}`)));
