import { h, s, disclosure } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { intersectConcepts } from './intersection.mjs';
import { coverageText, formatTokens } from './format.mjs';
import { renderRecipe } from './recipe.mjs';
import { initializeTheme } from './theme.mjs';

const VIEWS = [
  { id: 'outcomes', label: 'Outcomes' },
  { id: 'recipe', label: 'Recipe' },
  { id: 'surfaces', label: 'Surfaces' },
  { id: 'intersection', label: 'Intersection' },
  { id: 'model', label: 'Data model' },
  { id: 'gaps', label: 'Gaps' },
  { id: 'coverage', label: 'Live coverage' },
  { id: 'research', label: 'Research' },
];
const WINDOWS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
  { days: 0, label: 'All retained history' },
];
const AVAILABILITY_TEXT = {
  local: 'Local',
  'needs-vcs-join': 'Needs delivery data',
  'needs-org-api': 'Needs billing',
  'needs-baseline': 'Needs baseline',
};
const SOURCE_SHORT = { sessionStore: 'CLI / app', traces: 'VS Code', agentHost: 'VS Code Copilot harness' };

const state = {
  view: 'outcomes',
  model: null,
  coverage: null,
  research: null,
  group: 'all',
  busy: false,
  recipe: null,
  verifying: false,
  org: '',
  expanded: new Set(),
  showAllCycles: false,
};
const main = document.getElementById('view');

// ------------------------------------------------------------- helpers ---

async function api(path, init) {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
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

function outcomeTable(m) {
  return h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Outcome'), h('th', {}, 'Measure'), h('th', {}, 'Status'))),
    h('tbody', {}, m.outcomes.map((o) => h('tr', {},
      h('td', {}, o.name), h('td', {}, o.measure), h('td', {}, badge(o.availability, AVAILABILITY_TEXT[o.availability])),
    ))),
  );
}

// --------------------------------------------------------------- views ---

function renderOutcomes() {
  const m = state.model;
  const sources = okSources();
  const live = m.outcomes.filter((o) => o.liveMetric);
  const names = { coverage: 'PR references', repo_coverage: 'Repository', credit_coverage: 'Credit reporting', actor_coverage: 'User identity', efficiency: 'Cache read' };
  return [
    h('p', { class: 'lede' }, 'Usage linked to work. Coverage, not financial return.'),
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
              disclosure(`outcome-${o.id}`, 'Definition', h('p', {}, o.measure),
                o.liveMetric === 'cacheReadRatio'
                  ? h('ul', {}, sources.map((source) => h('li', {},
                      `${SOURCE_SHORT[source.id] ?? source.label}: ${coverageText(source.metricCoverage?.cacheReadRatio, source.totals.calls)}`,
                    )))
                  : null,
              ),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'No local store could be read. See Live coverage for details.'),
    h('p', { class: 'muted small' }, 'Sources stay separate. Missing = unknown; a PR reference does not prove delivery.'),
    h('h2', {}, 'Credits with a PR reference'),
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
                      h('span', {}, `${fmtCredits.format(pr.credits)} cr linked`),
                      h('span', { class: 'muted' }, `${fmtCredits.format(s.totals.credits - pr.credits)} cr unlinked`),
                    ),
                  ]
                : h('p', { class: 'muted' }, 'Not measured'),
              disclosure(`outcome-funnel-${s.id}`, `Attribution · ${creditWeighted(s) ? 'credits' : 'calls'}`, funnel(s), funnelCounts(s)),
            );
          }),
        )
      : null,
    h('h2', {}, 'Before ROI'),
    h('div', { class: 'flow-strip', 'aria-label': 'Inputs still needed for ROI' },
      ['Verify delivery', 'Reconcile billed cost', 'Measure human effort', 'Compare a baseline'].map((label, i) =>
        h('div', {}, h('span', { class: 'flow-number' }, i + 1), label),
      ),
    ),
    disclosure('roi-contract', 'Measures & limits', h('p', {}, m.summary), outcomeTable(m)),
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
              h('span', { class: 'mono' }, `OTel: ${c.otel}`),
              c.note ? h('p', { class: 'small muted' }, c.note) : null,
            ),
            intersection
              ? badge(c.intersectionAvailability, c.intersectionAvailability === 'native' ? 'All native' : 'Conditional')
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
        ? `${available.length} concepts shared across five surfaces. Availability, not equivalent data.`
        : 'What each surface emits. Expand a cell for fields and conditions.',
    ),
    intersection
      ? statTiles([
          ['Native everywhere', available.filter((c) => c.intersectionAvailability === 'native').length, 'native'],
          ['Conditional', available.filter((c) => c.intersectionAvailability !== 'native').length, 'partial'],
          ['Not shared', m.concepts.length - available.length, 'missing'],
        ])
      : null,
    h('p', { class: 'muted small' }, 'Per-call, daily and panel-only data differ. No cross-source join or sum.'),
    intersection && !concepts.length
      ? h('p', { class: 'muted' }, 'No verified shared concepts in this group.')
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
            h('th', {}, 'Concept'),
            m.surfaces.map((s) =>
              h('th', { title: s.collection }, s.name),
            ),
          ),
        ),
        h('tbody', {}, rows),
      ),
    ),
    disclosure('matrix-guide', 'How to read this matrix',
      h('ul', {}, m.availabilityLevels.map((l) => h('li', {}, h('strong', {}, `${l.label}: `), l.description))),
      h('p', {}, 'Capabilities are not proof of collection. Native means directly emitted, not identical grain. Missing and unverified fields are excluded from Intersection.'),
      h('ul', {}, m.surfaces.map((surface) => h('li', {}, h('strong', {}, `${surface.name}: `), surface.collection))),
    ),
  ];
}

function modelGraph(m) {
  const positions = {
    actor: [30, 28], ai_session: [300, 28], model_call: [570, 28], tool_call: [570, 150],
    cost_ledger: [30, 150], work_item: [30, 272], attribution: [300, 272], outcome: [840, 272],
  };
  const labels = { actor: 'Actor', ai_session: 'AI session', model_call: 'Model call', tool_call: 'Tool call', cost_ledger: 'Billing', work_item: 'Work item', attribution: 'Attribution', outcome: 'Outcome' };
  const routes = {
    'actor:ai_session': 'M220 57 H300',
    'ai_session:model_call': 'M490 57 H570',
    'ai_session:tool_call': 'M490 70 H530 V179 H570',
    'ai_session:attribution': 'M395 86 V272',
    'work_item:attribution': 'M220 301 H300',
    'work_item:outcome': 'M125 330 V375 H935 V330',
    'ai_session:outcome': 'M490 42 H800 V301 H840',
    'cost_ledger:actor': 'M125 150 V86',
  };
  return h('figure', { class: 'card model-graph' },
    s('svg', { viewBox: '0 0 1060 400', role: 'img', 'aria-label': 'Attribution data model: actors start AI sessions, which contain model and tool calls, link to work items, and produce outcomes. Billing reconciles separately.' },
      s('defs', {}, s('marker', { id: 'model-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' },
        s('path', { d: 'M0 0 L10 5 L0 10 Z' }),
      )),
      m.relationships.map((r) => s('path', { d: routes[`${r.from}:${r.to}`], class: 'edge', 'marker-end': 'url(#model-arrow)' },
        s('title', {}, `${r.from} ${r.label} ${r.to}`),
      )),
      m.entities.map((e) => {
        const [x, y] = positions[e.id];
        return s('g', { class: `model-node node-${e.id}`, 'data-entity': e.id },
          s('title', {}, `${e.name}: ${e.grain}`),
          s('rect', { x, y, width: 190, height: 58, rx: 9 }),
          s('text', { x: x + 14, y: y + 24, class: 'node-label' }, labels[e.id]),
          s('text', { x: x + 14, y: y + 43, class: 'node-caption' }, e.id),
        );
      }),
    ),
    h('figcaption', { class: 'muted small' }, 'Usage → attribution → outcomes. Billing reconciles separately; it is never added to local usage.'),
  );
}

function renderModel() {
  const m = state.model;
  return [
    h(
      'p',
      { class: 'lede' },
      'How usage connects to work and outcomes.',
    ),
    modelGraph(m),
    h('h2', {}, 'Attribution confidence'),
    h(
      'div',
      { class: 'grid tier-cards' },
      m.tiers.map((t) => h('div', { class: 'card' },
        h('h3', {}, badge(`conf-${t.confidence.replace(/[^a-z]/g, '')}`, t.id), ' ', t.name),
        h('p', { class: 'small muted' }, t.confidence),
        disclosure(`tier-${t.id}`, 'Evidence', h('p', {}, t.method), h('p', {}, t.example)),
      )),
    ),
    disclosure('entity-fields', 'Entities & fields',
      h('div', { class: 'grid cards' }, m.entities.map((e) =>
        h('div', { class: 'card entity' }, h('h3', {}, e.name), h('p', { class: 'muted small' }, e.grain),
          h('ul', {}, e.fields.map((f) => h('li', {}, f))),
        ),
      )),
    ),
    disclosure('model-relationships', 'Relationships',
      h('ul', { class: 'relations' }, m.relationships.map((r) =>
        h('li', {}, h('code', {}, r.from), h('span', { class: 'arrow' }, `— ${r.label} →`), h('code', {}, r.to)),
      )),
    ),
    disclosure('actor-provenance', 'Identity provenance',
      h('p', {}, 'Source capability does not mean the local store collected it. Device identity is not person identity.'),
      h('div', { class: 'matrix-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Field'), h('th', {}, 'Origin'), h('th', {}, 'Read path'), h('th', {}, 'Conditions'))),
        h('tbody', {}, m.entities.find((e) => e.id === 'actor').fieldProvenance.map((p) =>
          h('tr', {}, h('td', {}, h('code', {}, p.field)),
            h('td', {}, badge(p.kind === 'native' || p.kind === 'derived' ? p.kind : 'partial', p.kind)),
            h('td', {}, p.readPath), h('td', {}, p.conditions),
          ),
        ),
        ),
      )),
    ),
    h('p', { class: 'muted small' }, 'Missing stays unknown. Count each call once. Preserve the unattributed remainder.'),
    disclosure('accounting-rules', 'Accounting rules',
      h('ol', {}, m.invariants.map((i) => h('li', {}, i))),
    ),
    disclosure('billing-contract', 'Billing reconciliation',
      h('p', {}, m.reconciliation.source),
      h('p', {}, h('strong', {}, 'Grain: '), m.reconciliation.grain),
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
          h('p', {}, h('strong', {}, 'Consequence: '), g.consequence),
          h('p', {}, h('strong', {}, 'Mitigation: '), g.mitigation),
        ),
      ),
    ),
    disclosure('verification-status', `Verification status · ${m.verification.filter((v) => v.status === 'verified').length}/${m.verification.length} verified`,
      h(
      'table',
      {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Claim'), h('th', {}, 'Status'), h('th', {}, 'Note'))),
      h(
        'tbody',
        {},
        m.verification.map((v) =>
          h('tr', {}, h('td', {}, v.claim), h('td', {}, badge(v.status)), h('td', { class: 'muted' }, v.note)),
        ),
      ),
      ),
    ),
    disclosure('prior-art', 'Prior art',
      h(
      'div',
      { class: 'grid cards' },
      m.priorArt.map((p) =>
        h(
          'div',
          { class: 'card' },
          h('h3', {}, p.name),
          h('p', {}, h('strong', {}, 'Proved: '), p.proved),
          h('p', {}, h('strong', {}, 'Learned: '), p.learned),
          ),
        ),
      ),
    ),
  ];
}

/** Credit-weighted only when some credits are positive; otherwise the funnel is labelled call-weighted. */
function creditWeighted(source) {
  return source.funnel[0].credits > 0;
}

function funnel(source) {
  const top = source.funnel[0];
  const byCredits = creditWeighted(source);
  const labels = { observed: 'Observed', session: 'Session', repository: 'Repository', branch: 'Branch / commit', workRef: 'Work reference', pullRequest: 'PR reference' };
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
          { class: 'stats', title: f.emitted ? `${fmtCredits.format(f.credits)} credits · ${fmtInt.format(f.calls)} calls · ${fmtInt.format(f.sessions)} sessions` : 'Not emitted by this source' },
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
    h('thead', {}, h('tr', {}, ...['Stage', 'Sessions', 'Calls', 'Credits'].map((label) => h('th', {}, label)))),
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
        h('div', { class: 'metric-label' }, h('span', {}, r.key),
          h('span', { class: 'muted small' }, `${fmtCredits.format(r.credits)} cr · ${fmtInt.format(r.calls)} calls`),
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
    h('h2', { title: s.label }, SOURCE_SHORT[s.id] ?? s.label, ' ', badge(s.status)),
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
        ['Model calls', fmtInt.format(t.calls)],
        ['Reported credits', fmtCredits.format(t.credits)],
        ['Credit reporting', pct(s.metrics.creditCoverage)],
        ['Sessions', fmtInt.format(t.sessions)],
        ['Input / output tokens', `${formatTokens(t.inputTokens)} / ${formatTokens(t.outputTokens)}`],
        ['Cache-read ratio', pct(s.metrics.cacheReadRatio)],
        s.metrics.subAgentShare !== null ? ['Sub-agent credit share', pct(s.metrics.subAgentShare)] : null,
        s.metrics.creditsToActorShare !== null && s.metrics.creditsToActorShare !== undefined
          ? ['Credits with a user', pct(s.metrics.creditsToActorShare)]
          : null,
      ]
        .filter(Boolean)
        .map(([label, value]) =>
          h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value)),
        ),
    ),
    h('p', { class: 'muted small' }, `${t.creditedCalls}/${t.calls} calls report credits. Cache pairs: ${coverageText(s.metricCoverage?.cacheReadRatio, t.calls)}.`),
    sparkline(s.daily),
    h('h3', {}, `Attribution · ${creditWeighted(s) ? 'credits' : 'calls'}`),
    funnel(s),
    disclosure(`tokens-${s.id}`, 'Token reporting',
      h('p', { class: 'muted small' }, 'Reported subtotals only. Missing is unknown, not zero.'),
      h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Field'), h('th', { class: 'num' }, 'Tokens'), h('th', {}, 'Reporting coverage'))),
      h('tbody', {}, [
        ['inputTokens', 'Input'],
        ['outputTokens', 'Output'],
        ['cacheReadTokens', 'Cache read'],
        ['cacheWriteTokens', 'Cache write'],
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
      breakdownTable(b.agent ? 'By agent' : 'By initiator', b.agent ?? b.initiator),
      breakdownTable('By reasoning effort', b.reasoningEffort),
      breakdownTable('By repository', b.repository),
      b.user ? breakdownTable('By user (user.name)', b.user) : null,
      b.link ? breakdownTable('By repository link method', b.link) : null,
      s.tools?.length
        ? h(
            'div',
            {},
            h('h3', {}, 'Tool calls · top 8 by calls'),
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
                  h('th', { class: 'num' }, 'Calls'),
                  h(
                    'th',
                    { class: 'num', title: 'Failed calls / calls that reported an OK or ERROR status' },
                    'Failed / with status',
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
    disclosure(`source-${s.id}`, 'Source & caveats',
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
      'Local usage, by source. No prompts or responses; no cross-source totals.',
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
    c ? disclosure('coverage-rules', 'Accounting & scope', h('ul', {}, c.caveats.map((x) => h('li', {}, x)))) : null,
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
  if (!state.research) return h('p', { class: 'muted' }, 'Loading research…');
  const document = renderMarkdown(state.research);
  const index = h('div', { class: 'md research-index' });
  let section = disclosure('research-about', 'About this research');
  index.append(section);
  let number = 0;
  for (const node of [...document.childNodes]) {
    if (node.nodeName === 'H3') {
      section = disclosure(`research-${number++}`, node.textContent);
      index.append(section);
    } else {
      section.append(node);
    }
  }
  return [
    h('p', { class: 'lede' }, 'The evidence behind the model. Read one section at a time.'),
    h('div', { class: 'flow-strip' },
      h('div', {}, h('strong', {}, 'Usage'), 'Captured locally'),
      h('div', {}, h('strong', {}, 'Delivery'), 'Verify ownership'),
      h('div', {}, h('strong', {}, 'Return'), 'Needs cost & baseline'),
    ),
    index,
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
  surfaces: () => renderSurfaces(),
  intersection: () => renderSurfaces(true),
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
  if (view === 'research' && !state.research) {
    state.research = (await api('/api/research')).markdown;
    render();
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
  render();
  try {
    state.recipe = await api('/api/recipe/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.org.trim() ? { azureDevOpsOrg: state.org.trim() } : {}),
    });
  } finally {
    state.verifying = false;
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
