'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION_DIR = path.join(ROOT, '.github', 'extensions', 'ai-attribution');
const OUT = path.join(ROOT, 'docs', 'media');
const WORK = path.join(ROOT, '.canvas-shot-work');
const PORT = Number(process.env.CDP_PORT || 9334);
const NANO = 1_000_000_000;
const DAY = 86_400_000;

const SHOTS = [
  {
    file: 'canvas-outcomes.png',
    view: 'outcomes',
    w: 1280,
    h: 980,
    dsf: 1,
    ready: "document.body.innerText.includes('reported credits and PR references') && !document.body.innerText.includes('No local store')",
  },
  {
    file: 'canvas-coverage.png',
    view: 'coverage',
    w: 1280,
    h: 1800,
    dsf: 1,
    ready: "document.body.innerText.includes('Copilot CLI / app session store') && document.body.innerText.includes('VS Code agent-traces.db') && document.body.innerText.includes('Tool calls')",
  },
  {
    file: 'canvas-surfaces.png',
    view: 'surfaces',
    w: 1280,
    h: 900,
    dsf: 1,
    ready: "document.body.innerText.includes('What each surface emits') && document.querySelector('table.matrix')",
  },
  {
    file: 'canvas-model.png',
    view: 'model',
    w: 1280,
    h: 980,
    dsf: 1,
    ready: "document.body.innerText.includes('Canonical entities') && document.body.innerText.includes('Attribution tiers')",
  },
];

const requested = process.argv.slice(2);
for (const file of requested) {
  if (!SHOTS.some((shot) => shot.file === file)) throw new Error(`Unknown screenshot: ${file}`);
}
const shots = requested.length ? SHOTS.filter((shot) => requested.includes(shot.file)) : SHOTS;

function findBrowser() {
  if (process.env.BROWSER_PATH) return process.env.BROWSER_PATH;
  const candidates = {
    win32: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
  }[process.platform] || [];
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) throw new Error('No Chrome/Edge found. Set BROWSER_PATH to the executable.');
  return hit;
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function iso(now, daysAgo, hour = 10, minute = 0) {
  const base = new Date(now - daysAgo * DAY);
  base.setUTCHours(hour, minute, 0, 0);
  return base.toISOString();
}

function ms(now, daysAgo, hour = 10, minute = 0) {
  return Date.parse(iso(now, daysAgo, hour, minute));
}

function nano(credits) {
  return Math.round(credits * NANO);
}

function createSessionStore(file, now) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE session_refs (id INTEGER PRIMARY KEY, session_id TEXT, ref_type TEXT, ref_value TEXT, turn_index INTEGER, created_at TEXT);
    CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER, agent_id TEXT,
      model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
      reasoning_tokens INTEGER, total_nano_aiu INTEGER, initiator TEXT, reasoning_effort TEXT, created_at TEXT);
  `);

  const session = db.prepare(
    `INSERT INTO sessions (id, cwd, repository, host_type, branch, summary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  [
    ['cli-web-pr', 'https://github.com/contoso/web-app.git', 'feature/checkout', 'Checkout flow PR'],
    ['app-api-pr', 'contoso/api', 'fix/token-refresh', 'API auth fix'],
    ['cli-tools-issue', 'https://github.com/fabrikam/tools.git', 'main', 'Tooling issue triage'],
    ['cloud-web-repo', 'contoso/web-app', 'experiment/pricing', 'Repository-only exploration'],
    ['cli-unlinked', null, null, 'General coding Q&A'],
  ].forEach(([id, repo, branch, summary], i) => {
    session.run(id, '', repo, 'worktree', branch, summary, iso(now, 18 - i, 9), iso(now, 2 + i, 16));
  });

  const ref = db.prepare('INSERT INTO session_refs (session_id, ref_type, ref_value, turn_index, created_at) VALUES (?, ?, ?, ?, ?)');
  [
    ['cli-web-pr', 'pr', '128', 7],
    ['cli-web-pr', 'commit', 'a1b2c3d', 8],
    ['cli-web-pr', 'issue', '44', 9],
    ['app-api-pr', 'pr', '87', 5],
    ['app-api-pr', 'commit', 'd4e5f6a', 6],
    ['cli-tools-issue', 'issue', '19', 3],
    ['cli-tools-issue', 'commit', 'c0ffee1', 4],
  ].forEach(([sessionId, type, value, turn], i) => ref.run(sessionId, type, value, turn, iso(now, 12 - i, 12)));

  const usage = db.prepare(
    `INSERT INTO assistant_usage_events (session_id, turn_index, agent_id, model, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, reasoning_tokens, total_nano_aiu, initiator, reasoning_effort, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  [
    ['cli-web-pr', 1, null, 'claude-sonnet-4.5', 11800, 1280, 6200, 500, 900, 7.6, 'user', 'high', 27, 9],
    ['cli-web-pr', 2, 'sub-review', 'gpt-5-mini', 4200, 620, 1100, 90, 180, 1.4, 'sub-agent', 'low', 26, 15],
    ['cli-web-pr', 3, null, 'gpt-5', 8600, 910, 2500, 220, 640, 5.2, 'agent', 'medium', 20, 11],
    ['app-api-pr', 1, null, 'gpt-5', 9600, 1100, 3100, 350, 700, 6.1, 'agent', 'high', 17, 14],
    ['app-api-pr', 2, 'sub-tests', 'gpt-5-mini', 3800, 500, 800, 80, 140, 1.1, 'sub-agent', 'low', 16, 10],
    ['app-api-pr', 3, null, 'claude-sonnet-4.5', 7200, 760, 1900, 200, 420, 4.3, 'user', 'medium', 10, 16],
    ['cli-tools-issue', 1, null, 'claude-sonnet-4.5', 6800, 840, 1200, 160, 510, 3.9, 'user', 'xhigh', 13, 13],
    ['cli-tools-issue', 2, null, 'gpt-5-mini', 2600, 340, 400, 60, 90, 0.8, 'agent', 'low', 8, 9],
    ['cloud-web-repo', 1, null, 'gpt-5', 7400, 900, 2100, 190, 580, 4.8, 'agent', 'high', 7, 17],
    ['cloud-web-repo', 2, 'sub-docs', 'gpt-5-mini', 2200, 280, 450, 40, 70, 0.7, 'sub-agent', 'medium', 4, 12],
    ['cli-unlinked', 1, null, 'gpt-5-mini', 1800, 240, 0, 0, 30, 0.5, 'user', null, 3, 10],
    [null, 1, null, 'claude-sonnet-4.5', 1400, 180, 0, 0, 0, 0.4, 'user', 'medium', 2, 18],
  ].forEach((row) => {
    const [sessionId, turn, agent, model, input, output, cacheRead, cacheWrite, reasoning, credits, initiator, effort, day, hour] = row;
    usage.run(sessionId, turn, agent, model, input, output, cacheRead, cacheWrite, reasoning, nano(credits), initiator, effort, iso(now, day, hour));
  });
  db.close();
}

function createTracesStore(file, now) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE spans (span_id TEXT PRIMARY KEY, trace_id TEXT, parent_span_id TEXT, name TEXT, start_time_ms INTEGER,
      end_time_ms INTEGER, status_code INTEGER, operation_name TEXT, agent_name TEXT, conversation_id TEXT,
      request_model TEXT, response_model TEXT, input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
      reasoning_tokens INTEGER, tool_name TEXT, chat_session_id TEXT);
    CREATE TABLE span_attributes (span_id TEXT, key TEXT, value TEXT, PRIMARY KEY (span_id, key));
  `);
  const span = db.prepare(
    `INSERT INTO spans (span_id, trace_id, parent_span_id, name, start_time_ms, end_time_ms, status_code,
      operation_name, agent_name, conversation_id, request_model, response_model, input_tokens, output_tokens,
      cached_tokens, reasoning_tokens, tool_name, chat_session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const attr = db.prepare('INSERT INTO span_attributes VALUES (?, ?, ?)');

  function addSpan(id, trace, operation, at, fields = {}) {
    span.run(
      id,
      trace,
      fields.parent ?? null,
      fields.name ?? operation,
      at,
      at + (fields.duration ?? 900),
      fields.status ?? 0,
      operation,
      fields.agent ?? null,
      fields.conversation ?? null,
      fields.requestModel ?? null,
      fields.responseModel ?? null,
      fields.input ?? null,
      fields.output ?? null,
      fields.cached ?? null,
      fields.reasoning ?? null,
      fields.tool ?? null,
      fields.chatSession ?? null,
    );
  }
  function addAttr(spanId, key, value) {
    attr.run(spanId, key, String(value));
  }
  function addAgent(id, trace, at, repo, branch, fields = {}) {
    addSpan(id, trace, 'invoke_agent', at, {
      duration: 4000,
      agent: fields.agent ?? 'GitHub Copilot Chat',
      conversation: fields.conversation,
      chatSession: fields.chatSession,
    });
    addAttr(id, 'github.copilot.git.repository', repo);
    if (branch) addAttr(id, 'github.copilot.git.branch', branch);
    if (fields.commit) addAttr(id, 'github.copilot.git.commit_sha', fields.commit);
  }
  function addChat(id, trace, at, fields) {
    addSpan(id, trace, 'chat', at, {
      duration: fields.duration ?? 1200,
      agent: fields.agent,
      conversation: fields.conversation,
      requestModel: fields.requestModel,
      responseModel: fields.responseModel,
      input: fields.input,
      output: fields.output,
      cached: fields.cached,
      reasoning: fields.reasoning,
      chatSession: fields.chatSession,
    });
    if (fields.credits !== undefined) addAttr(id, 'copilot_chat.copilot_usage_nano_aiu', nano(fields.credits));
    if (fields.effort) addAttr(id, 'copilot_chat.request.options', JSON.stringify({ stream: true, reasoning: { effort: fields.effort } }));
    if (fields.parentSession) addAttr(id, 'copilot_chat.parent_chat_session_id', fields.parentSession);
  }
  function addTool(id, trace, at, tool, status) {
    addSpan(id, trace, 'execute_tool', at, { duration: 80, tool, status });
  }

  addAgent('agent-web', 'trace-web', ms(now, 6, 9), 'https://github.com/contoso/web-app.git', 'feature/checkout', {
    conversation: 'conv-web',
    chatSession: 'chat-web',
  });
  addChat('chat-web-1', 'trace-web', ms(now, 6, 9, 5), {
    agent: 'panel/editAgent',
    conversation: 'conv-web',
    chatSession: 'chat-web',
    responseModel: 'claude-sonnet-4.5',
    input: 12600,
    output: 1480,
    cached: 7200,
    reasoning: 880,
    credits: 8.2,
    effort: 'high',
  });
  addChat('chat-web-sub', 'trace-web-sub', ms(now, 5, 15), {
    agent: 'executionSubagentTool',
    responseModel: 'gpt-5-mini',
    input: 3900,
    output: 520,
    cached: 900,
    reasoning: 160,
    credits: 1.2,
    effort: 'low',
    parentSession: 'chat-web',
  });

  addAgent('agent-api', 'trace-api', ms(now, 4, 10), 'contoso/api', 'fix/token-refresh', {
    conversation: 'conv-api',
  });
  addChat('chat-api-1', 'trace-api', ms(now, 4, 10, 6), {
    agent: 'workspaceAgent',
    conversation: 'conv-api',
    requestModel: 'gpt-5',
    responseModel: 'gpt-5',
    input: 10300,
    output: 920,
    cached: 3300,
    reasoning: 720,
    credits: 5.7,
    effort: 'medium',
  });
  addChat('chat-api-2', 'trace-api', ms(now, 3, 13), {
    agent: 'terminalAgent',
    conversation: 'conv-api',
    responseModel: 'gpt-5-mini',
    input: 3600,
    output: 390,
    cached: 600,
    reasoning: 120,
    credits: 0.9,
    effort: 'low',
  });

  addAgent('agent-tools', 'trace-tools', ms(now, 2, 11), 'https://github.com/fabrikam/tools.git', 'main', {
    commit: 'c0ffee1',
  });
  addChat('chat-tools-1', 'trace-tools', ms(now, 2, 11, 5), {
    agent: 'GitHub Copilot Chat',
    conversation: 'conv-tools',
    responseModel: 'claude-sonnet-4.5',
    input: 7900,
    output: 780,
    cached: 1800,
    reasoning: 540,
    credits: 3.8,
    effort: 'xhigh',
  });

  addChat('chat-unlinked-1', 'trace-loose', ms(now, 1, 16), {
    agent: 'title',
    responseModel: 'gpt-5-mini',
    input: 1100,
    output: 130,
    cached: 0,
    reasoning: 20,
    credits: 0.2,
  });
  addChat('chat-uncredited', 'trace-loose-2', ms(now, 1, 17), {
    agent: 'copilotLanguageModelWrapper',
    responseModel: 'gpt-5-mini',
    input: 900,
    output: 110,
    cached: 0,
    reasoning: 0,
  });

  [
    ['tool-read-1', 'trace-web', 6, 9, 8, 'read_file', 1],
    ['tool-rg-1', 'trace-web', 6, 9, 9, 'rg', 1],
    ['tool-test-1', 'trace-api', 4, 10, 9, 'run_in_terminal', 2],
    ['tool-apply-1', 'trace-api', 3, 13, 5, 'apply_patch', 1],
    ['tool-rg-2', 'trace-tools', 2, 11, 8, 'rg', 1],
    ['tool-shell-1', 'trace-tools', 2, 11, 9, 'run_in_terminal', 0],
    ['tool-web-1', 'trace-loose', 1, 16, 4, 'read_file', 1],
  ].forEach(([id, trace, day, hour, minute, tool, status]) => addTool(id, trace, ms(now, day, hour, minute), tool, status));

  db.close();
}

function createFixtures(runDir, now) {
  const fixtureDir = path.join(runDir, 'fixtures');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const sessionStorePath = path.join(fixtureDir, 'session-store.db');
  const tracesDbPath = path.join(fixtureDir, 'agent-traces.db');
  createSessionStore(sessionStorePath, now);
  createTracesStore(tracesDbPath, now);
  return { sessionStorePath, tracesDbPath };
}

let nextId = 1;
const pending = new Map();

function send(ws, method, params, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDevTools() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return await res.json();
    } catch {
      await sleep(200);
    }
  }
  throw new Error('the browser never opened its DevTools endpoint');
}

async function evaluate(ws, sessionId, expression) {
  const result = await send(
    ws,
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
  }
  return result.result?.value;
}

async function waitForRender(ws, sessionId, ready) {
  const expression = `(() => {
    if (document.readyState !== 'complete') return false;
    const text = document.body.innerText || '';
    if (/Loading…|Failed to load|Could not render|Coverage failed/.test(text)) return false;
    return Boolean(${ready});
  })()`;
  for (let i = 0; i < 80; i++) {
    if (await evaluate(ws, sessionId, expression).catch(() => false)) return;
    await sleep(250);
  }
  const text = await evaluate(ws, sessionId, '(document.body.innerText || "").slice(0, 600)').catch(() => '');
  throw new Error(`canvas did not finish rendering; saw: ${text}`);
}

async function startServer(paths, now) {
  const [{ startCanvasServer }, { computeCoverage }, { loadModel, loadResearch }] = await Promise.all([
    import(pathToFileURL(path.join(EXTENSION_DIR, 'lib', 'server.mjs')).href),
    import(pathToFileURL(path.join(EXTENSION_DIR, 'lib', 'coverage.mjs')).href),
    import(pathToFileURL(path.join(EXTENSION_DIR, 'lib', 'model.mjs')).href),
  ]);
  let view = 'outcomes';
  let windowDays = 30;
  let cachedCoverage;
  const displayCoverage = (coverage) => ({
    ...coverage,
    sources: coverage.sources.map((source) => ({
      ...source,
      path: source.id === 'sessionStore' ? 'synthetic\\session-store.db' : 'synthetic\\agent-traces.db',
    })),
  });
  const options = () => ({ windowDays, now, ...paths });
  return startCanvasServer({
    uiDir: path.join(EXTENSION_DIR, 'ui'),
    api: {
      model: () => loadModel(),
      research: () => loadResearch(),
      coverage: async () => {
        cachedCoverage ??= await computeCoverage(options());
        return displayCoverage(cachedCoverage);
      },
      refresh: async (days) => {
        windowDays = Number.isFinite(Number(days)) ? Math.max(0, Math.min(365, Math.floor(Number(days)))) : windowDays;
        cachedCoverage = await computeCoverage(options());
        return displayCoverage(cachedCoverage);
      },
      getView: () => view,
      setView: (next) => {
        if (SHOTS.some((shot) => shot.view === next) || ['gaps', 'research'].includes(next)) view = next;
        return view;
      },
      windowDays: () => windowDays,
    },
  });
}

async function setServerView(serverUrl, view) {
  const res = await fetch(new URL('/api/view', serverUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ view }),
  });
  if (!res.ok) throw new Error(`Could not set view ${view}: ${res.status}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(WORK, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(WORK, 'run-'));
  const profile = fs.mkdtempSync(path.join(runDir, 'profile-'));
  const now = Date.now();
  let browser;
  let ws;
  let server;
  try {
    const fixtures = createFixtures(runDir, now);
    server = await startServer(fixtures, now);
    browser = spawn(
      findBrowser(),
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-color-profile=srgb',
        '--no-first-run',
        '--disable-extensions',
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${profile}`,
        'about:blank',
      ],
      { stdio: 'ignore' },
    );

    const version = await waitForDevTools();
    ws = new WebSocket(version.webSocketDebuggerUrl);
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (!msg.id || !pending.has(msg.id)) return;
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

    const { targetId } = await send(ws, 'Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send(ws, 'Target.attachToTarget', { targetId, flatten: true });
    await send(ws, 'Page.enable', {}, sessionId);
    await send(ws, 'Runtime.enable', {}, sessionId);

    for (const shot of shots) {
      await setServerView(server.url, shot.view);
      await send(
        ws,
        'Emulation.setDeviceMetricsOverride',
        { width: shot.w, height: shot.h, deviceScaleFactor: shot.dsf, mobile: false },
        sessionId,
      );
      await send(ws, 'Page.navigate', { url: server.url }, sessionId);
      await waitForRender(ws, sessionId, shot.ready);
      await evaluate(ws, sessionId, 'window.scrollTo(0, 0)');
      const { data } = await send(ws, 'Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId);
      const buf = Buffer.from(data, 'base64');
      const out = path.join(OUT, shot.file);
      fs.writeFileSync(out, buf);
      console.log(`${rel(out)}  ${shot.w * shot.dsf}x${shot.h * shot.dsf}  ${(buf.length / 1024).toFixed(1)} kB`);
    }
  } finally {
    if (ws) {
      await send(ws, 'Browser.close').catch(() => {});
      ws.close();
    }
    if (browser) browser.kill();
    if (server) await server.close().catch(() => {});
    await sleep(500);
    fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    try {
      fs.rmdirSync(WORK);
    } catch {
      /* another run or leftover file owns the work directory */
    }
  }
})().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});
