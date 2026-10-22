// Extension: ai-attribution
// Canvas for Data and Attribution Model: how Copilot surfaces'
// telemetry connects AI usage to work and outcomes, plus live, read-only
// attribution coverage from local stores. Research lives in docs/research/.

import path from 'node:path';
import { joinSession, createCanvas, CanvasError } from '@github/copilot-sdk/extension';
import { computeCoverage, withoutRecipe } from './lib/coverage.mjs';
import { EXTENSION_DIR, MODEL_SECTIONS, loadModel, loadResearch } from './lib/model.mjs';
import { recipeView } from './lib/recipe.mjs';
import { startCanvasServer } from './lib/server.mjs';
import { verifyRecipe } from './lib/verify.mjs';
import { validateIdentityLinks } from './lib/actors.mjs';
import { fetchBilling, billingView } from './lib/billing.mjs';
import { sourceLabels as SOURCE_NAMES } from './ui/format.mjs';

const VIEWS = ['outcomes', 'recipe', 'surfaces', 'intersection', 'model', 'gaps', 'coverage', 'research'];
const DEFAULT_WINDOW_DAYS = 30;
const UI_DIR = path.join(EXTENSION_DIR, 'ui');

// Per panel: server, selected view and coverage options. Coverage is derived
// from local stores on demand, so an in-memory cache is enough.
const instances = new Map();
const coverageCache = new Map();

function coverageKey(options) {
  return JSON.stringify([
    options.windowDays,
    options.sessionStorePath ?? '',
    options.tracesDbPath ?? '',
    options.agentHostTracesDbPath ?? '',
  ]);
}

async function coverageFor(options, { refresh = false } = {}) {
  const key = coverageKey(options);
  if (refresh || !coverageCache.has(key)) {
    coverageCache.set(key, await computeCoverage(options));
  }
  return coverageCache.get(key);
}

function clampWindow(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_WINDOW_DAYS;
  return Math.min(Math.floor(n), 365);
}

function summarize(coverage) {
  return {
    generatedAt: coverage.generatedAt,
    window: coverage.window,
    sources: coverage.sources.map((s) => ({
      id: s.id,
      label: s.label,
      status: s.status,
      reason: s.reason,
      totals: s.totals,
      metrics: s.metrics,
      tokenCoverage: s.tokenCoverage,
      metricCoverage: s.metricCoverage,
      funnel: s.funnel?.map(({ id, sessions, calls, credits, emitted }) => ({ id, sessions, calls, credits, emitted })),
    })),
    caveats: coverage.caveats,
  };
}


function statusLine(coverage) {
  const window = coverage.window.days ? `${coverage.window.days}-day window` : 'All history';
  const pct = (share) => Math.round(share * 100);
  const parts = coverage.sources
    .filter((s) => s.status === 'ok' && s.metrics.creditsToRepoShare !== null)
    .map(
      (s) =>
        `${SOURCE_NAMES[s.id] ?? s.label} ${pct(s.metrics.creditsToRepoShare)}% repo` +
        (s.metrics.creditsToActorShare != null ? `, ${pct(s.metrics.creditsToActorShare)}% user` : ''),
    );
  return [window, ...parts].join(' · ');
}

function instanceFor(ctx) {
  const instance = instances.get(ctx.instanceId);
  if (!instance) throw new CanvasError('not_open', `Canvas instance ${ctx.instanceId} is not open.`);
  return instance;
}

async function recipeFor(instance) {
  const recipe = (await coverageFor(instance.options)).recipe;
  return {
    ...recipeView(recipe, instance.verification, { identityLinks: instance.identityLinks }),
    billing: billingView(instance.billing, recipe),
  };
}

async function readBilling(instance, scope) {
  if (instance.readingBilling) throw new CanvasError('busy', 'A billing request is already running.');
  instance.readingBilling = true;
  instance.billing = null;
  try {
    instance.billing = await fetchBilling(scope);
    instance.server.broadcast('recipe', {});
    return recipeFor(instance);
  } finally {
    instance.readingBilling = false;
  }
}

async function setIdentityLinks(instance, links) {
  instance.identityLinks = validateIdentityLinks(links);
  instance.server.broadcast('recipe', {});
  return recipeFor(instance);
}

/** Explicit network step: asks GitHub and Azure Boards about the cycles already found locally. */
async function verifyInstance(instance, organization) {
  if (organization !== undefined) instance.options = { ...instance.options, azureDevOpsOrg: organization || undefined };
  instance.verifying ??= (async () => {
    try {
      const coverage = await coverageFor(instance.options);
      instance.verification = await verifyRecipe(coverage.recipe, { organization: instance.options.azureDevOpsOrg });
      instance.server.broadcast('recipe', { at: instance.verification.at });
    } finally {
      instance.verifying = null;
    }
  })();
  await instance.verifying;
  return recipeFor(instance);
}

function summarizeRecipe(view, filter = {}) {
  const developerSources = view.developers.sources
    .filter((source) => !filter.sourceId || source.id === filter.sourceId)
    .map((source) => {
      const owned = filter.perspective === 'ownership';
      const selected = filter.actorKey === '__unknown' ? source[owned ? 'unowned' : 'unknown'] :
        filter.actorKey ? source.actors.find((actor) => actor.key === filter.actorKey)?.[owned ? 'ownership' : 'usage'] :
          owned ? source.ownership : source;
      return { id: source.id, summary: selected ? {
        total: selected.total, measured: selected.measured, inferred: selected.inferred, unattributed: selected.unattributed,
        work: selected.work.map((row) => {
          const cycle = view.cycles.find((c) => c.key === row.cycleKey);
          return { ...row, repository: cycle?.repository ?? null, branch: cycle?.branch ?? null,
            workItems: cycle?.workItems.map((w) => w.reference) ?? [], pullRequest: cycle?.pullRequest?.number ?? null };
        }),
      } : null };
    });
  return {
    billing: view.billing,
    developers: { actors: view.developers.actors, identityLinks: view.developers.identityLinks, sources: developerSources, perspective: filter.perspective ?? 'usage' },
    verification: view.verification,
    totals: view.totals,
    stations: view.stations.map(({ id, any, strict, unknown }) => ({ id, any, strict, unknown })),
    kpis: view.kpis,
    adherence: view.adherence,
    cycles: view.cycles.slice(0, 10).map((c) => ({
      repository: c.repository,
      branch: c.branch,
      workItems: c.workItems.map((w) => w.reference),
      ownership: c.ownership,
      pullRequest: c.pullRequest?.number ?? null,
      reached: c.reached,
      steps: Object.fromEntries(Object.entries(c.steps).map(([id, s]) => [id, s.state])),
    })),
  };
}

async function openInstance(ctx) {
  const input = ctx.input ?? {};
  let instance = instances.get(ctx.instanceId);
  if (!instance) {
    instance = {
      view: 'outcomes',
      options: { windowDays: DEFAULT_WINDOW_DAYS },
      verification: null,
      verifying: null,
      identityLinks: [],
      billing: null,
      readingBilling: false,
    };
    instance.server = await startCanvasServer({
      uiDir: UI_DIR,
      api: {
        model: () => loadModel(),
        research: () => loadResearch(),
        coverage: async () => withoutRecipe(await coverageFor(instance.options)),
        refresh: async (days) => {
          instance.options = { ...instance.options, windowDays: clampWindow(days) };
          const coverage = await coverageFor(instance.options, { refresh: true });
          instance.server.broadcast('coverage', { generatedAt: coverage.generatedAt });
          return withoutRecipe(coverage);
        },
        recipe: () => recipeFor(instance),
        verify: ({ azureDevOpsOrg } = {}) => verifyInstance(instance, azureDevOpsOrg),
        identityLinks: (links) => setIdentityLinks(instance, links),
        billing: (scope) => readBilling(instance, scope),
        getView: () => instance.view,
        setView: (view) => {
          if (VIEWS.includes(view)) instance.view = view;
          return instance.view;
        },
        windowDays: () => instance.options.windowDays,
      },
    });
    instances.set(ctx.instanceId, instance);
  }

  if (input.view) instance.view = input.view;
  const options = { ...instance.options };
  if (input.windowDays !== undefined) options.windowDays = clampWindow(input.windowDays);
  if (input.sessionStorePath !== undefined) options.sessionStorePath = input.sessionStorePath || undefined;
  if (input.tracesDbPath !== undefined) options.tracesDbPath = input.tracesDbPath || undefined;
  if (input.agentHostTracesDbPath !== undefined) options.agentHostTracesDbPath = input.agentHostTracesDbPath || undefined;
  if (input.azureDevOpsOrg !== undefined) options.azureDevOpsOrg = input.azureDevOpsOrg || undefined;
  if (input.identityLinks !== undefined) instance.identityLinks = validateIdentityLinks(input.identityLinks);
  instance.options = options;

  // Every open recomputes, so a reopened panel never shows a stale snapshot;
  // the UI's follow-up GET reuses this fresh result.
  const coverage = await coverageFor(instance.options, { refresh: true });
  instance.server.broadcast('view', { view: instance.view });
  instance.server.broadcast('coverage', { generatedAt: coverage.generatedAt });

  return {
    title: 'AI attribution',
    status: statusLine(coverage),
    url: instance.server.url,
  };
}

await joinSession({
  canvases: [
    createCanvas({
      id: 'ai-attribution',
      displayName: 'AI attribution',
      description:
        'Research canvas connecting Copilot AI usage (VS Code, CLI, app, cloud agent) to work and outcomes, with live read-only attribution coverage from local stores.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          view: { type: 'string', enum: VIEWS, description: 'Tab to show.' },
          windowDays: {
            type: 'integer',
            minimum: 0,
            maximum: 365,
            description: 'Coverage window in days; 0 = all retained history.',
          },
          sessionStorePath: { type: 'string', description: 'Override for the Copilot CLI / app session-store.db.' },
          tracesDbPath: { type: 'string', description: "Override for VS Code's agent-traces.db." },
          agentHostTracesDbPath: {
            type: 'string',
            description: "Override for VS Code's Copilot Agent Host harness agent-host-traces.db.",
          },
          azureDevOpsOrg: {
            type: 'string',
            description:
              'Azure DevOps organization for Recipe verification (name, https://dev.azure.com/<org> or https://<org>.visualstudio.com). Defaults to az devops configure.',
          },
          identityLinks: {
            type: 'array', maxItems: 32,
            description: 'Explicit Azure Boards account-key to GitHub-login links. No display-name matching.',
            items: {
              type: 'object', additionalProperties: false, required: ['boardsKey', 'githubLogin'],
              properties: { boardsKey: { type: 'string' }, githubLogin: { type: 'string' } },
            },
          },
        },
      },
      actions: [
        {
          name: 'show_view',
          description: 'Switch the canvas to outcomes, recipe, surfaces, intersection, model, gaps, coverage or research.',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['view'],
            properties: { view: { type: 'string', enum: VIEWS } },
          },
          handler: async (ctx) => {
            const instance = instanceFor(ctx);
            instance.view = ctx.input.view;
            instance.server.broadcast('view', { view: instance.view });
            return { view: instance.view };
          },
        },
        {
          name: 'refresh_coverage',
          description: 'Recompute live attribution coverage from local stores and return a summary.',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: { windowDays: { type: 'integer', minimum: 0, maximum: 365 } },
          },
          handler: async (ctx) => {
            const instance = instanceFor(ctx);
            if (ctx.input?.windowDays !== undefined) {
              instance.options = { ...instance.options, windowDays: clampWindow(ctx.input.windowDays) };
            }
            const coverage = await coverageFor(instance.options, { refresh: true });
            instance.server.broadcast('coverage', { generatedAt: coverage.generatedAt });
            return summarize(coverage);
          },
        },
        {
          name: 'get_coverage',
          description: 'Return the full live coverage (funnels, breakdowns, freshness) currently shown.',
          inputSchema: { type: 'object', additionalProperties: false, properties: {} },
          handler: async (ctx) => withoutRecipe(await coverageFor(instanceFor(ctx).options)),
        },
        {
          name: 'reconcile_recipe_billing',
          description: 'Explicitly read one completed UTC day of GitHub Copilot AI-credit billing for a user and paying account. Compare native captured consumption per source; work amounts are estimated allocations, never PR invoices.',
          inputSchema: {
            type: 'object', additionalProperties: false, required: ['level', 'account', 'user', 'day'],
            properties: {
              level: { type: 'string', enum: ['organization', 'enterprise', 'user'] },
              account: { type: 'string' }, user: { type: 'string' },
              day: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            },
          },
          handler: async (ctx) => summarizeRecipe(await readBilling(instanceFor(ctx), ctx.input)),
        },
        {
          name: 'get_recipe',
          description: 'Return Recipe and developer credit attribution. Filter by actorKey/sourceId; usage separates measured from inferred, ownership shows all contributors to owned work.',
          inputSchema: { type: 'object', additionalProperties: false, properties: {
            actorKey: { type: 'string' }, sourceId: { type: 'string', enum: ['sessionStore', 'traces', 'agentHost'] },
            perspective: { type: 'string', enum: ['usage', 'ownership'] },
          } },
          handler: async (ctx) => summarizeRecipe(await recipeFor(instanceFor(ctx)), ctx.input ?? {}),
        },
        {
          name: 'set_recipe_identity_links',
          description: 'Set explicit Azure Boards account-key to GitHub-login links for this panel. Never infer them from names or emails.',
          inputSchema: { type: 'object', additionalProperties: false, required: ['links'], properties: {
            links: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, required: ['boardsKey', 'githubLogin'],
              properties: { boardsKey: { type: 'string' }, githubLogin: { type: 'string' } } } },
          } },
          handler: async (ctx) => summarizeRecipe(await setIdentityLinks(instanceFor(ctx), ctx.input.links)),
        },
        {
          name: 'verify_recipe',
          description:
            'Verify Recipe cycles with GitHub (gh CLI) and Azure Boards (az CLI token or AZURE_DEVOPS_EXT_PAT): PR, reviews, merge and work-item closure. Sends only recorded identifiers; never titles, descriptions or commit messages.',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: { azureDevOpsOrg: { type: 'string' } },
          },
          handler: async (ctx) => summarizeRecipe(await verifyInstance(instanceFor(ctx), ctx.input?.azureDevOpsOrg)),
        },
        {
          name: 'get_model',
          description: 'Return the attribution model spec, or one section of it.',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: { section: { type: 'string', enum: MODEL_SECTIONS } },
          },
          handler: async (ctx) => {
            instanceFor(ctx);
            const model = await loadModel();
            const section = ctx.input?.section;
            return section ? { [section]: model[section] } : model;
          },
        },
      ],
      open: openInstance,
      onClose: async (ctx) => {
        const instance = instances.get(ctx.instanceId);
        if (instance) {
          instances.delete(ctx.instanceId);
          await instance.server.close();
        }
      },
    }),
  ],
});
