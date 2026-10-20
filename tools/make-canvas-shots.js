'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION_DIR = path.join(ROOT, '.github', 'extensions', 'ai-attribution');
const OUT = path.join(ROOT, 'docs', 'media');
const WORK = path.join(ROOT, '.canvas-shot-work');
const PORT = Number(process.env.CDP_PORT || 0);
const NANO = 1_000_000_000;
const DAY = 86_400_000;

const SHOTS = [
  {
    file: 'canvas-outcomes.png',
    view: 'outcomes',
    w: 1280,
    h: 980,
    dsf: 1,
    ready: "document.querySelector('.outcome-kpis .ratio-bar') && document.body.innerText.includes('Credits with a PR reference')",
  },
  {
    file: 'canvas-coverage.png',
    view: 'coverage',
    w: 1280,
    h: 1100,
    dsf: 1,
    ready: "document.querySelectorAll('.source-card').length === 2",
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
    file: 'canvas-intersection.png',
    view: 'intersection',
    w: 1440,
    h: 1080,
    dsf: 1,
    ready: "document.querySelector('.mini-stats') && document.querySelector('table.matrix')",
  },
  {
    file: 'canvas-intersection-dark.png',
    view: 'intersection',
    theme: 'dark',
    w: 1440,
    h: 1080,
    dsf: 1,
    ready: "document.querySelector('.mini-stats') && document.querySelector('table.matrix')",
  },
  {
    file: 'canvas-model.png',
    view: 'model',
    w: 1280,
    h: 1000,
    dsf: 1,
    ready: "document.querySelector('.model-graph svg') && document.querySelector('.tier-cards')",
  },
  {
    file: 'canvas-recipe.png',
    view: 'recipe',
    w: 1440,
    h: 1750,
    dsf: 1,
    ready: "document.querySelector('.recipe-strip svg') && document.querySelectorAll('.lane').length >= 6 && document.body.innerText.includes('Azure Boards: connected')",
    prepare: "document.querySelector('.lane-meta').click()",
  },
  {
    file: 'canvas-recipe-local.png',
    view: 'recipe',
    verified: false,
    w: 1440,
    h: 1180,
    dsf: 1,
    ready: "document.querySelector('.recipe-strip svg') && document.body.innerText.includes('Local evidence only')",
  },
  {
    file: 'canvas-gaps.png',
    view: 'gaps',
    w: 1280,
    h: 900,
    dsf: 1,
    ready: "document.querySelector('[data-detail=\"verification-status\"]')",
  },
  {
    file: 'canvas-research.png',
    view: 'research',
    w: 1280,
    h: 900,
    dsf: 1,
    ready: "document.querySelector('.research-index .disclosure')",
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
    ['cli-web-pr', 'https://github.com/contoso/web-app.git', 'mona/AB1234-checkout-flow', 'Checkout flow PR'],
    ['app-api-pr', 'contoso/api', 'mona/52-token-refresh', 'API auth fix'],
    ['cli-tools-issue', 'https://github.com/fabrikam/tools.git', 'main', 'Tooling issue triage'],
    ['cloud-web-repo', 'contoso/web-app', 'experiment/pricing', 'Repository-only exploration'],
    ['cli-unlinked', null, null, 'General coding Q&A'],
    ['app-web-docs', 'contoso/web-app', 'mona/AB1250-docs-refresh', 'Docs refresh'],
    ['cli-api-limits', 'contoso/api', 'mona/61-rate-limits', 'Rate limits'],
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
    ['app-web-docs', 1, null, 'gpt-5', 5200, 640, 1500, 120, 300, 3.1, 'user', 'medium', 4, 10],
    ['app-web-docs', 2, null, 'gpt-5-mini', 2100, 260, 500, 40, 60, 0.6, 'agent', 'low', 3, 15],
    ['cli-api-limits', 1, null, 'claude-sonnet-4.5', 6400, 720, 1800, 150, 460, 4.4, 'user', 'high', 6, 11],
    ['cli-api-limits', 2, 'sub-tests', 'gpt-5-mini', 2400, 300, 600, 50, 80, 0.9, 'sub-agent', 'low', 5, 14],
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
    if (fields.user) addAttr(id, 'user.name', fields.user);
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

  addAgent('agent-web', 'trace-web', ms(now, 6, 9), 'https://github.com/contoso/web-app.git', 'mona/AB1250-docs-refresh', {
    conversation: 'conv-web',
    chatSession: 'chat-web',
    user: 'octocat',
    commit: '5e1f0aa',
  });
  addAgent('agent-web-2', 'trace-web-2', ms(now, 5, 14), 'https://github.com/contoso/web-app.git', 'mona/AB1250-docs-refresh', {
    chatSession: 'chat-web',
    user: 'octocat',
    commit: '7c2d9e1',
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

  addAgent('agent-api', 'trace-api', ms(now, 4, 10), 'contoso/api', 'mona/61-rate-limits', {
    conversation: 'conv-api',
    user: 'octocat',
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

/**
 * Canned GitHub and Azure Boards answers for the synthetic cycles, served
 * through verify.mjs's injectable runner and fetch, so the Recipe screenshot
 * exercises the real verification code without any network request.
 */
function syntheticForges(now) {
  const at = (daysAgo, hour = 10) => iso(now, daysAgo, hour);
  const sha = (seed) => seed.repeat(40).slice(0, 40);
  const pr = (number, branch, { state, created, merged = null, reviews = [], commits = [], closing = [] }) => ({
    number,
    state,
    isDraft: false,
    createdAt: at(created, 15),
    mergedAt: merged === null ? null : at(merged, 11),
    closedAt: merged === null ? null : at(merged, 11),
    headRefName: branch,
    baseRefName: 'main',
    reviewDecision: reviews.at(-1)?.[0] ?? null,
    reviews: { totalCount: reviews.length, nodes: reviews.map(([s, d]) => ({ state: s, submittedAt: at(d, 16) })) },
    commits: { totalCount: commits.length, nodes: commits.map(([seed, d], i) => ({ commit: { oid: sha(seed), committedDate: at(d, 9 + i) } })) },
    closingIssuesReferences: { nodes: closing },
  });
  const issue = (number, state, type, created, closed = null) => ({
    __typename: 'Issue',
    number,
    state,
    stateReason: state === 'CLOSED' ? 'COMPLETED' : null,
    createdAt: at(created, 9),
    closedAt: closed === null ? null : at(closed, 12),
    issueType: { name: type },
  });
  const github = {
    'contoso/web-app': {
      'branch:mona/AB1234-checkout-flow': { totalCount: 1, nodes: [
        pr(128, 'mona/AB1234-checkout-flow', {
          state: 'MERGED', created: 22, merged: 16,
          reviews: [['CHANGES_REQUESTED', 21], ['APPROVED', 18]],
          commits: [['a1', 26], ['b2', 24], ['c3', 23], ['d4', 21], ['e5', 19]],
        }),
      ] },
      'pr:128': null,
      'issue:44': issue(44, 'CLOSED', 'Bug', 30, 16),
      'branch:experiment/pricing': { totalCount: 0, nodes: [] },
      'branch:mona/AB1250-docs-refresh': { totalCount: 1, nodes: [
        pr(131, 'mona/AB1250-docs-refresh', {
          state: 'OPEN', created: 3,
          reviews: [['CHANGES_REQUESTED', 2]],
          commits: [['f6', 5], ['a7', 4], ['b8', 3], ['c9', 2]],
        }),
      ] },
    },
    'contoso/api': {
      'branch:mona/52-token-refresh': { totalCount: 1, nodes: [
        pr(87, 'mona/52-token-refresh', {
          state: 'MERGED', created: 15, merged: 9,
          reviews: [['APPROVED', 11]],
          commits: [['d0', 17], ['e1', 16], ['f2', 15], ['a3', 11]],
          closing: [{ number: 52, state: 'CLOSED', stateReason: 'COMPLETED', createdAt: at(19, 9), closedAt: at(9, 11), repository: { nameWithOwner: 'contoso/api' }, issueType: { name: 'Bug' } }],
        }),
      ] },
      'pr:87': null,
      'issue:52': issue(52, 'CLOSED', 'Bug', 19, 9),
      'branch:mona/61-rate-limits': { totalCount: 1, nodes: [
        pr(90, 'mona/61-rate-limits', { state: 'OPEN', created: 2, commits: [['b4', 5], ['c5', 3]] }),
      ] },
      'issue:61': issue(61, 'OPEN', 'Feature', 8),
    },
    'fabrikam/tools': {
      'branch:main': { totalCount: 0, nodes: [] },
      'issue:19': issue(19, 'OPEN', 'Task', 14),
    },
  };
  github['contoso/web-app']['pr:128'] = github['contoso/web-app']['branch:mona/AB1234-checkout-flow'].nodes[0];
  github['contoso/api']['pr:87'] = github['contoso/api']['branch:mona/52-token-refresh'].nodes[0];

  const run = async (command, args) => {
    assert.equal(command, 'gh', 'only gh is called when a PAT is set');
    const value = (flag, name) => {
      const i = args.findIndex((a, j) => args[j - 1] === flag && a.startsWith(`${name}=`));
      return i < 0 ? null : args[i].slice(name.length + 1);
    };
    const repo = github[`${value('-f', 'owner')}/${value('-f', 'name')}`] ?? {};
    const data = {};
    args.forEach((arg, i) => {
      const match = /^([pbi])(\d+)=(.*)$/.exec(arg);
      if (!match || !['-f', '-F'].includes(args[i - 1])) return;
      const kind = { p: 'pr', b: 'branch', i: 'issue' }[match[1]];
      data[`${match[1]}${match[2]}`] = repo[`${kind}:${match[3]}`] ?? (kind === 'branch' ? { totalCount: 0, nodes: [] } : null);
    });
    return { code: 0, missing: false, stdout: JSON.stringify({ data: { repository: data } }), stderr: '' };
  };

  const workItems = {
    1234: { 'System.WorkItemType': 'User Story', 'System.State': 'Closed', 'System.TeamProject': 'Web', 'System.CreatedDate': at(35), 'Microsoft.VSTS.Common.ActivatedDate': at(27, 8), 'Microsoft.VSTS.Common.ClosedDate': at(15, 13) },
    1250: { 'System.WorkItemType': 'Task', 'System.State': 'Active', 'System.TeamProject': 'Web', 'System.CreatedDate': at(9), 'Microsoft.VSTS.Common.ActivatedDate': at(6, 8) },
  };
  const states = [
    { name: 'New', category: 'Proposed' },
    { name: 'Active', category: 'InProgress' },
    { name: 'Resolved', category: 'Resolved' },
    { name: 'Closed', category: 'Completed' },
  ];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const body = u.pathname.endsWith('/_apis/wit/workitems')
      ? { value: u.searchParams.get('ids').split(',').map((id) => (workItems[id] ? { id: Number(id), fields: workItems[id] } : null)) }
      : { value: states };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { run, fetch: fetchImpl, organization: 'contoso', env: { AZURE_DEVOPS_EXT_PAT: 'synthetic' } };
}

let nextId = 1;
const pending = new Map();

function send(ws, method, params, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDevTools(profile, browser) {
  // Chrome writes the port it actually bound, and its browser endpoint, into
  // this profile's DevToolsActivePort, so the endpoint always belongs to the
  // browser spawned here, never to another one already on a fixed port.
  const file = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100; i++) {
    if (browser.exitCode !== null) break;
    try {
      const [port, endpoint] = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      if (port && endpoint) return `ws://127.0.0.1:${port.trim()}${endpoint.trim()}`;
    } catch {
      /* not written yet */
    }
    await sleep(200);
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

const WORD_BUDGETS = { outcomes: 200, recipe: 600, surfaces: 300, intersection: 180, model: 130, gaps: 180, coverage: 280, research: 130 };

async function verifyCompactView(ws, sessionId, view) {
  const words = await evaluate(ws, sessionId, "document.getElementById('view').innerText.trim().split(/\\s+/).length");
  assert.ok(words <= WORD_BUDGETS[view], `${view}: ${words} visible words exceeds ${WORD_BUDGETS[view]}`);
  console.log(`${view}: ${words}/${WORD_BUDGETS[view]} visible words`);
  const detail = {
    outcomes: ['roi-contract', 'incremental cost'],
    recipe: ['recipe-privacy', 'Titles'],
    surfaces: ['cell-time-vscode', 'span start_time'],
    intersection: ['matrix-guide', 'Missing and unverified'],
    model: ['accounting-rules', 'Count each model call once'],
    gaps: ['verification-status', 'verified'],
    coverage: ['tokens-sessionStore', 'Reported subtotals'],
    research: ['research-0', 'Decision: proceed'],
  }[view];
  if (detail) {
    const selector = `[data-detail="${detail[0]}"]`;
    await evaluate(ws, sessionId, `document.querySelector(${JSON.stringify(`${selector} > summary`)}).focus()`);
    await send(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 }, sessionId);
    await send(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId);
    await evaluate(ws, sessionId, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const expanded = await evaluate(ws, sessionId, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return { open: el.open, text: el.innerText };
    })()`);
    assert.ok(expanded.open, `${view}: Enter opens the detail`);
    assert.ok(expanded.text.includes(detail[1]), `${view}: full evidence is still accessible`);
    if (view === 'surfaces') {
      await evaluate(ws, sessionId, "document.querySelector('[data-focus-key=\"group-all\"]').click()");
      await evaluate(ws, sessionId, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
      assert.ok(await evaluate(ws, sessionId, `document.querySelector(${JSON.stringify(selector)}).open`), 'disclosures survive re-rendering');
      assert.equal(await evaluate(ws, sessionId, 'document.activeElement.dataset.focusKey'), 'detail-cell-time-vscode', 'detail focus survives re-rendering');
    }
    await evaluate(ws, sessionId, `document.querySelector(${JSON.stringify(selector)}).open = false`);
    await evaluate(ws, sessionId, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  }
  if (view === 'model') {
    assert.equal(await evaluate(ws, sessionId, "document.querySelectorAll('.model-node').length"), 8);
    assert.equal(await evaluate(ws, sessionId, "document.querySelectorAll('.model-graph .edge').length"), 8);
  }
  if (view === 'outcomes') {
    assert.ok(await evaluate(ws, sessionId, "document.querySelector('.ratio-bar.unknown[aria-label=\"Not measured\"]') !== null"), 'missing is not a zero bar');
  }
  if (view === 'coverage') {
    assert.ok(await evaluate(ws, sessionId, "document.querySelector('.not-emitted .bar.unknown') !== null"), 'unavailable stages have a dashed empty bar');
    assert.ok(await evaluate(ws, sessionId, "document.getElementById('view').innerText.includes('No agent-host-traces.db')"), 'source failures stay visible');
  }
}

async function verifyNarrowView(ws, sessionId, view) {
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, sessionId);
  for (const expanded of [false, true]) {
    await evaluate(ws, sessionId, `document.querySelectorAll('#view details').forEach((el) => { el.open = ${expanded}; })`);
    await evaluate(ws, sessionId, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const width = await evaluate(ws, sessionId, 'document.documentElement.scrollWidth');
    assert.ok(width <= 391, `${view}: ${expanded ? 'expanded' : 'compact'} page overflows a 390px viewport (${width}px)`);
  }
  await evaluate(ws, sessionId, "document.querySelectorAll('#view details').forEach((el) => { el.open = false; })");
  await evaluate(ws, sessionId, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
}

async function verifyThemes(ws, sessionId) {
  const colors = async () => evaluate(ws, sessionId, `(() => {
    const style = getComputedStyle(document.body);
    const luminance = (color) => {
      const values = color.match(/[\\d.]+/g).slice(0, 3).map(Number).map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
    };
    const bg = luminance(style.backgroundColor), fg = luminance(style.color);
    return { background: style.backgroundColor, mode: document.documentElement.dataset.canvasColorMode,
      contrast: (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05) };
  })()`);
  const settled = () => evaluate(ws, sessionId, 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const select = (theme) => evaluate(ws, sessionId, `(() => {
    const control = document.getElementById('theme');
    control.value = ${JSON.stringify(theme)};
    control.dispatchEvent(new Event('change'));
  })()`);
  await select('auto');
  for (const [scheme, background] of [['dark', 'rgb(13, 17, 23)'], ['light', 'rgb(255, 255, 255)']]) {
    await send(ws, 'Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, sessionId);
    await settled();
    const result = await colors();
    assert.equal(result.mode, scheme, `system ${scheme}`);
    assert.equal(result.background, background, `system ${scheme} palette`);
    assert.ok(result.contrast >= 4.5, `system ${scheme} text contrast`);
  }
  await evaluate(ws, sessionId, `(() => {
    document.body.dataset.colorMode = 'dark';
    document.body.style.setProperty('--background-color-default', '#1a1a1a');
    document.body.style.setProperty('--text-color-default', '#f0f6fc');
  })()`);
  await settled();
  assert.equal((await colors()).background, 'rgb(26, 26, 26)', 'auto respects body-injected host tokens');
  for (const [theme, background] of [['light', 'rgb(255, 255, 255)'], ['dark', 'rgb(13, 17, 23)']]) {
    await select(theme);
    const result = await colors();
    assert.equal(result.background, background, `explicit ${theme} overrides host tokens`);
    assert.ok(result.contrast >= 4.5, `explicit ${theme} text contrast`);
  }
  await evaluate(ws, sessionId, `(() => {
    delete document.body.dataset.colorMode;
    document.body.style.removeProperty('--background-color-default');
    document.body.style.removeProperty('--text-color-default');
  })()`);
  await select('auto');
  await settled();
  assert.equal((await colors()).mode, 'light', 'return to system after host theme is removed');
  console.log('Theme checks passed: system changes, body-injected host tokens, explicit overrides and text contrast >= 4.5:1.');
}

async function startServer(paths, now, display = { verified: true }) {
  const [{ startCanvasServer }, { computeCoverage, withoutRecipe }, { loadModel, loadResearch }, { recipeView }, { verifyRecipe }] = await Promise.all([
    import(pathToFileURL(path.join(EXTENSION_DIR, 'lib', 'server.mjs')).href),
    import(pathToFileURL(path.join(EXTENSION_DIR, 'lib', 'coverage.mjs')).href),
    import(pathToFileURL(path.join(EXTENSION_DIR, 'lib', 'model.mjs')).href),
    import(pathToFileURL(path.join(EXTENSION_DIR, 'lib', 'recipe.mjs')).href),
    import(pathToFileURL(path.join(EXTENSION_DIR, 'lib', 'verify.mjs')).href),
  ]);
  let view = 'outcomes';
  let windowDays = 30;
  let cachedCoverage;
  let verification = null;
  const displayCoverage = (coverage) => ({
    ...withoutRecipe(coverage),
    sources: coverage.sources.map((source) => ({
      ...source,
      path: source.path ? `synthetic\\${path.basename(source.path)}` : null,
    })),
  });
  // Discovery is pointed at an empty sandbox, so no real local store can reach a screenshot.
  const sandbox = path.dirname(paths.sessionStorePath);
  const options = () => ({ windowDays, now, ...paths, env: {}, home: sandbox, platform: 'linux' });
  const coverage = async () => {
    if (!cachedCoverage) {
      cachedCoverage = await computeCoverage(options());
      for (const source of cachedCoverage.sources) {
        assert.ok(!source.path || path.resolve(source.path).startsWith(sandbox), `${source.id} must read only synthetic fixtures`);
        assert.ok(source.status !== 'ok' || source.path, `${source.id} must come from a synthetic fixture`);
      }
    }
    return cachedCoverage;
  };
  const verify = async () => {
    verification = await verifyRecipe((await coverage()).recipe, { ...syntheticForges(now), now, home: sandbox, platform: 'linux' });
    return recipeView((await coverage()).recipe, verification);
  };
  await verify();
  return startCanvasServer({
    uiDir: path.join(EXTENSION_DIR, 'ui'),
    api: {
      model: () => loadModel(),
      research: () => loadResearch(),
      coverage: async () => displayCoverage(await coverage()),
      refresh: async (days) => {
        windowDays = Number.isFinite(Number(days)) ? Math.max(0, Math.min(365, Math.floor(Number(days)))) : windowDays;
        cachedCoverage = null;
        return displayCoverage(await coverage());
      },
      recipe: async () => recipeView((await coverage()).recipe, display.verified ? verification : null),
      verify,
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
    const display = { verified: true };
    server = await startServer(fixtures, now, display);
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

    const endpoint = await waitForDevTools(profile, browser);
    ws = new WebSocket(endpoint);
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

    let themesVerified = false;
    for (const shot of shots) {
      display.verified = shot.verified !== false;
      await setServerView(server.url, shot.view);
      await send(
        ws,
        'Emulation.setDeviceMetricsOverride',
        { width: shot.w, height: shot.h, deviceScaleFactor: shot.dsf, mobile: false },
        sessionId,
      );
      await send(ws, 'Page.navigate', { url: server.url }, sessionId);
      await waitForRender(ws, sessionId, shot.ready);
      await verifyCompactView(ws, sessionId, shot.view);
      if (!themesVerified) {
        await verifyThemes(ws, sessionId);
        themesVerified = true;
      }
      await evaluate(ws, sessionId, `(() => {
        const control = document.getElementById('theme');
        control.value = ${JSON.stringify(shot.theme ?? 'light')};
        control.dispatchEvent(new Event('change'));
      })()`);
      if (shot.view === 'intersection') {
        assert.equal(await evaluate(ws, sessionId, "document.querySelectorAll('table.matrix .badge.missing, table.matrix .badge.unverified').length"), 0);
      }
      if (shot.prepare) await evaluate(ws, sessionId, shot.prepare);
      await evaluate(ws, sessionId, 'document.activeElement.blur(); window.scrollTo(0, 0)');
      const { data } = await send(ws, 'Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId);
      const buf = Buffer.from(data, 'base64');
      const out = path.join(OUT, shot.file);
      fs.writeFileSync(out, buf);
      console.log(`${rel(out)}  ${shot.w * shot.dsf}x${shot.h * shot.dsf}  ${(buf.length / 1024).toFixed(1)} kB`);
      await verifyNarrowView(ws, sessionId, shot.view);
    }
    await evaluate(ws, sessionId, "document.querySelector('[role=\"tab\"][aria-selected=\"true\"]').focus()");
    for (const [key, expected] of [['Home', 'outcomes'], ['ArrowRight', 'recipe'], ['End', 'research']]) {
      await send(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code: key }, sessionId);
      await send(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code: key }, sessionId);
      assert.equal(await evaluate(ws, sessionId, "document.querySelector('[role=\"tab\"][aria-selected=\"true\"]').dataset.view"), expected);
    }
    console.log('Compact views passed: word budgets, keyboard disclosures and tabs, retained evidence, narrow layouts.');
  } finally {
    if (ws) {
      await send(ws, 'Browser.close').catch(() => {});
      ws.close();
    }
    if (browser) browser.kill();
    if (server) await server.close().catch(() => {});
    await sleep(500);
    // Best effort: on Windows the browser can hold its profile open briefly
    // after exiting, and a leftover temp directory is not worth failing on.
    try {
      fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* ignore */
    }
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
