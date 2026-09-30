import { h } from './dom.js';
import { renderMarkdown } from './markdown.js';

const VIEWS = [
  { id: 'outcomes', label: 'Outcomes' },
  { id: 'surfaces', label: 'Surfaces' },
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
  local: 'Available locally',
  'needs-vcs-join': 'Needs VCS join',
  'needs-org-api': 'Needs org API',
  'needs-baseline': 'Needs value & baseline',
};
const SOURCE_SHORT = { sessionStore: 'CLI / app', traces: 'VS Code' };

const state = { view: 'outcomes', model: null, coverage: null, research: null, group: 'all', busy: false };
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
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

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

// --------------------------------------------------------------- views ---

function renderOutcomes() {
  const m = state.model;
  const sources = okSources();
  const live = m.outcomes.filter((o) => o.liveMetric);
  return [
    h('p', { class: 'lede' }, m.summary),
    h('h2', {}, 'Measured locally · ROI readiness, not return'),
    sources.length
      ? h(
          'div',
          { class: 'grid kpis' },
          live.map((o) =>
            h(
              'div',
              { class: 'card kpi' },
              h('div', { class: 'label' }, o.name),
              h(
                'div',
                { class: 'values' },
                sources.map((s) =>
                  h(
                    'div',
                    { class: 'value' },
                    pct(s.metrics[o.liveMetric]),
                    h('span', { class: 'who' }, SOURCE_SHORT[s.id] ?? s.label),
                  ),
                ),
              ),
              h('p', { class: 'muted small' }, o.measure),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'No local store could be read. See Live coverage for details.'),
    sources.length
      ? h(
          'div',
          { class: 'grid two' },
          sources.map((s) => {
            const pr = s.funnel.find((f) => f.id === 'pullRequest');
            return h(
              'div',
              { class: 'card' },
              h('h3', {}, `${SOURCE_SHORT[s.id] ?? s.label} · reported credits and PR references`),
              h(
                'p',
                {},
                pr?.emitted && s.totals.creditedCalls
                  ? `${fmtCredits.format(pr.credits)} credits in sessions reaching repository + branch + PR reference; ${fmtCredits.format(s.totals.credits - pr.credits)} credits without one.`
                  : 'PR-reference credit split unavailable.',
              ),
              h('p', { class: 'muted small' }, 'Only calls reporting credits contribute. A reference does not establish a merged PR or delivered value. Sources are not added together.'),
            );
          }),
        )
      : null,
    sources.length
      ? h(
          'div',
          { class: 'grid two', style: { marginTop: '12px' } },
          sources.map((s) =>
            h(
              'div',
              { class: 'card' },
              h(
                'h3',
                {},
                `${SOURCE_SHORT[s.id] ?? s.label} · ${creditWeighted(s) ? 'credits' : 'model calls'} reaching each stage`,
              ),
              funnel(s),
            ),
          ),
        )
      : null,
    h(
      'div',
      { class: 'callout' },
      h('strong', {}, 'Next step: '),
      'join repository/branch or commit to verified PR and quality outcomes, reconcile billed costs and human oversight, and compare with a matched non-AI baseline before estimating incremental return.',
    ),
    h('h2', {}, 'Measurements needed for ROI'),
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Outcome'), h('th', {}, 'Measure'), h('th', {}, 'Status'))),
      h(
        'tbody',
        {},
        m.outcomes.map((o) =>
          h(
            'tr',
            {},
            h('td', {}, h('strong', {}, o.name)),
            h('td', {}, o.measure),
            h('td', {}, badge(o.availability, AVAILABILITY_TEXT[o.availability] ?? o.availability)),
          ),
        ),
      ),
    ),
  ];
}

function renderSurfaces() {
  const m = state.model;
  const groups = [{ id: 'all', label: 'All' }, ...m.groups];
  const concepts = m.concepts.filter((c) => state.group === 'all' || c.group === state.group);
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
            h('strong', {}, c.name),
            h('span', { class: 'mono', title: 'Canonical field' }, c.canonical),
            h('span', { class: 'mono', title: 'OTel semantic convention' }, `OTel: ${c.otel}`),
            c.note ? h('span', { class: 'small muted' }, c.note) : null,
          ),
          m.surfaces.map((s) => {
            const cell = c.surfaces[s.id];
            return h(
              'td',
              { class: 'cell', title: cell.note ?? '' },
              badge(cell.availability, m.availabilityLevels.find((l) => l.id === cell.availability)?.label),
              h('span', { class: 'mono' }, cell.field),
              cell.note ? h('span', { class: 'note' }, cell.note) : null,
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
      'What each surface emits for ROI inputs. The common spine is the OTel GenAI span tree, a session ID, repository/branch/commit and per-call model and tokens; verified outcomes, billed cost, human effort and a baseline still need to be joined.',
    ),
    h(
      'div',
      { class: 'legend' },
      m.availabilityLevels.map((l) =>
        h(
          'span',
          { title: l.description },
          badge(l.id, l.label),
          ' ',
          h('span', { class: 'small muted' }, l.description),
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
              h('th', { title: s.collection }, s.name, h('div', { class: 'small muted' }, s.detail)),
            ),
          ),
        ),
        h('tbody', {}, rows),
      ),
    ),
  ];
}

function renderModel() {
  const m = state.model;
  return [
    h(
      'p',
      { class: 'lede' },
      'Canonical entities connecting consumption to work to verified outcomes. Attribution weights and the unattributed remainder make coverage visible; neither a work link nor a reported credit is a return.',
    ),
    h(
      'div',
      { class: 'grid cards' },
      m.entities.map((e) =>
        h(
          'div',
          { class: 'card entity' },
          h('h3', {}, e.name),
          h('p', { class: 'muted small' }, `Grain: ${e.grain}`),
          h(
            'ul',
            {},
            e.fields.map((f) => h('li', {}, f)),
          ),
        ),
      ),
    ),
    h('h2', {}, 'Relationships'),
    h(
      'ul',
      { class: 'relations' },
      m.relationships.map((r) =>
        h('li', {}, h('code', {}, r.from), h('span', { class: 'arrow' }, `— ${r.label} →`), h('code', {}, r.to)),
      ),
    ),
    h('h2', {}, 'Attribution tiers'),
    h(
      'table',
      {},
      h(
        'thead',
        {},
        h('tr', {}, h('th', {}, 'Tier'), h('th', {}, 'Method'), h('th', {}, 'Example'), h('th', {}, 'Confidence')),
      ),
      h(
        'tbody',
        {},
        m.tiers.map((t) =>
          h(
            'tr',
            {},
            h('td', {}, h('strong', {}, `${t.id} ${t.name}`)),
            h('td', {}, t.method),
            h('td', {}, t.example),
            h('td', {}, badge(`conf-${t.confidence.replace(/[^a-z]/g, '')}`, t.confidence)),
          ),
        ),
      ),
    ),
    h('h2', {}, 'Accounting invariants'),
    h(
      'ol',
      {},
      m.invariants.map((i) => h('li', {}, i)),
    ),
  ];
}

function renderGaps() {
  const m = state.model;
  const order = { high: 0, medium: 1, low: 2 };
  const gaps = [...m.gaps].sort((a, b) => order[a.severity] - order[b.severity]);
  return [
    h('p', { class: 'lede' }, 'Where the join breaks today, why it matters, and how to close it.'),
    h(
      'div',
      { class: 'grid cards' },
      gaps.map((g) =>
        h(
          'div',
          { class: 'card gap' },
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
    h('h2', {}, 'Verification status'),
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
    h('h2', {}, 'Prior art'),
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
  ];
}

/** Credit-weighted only when some credits are positive; otherwise the funnel is labelled call-weighted. */
function creditWeighted(source) {
  return source.funnel[0].credits > 0;
}

function funnel(source) {
  const top = source.funnel[0];
  const byCredits = creditWeighted(source);
  return h(
    'div',
    { class: 'funnel' },
    source.funnel.map((f) => {
      const ratio = byCredits ? f.credits / top.credits : top.calls ? f.calls / top.calls : 0;
      return h(
        'div',
        { class: `row${f.emitted ? '' : ' not-emitted'}` },
        h('span', { class: 'label' }, f.label),
        h(
          'div',
          { class: 'bar', title: pct(ratio) },
          h('div', { class: 'fill', style: { width: `${Math.max(0, Math.min(1, ratio)) * 100}%` } }),
        ),
        h(
          'span',
          { class: 'stats' },
          f.emitted
            ? `${pct(ratio)} · ${fmtCredits.format(f.credits)} cr · ${fmtInt.format(f.calls)} calls · ${fmtInt.format(f.sessions)} sess`
            : 'Not emitted',
        ),
      );
    }),
  );
}

function breakdownTable(title, rows) {
  if (!rows?.length) return null;
  return h(
    'div',
    {},
    h('h3', {}, title),
    h(
      'table',
      {},
      h(
        'thead',
        {},
        h('tr', {}, h('th', {}, 'Key'), h('th', { class: 'num' }, 'Calls'), h('th', { class: 'num' }, 'Credits')),
      ),
      h(
        'tbody',
        {},
        rows.map((r) =>
          h(
            'tr',
            {},
            h('td', {}, r.key),
            h('td', { class: 'num' }, fmtInt.format(r.calls)),
            h('td', { class: 'num' }, fmtCredits.format(r.credits)),
          ),
        ),
      ),
    ),
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
    h('h2', {}, s.label, ' ', badge(s.status)),
    h(
      'p',
      { class: 'muted small' },
      `Surfaces: ${s.surfaces.map(surfaceName).join(', ')} · `,
      h('span', { class: 'mono', title: s.path ?? '' }, shortPath(s.path)),
    ),
  );
  if (s.status !== 'ok') return h('section', { class: 'card' }, head, h('p', {}, s.reason ?? 'Unavailable.'));
  const t = s.totals;
  const b = s.breakdowns;
  return h(
    'section',
    { class: 'card' },
    head,
    h(
      'p',
      { class: 'muted small' },
      `Observed ${s.freshness.first?.slice(0, 16).replace('T', ' ') ?? '—'} → ${s.freshness.last?.slice(0, 16).replace('T', ' ') ?? '—'} UTC`,
    ),
    h(
      'div',
      { class: 'grid kpis' },
      [
        ['Model calls', fmtInt.format(t.calls)],
        ['Credits (nano-AIU / 1e9)', fmtCredits.format(t.credits)],
        ['Calls reporting credits', pct(s.metrics.creditCoverage)],
        ['Sessions', fmtInt.format(t.sessions)],
        ['Input / output tokens', `${compact.format(t.inputTokens)} / ${compact.format(t.outputTokens)}`],
        ['Cache-read ratio', pct(s.metrics.cacheReadRatio)],
        s.metrics.subAgentShare !== null ? ['Sub-agent credit share', pct(s.metrics.subAgentShare)] : null,
      ]
        .filter(Boolean)
        .map(([label, value]) =>
          h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value)),
        ),
    ),
    sparkline(s.daily),
    h(
      'h3',
      {},
      creditWeighted(s)
        ? 'Attribution funnel (credit-weighted)'
        : 'Attribution funnel (call-weighted: no positive credits)',
    ),
    funnel(s),
    h(
      'div',
      { class: 'grid two' },
      breakdownTable('By model', b.model),
      breakdownTable(b.agent ? 'By agent' : 'By initiator', b.agent ?? b.initiator),
      breakdownTable('By reasoning effort', b.reasoningEffort),
      breakdownTable('By repository', b.repository),
      b.link ? breakdownTable('By repository link method', b.link) : null,
      s.tools?.length
        ? h(
            'div',
            {},
            h('h3', {}, 'Tool calls'),
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
    s.notes?.length
      ? h(
          'ul',
          { class: 'small muted' },
          s.notes.map((n) => h('li', {}, n)),
        )
      : null,
  );
}

function renderCoverage() {
  const c = state.coverage;
  const select = h(
    'select',
    {
      'aria-label': 'Window',
      'data-focus-key': 'window',
      onchange: (e) => refresh(Number(e.target.value)),
    },
    WINDOWS.map((w) => h('option', { value: w.days, selected: c?.window.days === w.days }, w.label)),
  );
  return [
    h(
      'p',
      { class: 'lede' },
      "Read-only coverage from this machine's local stores. Aggregates only: no prompts, responses or tool content are read. Sources are never summed.",
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
    c
      ? h(
          'ul',
          { class: 'small muted' },
          c.caveats.map((x) => h('li', {}, x)),
        )
      : null,
    c
      ? h('div', { class: 'grid', style: { gap: '16px' } }, c.sources.map(sourceCard))
      : h('p', { class: 'muted' }, 'Loading coverage…'),
  ];
}

function renderResearch() {
  if (!state.research) return h('p', { class: 'muted' }, 'Loading research…');
  return [
    renderMarkdown(state.research),
    h('h2', {}, 'Sources'),
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
  ];
}

const RENDERERS = {
  outcomes: renderOutcomes,
  surfaces: renderSurfaces,
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
}

async function loadCoverage() {
  state.coverage = await api('/api/coverage');
  render();
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
}

async function start() {
  renderTabs();
  state.model = await api('/api/model');
  document.getElementById('question').textContent = state.model.question;
  document.getElementById('workstream').textContent = state.model.workstream;
  document.getElementById('title').textContent = state.model.title;
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
}

start().catch((err) => main.replaceChildren(h('p', {}, `Failed to load: ${err.message}`)));
