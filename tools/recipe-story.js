'use strict';

const assert = require('node:assert/strict');

const TITLES = {
  workItem: 'Work item',
  branch: 'Branch seen',
  aiWork: 'AI work',
  commits: 'Commits',
  pullRequest: 'Pull request',
  review: 'Review',
  close: 'Merge & close',
};
const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const amount = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[c]);

function buildRecipeStory(view, { branch, steps, sourceId, sourceLabel }) {
  const cycle = view.cycles.find((row) => row.branch === branch);
  assert.ok(cycle, 'the README story needs its synthetic cycle');
  assert.deepEqual(steps.map((step) => step.id), Object.keys(TITLES), 'keep the seven delivery steps in order');
  let previous = -Infinity;
  const ordered = steps.map(({ id }) => {
    const step = cycle.steps[id];
    assert.equal(step?.state, 'yes', `the README story needs a completed ${id} step`);
    const at = Date.parse(step.at);
    assert.ok(Number.isFinite(at) && at >= previous, `${id} must not precede the previous delivery step`);
    previous = at;
    return { id, title: TITLES[id], at: step.at };
  });
  const report = view.billing;
  assert.equal(report?.status, 'ok', 'the README story needs a successful mocked billing read');
  assert.ok(Date.parse(report.retrievedAt) >= previous, 'the example billing read follows delivery, not its billing day');
  const source = report.sources.find((row) => row.sourceId === sourceId);
  const allocation = source?.work.find((row) => row.cycleKey === cycle.key);
  assert.ok(allocation && allocation.method === 'estimated-share', 'the story needs a matched estimated share, not an invented charge');
  const models = source.models.filter((model) => model.observed > 0);
  assert.equal(models.length, 1, 'the worked example uses one matched model');
  assert.equal(source.work.length, 1, 'the matched model usage belongs to this example cycle');
  assert.equal(allocation.grossQuantity, models[0].observed, 'the example cannot borrow another cycle or unlinked usage');
  const items = report.items.filter((item) => item.model.toLowerCase() === models[0].model.toLowerCase());
  const billedCredits = items.reduce((sum, item) => sum + item.grossQuantity, 0);
  const finalCharge = items.reduce((sum, item) => sum + item.netAmount, 0);
  assert.ok(billedCredits > 0 && allocation.grossQuantity <= billedCredits && finalCharge >= 0);
  assert.ok(Number.isFinite(allocation.netAmount) &&
    Math.abs(allocation.netAmount - finalCharge * allocation.grossQuantity / billedCredits) < 1e-9,
  'the displayed cost must be the real calculated share');
  assert.ok(report.scope.day < report.retrievedAt.slice(0, 10), 'billing covers a completed UTC day');
  return {
    repository: cycle.repository,
    branch: cycle.branch,
    steps: ordered,
    workItem: cycle.workItems.map((item) => item.reference).join(', '),
    pullRequest: cycle.pullRequest.number,
    commits: cycle.pullRequest.commits.total,
    billing: {
      at: report.retrievedAt, day: report.scope.day, user: report.scope.user,
      sourceLabel, model: models[0].model, credits: allocation.grossQuantity,
      billedCredits, finalCharge, estimatedCost: allocation.netAmount,
    },
  };
}

function renderRecipeStory(story) {
  const text = (x, y, value, cls = '') => `<text x="${x}" y="${y}" class="${cls}">${escape(value)}</text>`;
  const b = story.billing;
  const details = [
    story.workItem, 'Branch recorded', 'Usage recorded', `${story.commits} commits`,
    `PR #${story.pullRequest} opened`, 'Review submitted', 'PR and item closed',
  ];
  const cards = story.steps.map((step, i) => {
    const x = 24 + i * 172;
    const phase = i < 2 ? 'work' : i < 4 ? 'ai' : 'delivery';
    return `<g data-story-step="${step.id}">
      <rect x="${x}" y="170" width="158" height="188" rx="12" class="card ${phase}"/>
      <circle cx="${x + 25}" cy="201" r="14" class="number ${phase}"/>
      ${text(x + 21, 206, i + 1, 'number-label')}
      ${text(x + 14, 243, step.title, 'step-title')}
      ${text(x + 14, 272, details[i], 'detail')}
      ${text(x + 14, 328, day.format(new Date(step.at)), 'date')}
    </g>`;
  }).join('');
  const arrows = story.steps.slice(1).map((_, i) => {
    const x = 24 + i * 172 + 158;
    return `<path d="M${x + 2} 264 H${x + 11} l-4 -4 m4 4 l-4 4" class="arrow"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="560" viewBox="0 0 1440 560" role="img" aria-labelledby="title desc" data-recipe-story="true">
    <title id="title">An ordered development cycle with a separate final billing check</title>
    <desc id="desc">Synthetic example. Seven delivery steps run left to right in date order. A mocked billing read follows visually; its work cost is an estimate, not a per-pull-request invoice.</desc>
    <style>
      text { font-family: "Segoe UI", Arial, sans-serif; fill: #1f2328; font-size: 14px; }
      .heading { font-size: 26px; font-weight: 600; }
      .muted, .detail { fill: #59636e; }
      .tag, .phase { font-size: 12px; font-weight: 600; letter-spacing: .6px; }
      .card { stroke: #d1d9e0; stroke-width: 1.2; fill: #fff; }
      .card.work { fill: #f6f0ff; } .card.ai { fill: #fff4e8; } .card.delivery { fill: #ecf8f0; }
      .number.work { fill: #8250df; } .number.ai { fill: #a34c00; } .number.delivery { fill: #1a7f37; }
      .number-label { fill: #fff; font-weight: 600; }
      .step-title { font-size: 16px; font-weight: 600; }
      .date { font-size: 18px; font-weight: 600; }
      .arrow { fill: none; stroke: #59636e; stroke-width: 1.5; }
      .billing { fill: #eef6ff; stroke: #0969da; stroke-width: 1.2; stroke-dasharray: 5 4; }
      .bill-link { fill: none; stroke: #0969da; stroke-width: 1.5; stroke-dasharray: 3 3; }
      .summary { fill: #f6f8fa; stroke: #d1d9e0; }
      .formula { font-size: 16px; font-weight: 600; }
      .small { fill: #59636e; font-size: 12px; }
    </style>
    <rect width="1440" height="560" fill="#fff"/>
    ${text(24, 40, 'One ordered cycle, from work to the bill', 'heading')}
    ${text(1240, 36, 'SYNTHETIC EXAMPLE', 'tag')}
    ${text(24, 72, `${story.repository}  |  ${story.branch}  |  ${b.at.slice(0, 4)} - all dates UTC`, 'muted')}
    ${text(24, 112, 'Seven delivery steps. Billing is a separate check, not an eighth completion step.', 'muted')}
    ${text(38, 152, 'START WITH WORK', 'phase')}
    ${text(382, 152, 'AI-ASSISTED WORK', 'phase')}
    ${text(726, 152, 'DELIVER THE CHANGE', 'phase')}
    ${text(1248, 152, 'SEPARATE CHECK', 'phase')}
    ${cards}${arrows}
    <g data-story-billing="true">
      <path d="M1218 264 H1238" class="bill-link"/>
      <rect x="1242" y="170" width="174" height="188" rx="12" class="billing"/>
      ${text(1256, 205, 'MOCK API READ', 'tag')}
      ${text(1256, 243, 'Billing checked', 'step-title')}
      ${text(1256, 272, 'Estimated share', 'detail')}
      ${text(1256, 296, amount.format(b.estimatedCost), 'formula')}
      ${text(1256, 328, day.format(new Date(b.at)), 'date')}
    </g>
    <rect x="24" y="390" width="1392" height="132" rx="12" class="summary"/>
    ${text(44, 418, `Report for ${day.format(new Date(b.day))}, read after delivery on ${day.format(new Date(b.at))}`, 'step-title')}
    ${text(44, 446, `${b.user}  |  ${b.sourceLabel}  |  ${b.model}  |  only this source, account, UTC day and model`, 'detail')}
    ${text(44, 475, `${b.credits} recorded credits / ${b.billedCredits} billed credits x ${amount.format(b.finalCharge)} charge after discounts = ${amount.format(b.estimatedCost)} estimated work cost`, 'formula')}
    ${text(44, 503, 'Sources are not summed. Unmatched charges stay unassigned. The API supplies no currency; this is not an invoice for the PR.', 'detail')}
    ${text(24, 547, 'Branch seen means first recorded context, not proof of branch creation. Billing does not extend delivery time or have to wait for merge.', 'small')}
  </svg>`;
}

module.exports = { buildRecipeStory, renderRecipeStory };
