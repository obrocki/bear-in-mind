'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { it } = require('node:test');
const { pathToFileURL } = require('node:url');

const lib = path.join(__dirname, '..', '.github', 'extensions', 'ai-attribution', 'lib');
const load = (name) => import(pathToFileURL(path.join(lib, name)).href);
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 22, 10);
const at = (days) => new Date(NOW - days * DAY).toISOString();
const NANO = 1_000_000_000;

async function fixture() {
  const { CycleCollector, buildRecipe } = await load('recipe.mjs');
  const { githubActor } = await load('actors.mjs');
  const c = new CycleCollector();
  const call = (branch, user, credits, source = 'traces') => c.addCall(source, {
    repository: branch ? 'fable/widgets' : null, branch, user,
    session: `s-${branch}`, nano: credits * NANO, credited: credits !== null, at: Date.parse(at(4)),
  });
  call('dev/1-feature', 'alex', 260000);
  call('dev/1-feature', 'blair', 150000);
  call('dev/2-feature', null, 100000);
  call(null, 'alex', 40000);
  call('spike', null, 50000);
  call('dev/1-feature', null, 200000, 'sessionStore');
  call('dev/1-feature', 'casey', null);
  const recipe = buildRecipe(c, { generatedAt: at(0), window: { days: 7 } });
  const pr = (number) => ({
    number, state: 'OPEN', author: githubActor('alex'), createdAt: at(3),
    commits: { total: 1, items: [{ sha: 'a'.repeat(40), at: at(4) }] },
    reviews: { total: 0, items: [] }, closingIssues: [],
  });
  const verification = { at: at(0), github: { status: 'ok' }, azureBoards: { status: 'skipped' }, cycles: {
    'fable/widgets#dev/1-feature': { github: true, pullRequest: pr(11), issues: {} },
    'fable/widgets#dev/2-feature': { github: true, pullRequest: pr(12), issues: {} },
  } };
  return { c, recipe, verification };
}

it('developer report answers the 400k question without combining sources or replacing measured consumers', async () => {
  const { recipeView } = await load('recipe.mjs');
  const { recipe, verification } = await fixture();
  const view = recipeView(recipe, verification);
  const traces = view.developers.sources.find((s) => s.id === 'traces');
  assert.equal(traces.total.credits, 600000);
  assert.equal(traces.measured.credits, 450000);
  assert.equal(traces.inferred.credits, 100000);
  assert.equal(traces.unattributed.credits, 50000);
  assert.equal(traces.measured.credits + traces.inferred.credits + traces.unattributed.credits, traces.total.credits);
  const alex = traces.actors.find((a) => a.key === 'github:alex');
  assert.equal(alex.usage.total.credits, 400000);
  assert.equal(alex.usage.measured.credits, 300000);
  assert.equal(alex.usage.inferred.credits, 100000);
  assert.equal(alex.usage.work.reduce((n, w) => n + (w.total.credits ?? 0), 0), 400000);
  assert.equal(alex.usage.work.find((w) => w.cycleKey === null).measured.credits, 40000, 'known user without work is retained');
  assert.equal(alex.ownership.total.credits, 510000, 'owned work includes Blair; not personal consumption');
  assert.equal(traces.actors.find((a) => a.key === 'github:blair').usage.measured.credits, 150000);
  assert.equal(traces.actors.find((a) => a.key === 'github:casey').usage.total.credits, null, 'missing credit reports are not zero');
  assert.equal(view.developers.sources.find((s) => s.id === 'sessionStore').total.credits, 200000, 'the second source stays separate');
});

it('cycle AIC readouts round to whole credits while preserving small, zero and unknown distinctions', async () => {
  const { formatCycleCredits } = await import(pathToFileURL(path.join(lib, '..', 'ui', 'recipe.mjs')).href);
  assert.equal(formatCycleCredits(4.123456), '4');
  assert.equal(formatCycleCredits(3.654321), '4');
  assert.equal(formatCycleCredits(9876.54321), new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(9877));
  assert.equal(formatCycleCredits(0.000001), '<1');
  assert.equal(formatCycleCredits(0), '0');
  assert.equal(formatCycleCredits(null), '—');
  assert.equal(formatCycleCredits(undefined), '—');
});

it('case-insensitive login joins do not use branch names, device identities, emails or matching display names', async () => {
  const { telemetryActor, githubActor, boardsActor, ownershipFor, validateIdentityLinks } = await load('actors.mjs');
  assert.equal(telemetryActor('Alex').key, githubActor('alex').key);
  assert.equal(telemetryActor('\n'), null);
  const board = boardsActor({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', displayName: 'alex', uniqueName: 'private@example.com' }, 'https://dev.azure.com/fable');
  assert.notEqual(board.key, githubActor('alex').key);
  assert.doesNotMatch(JSON.stringify(board), /private@example/);
  assert.equal(ownershipFor([{ assignees: [githubActor('alex')] }], null, []).inferred, null, 'current assignee is never backdated');
  const items = [{ assigneesAtStart: [board], assignmentAt: at(4) }];
  assert.equal(ownershipFor(items, { author: githubActor('alex') }, []).inference, 'Conflicting owners');
  const links = validateIdentityLinks([{ boardsKey: board.key, githubLogin: 'alex' }]);
  assert.equal(ownershipFor(items, { author: githubActor('alex') }, links).inferred.key, 'github:alex');
  assert.equal(ownershipFor([], { author: githubActor('helper[bot]', 'Bot') }, []).inferred, null, 'bots are not assumed human consumers');
  assert.throws(() => validateIdentityLinks([{ boardsKey: 'alex', githubLogin: 'alex' }]));
  assert.throws(() => validateIdentityLinks([...links, ...links]), /unique/);
});

it('truncated cycles and no-repository usage retain the full developer balance', async () => {
  const { CycleCollector, buildRecipe, recipeView } = await load('recipe.mjs');
  const c = new CycleCollector();
  for (let i = 0; i < 202; i++) c.addCall('traces', {
    repository: 'fable/widgets', branch: `dev/${i + 1}-feature`, user: 'alex',
    at: NOW - i, nano: NANO, credited: true,
  });
  const recipe = buildRecipe(c);
  assert.equal(recipe.truncated, 2);
  const source = recipeView(recipe).developers.sources[0];
  assert.equal(source.total.credits, 202);
  assert.equal(source.work.find((w) => w.cycleKey === null).total.credits, 2);
});

it('assignment history reconstructs the assignee at pickup, never the current assignee', async () => {
  const { githubAssignments } = await load('verify.mjs');
  const node = {
    assignees: { totalCount: 1, nodes: [{ login: 'blair' }] },
    timelineItems: { pageInfo: { hasNextPage: false }, nodes: [
      { __typename: 'AssignedEvent', createdAt: at(8), assignee: { login: 'alex', __typename: 'User' } },
      { __typename: 'UnassignedEvent', createdAt: at(2), assignee: { login: 'alex', __typename: 'User' } },
      { __typename: 'AssignedEvent', createdAt: at(2), assignee: { login: 'blair', __typename: 'User' } },
    ] },
  };
  const assignment = githubAssignments(node, at(4), at(0));
  assert.equal(assignment.assignees[0].key, 'github:blair');
  assert.equal(assignment.assigneesAtStart[0].key, 'github:alex');
  node.timelineItems.pageInfo.hasNextPage = true;
  assert.deepEqual(githubAssignments(node, at(4), at(0)).assigneesAtStart, [], 'partial history cannot establish a past owner');
});

it('Azure Boards reads field-limited assignment snapshots at first activity and drops email data', async () => {
  const { verifyRecipe } = await load('verify.mjs');
  const { recipeView } = await load('recipe.mjs');
  const { recipe } = await fixture();
  const cycle = recipe.cycles[0];
  cycle.convention = { provider: 'azure-boards', id: 123 };
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith('/states')) return new Response(JSON.stringify({ value: [] }));
    const old = u.searchParams.has('asOf');
    const assigned = { id: old ? 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' : 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      displayName: old ? 'Alex Boards' : 'Blair Boards', uniqueName: 'must-not-retain@example.com', imageUrl: 'private/avatar' };
    return new Response(JSON.stringify({ value: [{ id: 123, fields: {
      'System.WorkItemType': 'Task', 'System.State': 'Active', 'System.TeamProject': 'Test', 'System.AssignedTo': assigned,
    } }] }));
  };
  const verification = await verifyRecipe({ ...recipe, cycles: [cycle] }, {
    fetch, run: async () => ({ missing: true }), organization: 'fable',
    env: { AZURE_DEVOPS_EXT_PAT: 'test' }, now: NOW,
  });
  assert.equal(verification.azureBoards.status, 'ok');
  const snap = calls.find((url) => url.includes('asOf='));
  assert.equal(new URL(snap).searchParams.get('asOf'), cycle.first);
  assert.equal(new URL(snap).searchParams.get('fields'), 'System.Id,System.AssignedTo');
  assert.doesNotMatch(JSON.stringify(verification), /must-not-retain|private\/avatar/);
  const view = recipeView({ ...recipe, cycles: [cycle] }, verification);
  assert.equal(view.cycles[0].ownership.inferred.label, 'Alex Boards');
  assert.equal(view.cycles[0].ownership.roles.find((r) => r.role === 'Assigned now').actor.label, 'Blair Boards');
});

it('GitHub actor queries remain content-free and use fixed assignment event kinds', async () => {
  const { githubQuery } = await load('verify.mjs');
  const query = githubQuery([{ kind: 'pr', alias: 'p0' }, { kind: 'issue', alias: 'i1' }]);
  assert.match(query, /author \{ login __typename \}/);
  assert.match(query, /ASSIGNED_EVENT, UNASSIGNED_EVENT/);
  assert.doesNotMatch(query, /\b(title|body|message|description|email|comments)\b/);
});

it('changing the activity window invalidates historical ownership snapshots', async () => {
  const { recipe, verification } = await fixture();
  const { recipeView } = await load('recipe.mjs');
  const key = 'fable/widgets#dev/2-feature';
  verification.cycles[key].activityFirst = at(5);
  const view = recipeView(recipe, verification);
  const cycle = view.cycles.find((c) => c.key === key);
  assert.equal(cycle.ownership.inferred, null);
  assert.equal(cycle.attribution[0].method, 'unattributed');
});

it('Azure Boards snapshot failures are visible and do not backdate current assignment', async () => {
  const { verifyRecipe } = await load('verify.mjs');
  const { recipeView } = await load('recipe.mjs');
  const { recipe } = await fixture();
  const cycle = recipe.cycles[0];
  cycle.convention = { provider: 'azure-boards', id: 123 };
  const fetch = async (url) => {
    if (url.includes('asOf=')) return new Response('', { status: 403 });
    return new Response(JSON.stringify({ value: [{ id: 123, fields: {
      'System.AssignedTo': { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', displayName: 'Alex' },
    } }] }));
  };
  const verification = await verifyRecipe({ ...recipe, cycles: [cycle] }, {
    fetch, run: async () => ({ missing: true }), organization: 'fable',
    env: { AZURE_DEVOPS_EXT_PAT: 'test' }, now: NOW,
  });
  assert.equal(verification.azureBoards.status, 'partial');
  assert.match(verification.azureBoards.reason, /historical assignments/);
  const view = recipeView({ ...recipe, cycles: [cycle] }, verification);
  assert.equal(view.cycles[0].ownership.inferred, null);
  assert.ok(view.cycles[0].ownership.roles.some((r) => r.role === 'Assigned now'));
});
