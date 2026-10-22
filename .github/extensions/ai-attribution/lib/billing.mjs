// Explicit GitHub billing reads. Usage reconciliation is by native consumer,
// UTC day and exact model, per source. Work-level cost is an estimated share.
import { runCommand } from './verify.mjs';
import { githubActor } from './actors.mjs';

const AMOUNTS = ['grossQuantity', 'grossAmount', 'discountQuantity', 'discountAmount', 'netQuantity', 'netAmount'];
const SOURCE_IDS = ['sessionStore', 'traces', 'agentHost'];

function utcDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function billingScope(input, now = Date.now()) {
  const { level, account, user, day } = input ?? {};
  if (!['organization', 'enterprise', 'user'].includes(level) ||
      typeof account !== 'string' || !/^[a-z\d][a-z\d-]{0,99}$/i.test(account) ||
      !githubActor(user) || !utcDay(day)) {
    throw new Error('Choose a billing level, account, GitHub login and valid UTC day.');
  }
  if (day >= new Date(now).toISOString().slice(0, 10)) throw new Error('Choose a completed UTC day, not today or a future date.');
  if (level === 'user' && account.toLowerCase() !== user.toLowerCase()) throw new Error('Personal billing can only report the selected account itself.');
  return { level, account: account.toLowerCase(), user: user.toLowerCase(), day, product: 'Copilot' };
}

function finiteAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function safeWord(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}

export function parseBillingReport(body, scope, retrievedAt) {
  const [year, month, day] = scope.day.split('-').map(Number);
  if (body?.timePeriod?.year !== year || body.timePeriod.month !== month || body.timePeriod.day !== day ||
      !Array.isArray(body.usageItems) || body.usageItems.length > 1000) throw new Error('GitHub returned a different billing period or an invalid report.');
  const accountField = scope.level === 'organization' ? 'organization' : scope.level === 'enterprise' ? 'enterprise' : 'user';
  for (const [field, expected] of [[accountField, scope.account], ['user', scope.user], ['product', scope.product]]) {
    if (body[field] !== undefined && (typeof body[field] !== 'string' || body[field].toLowerCase() !== expected.toLowerCase())) {
      throw new Error('GitHub returned a different billing account, user or product.');
    }
  }
  const items = body.usageItems.map((row) => {
    if (!safeWord(row.product) || row.product.toLowerCase() !== 'copilot' || !safeWord(row.sku) ||
        !safeWord(row.model) || !safeWord(row.unitType) ||
        !/^(ai[\s_-]?)?credits?$/i.test(row.unitType) ||
        !finiteAmount(row.pricePerUnit) || !AMOUNTS.every((key) => finiteAmount(row[key]))) {
      throw new Error('Unsupported billing units or missing amounts. No comparison was made.');
    }
    return {
      product: row.product, sku: row.sku, model: row.model, unitType: row.unitType, pricePerUnit: row.pricePerUnit,
      ...Object.fromEntries(AMOUNTS.map((key) => [key, row[key]])),
    };
  });
  return { status: 'ok', scope, retrievedAt, items };
}

export async function fetchBilling(input, { run = runCommand, now = Date.now(), env = process.env } = {}) {
  const scope = billingScope(input, now);
  const prefix = { organization: 'organizations', enterprise: 'enterprises', user: 'users' }[scope.level];
  const endpoint = `/${prefix}/${scope.account}/settings/billing/ai_credit/usage`;
  const [year, month, day] = scope.day.split('-').map(Number);
  const args = ['api', '--hostname', 'github.com', '--method', 'GET', endpoint,
    '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2026-03-10',
    '-f', `year=${year}`, '-f', `month=${month}`, '-f', `day=${day}`, '-f', 'product=Copilot'];
  if (scope.level !== 'user') args.push('-f', `user=${scope.user}`);
  const retrievedAt = new Date(now).toISOString();
  try {
    const response = await run('gh', args, { env, timeout: 30_000 });
    if (response.missing) return { status: 'error', scope, retrievedAt, reason: 'Install gh and sign in with access to the paying account.' };
    if (response.code !== 0) {
      const denied = /401|403|404|auth login|bad credentials/i.test(response.stderr);
      return { status: 'error', scope, retrievedAt,
        reason: denied ? 'Billing access denied. Use a supported credential with billing permissions on the paying account.' : 'GitHub billing request failed or timed out. Retry explicitly.' };
    }
    let body;
    try { body = JSON.parse(response.stdout); } catch { throw new Error('GitHub returned invalid billing JSON.'); }
    return parseBillingReport(body, scope, retrievedAt);
  } catch (err) {
    return { status: 'error', scope, retrievedAt,
      reason: err instanceof Error && /^(GitHub returned|Unsupported billing)/.test(err.message) ? err.message : 'Billing request failed. No billing data was retained.' };
  }
}

function sum(rows, field) {
  return rows.reduce((value, row) => value + row[field], 0);
}

/** A billing balance is not proof that the selected account paid for local calls. */
export function reconcileBilling(report, recipe, sourceId) {
  if (report?.status !== 'ok') return null;
  if (!SOURCE_IDS.includes(sourceId)) throw new Error('Choose a supported local usage source.');
  const scope = report.scope;
  const rows = (recipe.billingUsage ?? []).filter((row) => row.source === sourceId && row.day === scope.day);
  const userRows = rows.filter((row) => row.actor?.key === `github:${scope.user}`);
  const modelRows = new Map();
  for (const item of report.items) {
    const key = item.model.toLowerCase();
    const group = modelRows.get(key) ?? { model: item.model, items: [] };
    group.items.push(item);
    modelRows.set(key, group);
  }
  const allocations = new Map();
  let matched = 0;
  let observed = 0;
  let reportingCalls = 0;
  let modelDifference = false;
  const models = [...modelRows.entries()].map(([model, group]) => {
    const usage = userRows.filter((row) => row.model?.toLowerCase() === model);
    const credited = usage.filter((row) => row.creditedCalls > 0);
    const local = sum(credited, 'credits');
    const gross = sum(group.items, 'grossQuantity');
    const netAmount = sum(group.items, 'netAmount');
    observed += local;
    reportingCalls += sum(usage, 'creditedCalls');
    matched += Math.min(local, gross);
    if (local > gross) modelDifference = true;
    // Never distribute more than the bill. No allocation for model mismatches,
    // unknown consumers or unlinked work; those amounts remain unallocated.
    if (gross > 0 && local <= gross) {
      for (const row of credited.filter((row) => row.cycleKey)) {
        const allocation = allocations.get(row.cycleKey) ?? { cycleKey: row.cycleKey, grossQuantity: 0, netAmount: 0, method: 'estimated-share' };
        allocation.grossQuantity += row.credits;
        allocation.netAmount += netAmount * row.credits / gross;
        allocations.set(row.cycleKey, allocation);
      }
    }
    return {
      model: group.model, grossQuantity: gross, observed: credited.length ? local : null,
      difference: credited.length ? gross - local : null,
    };
  });
  const unseenModels = userRows.filter((row) => !row.model || !modelRows.has(row.model.toLowerCase()));
  const totals = Object.fromEntries(AMOUNTS.map((field) => [field, sum(report.items, field)]));
  const work = [...allocations.values()].sort((a, b) => b.grossQuantity - a.grossQuantity);
  return {
    sourceId, ...totals, models,
    observed: reportingCalls ? observed : null,
    difference: reportingCalls ? totals.grossQuantity - observed : null,
    unmatchedBilling: Math.max(0, totals.grossQuantity - matched),
    outsideModelScope: sum(unseenModels, 'credits'),
    unknownIdentity: sum(rows.filter((row) => !row.actor), 'credits'),
    localExceedsBilling: modelDifference,
    work,
    unallocatedNetAmount: Math.max(0, totals.netAmount - sum(work, 'netAmount')),
  };
}

export function billingView(report, recipe) {
  if (!report) return { status: 'disconnected' };
  return { ...report,
    sources: report.status === 'ok' ? SOURCE_IDS.map((id) => reconcileBilling(report, recipe, id)) : [],
  };
}
