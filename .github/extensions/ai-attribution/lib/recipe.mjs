// The Recipe view: one AI-assisted delivery cycle per repository branch.
//
//   Ingredients  work item (GitHub issue or Azure Boards work item) → branch
//   Method       AI-assisted sessions → commits
//   Serve        pull request → review → merge and close the work item
//
// Pure: no I/O. Coverage readers feed a CycleCollector; verify.mjs adds what
// GitHub and Azure Boards report; recipeView() turns both into the view model.
// Credits stay per source and are never summed across sources.

import { branchName, parseBranchWorkItem } from './convention.mjs';

export const RECIPE_STEPS = ['workItem', 'branch', 'aiWork', 'commits', 'pullRequest', 'review', 'close'];
const STEP_PHASE = {
  workItem: 'ingredients',
  branch: 'ingredients',
  aiWork: 'method',
  commits: 'method',
  pullRequest: 'serve',
  review: 'serve',
  close: 'serve',
};
const EVIDENCE_RANK = { verified: 4, recorded: 3, convention: 2, observed: 1 };
const NANO_AIU_PER_CREDIT = 1_000_000_000;
const HOUR_MS = 3_600_000;
const MAX_CYCLES = 200;
const ACTIVITY_BINS = 40;
const ID = /^[1-9]\d{0,8}$/;

const credits = (nano) => nano / NANO_AIU_PER_CREDIT;
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const msOf = (value) => (value ? Date.parse(value) : NaN);

/** owner/name on github.com; coverage keeps other hosts as host/path. */
export function isGitHubRepository(repository) {
  return typeof repository === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(repository);
}

function sameRepository(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/**
 * A PR or issue number from a recorded reference: `12`, `#12`, `owner/name#12`
 * or a github.com pull/issue URL. References to another repository are dropped.
 */
export function refNumber(value, repository) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  let match = /^#?(\d{1,9})$/.exec(text);
  if (match) return ID.test(match[1]) ? Number(match[1]) : null;
  match = /^([\w.-]+\/[\w.-]+)#(\d{1,9})$/.exec(text);
  if (match) return sameRepository(match[1], repository) && ID.test(match[2]) ? Number(match[2]) : null;
  match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d{1,9})\/?$/i.exec(text);
  if (match) return sameRepository(match[1], repository) && ID.test(match[2]) ? Number(match[2]) : null;
  return null;
}

export function commitSha(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^[0-9a-f]{7,40}$/i.test(text) ? text.toLowerCase() : null;
}

function earliest(map, key, at) {
  const known = map.get(key);
  if (known === undefined || (Number.isFinite(at) && (!Number.isFinite(known) || at < known))) map.set(key, at);
}

// ------------------------------------------------------------- collector ---

/** Accumulates local evidence per (repository, branch) while coverage scans its stores. */
export class CycleCollector {
  constructor() {
    this.cycles = new Map();
    this.unlinked = new Map();
    this.droppedRefs = 0;
  }

  #key(repository, branch) {
    return `${repository}\u0000${branch ?? ''}`;
  }

  #cycle(repository, branch) {
    const key = this.#key(repository, branch);
    let cycle = this.cycles.get(key);
    if (!cycle) {
      cycle = {
        repository,
        branch,
        sources: new Map(),
        hours: new Map(),
        first: Infinity,
        last: -Infinity,
        issues: new Map(),
        pullRequests: new Map(),
        commits: new Map(),
        heads: new Map(),
      };
      this.cycles.set(key, cycle);
    }
    return cycle;
  }

  /** One model call. Calls without a repository are tallied as unlinked AI work. */
  addCall(source, { repository, branch, commit, session, at, nano = 0, credited = false }) {
    if (!repository) {
      const u = this.unlinked.get(source) ?? { calls: 0, creditedCalls: 0, nano: 0 };
      u.calls += 1;
      u.creditedCalls += credited ? 1 : 0;
      u.nano += nano;
      this.unlinked.set(source, u);
      return;
    }
    const cycle = this.#cycle(repository, branchName(branch));
    const s = cycle.sources.get(source) ?? { sessions: new Set(), calls: 0, creditedCalls: 0, nano: 0 };
    s.calls += 1;
    s.creditedCalls += credited ? 1 : 0;
    s.nano += nano;
    if (session) s.sessions.add(String(session));
    cycle.sources.set(source, s);
    if (Number.isFinite(at) && at > 0) {
      cycle.first = Math.min(cycle.first, at);
      cycle.last = Math.max(cycle.last, at);
      const hour = Math.floor(at / HOUR_MS) * HOUR_MS;
      const bucket = cycle.hours.get(hour) ?? new Map();
      const b = bucket.get(source) ?? { calls: 0, nano: 0 };
      b.calls += 1;
      b.nano += nano;
      bucket.set(source, b);
      cycle.hours.set(hour, bucket);
    }
    const sha = commitSha(commit);
    if (sha) earliest(cycle.heads, sha, at);
  }

  /** A recorded issue, PR or commit reference; attached only to a cycle with AI work in the window. */
  addRef({ repository, branch, type, value, at }) {
    if (!repository) return;
    const cycle = this.cycles.get(this.#key(repository, branchName(branch)));
    if (!cycle) return;
    if (type === 'commit') {
      const sha = commitSha(value);
      if (sha) earliest(cycle.commits, sha, at);
      else this.droppedRefs += 1;
      return;
    }
    if (type !== 'pr' && type !== 'issue') return;
    const number = refNumber(value, repository);
    if (number === null) {
      this.droppedRefs += 1;
      return;
    }
    earliest(type === 'pr' ? cycle.pullRequests : cycle.issues, number, at);
  }
}

/** Serializable local recipe: cycles sorted by latest activity. */
export function buildRecipe(collector, { generatedAt, window } = {}) {
  const all = [...collector.cycles.values()].sort((a, b) => b.last - a.last);
  const pairs = (map, name) =>
    [...map.entries()]
      .map(([k, at]) => ({ [name]: k, at: iso(at) }))
      .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  return {
    generatedAt,
    window,
    truncated: Math.max(0, all.length - MAX_CYCLES),
    droppedRefs: collector.droppedRefs,
    unlinked: [...collector.unlinked.entries()].map(([id, u]) => ({
      id,
      calls: u.calls,
      creditedCalls: u.creditedCalls,
      credits: credits(u.nano),
    })),
    cycles: all.slice(0, MAX_CYCLES).map((c) => ({
      key: `${c.repository}#${c.branch ?? ''}`,
      repository: c.repository,
      branch: c.branch,
      github: isGitHubRepository(c.repository),
      convention: parseBranchWorkItem(c.branch ?? ''),
      first: iso(c.first),
      last: iso(c.last),
      sources: [...c.sources.entries()].map(([id, s]) => ({
        id,
        sessions: s.sessions.size,
        calls: s.calls,
        creditedCalls: s.creditedCalls,
        credits: credits(s.nano),
      })),
      hours: [...c.hours.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([hour, bySource]) => ({
          at: iso(hour),
          sources: Object.fromEntries(
            [...bySource.entries()].map(([id, b]) => [id, { calls: b.calls, credits: credits(b.nano) }]),
          ),
        })),
      issues: pairs(c.issues, 'number'),
      pullRequests: pairs(c.pullRequests, 'number'),
      commits: pairs(c.commits, 'sha'),
      heads: pairs(c.heads, 'sha'),
    })),
  };
}

// ------------------------------------------------------------------ view ---

function bestEvidence(list) {
  return list.reduce((best, e) => (e && (!best || EVIDENCE_RANK[e] > EVIDENCE_RANK[best]) ? e : best), null);
}

function minIso(values) {
  const ms = values.map(msOf).filter(Number.isFinite);
  return ms.length ? iso(Math.min(...ms)) : null;
}

function maxIso(values) {
  const ms = values.map(msOf).filter(Number.isFinite);
  return ms.length ? iso(Math.max(...ms)) : null;
}

function hoursBetween(from, to) {
  const a = msOf(from);
  const b = msOf(to);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? (b - a) / HOUR_MS : null;
}

function median(values) {
  const sorted = values.filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** A GitHub issue counts as done only when closed as completed (or without a reason). */
export function githubIssueClosed(issue) {
  return issue?.state === 'CLOSED' && (issue.stateReason === undefined || issue.stateReason === null || issue.stateReason === 'COMPLETED');
}

/** Azure Boards work items are done in the Resolved or Completed state category. */
export function boardsItemClosed(item) {
  return item?.category === 'Completed' || item?.category === 'Resolved';
}

function workItemsFor(cycle, checked) {
  const items = new Map();
  const add = (provider, id, repository, evidence, at, extra = {}) => {
    const key = `${provider}:${repository ?? ''}:${id}`;
    const item = items.get(key) ?? { provider, id, repository, evidences: [], at: null };
    item.evidences.push(evidence);
    if (at && (!item.at || at < item.at)) item.at = at;
    Object.assign(item, extra);
    items.set(key, item);
  };
  if (cycle.convention?.provider === 'github') add('github', cycle.convention.id, cycle.repository, 'convention', null);
  if (cycle.convention?.provider === 'azure-boards') add('azure-boards', cycle.convention.id, null, 'convention', null);
  for (const issue of cycle.issues) add('github', issue.number, cycle.repository, 'recorded', issue.at);
  for (const issue of checked?.pullRequest?.closingIssues ?? []) {
    add('github', issue.number, issue.repository ?? cycle.repository, 'verified', issue.createdAt, {
      closing: true,
      verified: { found: true, ...issue },
    });
  }

  return [...items.values()].map((item) => {
    let verified = item.verified ?? null;
    if (!verified && item.provider === 'github' && sameRepository(item.repository, cycle.repository)) {
      verified = checked?.issues?.[item.id] ?? null;
    }
    if (!verified && item.provider === 'azure-boards') verified = checked?.workItems?.[item.id] ?? null;
    const found = verified ? verified.found !== false : null;
    const closed = verified?.found === false ? false : item.provider === 'github' ? githubIssueClosed(verified) : boardsItemClosed(verified);
    return {
      provider: item.provider,
      id: item.id,
      repository: item.provider === 'github' ? item.repository : null,
      reference: item.provider === 'azure-boards' ? `AB#${item.id}` : sameRepository(item.repository, cycle.repository) ? `#${item.id}` : `${item.repository}#${item.id}`,
      evidence: found ? 'verified' : bestEvidence(item.evidences.filter((e) => e !== 'verified')) ?? 'convention',
      via: [...new Set(item.evidences)],
      closing: Boolean(item.closing),
      found,
      checked: Boolean(verified),
      type: verified?.type ?? null,
      state: verified?.state ?? null,
      category: verified?.category ?? null,
      stateReason: verified?.stateReason ?? null,
      createdAt: verified?.createdAt ?? null,
      activatedAt: verified?.activatedAt ?? null,
      closedAt: verified?.closedAt ?? verified?.resolvedAt ?? null,
      closed: Boolean(verified && closed),
      at: verified?.createdAt ?? item.at,
    };
  });
}

function step(state, evidence = null, at = null, detail = '') {
  return { state, evidence, at, detail };
}

function cycleSteps(cycle, checked, workItems) {
  const github = cycle.github;
  const verifiedGithub = Boolean(checked?.github);
  const pr = checked?.pullRequest ?? null;
  const steps = {};

  const live = workItems.filter((w) => w.found !== false);
  steps.workItem = live.length
    ? step('yes', bestEvidence(live.map((w) => w.evidence)), minIso(live.map((w) => w.at)), live.map((w) => w.reference).join(', '))
    : step('no', null, null, workItems.length ? `${workItems.map((w) => w.reference).join(', ')} not found` : 'No work item linked');

  steps.branch = cycle.branch
    ? step('yes', 'observed', cycle.first, cycle.convention ? `Follows the convention (${cycle.convention.reference})` : 'Does not follow the convention')
    : step('no', null, null, 'No branch recorded');

  const calls = cycle.sources.reduce((n, s) => n + s.calls, 0);
  steps.aiWork = step('yes', 'observed', cycle.first, `${calls} model call${calls === 1 ? '' : 's'} across ${cycle.sources.length} source${cycle.sources.length === 1 ? '' : 's'}`);

  const prCommits = pr?.commits?.total ?? 0;
  const headMoves = Math.max(0, cycle.heads.length - 1);
  if (pr && prCommits > 0) steps.commits = step('yes', 'verified', pr.commits.items[0]?.at ?? null, `${prCommits} commit${prCommits === 1 ? '' : 's'} on the PR`);
  else if (cycle.commits.length) steps.commits = step('yes', 'recorded', cycle.commits[0].at, `${cycle.commits.length} recorded commit${cycle.commits.length === 1 ? '' : 's'}`);
  else if (headMoves) steps.commits = step('yes', 'observed', cycle.heads[1].at, `Head moved ${headMoves} time${headMoves === 1 ? '' : 's'} during AI work`);
  else if (pr) steps.commits = step('no', 'verified', null, 'The PR has no commits');
  else steps.commits = step('unknown', null, null, github && !verifiedGithub ? 'Verify to read commits from the PR' : 'No commits recorded locally');

  const mentioned = checked?.mentioned ?? [];
  if (pr) steps.pullRequest = step('yes', 'verified', pr.createdAt, `#${pr.number} (${pr.isDraft ? 'draft' : pr.state.toLowerCase()})${checked.candidates > 1 ? `, ${checked.candidates} PRs on this branch` : ''}`);
  else if (verifiedGithub) {
    steps.pullRequest = step('no', mentioned.length ? 'verified' : null, null, mentioned.length ? `Referenced ${mentioned.map((p) => `#${p.number}`).join(', ')} on another branch` : 'No PR for this branch');
  } else if (cycle.pullRequests.length) {
    steps.pullRequest = step('yes', 'recorded', cycle.pullRequests[0].at, cycle.pullRequests.map((p) => `#${p.number}`).join(', '));
  } else steps.pullRequest = step('unknown', null, null, github ? 'Verify to find the PR' : 'Only github.com repositories can be verified');

  if (pr) {
    const reviews = pr.reviews?.items ?? [];
    steps.review = (pr.reviews?.total ?? 0) > 0
      ? step('yes', 'verified', minIso(reviews.map((r) => r.at)), `${pr.reviews.total} review${pr.reviews.total === 1 ? '' : 's'}${pr.reviewDecision ? ` · ${pr.reviewDecision.toLowerCase().replace(/_/g, ' ')}` : ''}`)
      : step('no', 'verified', null, 'No reviews');
  } else if (steps.pullRequest.state === 'no') steps.review = step('no', null, null, 'No PR');
  else steps.review = step('unknown', null, null, 'Verify to read reviews');

  if (pr) {
    const merged = pr.state === 'MERGED';
    const items = live;
    const unchecked = items.filter((w) => !w.checked);
    const open = items.filter((w) => w.checked && !w.closed);
    if (!merged) steps.close = step('no', 'verified', null, pr.state === 'CLOSED' ? 'PR closed without merge' : 'PR not merged yet');
    else if (open.length) steps.close = step('no', 'verified', null, `Merged; ${open.map((w) => `${w.reference} ${w.state ?? 'open'}`).join(', ')}`);
    else if (unchecked.length) steps.close = step('unknown', 'verified', pr.mergedAt, `Merged; ${unchecked.map((w) => w.reference).join(', ')} not verified`);
    else steps.close = step('yes', 'verified', maxIso([pr.mergedAt, ...items.map((w) => w.closedAt)]), items.length ? `Merged; ${items.map((w) => w.reference).join(', ')} closed` : 'Merged; no work item to close');
  } else if (steps.pullRequest.state === 'no') steps.close = step('no', null, null, 'No PR');
  else steps.close = step('unknown', null, null, 'Verify to read merge and closure');

  return steps;
}

function binActivity(hours, start, end) {
  const from = msOf(start);
  const to = msOf(end);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
  const span = Math.max(to - from, HOUR_MS);
  const bins = Array.from({ length: ACTIVITY_BINS }, () => ({ calls: 0, credits: {} }));
  for (const hour of hours) {
    const at = msOf(hour.at);
    const index = Math.min(ACTIVITY_BINS - 1, Math.max(0, Math.floor(((at - from) / span) * ACTIVITY_BINS)));
    for (const [id, v] of Object.entries(hour.sources)) {
      bins[index].calls += v.calls;
      bins[index].credits[id] = (bins[index].credits[id] ?? 0) + v.credits;
    }
  }
  return bins;
}

function cycleEvents(cycle, steps, workItems, pr) {
  const events = [];
  const push = (kind, at, evidence, label) => {
    if (at) events.push({ kind, at, evidence, label });
  };
  for (const w of workItems.filter((x) => x.found !== false)) {
    push('workItemCreated', w.createdAt, w.evidence, `${w.reference} created${w.type ? ` (${w.type})` : ''}`);
    push('workItemActivated', w.activatedAt, w.evidence, `${w.reference} activated`);
    if (!w.createdAt && w.at) push('workItemReferenced', w.at, w.evidence, `${w.reference} referenced`);
  }
  push('branch', steps.branch.state === 'yes' ? cycle.first : null, 'observed', `First AI work on ${cycle.branch}`);
  const commits = pr?.commits?.items?.length
    ? pr.commits.items.map((c) => ({ ...c, evidence: 'verified' }))
    : [...cycle.commits.map((c) => ({ ...c, evidence: 'recorded' })), ...cycle.heads.slice(1).map((c) => ({ ...c, evidence: 'observed' }))];
  for (const c of commits) push('commit', c.at, c.evidence, `Commit ${c.sha.slice(0, 7)}`);
  if (pr) push('pullRequest', pr.createdAt, 'verified', `PR #${pr.number} opened`);
  else for (const p of cycle.pullRequests) push('pullRequest', p.at, 'recorded', `PR #${p.number} referenced`);
  for (const r of pr?.reviews?.items ?? []) push('review', r.at, 'verified', `Review: ${String(r.state).toLowerCase().replace(/_/g, ' ')}`);
  if (pr?.mergedAt) push('merged', pr.mergedAt, 'verified', `PR #${pr.number} merged`);
  else if (pr?.closedAt) push('prClosed', pr.closedAt, 'verified', `PR #${pr.number} closed unmerged`);
  for (const w of workItems.filter((x) => x.closed)) push('workItemClosed', w.closedAt, 'verified', `${w.reference} closed`);
  return events.sort((a, b) => a.at.localeCompare(b.at));
}

function sourceCredits(cycles) {
  const totals = new Map();
  for (const c of cycles) {
    for (const s of c.sources) {
      const t = totals.get(s.id) ?? { id: s.id, credits: 0, cycles: 0 };
      t.credits += s.credits;
      t.cycles += 1;
      totals.set(s.id, t);
    }
  }
  return [...totals.values()];
}

/**
 * The Recipe view model. `verification` is verify.mjs output or null; cycles
 * it did not cover stay unverified, and unknown steps stay unknown, not zero.
 */
export function recipeView(recipe, verification = null) {
  const cycles = (recipe?.cycles ?? []).map((cycle) => {
    const checked = verification?.cycles?.[cycle.key] ?? null;
    const workItems = workItemsFor(cycle, checked);
    const steps = cycleSteps(cycle, checked, workItems);
    const pr = checked?.pullRequest ?? null;
    let strict = 0;
    for (const id of RECIPE_STEPS) {
      if (steps[id].state !== 'yes') break;
      strict += 1;
    }
    const pickup = minIso([cycle.first, ...workItems.map((w) => w.activatedAt)]);
    const done = steps.close.state === 'yes' ? steps.close.at : null;
    const spanStart = minIso([pickup, pr?.createdAt, ...cycle.commits.map((c) => c.at)]);
    const spanEnd = maxIso([cycle.last, pr?.mergedAt, pr?.closedAt, ...(pr?.reviews?.items ?? []).map((r) => r.at), ...workItems.map((w) => w.closedAt)]);
    return {
      key: cycle.key,
      repository: cycle.repository,
      branch: cycle.branch,
      github: cycle.github,
      convention: cycle.convention,
      first: cycle.first,
      last: cycle.last,
      sources: cycle.sources,
      verified: Boolean(checked?.github),
      workItems,
      pullRequest: pr,
      candidates: checked?.candidates ?? 0,
      steps,
      reached: strict,
      events: cycleEvents(cycle, steps, workItems, pr),
      span: { start: spanStart, end: spanEnd },
      activity: binActivity(cycle.hours ?? [], spanStart, spanEnd),
      leadTimeHours: done ? hoursBetween(pickup, done) : null,
    };
  });

  const stations = RECIPE_STEPS.map((id, index) => {
    const evidence = { verified: 0, recorded: 0, convention: 0, observed: 0 };
    let any = 0;
    let unknown = 0;
    let strict = 0;
    let stoppedUnknown = 0;
    for (const c of cycles) {
      const s = c.steps[id];
      if (s.state === 'yes') {
        any += 1;
        if (s.evidence) evidence[s.evidence] += 1;
      }
      if (s.state === 'unknown') unknown += 1;
      if (c.reached > index) strict += 1;
      else if (c.reached === index && s.state === 'unknown') stoppedUnknown += 1;
    }
    return { id, phase: STEP_PHASE[id], any, unknown, strict, stoppedUnknown, evidence };
  });

  const merged = cycles.filter((c) => c.pullRequest?.state === 'MERGED');
  const withConvention = cycles.filter((c) => c.convention);
  const ingredients = new Map();
  for (const c of cycles) {
    const primary = c.workItems.find((w) => w.found !== false);
    const label = !primary
      ? 'No work item'
      : primary.provider === 'azure-boards'
        ? `Azure Boards · ${primary.type ?? 'work item'}`
        : `GitHub · ${primary.type ?? 'issue'}`;
    const entry = ingredients.get(label) ?? { label, provider: primary?.provider ?? null, cycles: [], closed: 0 };
    entry.cycles.push(c);
    if (c.steps.close.state === 'yes' && primary) entry.closed += 1;
    ingredients.set(label, entry);
  }

  return {
    generatedAt: recipe?.generatedAt ?? null,
    window: recipe?.window ?? null,
    verification: verification
      ? { at: verification.at, github: verification.github, azureBoards: verification.azureBoards, truncated: verification.truncated ?? 0 }
      : null,
    totals: {
      cycles: cycles.length,
      github: cycles.filter((c) => c.github).length,
      verified: cycles.filter((c) => c.verified).length,
      truncated: recipe?.truncated ?? 0,
      droppedRefs: recipe?.droppedRefs ?? 0,
      unlinked: recipe?.unlinked ?? [],
    },
    stations,
    adherence: {
      cycles: cycles.length,
      azureBoards: withConvention.filter((c) => c.convention.provider === 'azure-boards').length,
      github: withConvention.filter((c) => c.convention.provider === 'github').length,
      nonConforming: cycles.filter((c) => c.branch && !c.convention).length,
      noBranch: cycles.filter((c) => !c.branch).length,
      credits: {
        conforming: sourceCredits(withConvention),
        nonConforming: sourceCredits(cycles.filter((c) => !c.convention)),
      },
    },
    ingredients: [...ingredients.values()]
      .map((e) => ({ label: e.label, provider: e.provider, cycles: e.cycles.length, closed: e.closed, credits: sourceCredits(e.cycles) }))
      .sort((a, b) => (a.provider === null) - (b.provider === null) || b.cycles - a.cycles),
    kpis: {
      verifiedCycles: cycles.filter((c) => c.verified).length,
      prOpened: cycles.filter((c) => c.steps.pullRequest.state === 'yes').length,
      reviewed: cycles.filter((c) => c.steps.review.state === 'yes').length,
      merged: merged.length,
      closed: cycles.filter((c) => c.steps.close.state === 'yes').length,
      medianPickupToDoneHours: median(cycles.map((c) => c.leadTimeHours)),
      medianOpenToMergeHours: median(merged.map((c) => hoursBetween(c.pullRequest.createdAt, c.pullRequest.mergedAt))),
      medianOpenToFirstReviewHours: median(
        cycles.filter((c) => c.pullRequest && c.steps.review.state === 'yes').map((c) => hoursBetween(c.pullRequest.createdAt, c.steps.review.at)),
      ),
      creditsPerMergedPr: sourceCredits(merged).map((s) => ({ id: s.id, merged: s.cycles, credits: s.cycles ? s.credits / s.cycles : null })),
    },
    cycles: cycles.sort((a, b) => b.reached - a.reached || (b.last ?? '').localeCompare(a.last ?? '')),
  };
}
