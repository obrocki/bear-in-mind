'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { it } = require('node:test');
const { pathToFileURL } = require('node:url');

const extensionDir = path.join(__dirname, '..', '.github', 'extensions', 'ai-attribution');
const load = (file) => import(pathToFileURL(path.join(extensionDir, 'lib', file)).href);
const model = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'research', 'attribution-model.json'), 'utf8'));
const NANO = 1_000_000_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 20, 12);
const at = (daysAgo, hour = 10) => new Date(NOW - daysAgo * DAY + (hour - 12) * 3_600_000).toISOString();

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-recipe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const BRANCHES = [
  ['alex/AB123-add-recipe', { provider: 'azure-boards', id: 123 }],
  ['alex/ab#77_fix', { provider: 'azure-boards', id: 77 }],
  ['team/alex/AB9', { provider: 'azure-boards', id: 9 }],
  ['alex/123-add-recipe', { provider: 'github', id: 123 }],
  ['45-fix-login', { provider: 'github', id: 45 }],
  ['alex/#8.patch', { provider: 'github', id: 8 }],
  ['alex/add-recipe', null],
  ['alex/0-zero', null],
  ['alex/ABC123-x', null],
  ['alex/123abc', null],
  ['main', null],
  ['bad branch/1-x', null],
  ['', null],
];

it('recipe model: steps reference real concepts in phase order', () => {
  const r = model.recipe;
  const concepts = new Set(model.concepts.map((c) => c.id));
  assert.deepEqual(r.phases.map((p) => p.id), ['ingredients', 'method', 'serve']);
  assert.deepEqual(r.steps.map((s) => s.id), ['workItem', 'branch', 'aiWork', 'commits', 'pullRequest', 'review', 'close']);
  assert.equal(r.steps.find((s) => s.id === 'commits').name, 'Commit');
  for (const step of r.steps) {
    assert.ok(r.phases.some((p) => p.id === step.phase), step.id);
    for (const c of step.concepts) assert.ok(concepts.has(c), `${step.id}: ${c}`);
  }
  assert.deepEqual(r.evidence.map((e) => e.id), ['verified', 'recorded', 'convention', 'observed']);
  assert.match(r.guardrails.join(' '), /never requested/);
  assert.match(r.guardrails.join(' '), /never a sum/);
});

it('branch convention: AB123 is Azure Boards, a leading number is a GitHub issue', async () => {
  const { parseBranchWorkItem, referencesWorkItem, workItemTrailer } = await load('convention.mjs');
  for (const [branch, expected] of BRANCHES) {
    const item = parseBranchWorkItem(branch);
    assert.deepEqual(item && { provider: item.provider, id: item.id }, expected, branch);
  }
  const ab = parseBranchWorkItem('alex/AB123-x');
  const gh = parseBranchWorkItem('alex/123-x');
  assert.equal(workItemTrailer(ab), 'Refs: AB#123');
  assert.equal(workItemTrailer(gh), 'Refs: #123');
  assert.ok(referencesWorkItem('Fixes AB#123', ab));
  assert.ok(!referencesWorkItem('Fixes AB#1234', ab));
  assert.ok(referencesWorkItem('Closes #123', gh));
  assert.ok(referencesWorkItem('See octo/web#123', gh));
  assert.ok(!referencesWorkItem('AB#123', gh), 'an Azure Boards mention is not a GitHub issue');
  assert.ok(!referencesWorkItem('# Comment mentioning #123', gh), 'comment lines are ignored');
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

it('commit-msg hook: matches the shared parser and adds one trailer without blocking commits', async (t) => {
  if (spawnSync('git', ['--version']).status !== 0) {
    t.skip('git is not available');
    return;
  }
  const { parseBranchWorkItem } = await load('convention.mjs');
  const hook = path.join(extensionDir, 'hooks', 'commit-msg');
  const source = fs.readFileSync(hook, 'utf8');
  assert.match(source, /^#!\/usr\/bin\/env node/);
  assert.doesNotMatch(source, /require\(['"]\.\.?\//, 'the hook stays self-contained so it can be copied');

  const repo = tempDir(t);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  const message = path.join(repo, 'MSG');
  const run = (text, env = {}) => {
    fs.writeFileSync(message, text);
    const result = spawnSync(process.execPath, [hook, message], { cwd: repo, env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(message, 'utf8');
  };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');

  for (const [branch] of BRANCHES.filter(([b]) => b && !/\s/.test(b) && !b.includes('#') && b !== 'main')) {
    git(repo, 'checkout', '-q', '-B', branch);
    const item = parseBranchWorkItem(branch);
    const out = run('Change things\n');
    if (item) assert.match(out, new RegExp(`Refs: ${item.reference}\\s*$`), branch);
    else assert.equal(out, 'Change things\n', branch);
  }

  git(repo, 'checkout', '-q', '-B', 'alex/AB123-add-recipe');
  assert.equal(run('Fix AB#123 properly\n'), 'Fix AB#123 properly\n', 'already referenced');
  assert.equal(run('\n# Please enter the commit message\n'), '\n# Please enter the commit message\n', 'empty messages still abort');
  const withTrailers = run('Add recipe\n\nCo-authored-by: A <a@example.com>\n');
  assert.match(withTrailers, /Co-authored-by: A <a@example\.com>\nRefs: AB#123\n?$/, 'joins the existing trailer block');
  const edited = run('Add recipe\n# Please enter the commit message\n# On branch alex/AB123-add-recipe\n');
  assert.ok(edited.indexOf('Refs: AB#123') < edited.indexOf('# Please'), 'placed before comment lines');
  assert.equal(run('Add recipe\n', { AI_ATTRIBUTION_HOOK: 'off' }), 'Add recipe\n', 'opt-out');
  git(repo, 'checkout', '-q', '--detach');
  assert.equal(run('Detached\n'), 'Detached\n');
});

it('recorded references keep only numbers and commit IDs of the session repository', async () => {
  const { refNumber, commitSha, isGitHubRepository } = await load('recipe.mjs');
  assert.equal(refNumber('42', 'o/r'), 42);
  assert.equal(refNumber('#42', 'o/r'), 42);
  assert.equal(refNumber('O/R#42', 'o/r'), 42);
  assert.equal(refNumber('https://github.com/o/r/pull/42', 'o/r'), 42);
  assert.equal(refNumber('other/r#42', 'o/r'), null);
  assert.equal(refNumber('https://github.com/other/r/issues/42', 'o/r'), null);
  assert.equal(refNumber('fix the login bug', 'o/r'), null);
  assert.equal(refNumber('0', 'o/r'), null);
  assert.equal(commitSha('ABCDEF1'), 'abcdef1');
  assert.equal(commitSha('xyz1234'), null);
  assert.equal(commitSha('abc'), null);
  assert.ok(isGitHubRepository('octo/web'));
  assert.ok(!isGitHubRepository('gitlab.com/group/project'));
  assert.ok(!isGitHubRepository('dev.azure.com/org/project/_git/repo'));
});

function createStores(dir) {
  const { DatabaseSync } = require('node:sqlite');
  const sessionStorePath = path.join(dir, 'session-store.db');
  const store = new DatabaseSync(sessionStorePath);
  store.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE session_refs (id INTEGER PRIMARY KEY, session_id TEXT, ref_type TEXT, ref_value TEXT, turn_index INTEGER, created_at TEXT);
    CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER, agent_id TEXT,
      model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
      reasoning_tokens INTEGER, total_nano_aiu INTEGER, initiator TEXT, reasoning_effort TEXT, created_at TEXT);
  `);
  const session = store.prepare('INSERT INTO sessions (id, repository, branch, summary) VALUES (?, ?, ?, ?)');
  session.run('s-ab', 'https://github.com/octo/web.git', 'alex/AB123-checkout', 'SECRET SUMMARY');
  session.run('s-gh', 'octo/api', 'alex/45-token', 'SECRET SUMMARY');
  session.run('s-free', 'octo/web', 'spike', null);
  session.run('s-none', null, null, null);
  const ref = store.prepare('INSERT INTO session_refs (session_id, ref_type, ref_value, created_at) VALUES (?, ?, ?, ?)');
  ref.run('s-ab', 'pr', '128', at(5));
  ref.run('s-ab', 'commit', 'A1B2C3D', at(6));
  ref.run('s-ab', 'issue', 'other/repo#9', at(6));
  ref.run('s-ab', 'issue', 'SECRET TEXT', at(6));
  ref.run('s-gh', 'issue', '45', at(9));
  const usage = store.prepare(`INSERT INTO assistant_usage_events (session_id, model, total_nano_aiu, created_at) VALUES (?, 'm', ?, ?)`);
  usage.run('s-ab', 4 * NANO, at(7));
  usage.run('s-ab', 2 * NANO, at(6));
  usage.run('s-gh', 3 * NANO, at(10));
  usage.run('s-free', 1 * NANO, at(3));
  usage.run('s-none', 1 * NANO, at(2));
  store.close();

  const tracesDbPath = path.join(dir, 'agent-traces.db');
  const traces = new DatabaseSync(tracesDbPath);
  traces.exec(`
    CREATE TABLE spans (span_id TEXT PRIMARY KEY, trace_id TEXT, operation_name TEXT, start_time_ms INTEGER, chat_session_id TEXT,
      conversation_id TEXT, agent_name TEXT, request_model TEXT, response_model TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cached_tokens INTEGER, reasoning_tokens INTEGER, tool_name TEXT, status_code INTEGER);
    CREATE TABLE span_attributes (span_id TEXT, key TEXT, value TEXT);
  `);
  const span = traces.prepare('INSERT INTO spans (span_id, trace_id, operation_name, start_time_ms, chat_session_id) VALUES (?, ?, ?, ?, ?)');
  const attr = traces.prepare('INSERT INTO span_attributes VALUES (?, ?, ?)');
  for (const [id, ms, commit] of [['a1', Date.parse(at(8)), 'aaaaaaa'], ['a2', Date.parse(at(6)), 'bbbbbbb']]) {
    span.run(id, `t-${id}`, 'invoke_agent', ms, 'vs-1');
    attr.run(id, 'github.copilot.git.repository', 'https://github.com/octo/web');
    attr.run(id, 'github.copilot.git.branch', 'alex/AB123-checkout');
    attr.run(id, 'github.copilot.git.commit_sha', commit);
    attr.run(id, 'user.name', id === 'a1' ? 'alex' : 'blair');
  }
  span.run('c1', 't-a1', 'chat', Date.parse(at(8)) + 1000, 'vs-1');
  attr.run('c1', 'copilot_chat.copilot_usage_nano_aiu', String(5 * NANO));
  span.run('c2', 't-a2', 'chat', Date.parse(at(6)) + 1000, 'vs-1');
  attr.run('c2', 'copilot_chat.copilot_usage_nano_aiu', String(1 * NANO));
  traces.exec("UPDATE spans SET response_model = 'm' WHERE operation_name = 'chat'");
  traces.close();
  return { sessionStorePath, tracesDbPath };
}

async function localRecipe(t) {
  const { computeCoverage, withoutRecipe } = await load('coverage.mjs');
  const dir = tempDir(t);
  const coverage = await computeCoverage({ windowDays: 30, now: NOW, ...createStores(dir), env: {}, home: dir, platform: 'linux' });
  return { coverage, withoutRecipe };
}

it('local recipe: one cycle per repository branch, credits per source and never summed', async (t) => {
  const { coverage, withoutRecipe } = await localRecipe(t);
  const { recipe } = coverage;
  assert.equal(withoutRecipe(coverage).recipe, undefined);
  assert.deepEqual(recipe.cycles.map((c) => c.key).sort(), ['octo/api#alex/45-token', 'octo/web#alex/AB123-checkout', 'octo/web#spike']);
  const web = recipe.cycles.find((c) => c.branch === 'alex/AB123-checkout');
  assert.deepEqual(web.convention, { provider: 'azure-boards', id: 123, reference: 'AB#123' });
  assert.deepEqual(Object.fromEntries(web.sources.map((s) => [s.id, s.credits])), { sessionStore: 6, traces: 6 });
  assert.deepEqual(web.pullRequests.map((p) => p.number), [128]);
  assert.deepEqual(web.commits.map((c) => c.sha), ['a1b2c3d']);
  assert.deepEqual(web.heads.map((c) => c.sha), ['aaaaaaa', 'bbbbbbb']);
  assert.deepEqual(web.sources.find((s) => s.id === 'traces').actors.map((a) => [a.actor.key, a.credits]), [
    ['github:alex', 5], ['github:blair', 1],
  ], 'Recipe preserves the call-time user context, including account switches');
  assert.deepEqual(web.issues, [], 'other-repository and free-text references are dropped');
  assert.equal(recipe.droppedRefs, 2);
  assert.deepEqual(recipe.unlinked.map((u) => [u.id, u.calls]), [['sessionStore', 1]]);
  assert.doesNotMatch(JSON.stringify(recipe), /SECRET/, 'summaries and free-text references never reach the recipe');
});

it('recipe view without verification: unknown stays unknown, convention is counted', async (t) => {
  const { recipeView } = await load('recipe.mjs');
  const view = recipeView((await localRecipe(t)).coverage.recipe, null);
  assert.equal(view.verification, null);
  const web = view.cycles.find((c) => c.branch === 'alex/AB123-checkout');
  assert.equal(web.steps.workItem.evidence, 'convention');
  assert.equal(web.steps.commits.evidence, 'recorded');
  assert.equal(web.steps.pullRequest.evidence, 'recorded');
  assert.equal(web.steps.review.state, 'unknown');
  assert.equal(web.steps.close.state, 'unknown');
  assert.equal(web.reached, 5);
  const spike = view.cycles.find((c) => c.branch === 'spike');
  assert.equal(spike.steps.workItem.state, 'no');
  assert.equal(spike.steps.commits.state, 'unknown');
  assert.deepEqual(view.adherence, {
    cycles: 3,
    azureBoards: 1,
    github: 1,
    nonConforming: 1,
    noBranch: 0,
    credits: {
      conforming: [{ id: 'sessionStore', credits: 9, cycles: 2 }, { id: 'traces', credits: 6, cycles: 1 }],
      nonConforming: [{ id: 'sessionStore', credits: 1, cycles: 1 }],
    },
  });
  const station = Object.fromEntries(view.stations.map((s) => [s.id, s]));
  assert.equal(station.workItem.any, 2);
  assert.equal(station.workItem.strict, 2);
  assert.equal(station.review.unknown, 3);
  assert.equal(view.kpis.merged, 0);
  assert.equal(view.kpis.medianOpenToMergeHours, null, 'not measured is not zero');
});

const FORBIDDEN = /\b(title|body|bodyText|message|messageHeadline|comments|description|email)\b/;

function fakeGh(responses, calls) {
  return async (command, args) => {
    calls.push([command, args]);
    if (command !== 'gh') return { code: 1, missing: true, stdout: '', stderr: '' };
    const query = args[args.indexOf('-f') + 1];
    assert.match(query, /^query=/);
    assert.doesNotMatch(query, FORBIDDEN, 'only account/assignment metadata, never content or email');
    const value = (name) => args.find((a, i) => ['-f', '-F'].includes(args[i - 1]) && a.startsWith(`${name}=`))?.slice(name.length + 1);
    const repo = responses[`${value('owner')}/${value('name')}`];
    if (!repo) return { code: 1, missing: false, stdout: JSON.stringify({ data: { repository: null }, errors: [{ type: 'NOT_FOUND' }] }), stderr: '' };
    const data = {};
    args.forEach((a, i) => {
      const m = /^([pbi]\d+)=(.*)$/.exec(a);
      if (!m) return;
      assert.equal(args[i - 1], m[1][0] === 'b' ? '-f' : '-F', 'strings are raw fields, numbers typed fields');
      data[m[1]] = repo[`${m[1][0]}:${m[2]}`] ?? null;
    });
    return { code: 0, missing: false, stdout: JSON.stringify({ data: { repository: data } }), stderr: '' };
  };
}

const pr = (number, head, extra = {}) => ({
  number,
  state: 'MERGED',
  isDraft: false,
  createdAt: at(5),
  mergedAt: at(2),
  closedAt: at(2),
  headRefName: head,
  baseRefName: 'main',
  reviewDecision: 'APPROVED',
  reviews: { totalCount: 1, nodes: [{ state: 'APPROVED', submittedAt: at(3) }] },
  commits: { totalCount: 2, nodes: [{ commit: { oid: 'c'.repeat(40), committedDate: at(6) } }, { commit: { oid: 'd'.repeat(40), committedDate: at(4) } }] },
  closingIssuesReferences: { nodes: [] },
  ...extra,
});

it('verification: GitHub by branch and number, Azure Boards by convention, no content and no tokens', async (t) => {
  const { verifyRecipe } = await load('verify.mjs');
  const { recipeView } = await load('recipe.mjs');
  const { recipe } = (await localRecipe(t)).coverage;
  const calls = [];
  const run = fakeGh({
    'octo/web': {
      'b:alex/AB123-checkout': { totalCount: 2, nodes: [pr(128, 'alex/AB123-checkout'), pr(3, 'alex/AB123-checkout', { createdAt: at(400), mergedAt: at(399), closedAt: at(399) })] },
      'p:128': pr(128, 'alex/AB123-checkout'),
      'b:spike': { totalCount: 0, nodes: [] },
    },
    'octo/api': {
      'b:alex/45-token': { totalCount: 1, nodes: [pr(77, 'alex/45-token', { state: 'OPEN', mergedAt: null, closedAt: null, reviews: { totalCount: 0, nodes: [] } })] },
      'i:45': { __typename: 'Issue', number: 45, state: 'OPEN', stateReason: null, createdAt: at(12), closedAt: null, issueType: { name: 'Bug' } },
    },
  }, calls);
  const requests = [];
  const fetch = async (url, init) => {
    requests.push([url, init]);
    const u = new URL(url);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Authorization, `Basic ${Buffer.from(':pat-secret').toString('base64')}`);
    const body = u.pathname.endsWith('/_apis/wit/workitems')
      ? { value: [{ id: 123, fields: { 'System.WorkItemType': 'User Story', 'System.State': 'Closed', 'System.TeamProject': 'Web', 'System.CreatedDate': at(20), 'Microsoft.VSTS.Common.ActivatedDate': at(9), 'Microsoft.VSTS.Common.ClosedDate': at(1) } }] }
      : { value: [{ name: 'Active', category: 'InProgress' }, { name: 'Closed', category: 'Completed' }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const verification = await verifyRecipe(recipe, { run, fetch, organization: 'contoso', env: { AZURE_DEVOPS_EXT_PAT: 'pat-secret' }, now: NOW });

  assert.equal(verification.github.status, 'ok');
  assert.equal(verification.azureBoards.status, 'ok');
  assert.equal(verification.azureBoards.organization, 'https://dev.azure.com/contoso');
  assert.ok(calls.every(([command]) => command === 'gh'), 'a PAT skips the Azure CLI');
  assert.match(requests[0][0], /^https:\/\/dev\.azure\.com\/contoso\/_apis\/wit\/workitems\?ids=123&fields=System\.Id,System\.WorkItemType/);
  assert.doesNotMatch(requests[0][0], /Title|Description|History/);
  assert.match(requests[1][0], /\/Web\/_apis\/wit\/workitemtypes\/User%20Story\/states/);
  assert.doesNotMatch(JSON.stringify(verification), /pat-secret|cGF0/, 'tokens never leave verify');

  const web = verification.cycles['octo/web#alex/AB123-checkout'];
  assert.equal(web.pullRequest.number, 128, 'the old PR on a reused branch name does not match');
  assert.equal(web.candidates, 2);
  assert.equal(web.workItems[123].category, 'Completed');

  const view = recipeView(recipe, verification);
  const cycle = (branch) => view.cycles.find((c) => c.branch === branch);
  assert.deepEqual(Object.values(cycle('alex/AB123-checkout').steps).map((s) => s.state), ['yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'yes']);
  assert.equal(cycle('alex/AB123-checkout').steps.workItem.evidence, 'verified');
  assert.ok(cycle('alex/AB123-checkout').leadTimeHours > 0);
  const api = cycle('alex/45-token');
  assert.equal(api.workItems[0].type, 'Bug');
  assert.equal(api.steps.review.state, 'no');
  assert.equal(api.steps.close.state, 'no');
  assert.equal(cycle('spike').steps.pullRequest.state, 'no');
  assert.equal(view.kpis.merged, 1);
  assert.equal(view.kpis.closed, 1);
  assert.deepEqual(view.kpis.creditsPerMergedPr, [{ id: 'sessionStore', merged: 1, credits: 6 }, { id: 'traces', merged: 1, credits: 6 }]);
});

it('verification: a recorded PR on another branch is a mention, not the cycle PR', async (t) => {
  const { verifyRecipe } = await load('verify.mjs');
  const { recipeView } = await load('recipe.mjs');
  const { recipe } = (await localRecipe(t)).coverage;
  const run = fakeGh({ 'octo/web': { 'p:128': pr(128, 'someone/else') }, 'octo/api': {} }, []);
  const verification = await verifyRecipe(recipe, { run, fetch: async () => assert.fail('no org, no request'), env: {}, home: tempDir(t), now: NOW });
  assert.equal(verification.azureBoards.status, 'not-configured');
  const view = recipeView(recipe, verification);
  const web = view.cycles.find((c) => c.branch === 'alex/AB123-checkout');
  assert.equal(web.steps.pullRequest.state, 'no');
  assert.match(web.steps.pullRequest.detail, /#128 on another branch/);
  assert.equal(web.steps.workItem.evidence, 'convention', 'unverified Azure Boards item stays a convention link');
});

it('verification failures are statuses, never thrown errors', async (t) => {
  const { verifyRecipe, normalizeOrganization, configuredOrganization } = await load('verify.mjs');
  const { recipe } = (await localRecipe(t)).coverage;
  const missing = await verifyRecipe(recipe, { run: async () => ({ code: 1, missing: true, stdout: '', stderr: '' }), env: {}, home: tempDir(t), now: NOW });
  assert.equal(missing.github.status, 'unavailable');
  assert.match(missing.github.reason, /gh auth login/);
  const signedOut = await verifyRecipe(recipe, { run: async () => ({ code: 1, missing: false, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' }), env: {}, home: tempDir(t), now: NOW });
  assert.equal(signedOut.github.status, 'unavailable');
  const commands = [];
  const noAz = await verifyRecipe(recipe, {
    run: async (command, args) => {
      commands.push([command, args]);
      return command === 'gh' ? fakeGh({ 'octo/web': {}, 'octo/api': {} }, [])(command, args) : { code: 1, missing: false, stdout: '', stderr: "'az' is not recognized" };
    },
    organization: 'https://contoso.visualstudio.com/',
    env: { ComSpec: 'cmd.exe' },
    platform: 'win32',
    now: NOW,
  });
  assert.equal(noAz.azureBoards.status, 'unavailable');
  assert.match(noAz.azureBoards.reason, /az login|AZURE_DEVOPS_EXT_PAT/);
  const az = commands.find(([command]) => command === 'cmd.exe');
  assert.deepEqual(az[1].slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(az[1][3], 'az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv', 'a constant command line');

  assert.equal(normalizeOrganization('contoso'), 'https://dev.azure.com/contoso');
  assert.equal(normalizeOrganization('https://dev.azure.com/contoso/'), 'https://dev.azure.com/contoso');
  assert.equal(normalizeOrganization('https://Contoso.visualstudio.com'), 'https://contoso.visualstudio.com');
  for (const bad of ['https://evil.example/contoso', 'http://dev.azure.com/contoso', 'contoso & calc', 'https://dev.azure.com/a/b']) {
    assert.equal(normalizeOrganization(bad), null, bad);
  }
  const home = tempDir(t);
  fs.mkdirSync(path.join(home, '.azure', 'azuredevops'), { recursive: true });
  fs.writeFileSync(path.join(home, '.azure', 'azuredevops', 'config'), '[defaults]\norganization = https://dev.azure.com/fabrikam/\nproject = X\n');
  assert.equal(configuredOrganization({ env: {}, home }), 'https://dev.azure.com/fabrikam');
});

function request(port, { method = 'GET', pathname = '/', origin, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `127.0.0.1:${port}` };
    if (origin) headers.Origin = origin;
    if (body) headers['Content-Type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

it('canvas server: recipe and verify routes, with the same origin check', async (t) => {
  const { startCanvasServer } = await load('server.mjs');
  const verified = [];
  const server = await startCanvasServer({
    uiDir: path.join(extensionDir, 'ui'),
    api: {
      model: async () => ({}),
      research: async () => '',
      coverage: async () => ({}),
      refresh: async () => ({}),
      recipe: async () => ({ cycles: [] }),
      verify: async (options) => {
        verified.push(options);
        return { verified: true };
      },
      identityLinks: async (links) => {
        const { validateIdentityLinks } = await load('actors.mjs');
        return { links: validateIdentityLinks(links) };
      },
      billing: async (scope) => {
        const { billingScope } = await load('billing.mjs');
        return { scope: billingScope(scope, Date.UTC(2026, 9, 22)) };
      },
      getView: () => 'recipe',
      setView: (v) => v,
      windowDays: () => 30,
    },
  });

  t.after(() => server.close());
  const port = Number(new URL(server.url).port);
  assert.equal((await request(port, { pathname: '/recipe.mjs' })).status, 200);
  assert.deepEqual(JSON.parse((await request(port, { pathname: '/api/recipe' })).body), { cycles: [] });
  assert.deepEqual(JSON.parse((await request(port, { method: 'POST', pathname: '/api/recipe/verify', body: { azureDevOpsOrg: 'contoso' } })).body), { verified: true });
  assert.equal((await request(port, { method: 'POST', pathname: '/api/recipe/verify', origin: 'https://evil.example', body: {} })).status, 403);
  assert.deepEqual(verified, [{ azureDevOpsOrg: 'contoso' }]);
  const links = [{ boardsKey: 'boards:https://dev.azure.com/contoso:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', githubLogin: 'alex' }];
  assert.deepEqual(JSON.parse((await request(port, { method: 'POST', pathname: '/api/recipe/identity-links', body: { links } })).body), { links });
  assert.equal((await request(port, { method: 'POST', pathname: '/api/recipe/identity-links', origin: 'https://evil.example', body: { links } })).status, 403);
  assert.equal((await request(port, { method: 'POST', pathname: '/api/recipe/identity-links', body: { links: 'invalid' } })).status, 500);
  const scope = { level: 'organization', account: 'contoso', user: 'alex', day: '2026-10-20' };
  assert.equal((await request(port, { method: 'POST', pathname: '/api/recipe/billing', body: scope })).status, 200);
  assert.equal((await request(port, { method: 'POST', pathname: '/api/recipe/billing', origin: 'https://evil.example', body: scope })).status, 403);
  assert.equal((await request(port, { method: 'POST', pathname: '/api/recipe/billing', body: { ...scope, day: 'invalid' } })).status, 500);
  assert.equal((await request(port, { pathname: '/research.md' })).status, 404, 'Research is inline, not a download');
});

it('canvas wiring exposes filtered developer reports and identity links through SDK actions', async (t) => {
  const dir = tempDir(t);
  const paths = createStores(dir);
  const slot = `__recipeCanvas${Date.now()}`;
  const stub = `data:text/javascript;base64,${Buffer.from(`
    export const createCanvas = (canvas) => canvas;
    export const joinSession = async (options) => { globalThis[${JSON.stringify(slot)}] = options.canvases[0]; };
    export class CanvasError extends Error {}
  `).toString('base64')}`;
  const billingStub = `data:text/javascript;base64,${Buffer.from(`
    import { billingScope, parseBillingReport, billingView } from ${JSON.stringify(pathToFileURL(path.join(extensionDir, 'lib', 'billing.mjs')).href)};
    export { billingView };
    export async function fetchBilling(input) {
      const scope = billingScope(input, Date.UTC(2026, 9, 22));
      if (scope.account === 'denied') return {status:'error', scope, reason:'Billing access denied.'};
      const [year,month,day] = scope.day.split('-').map(Number);
      return parseBillingReport({timePeriod:{year,month,day}, user:scope.user, organization:scope.account,
        usageItems:[{product:'Copilot',sku:'credits',model:'m',unitType:'AI credits',pricePerUnit:.01,
          grossQuantity:10,grossAmount:.1,discountQuantity:0,discountAmount:0,netQuantity:10,netAmount:.1}]},
        scope, new Date(Date.UTC(2026,9,22)).toISOString());
    }
  `).toString('base64')}`;
  const source = fs.readFileSync(path.join(extensionDir, 'extension.mjs'), 'utf8')
    .replace("from '@github/copilot-sdk/extension'", `from '${stub}'`)
    .replace("from './lib/billing.mjs'", `from '${billingStub}'`)
    .replace(/from '(\.\/[^']+)'/g, (_, file) => `from '${pathToFileURL(path.resolve(extensionDir, file)).href}'`);
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const canvas = globalThis[slot];
  delete globalThis[slot];
  assert.ok(canvas.inputSchema.properties.identityLinks);
  assert.ok(canvas.actions.some((action) => action.name === 'reconcile_recipe_billing'));
  const instanceId = 'actors-test';
  t.after(() => canvas.onClose({ instanceId }));
  const opened = await canvas.open({ instanceId, input: {
    view: 'recipe', windowDays: 0, ...paths, agentHostTracesDbPath: path.join(dir, 'absent.db'),
  } });
  assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+/);
  const action = (name, input) => canvas.actions.find((a) => a.name === name).handler({ instanceId, input });
  const report = await action('get_recipe', { sourceId: 'traces', actorKey: 'github:alex' });
  assert.equal(report.billing.status, 'disconnected', 'opening/reading Recipe does not fetch billing');
  await assert.rejects(action('reconcile_recipe_billing', { level: 'organization', account: 'bad/path', user: 'alex', day: 'invalid' }));
  assert.equal((await action('get_recipe', {})).billing.status, 'disconnected', 'a rejected read cannot expose a stale report');
  assert.equal(report.developers.sources.length, 1);
  assert.equal(report.developers.sources[0].summary.measured.credits, 5);
  assert.equal(report.developers.sources[0].summary.work[0].repository, 'octo/web');
  const billing = await action('reconcile_recipe_billing', { level: 'organization', account: 'contoso', user: 'alex', day: '2026-10-12' });
  assert.equal(billing.billing.status, 'ok');
  assert.equal(billing.billing.sources.find((row) => row.sourceId === 'traces').observed, 5);
  const denied = await action('reconcile_recipe_billing', { level: 'organization', account: 'denied', user: 'alex', day: '2026-10-12' });
  assert.equal(denied.billing.status, 'error');
  assert.equal(denied.billing.items, undefined, 'a failed billing request clears the previous report');
  const link = { boardsKey: 'boards:https://dev.azure.com/contoso:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', githubLogin: 'alex' };
  const mapped = await action('set_recipe_identity_links', { links: [link] });
  assert.deepEqual(mapped.developers.identityLinks, [link]);
  await assert.rejects(action('set_recipe_identity_links', { links: [{ boardsKey: 'display name', githubLogin: 'alex' }] }));
});
