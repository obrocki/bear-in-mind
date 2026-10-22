// Explicit, on-demand verification of Recipe cycles against GitHub.com and
// Azure Boards.
//
// Only identifiers already recorded locally are sent: repository, branch and
// PR, issue or work-item numbers. Queries select states, dates, types, review
// states, commit IDs and actor/assignment metadata. Titles, descriptions,
// commit messages and comments are never requested. GitHub uses the signed-in CLI
// (no shell; values are GraphQL variables). Azure Boards uses a token from
// `az account get-access-token` or AZURE_DEVOPS_EXT_PAT, held only in memory.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { branchName } from './convention.mjs';
import { isGitHubRepository } from './recipe.mjs';
import { githubActor, boardsActor } from './actors.mjs';

/** Azure DevOps' Entra resource ID, used to request a token from the Azure CLI. */
export const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
export const MAX_VERIFY_CYCLES = 60;
const LOOKUPS_PER_QUERY = 20;
const MAX_LOOKUPS_PER_KIND = 5;
const MAX_WORK_ITEMS = 200;
const COMMAND_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DAY_MS = 86_400_000;
const ID = /^[1-9]\d{0,8}$/;
const WORK_ITEM_FIELDS = [
  'System.Id',
  'System.WorkItemType',
  'System.State',
  'System.TeamProject',
  'System.AssignedTo',
  'System.CreatedDate',
  'Microsoft.VSTS.Common.ActivatedDate',
  'Microsoft.VSTS.Common.ResolvedDate',
  'Microsoft.VSTS.Common.ClosedDate',
];

/** Runs a command without a shell. Never rejects. */
export function runCommand(command, args, { timeout = COMMAND_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, env, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        missing: error?.code === 'ENOENT',
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      });
    });
  });
}

function text(value, max = 255) {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function date(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null;
}

function word(value) {
  return typeof value === 'string' && /^[A-Z_]{1,32}$/.test(value) ? value : null;
}

function firstLine(value) {
  return String(value ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? '';
}

// ---------------------------------------------------------------- GitHub ---

const ISSUE_TYPE = 'issueType { name }';
const ASSIGNMENT_FIELDS = `assignees(first: 20) { totalCount nodes { login } }
  timelineItems(first: 100, itemTypes: [ASSIGNED_EVENT, UNASSIGNED_EVENT]) {
    pageInfo { hasNextPage }
    nodes {
      __typename
      ... on AssignedEvent { createdAt assignee { __typename ... on User { login } ... on Bot { login } } }
      ... on UnassignedEvent { createdAt assignee { __typename ... on User { login } ... on Bot { login } } }
    }
  }`;

function prFields(issueType) {
  return `number state isDraft createdAt mergedAt closedAt headRefName baseRefName reviewDecision
    author { login __typename }
    reviews(first: 50) { totalCount nodes { state submittedAt } }
    commits(first: 100) { totalCount nodes { commit { oid committedDate } } }
    closingIssuesReferences(first: 10) { nodes { number state stateReason createdAt closedAt repository { nameWithOwner } ${issueType ? ISSUE_TYPE : ''} ${ASSIGNMENT_FIELDS} } }`;
}

/** One GraphQL document per repository batch. Values are variables, never interpolated. */
export function githubQuery(lookups, { issueType = true } = {}) {
  const vars = ['$owner: String!', '$name: String!'];
  const fields = lookups.map((l) => {
    if (l.kind === 'pr') {
      vars.push(`$${l.alias}: Int!`);
      return `${l.alias}: pullRequest(number: $${l.alias}) { ${prFields(issueType)} }`;
    }
    if (l.kind === 'branch') {
      vars.push(`$${l.alias}: String!`);
      return `${l.alias}: pullRequests(headRefName: $${l.alias}, first: 5, orderBy: { field: CREATED_AT, direction: DESC }) { totalCount nodes { ${prFields(issueType)} } }`;
    }
    vars.push(`$${l.alias}: Int!`);
    return `${l.alias}: issueOrPullRequest(number: $${l.alias}) { __typename ... on Issue { number state stateReason createdAt closedAt ${issueType ? ISSUE_TYPE : ''} ${ASSIGNMENT_FIELDS} } }`;
  });
  return `query(${vars.join(', ')}) { repository(owner: $owner, name: $name) { ${fields.join(' ')} } }`;
}

function githubArgs(repository, lookups, issueType) {
  const [owner, name] = repository.split('/');
  const args = ['api', 'graphql', '--hostname', 'github.com', '-f', `query=${githubQuery(lookups, { issueType })}`, '-f', `owner=${owner}`, '-f', `name=${name}`];
  for (const l of lookups) args.push(l.kind === 'branch' ? '-f' : '-F', `${l.alias}=${l.value}`);
  return args;
}

function issueFrom(node, pickup, checkedAt) {
  if (!node || node.__typename !== 'Issue') return { found: false };
  return {
    found: true,
    number: node.number,
    state: word(node.state),
    stateReason: word(node.stateReason),
    createdAt: date(node.createdAt),
    closedAt: date(node.closedAt),
    type: text(node.issueType?.name, 64),
    ...githubAssignments(node, pickup, checkedAt),
  };
}

export function githubAssignments(node, pickup, checkedAt) {
  const current = (node.assignees?.nodes ?? []).map((a) => githubActor(a?.login)).filter(Boolean);
  const events = node.timelineItems?.nodes;
  const complete = node.timelineItems?.pageInfo?.hasNextPage === false && Array.isArray(events);
  const at = Date.parse(pickup ?? '');
  const assignees = new Map();
  let valid = complete && Number.isFinite(at);
  for (const event of events ?? []) {
    const actor = githubActor(event?.assignee?.login, event?.assignee?.__typename);
    const time = Date.parse(event?.createdAt ?? '');
    if (!actor || !Number.isFinite(time) || !['AssignedEvent', 'UnassignedEvent'].includes(event.__typename)) {
      valid = false;
      continue;
    }
    if (time <= at) {
      if (event.__typename === 'AssignedEvent') assignees.set(actor.key, actor);
      else assignees.delete(actor.key);
    }
  }
  return {
    assignees: current,
    assigneesAtStart: valid ? [...assignees.values()] : [],
    assignmentAt: valid ? date(pickup) : null,
    assignmentCheckedAt: date(checkedAt),
    assignmentStatus: valid ? 'history' : complete ? 'unknown' : 'history unavailable or truncated',
  };
}

export function prFrom(node) {
  if (!node || !Number.isInteger(node.number)) return null;
  return {
    number: node.number,
    author: githubActor(node.author?.login, node.author?.__typename),
    state: word(node.state),
    isDraft: node.isDraft === true,
    createdAt: date(node.createdAt),
    mergedAt: date(node.mergedAt),
    closedAt: date(node.closedAt),
    headRefName: branchName(node.headRefName),
    baseRefName: branchName(node.baseRefName),
    reviewDecision: word(node.reviewDecision),
    reviews: {
      total: Number.isInteger(node.reviews?.totalCount) ? node.reviews.totalCount : 0,
      items: (node.reviews?.nodes ?? [])
        .filter((r) => date(r?.submittedAt))
        .map((r) => ({ state: word(r.state), at: date(r.submittedAt) }))
        .sort((a, b) => a.at.localeCompare(b.at)),
    },
    commits: {
      total: Number.isInteger(node.commits?.totalCount) ? node.commits.totalCount : 0,
      items: (node.commits?.nodes ?? [])
        .map((n) => n?.commit)
        .filter((c) => typeof c?.oid === 'string' && /^[0-9a-f]{40}$/i.test(c.oid))
        .map((c) => ({ sha: c.oid.toLowerCase(), at: date(c.committedDate) }))
        .filter((c) => c.at)
        .sort((a, b) => a.at.localeCompare(b.at)),
    },
    closingIssues: (node.closingIssuesReferences?.nodes ?? [])
      .filter((i) => Number.isInteger(i?.number))
      .map((i) => ({
        number: i.number,
        state: word(i.state),
        stateReason: word(i.stateReason),
        createdAt: date(i.createdAt),
        closedAt: date(i.closedAt),
        repository: text(i.repository?.nameWithOwner, 140),
        type: text(i.issueType?.name, 64),
        assignment: { assignees: i.assignees, timelineItems: i.timelineItems },
      })),
  };
}

/** The branch's PR whose lifetime overlaps the cycle's AI work; reused branch names do not match old PRs. */
export function choosePullRequest(prs, cycle, now = Date.now()) {
  const first = Date.parse(cycle.first ?? '');
  const last = Date.parse(cycle.last ?? '');
  if (!Number.isFinite(first) || !Number.isFinite(last)) return prs[0] ?? null;
  const overlapping = prs.filter((pr) => {
    const opened = Date.parse(pr.createdAt ?? '');
    const ended = Date.parse(pr.mergedAt ?? pr.closedAt ?? '') || now;
    return Number.isFinite(opened) && opened <= last + 30 * DAY_MS && ended >= first - DAY_MS;
  });
  return overlapping.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

async function runGitHub(run, env, repository, lookups) {
  let issueType = true;
  for (;;) {
    const result = await run('gh', githubArgs(repository, lookups, issueType), { env });
    if (result.missing) return { fatal: 'GitHub CLI (gh) not found. Install it and run gh auth login.' };
    let body = null;
    try {
      body = JSON.parse(result.stdout);
    } catch {
      /* not JSON: an auth or transport failure */
    }
    const errors = Array.isArray(body?.errors) ? body.errors : [];
    if (issueType && errors.some((e) => /issueType/.test(String(e?.message)))) {
      issueType = false;
      continue;
    }
    if (!body?.data) {
      const message = firstLine(result.stderr) || 'gh api graphql failed';
      if (/auth login|not logged|401|Bad credentials/i.test(result.stderr)) return { fatal: 'gh is not signed in to github.com. Run gh auth login.' };
      return { error: message };
    }
    if (!body.data.repository) return { error: `${repository} is not accessible to the signed-in gh account` };
    return { data: body.data.repository };
  }
}

async function verifyGitHub(cycles, { run, env, now }) {
  const byRepo = new Map();
  for (const cycle of cycles) {
    const list = byRepo.get(cycle.repository) ?? [];
    list.push(cycle);
    byRepo.set(cycle.repository, list);
  }
  const results = {};
  const failures = [];
  let checked = 0;
  for (const [repository, repoCycles] of byRepo) {
    const lookups = new Map();
    const want = (kind, value) => {
      const key = `${kind}:${value}`;
      if (!lookups.has(key)) lookups.set(key, { kind, value, alias: `${kind[0]}${lookups.size}` });
      return lookups.get(key);
    };
    const plans = repoCycles.map((cycle) => {
      const branch = branchName(cycle.branch);
      const issueIds = new Set(cycle.issues.map((i) => i.number));
      if (cycle.convention?.provider === 'github') issueIds.add(cycle.convention.id);
      return {
        cycle,
        branch: branch ? want('branch', branch) : null,
        prs: cycle.pullRequests.map((p) => p.number).filter((n) => ID.test(String(n))).slice(0, MAX_LOOKUPS_PER_KIND).map((n) => want('pr', n)),
        issues: [...issueIds].filter((n) => ID.test(String(n))).slice(0, MAX_LOOKUPS_PER_KIND).map((n) => ({ id: n, lookup: want('issue', n) })),
      };
    });

    const data = {};
    let failed = null;
    const all = [...lookups.values()];
    for (let i = 0; i < all.length && !failed; i += LOOKUPS_PER_QUERY) {
      const outcome = await runGitHub(run, env, repository, all.slice(i, i + LOOKUPS_PER_QUERY));
      if (outcome.fatal) return { status: 'unavailable', reason: outcome.fatal, checked: 0, cycles: {} };
      if (outcome.error) failed = outcome.error;
      else Object.assign(data, outcome.data);
    }
    if (failed) {
      failures.push(failed);
      continue;
    }

    for (const plan of plans) {
      const { cycle } = plan;
      const onBranch = plan.branch ? (data[plan.branch.alias]?.nodes ?? []).map(prFrom).filter((pr) => pr && pr.headRefName === cycle.branch) : [];
      const recorded = plan.prs.map((l) => prFrom(data[l.alias])).filter(Boolean);
      const matching = new Map([...onBranch, ...recorded.filter((pr) => pr.headRefName === cycle.branch)].map((pr) => [pr.number, pr]));
      const issues = {};
      const checkedAt = new Date(now).toISOString();
      for (const { id, lookup } of plan.issues) issues[id] = issueFrom(data[lookup.alias], cycle.first, checkedAt);
      const chosen = choosePullRequest([...matching.values()], cycle, now);
      if (chosen) chosen.closingIssues = chosen.closingIssues.map(({ assignment, ...issue }) => ({
        ...issue, ...githubAssignments(assignment ?? {}, cycle.first, checkedAt),
      }));
      results[cycle.key] = {
        github: true,
        activityFirst: cycle.first,
        pullRequest: chosen,
        candidates: matching.size,
        mentioned: recorded.filter((pr) => pr.headRefName !== cycle.branch).map((pr) => ({ number: pr.number, headRefName: pr.headRefName })),
        issues,
      };
      checked += 1;
    }
  }
  return {
    status: failures.length ? (checked ? 'partial' : 'error') : 'ok',
    reason: failures.length ? [...new Set(failures)].slice(0, 3).join('; ') : null,
    checked,
    cycles: results,
  };
}

// ---------------------------------------------------------- Azure Boards ---

/** `contoso`, `https://dev.azure.com/contoso` or `https://contoso.visualstudio.com`; anything else is rejected. */
export function normalizeOrganization(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().replace(/\/+$/, '');
  if (/^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/.test(v)) return `https://dev.azure.com/${v}`;
  let match = /^https:\/\/dev\.azure\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,49})$/i.exec(v);
  if (match) return `https://dev.azure.com/${match[1]}`;
  match = /^https:\/\/([A-Za-z0-9][A-Za-z0-9-]{0,49})\.visualstudio\.com$/i.exec(v);
  if (match) return `https://${match[1].toLowerCase()}.visualstudio.com`;
  return null;
}

/** The `az devops configure --defaults organization=…` value, if any. */
export function configuredOrganization({ env = process.env, home = os.homedir() } = {}) {
  const dir = env.AZURE_CONFIG_DIR || path.join(home, '.azure');
  let ini;
  try {
    ini = fs.readFileSync(path.join(dir, 'azuredevops', 'config'), 'utf8');
  } catch {
    return null;
  }
  let section = '';
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[(.+)]$/.exec(line);
    if (header) section = header[1].trim().toLowerCase();
    else if (section === 'defaults') {
      const match = /^organization\s*=\s*(.+)$/i.exec(line);
      if (match) return normalizeOrganization(match[1]);
    }
  }
  return null;
}

async function azureAuthorization({ run, env, platform }) {
  const pat = (env.AZURE_DEVOPS_EXT_PAT || '').trim();
  if (pat) return { header: `Basic ${Buffer.from(`:${pat}`).toString('base64')}` };
  // The Azure CLI is a .cmd shim on Windows; the command line is a constant.
  const command = `az account get-access-token --resource ${AZURE_DEVOPS_RESOURCE} --query accessToken -o tsv`;
  const result = platform === 'win32'
    ? await run(env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], { env, timeout: 45_000 })
    : await run('az', command.split(' ').slice(1), { env, timeout: 45_000 });
  const token = result.code === 0 ? result.stdout.trim() : '';
  if (!/^[A-Za-z0-9._~+/=-]{20,}$/.test(token)) {
    return {
      reason: result.missing || /not recognized|not found/i.test(result.stderr)
        ? 'Azure CLI (az) not found. Install it and run az login, or set AZURE_DEVOPS_EXT_PAT.'
        : 'No Azure DevOps token. Run az login, or set AZURE_DEVOPS_EXT_PAT.',
    };
  }
  return { header: `Bearer ${token}` };
}

async function readBounded(res) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Azure DevOps response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function azureGet(fetchImpl, url, authorization) {
  const res = await fetchImpl(url, {
    headers: { Authorization: authorization, Accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  // Azure DevOps answers bad credentials with 203 + HTML or a sign-in redirect.
  if (res.status === 203 || res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel?.();
    throw Object.assign(new Error(`Azure DevOps rejected the credentials (HTTP ${res.status})`), { auth: true });
  }
  if (res.status === 404) {
    await res.body?.cancel?.();
    throw new Error('Azure DevOps organization or project not found (HTTP 404)');
  }
  if (!res.ok) {
    await res.body?.cancel?.();
    throw new Error(`Azure DevOps request failed (HTTP ${res.status})`);
  }
  const body = await readBounded(res);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Azure DevOps returned invalid JSON.');
  }
}

async function verifyBoards(ids, { organization, run, fetch: fetchImpl, env, home, platform, cycles, now }) {
  const org = normalizeOrganization(organization ?? '') ?? configuredOrganization({ env, home });
  if (!ids.length) return { status: 'skipped', reason: 'No branch follows the AB123 convention.', organization: org, checked: 0, items: {} };
  if (!org) {
    return {
      status: 'not-configured',
      reason: 'Set the Azure DevOps organization here, or run az devops configure --defaults organization=https://dev.azure.com/<org>.',
      organization: null,
      checked: 0,
      items: {},
    };
  }
  const auth = await azureAuthorization({ run, env, platform });
  if (!auth.header) return { status: 'unavailable', reason: auth.reason, organization: org, checked: 0, items: {} };

  const items = {};
  const snapshots = {};
  const warnings = [];
  try {
    const wanted = ids.slice(0, MAX_WORK_ITEMS);
    const url = `${org}/_apis/wit/workitems?ids=${wanted.join(',')}&fields=${WORK_ITEM_FIELDS.join(',')}&errorPolicy=omit&api-version=7.1`;
    const body = await azureGet(fetchImpl, url, auth.header);
    for (const id of wanted) items[id] = { found: false };
    const categories = new Map();
    for (const row of Array.isArray(body?.value) ? body.value : []) {
      const f = row?.fields;
      if (!Number.isInteger(row?.id) || !f) continue;
      const project = text(f['System.TeamProject'], 128);
      const type = text(f['System.WorkItemType'], 64);
      items[row.id] = {
        found: true,
        project,
        type,
        state: text(f['System.State'], 64),
        category: null,
        assignees: [boardsActor(f['System.AssignedTo'], org)].filter(Boolean),
        assignmentCheckedAt: new Date(now).toISOString(),
        createdAt: date(f['System.CreatedDate']),
        activatedAt: date(f['Microsoft.VSTS.Common.ActivatedDate']),
        resolvedAt: date(f['Microsoft.VSTS.Common.ResolvedDate']),
        closedAt: date(f['Microsoft.VSTS.Common.ClosedDate']),
      };
      if (project && type) categories.set(`${project}\u0000${type}`, { project, type });
    }
    // State names vary by process; the state category says whether an item is done.
    const stateCategories = new Map();
    for (const [key, { project, type }] of categories) {
      try {
        const states = await azureGet(
          fetchImpl,
          `${org}/${encodeURIComponent(project)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/states?api-version=7.1`,
          auth.header,
        );
        stateCategories.set(key, new Map((states?.value ?? []).map((s) => [s?.name, text(s?.category, 32)])));
      } catch (err) {
        if (err.auth) throw err;
        warnings.push('Some work-item state categories could not be read.');
      }
    }
    for (const item of Object.values(items)) {
      if (item.found) item.category = stateCategories.get(`${item.project}\u0000${item.type}`)?.get(item.state) ?? null;
    }
    // fields + asOf avoids the content-bearing revision/history endpoints.
    // Snapshot at first AI activity: never backdate the current assignee.
    const times = new Map();
    for (const cycle of cycles.slice(0, MAX_VERIFY_CYCLES)) {
      const at = date(cycle.first);
      const id = cycle.convention.id;
      if (!at || !items[id]?.found) continue;
      const group = times.get(at) ?? [];
      group.push({ key: cycle.key, id });
      times.set(at, group);
    }
    const groups = [...times.entries()];
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, groups.length) }, async () => {
      while (cursor < groups.length) {
        const [at, group] = groups[cursor++];
        const snapshotIds = [...new Set(group.map((c) => c.id))];
        try {
          const past = await azureGet(fetchImpl,
            `${org}/_apis/wit/workitems?ids=${snapshotIds.join(',')}&fields=System.Id,System.AssignedTo&asOf=${encodeURIComponent(at)}&errorPolicy=omit&api-version=7.1`,
            auth.header);
          if (!Array.isArray(past?.value)) throw new Error('Invalid assignment snapshot.');
          const rows = new Map(past.value.map((row) => [row.id, row]));
          for (const { key, id } of group) {
            const row = rows.get(id);
            snapshots[key] = {
              assigneesAtStart: row ? [boardsActor(row.fields?.['System.AssignedTo'], org)].filter(Boolean) : [],
              assignmentAt: at,
              assignmentStatus: row ? 'snapshot at pickup' : 'not present at pickup',
            };
          }
        } catch {
          warnings.push('Some historical assignments could not be read; current assignees are not used as historical owners.');
        }
      }
    }));
  } catch (err) {
    return { status: 'error', reason: err instanceof Error ? err.message : String(err), organization: org, checked: 0, items: {} };
  }
  return { status: warnings.length ? 'partial' : 'ok', reason: [...new Set(warnings)].join(' ') || null, organization: org, checked: Object.keys(items).length, items, snapshots };
}

// ------------------------------------------------------------ entry point ---

/**
 * @param {ReturnType<import('./recipe.mjs').buildRecipe>} recipe
 * @param {{ organization?: string, run?: typeof runCommand, fetch?: typeof fetch, env?: NodeJS.ProcessEnv,
 *           home?: string, platform?: NodeJS.Platform, now?: number, maxCycles?: number }} options
 */
export async function verifyRecipe(recipe, options = {}) {
  const {
    organization,
    run = runCommand,
    fetch: fetchImpl = globalThis.fetch,
    env = process.env,
    home = os.homedir(),
    platform = process.platform,
    now = Date.now(),
    maxCycles = MAX_VERIFY_CYCLES,
  } = options;
  const cycles = [...(recipe?.cycles ?? [])].sort((a, b) => (b.last ?? '').localeCompare(a.last ?? ''));
  const githubCycles = cycles.filter((c) => isGitHubRepository(c.repository));
  const selected = githubCycles.slice(0, maxCycles);

  const github = selected.length
    ? await verifyGitHub(selected, { run, env, now })
    : { status: 'skipped', reason: 'No github.com repository in this window.', checked: 0, cycles: {} };

  const boardsCycles = cycles.filter((c) => c.convention?.provider === 'azure-boards').slice(0, MAX_WORK_ITEMS);
  const ids = [...new Set(boardsCycles.map((c) => c.convention.id))];
  const boards = await verifyBoards(ids, { organization, run, fetch: fetchImpl, env, home, platform, cycles: boardsCycles, now });

  const result = {};
  for (const [key, value] of Object.entries(github.cycles)) result[key] = value;
  for (const cycle of boardsCycles) {
    const item = boards.items[cycle.convention.id];
    if (!item) continue;
    result[cycle.key] = {
      ...(result[cycle.key] ?? { github: false }),
      activityFirst: cycle.first,
      workItems: { [cycle.convention.id]: { ...item, ...(boards.snapshots?.[cycle.key] ?? { assignmentStatus: 'history unavailable' }) } },
    };
  }

  return {
    at: new Date(now).toISOString(),
    truncated: Math.max(0, githubCycles.length - selected.length),
    github: { status: github.status, reason: github.reason ?? null, checked: github.checked },
    azureBoards: { status: boards.status, reason: boards.reason ?? null, organization: boards.organization ?? null, checked: boards.checked },
    cycles: result,
  };
}
