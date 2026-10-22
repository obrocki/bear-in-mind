// Provider-qualified identities. Device names, branch prefixes and display names
// never become account keys; cross-provider links must be supplied explicitly.
export function githubActor(login, kind = 'User') {
  if (typeof login !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?(?:\[bot\])?$/i.test(login)) return null;
  const bot = kind === 'Bot' || login.endsWith('[bot]');
  return { key: `github:${login.toLowerCase()}`, label: login, provider: 'github', bot };
}

export function telemetryActor(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return githubActor(name) ?? { key: `telemetry:${name}`, label: name, provider: 'telemetry', bot: false };
}

export function boardsActor(value, organization) {
  if (!value || typeof value.id !== 'string' || !/^[a-f\d-]{8,64}$/i.test(value.id)) return null;
  const label = typeof value.displayName === 'string' && value.displayName.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value.displayName)
    ? value.displayName : value.id;
  return { key: `boards:${organization.toLowerCase()}:${value.id.toLowerCase()}`, label, provider: 'azure-boards', bot: false };
}

export function validateIdentityLinks(links) {
  if (!Array.isArray(links) || links.length > 32) throw new Error('Provide at most 32 identity links.');
  const seen = new Set();
  return links.map((link) => {
    if (!link || typeof link.boardsKey !== 'string' ||
        !/^boards:https:\/\/(?:dev\.azure\.com\/[a-z\d-]+|[a-z\d-]+\.visualstudio\.com):[a-f\d-]{8,64}$/i.test(link.boardsKey) ||
        !githubActor(link.githubLogin) || seen.has(link.boardsKey.toLowerCase())) {
      throw new Error('Each identity link needs a unique Azure Boards account key and a GitHub login.');
    }
    const boardsKey = link.boardsKey.toLowerCase();
    seen.add(boardsKey);
    return { boardsKey, githubLogin: link.githubLogin };
  });
}

function resolve(actor, links) {
  if (!actor) return null;
  const link = links.find((l) => l.boardsKey === actor.key);
  return link ? { ...githubActor(link.githubLogin), linkedFrom: actor.key } : actor;
}

/** Current assignment is displayed as a role, never backdated to infer usage. */
export function ownershipFor(workItems, pr, links) {
  const roles = [];
  if (pr?.author) roles.push({ role: 'PR author', actor: resolve(pr.author, links), identity: pr.author, at: pr.createdAt });
  for (const item of workItems) {
    for (const [field, role, at] of [
      ['assignees', 'Assigned now', item.assignmentCheckedAt],
      ['assigneesAtStart', 'Assigned at pickup', item.assignmentAt],
    ]) {
      for (const actor of item[field] ?? []) roles.push({ role, actor: resolve(actor, links), identity: actor, at, reference: item.reference });
    }
  }
  const historical = roles.filter((r) => r.role !== 'Assigned now' && !r.actor.bot);
  const candidates = [...new Map(historical.map((r) => [r.actor.key, r.actor])).values()];
  return {
    roles,
    inferred: candidates.length === 1 ? candidates[0] : null,
    inference: candidates.length === 1
      ? [...new Set(historical.map((r) => r.role))].join(' + ')
      : candidates.length > 1 ? 'Conflicting owners' : 'No historical owner',
  };
}

function newTally() {
  return { calls: 0, creditedCalls: 0, credits: 0 };
}

function add(tally, usage) {
  tally.calls += usage.calls;
  tally.creditedCalls += usage.creditedCalls;
  tally.credits += usage.credits ?? 0;
}

function reported(tally) {
  return { ...tally, credits: tally.creditedCalls ? tally.credits : null };
}

/** Partitions every source into disjoint measured, inferred and unattributed usage. */
export function attributeUsage(sources, ownership, links) {
  return sources.flatMap((source) => {
    const actors = source.actors ?? [{ actor: null, calls: source.calls, creditedCalls: source.creditedCalls, credits: source.credits }];
    return actors.map((usage) => ({
      source: source.id,
      ...reported(usage),
      actor: resolve(usage.actor, links) ?? ownership?.inferred ?? null,
      method: usage.actor ? 'measured' : ownership?.inferred ? 'inferred' : 'unattributed',
      evidence: usage.actor ? 'user.name' : ownership?.inference ?? 'No user identity',
    }));
  });
}

export function developerReport(cycles, unmatched, identityLinks) {
  const actors = new Map();
  const entries = [
    ...cycles.flatMap((cycle) => cycle.attribution.map((entry) => ({ ...entry, cycleKey: cycle.key }))),
    ...attributeUsage(unmatched, null, identityLinks).map((entry) => ({ ...entry, cycleKey: null })),
  ];
  for (const entry of entries) if (entry.actor) actors.set(entry.actor.key, entry.actor);
  // Owners without attributed usage remain selectable as work owners, not consumers.
  for (const cycle of cycles) for (const role of cycle.ownership.roles) actors.set(role.actor.key, role.actor);
  const summarize = (list, withWork = true) => {
    const tally = { total: newTally(), measured: newTally(), inferred: newTally(), unattributed: newTally() };
    const work = new Map();
    for (const entry of list) {
      add(tally.total, entry);
      add(tally[entry.method], entry);
      const group = work.get(entry.cycleKey) ?? [];
      group.push(entry);
      work.set(entry.cycleKey, group);
    }
    return {
      ...Object.fromEntries(Object.entries(tally).map(([key, value]) => [key, reported(value)])),
      ...(withWork ? { work: [...work.entries()].map(([cycleKey, group]) => ({ cycleKey, ...summarize(group, false) }))
        .sort((a, b) => (b.total.credits ?? -1) - (a.total.credits ?? -1)) } : {}),
    };
  };
  const sourceIds = [...new Set(entries.map((entry) => entry.source))];
  const ownedCycles = new Set(cycles.filter((cycle) => cycle.ownership.roles.length).map((cycle) => cycle.key));
  return {
    sources: sourceIds.map((id) => {
      const list = entries.filter((entry) => entry.source === id);
      return {
        id, ...summarize(list),
        unknown: summarize(list.filter((entry) => !entry.actor)),
        ownership: summarize(list.filter((entry) => ownedCycles.has(entry.cycleKey))),
        unowned: summarize(list.filter((entry) => !ownedCycles.has(entry.cycleKey))),
        actors: [...actors.keys()].map((key) => {
          const owned = new Set(cycles.filter((cycle) => cycle.ownership.roles.some((r) => r.actor.key === key)).map((cycle) => cycle.key));
          return { key, usage: summarize(list.filter((entry) => entry.actor?.key === key)), ownership: summarize(list.filter((entry) => owned.has(entry.cycleKey))) };
        }),
      };
    }),
    actors: [...actors.values()].sort((a, b) => a.label.localeCompare(b.label)),
    identityLinks,
  };
}
