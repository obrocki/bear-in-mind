// Extension: ai-attribution
// Canvas for Data and Attribution Model: how Copilot surfaces'
// telemetry connects AI usage to work and outcomes, plus live, read-only
// attribution coverage from local stores. Research lives in docs/research/.

import path from 'node:path';
import { joinSession, createCanvas, CanvasError } from '@github/copilot-sdk/extension';
import { computeCoverage } from './lib/coverage.mjs';
import { EXTENSION_DIR, MODEL_SECTIONS, loadModel, loadResearch } from './lib/model.mjs';
import { startCanvasServer } from './lib/server.mjs';

const VIEWS = ['outcomes', 'surfaces', 'model', 'gaps', 'coverage', 'research'];
const DEFAULT_WINDOW_DAYS = 30;
const UI_DIR = path.join(EXTENSION_DIR, 'ui');

// Per panel: server, selected view and coverage options. Coverage is derived
// from local stores on demand, so an in-memory cache is enough.
const instances = new Map();
const coverageCache = new Map();

function coverageKey(options) {
  return JSON.stringify([options.windowDays, options.sessionStorePath ?? '', options.tracesDbPath ?? '']);
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
        `${s.id === 'traces' ? 'VS Code' : 'CLI/app'} ${pct(s.metrics.creditsToRepoShare)}% repo` +
        (s.metrics.creditsToActorShare != null ? `, ${pct(s.metrics.creditsToActorShare)}% user` : ''),
    );
  return [window, ...parts].join(' · ');
}

function instanceFor(ctx) {
  const instance = instances.get(ctx.instanceId);
  if (!instance) throw new CanvasError('not_open', `Canvas instance ${ctx.instanceId} is not open.`);
  return instance;
}

async function openInstance(ctx) {
  const input = ctx.input ?? {};
  let instance = instances.get(ctx.instanceId);
  if (!instance) {
    instance = {
      view: 'outcomes',
      options: { windowDays: DEFAULT_WINDOW_DAYS },
    };
    instance.server = await startCanvasServer({
      uiDir: UI_DIR,
      api: {
        model: () => loadModel(),
        research: () => loadResearch(),
        coverage: () => coverageFor(instance.options),
        refresh: async (days) => {
          instance.options = { ...instance.options, windowDays: clampWindow(days) };
          const coverage = await coverageFor(instance.options, { refresh: true });
          instance.server.broadcast('coverage', { generatedAt: coverage.generatedAt });
          return coverage;
        },
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
        },
      },
      actions: [
        {
          name: 'show_view',
          description: 'Switch the canvas to a tab: outcomes, surfaces, model, gaps, coverage or research.',
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
          handler: async (ctx) => coverageFor(instanceFor(ctx).options),
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
