'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { it } = require('node:test');
const { buildRecipeStory, renderRecipeStory } = require('../tools/recipe-story');

const ids = ['workItem', 'branch', 'aiWork', 'commits', 'pullRequest', 'review', 'close'];
const options = {
  branch: 'mona/61-rate-limits',
  steps: ids.map((id) => ({ id })),
  sourceId: 'traces',
  sourceLabel: 'VS Code \u00b7 Local harness',
};

it('README story: both READMEs embed the generated PNG accepted by Marketplace packaging', () => {
  const root = path.resolve(__dirname, '..');
  for (const readme of [
    path.join(root, 'README.md'),
    path.join(root, '.github', 'extensions', 'ai-attribution', 'README.md'),
  ]) {
    const markdown = fs.readFileSync(readme, 'utf8');
    const images = [...markdown.matchAll(/!\[[^\]]*\]\(([^)\s]*recipe-flow\.\w+)\)/g)].map((match) => match[1]);
    assert.ok(images.length, `${readme}: keep the generated flow illustration`);
    for (const image of images) {
      assert.equal(path.extname(image), '.png', `${readme}: vsce rejects the SVG illustration`);
      assert.ok(fs.existsSync(path.resolve(path.dirname(readme), ...image.split('/'))), 'the embedded PNG must exist');
    }
  }
});

function fixture() {
  return {
    cycles: [{
      key: 'demo',
      repository: 'contoso/api',
      branch: options.branch,
      steps: Object.fromEntries(ids.map((id, i) => [id, {
        state: 'yes', at: `2026-10-${[14, 16, 16, 17, 19, 20, 21][i]}T10:00:00.000Z`,
      }])),
      workItems: [{ reference: '#61' }],
      pullRequest: { number: 90, commits: { total: 2 } },
    }],
    billing: {
      status: 'ok',
      retrievedAt: '2026-10-22T12:00:00.000Z',
      scope: { user: 'octocat', day: '2026-10-18' },
      items: [{ model: 'gpt-5', grossQuantity: 8, netAmount: 0.04 }],
      sources: [{
        sourceId: 'traces',
        models: [{ model: 'gpt-5', observed: 5.7 }],
        work: [{ cycleKey: 'demo', method: 'estimated-share', grossQuantity: 5.7, netAmount: 0.0285 }],
      }],
    },
  };
}

it('README story: preserves ordered delivery and calculates the matched billing estimate', () => {
  const story = buildRecipeStory(fixture(), options);
  assert.deepEqual(story.steps.map((step) => step.id), ids);
  assert.equal(story.billing.day, '2026-10-18');
  assert.equal(story.billing.at, '2026-10-22T12:00:00.000Z');
  assert.equal(story.billing.estimatedCost, 0.0285);
  const svg = renderRecipeStory(story);
  assert.equal((svg.match(/data-story-step=/g) ?? []).length, 7);
  assert.ok(svg.indexOf('data-story-billing=') > svg.indexOf('data-story-step="close"'));
  for (const phrase of ['SYNTHETIC EXAMPLE', 'MOCK API READ', 'Estimated share', 'not an eighth', 'not an invoice', 'not proof of branch creation']) {
    assert.ok(svg.includes(phrase), phrase);
  }
});

it('README story: rejects reversed, missing or reordered delivery steps', () => {
  for (let i = 1; i < ids.length; i++) {
    const data = fixture();
    data.cycles[0].steps[ids[i]].at = new Date(Date.parse(data.cycles[0].steps[ids[i - 1]].at) - 1).toISOString();
    assert.throws(() => buildRecipeStory(data, options), /must not precede/);
  }
  const incomplete = fixture();
  incomplete.cycles[0].steps.close.state = 'unknown';
  assert.throws(() => buildRecipeStory(incomplete, options), /completed close/);
  assert.throws(() => buildRecipeStory(fixture(), { ...options, steps: [...options.steps].reverse() }), /seven delivery steps/);
});

it('README story: does not manufacture missing billing, estimates or a later read date', () => {
  const missing = fixture();
  missing.billing.status = 'disconnected';
  assert.throws(() => buildRecipeStory(missing, options), /successful mocked billing/);
  const unmatched = fixture();
  unmatched.billing.sources[0].work = [];
  assert.throws(() => buildRecipeStory(unmatched, options), /matched estimated share/);
  const wrongAmount = fixture();
  wrongAmount.billing.sources[0].work[0].netAmount = 0.06;
  assert.throws(() => buildRecipeStory(wrongAmount, options), /real calculated share/);
  const earlier = fixture();
  earlier.billing.retrievedAt = '2026-10-20T12:00:00.000Z';
  assert.throws(() => buildRecipeStory(earlier, options), /follows delivery/);
});

it('README story: escapes all fixture labels in the generated SVG', () => {
  const story = buildRecipeStory(fixture(), options);
  story.repository = '<script>alert("fixture")</script>&';
  const svg = renderRecipeStory(story);
  assert.ok(svg.includes('&lt;script&gt;alert(&quot;fixture&quot;)&lt;/script&gt;&amp;'));
  assert.ok(!svg.includes('<script>'));
});
