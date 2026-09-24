'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { it } = require('node:test');
const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');
const lockfile = require('../package-lock.json');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const body = workflow.match(/          script: \|\r?\n([\s\S]*?)(?=\r?\n      -)/)[1]
  .split(/\r?\n/).map((line) => line.slice(12)).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const plan = new AsyncFunction('require', 'process', 'github', 'context', 'core', body);
const missing = async () => { throw Object.assign(new Error('not found'), { status: 404 }); };

async function run({ release = missing, ref = missing, tag = missing, contextRef = 'refs/heads/main' } = {}) {
  const outputs = {};
  await plan(
    (name) => name.endsWith('package.json') ? manifest : { execFileSync: () => 'tested-commit\n' },
    { env: { GITHUB_WORKSPACE: root } },
    { rest: { repos: { getReleaseByTag: release }, git: { getRef: ref, getTag: tag } } },
    { repo: { owner: 'obrocki', repo: 'bear-in-mind' }, ref: contextRef },
    { notice() {}, setOutput: (key, value) => { outputs[key] = value; } }
  );
  return outputs;
}

it('keeps release versions synchronized and waits for main CI instead of publishing from PRs', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(lockfile.version, manifest.version);
  assert.equal(lockfile.packages[''].version, manifest.version);
  assert.match(ci, /needs: build/);
  assert.match(ci, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(ci, /uses: \.\/\.github\/workflows\/release\.yml/);
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /target_commitish: \$\{\{ steps\.release\.outputs\.commit \}\}/);
});

it('plans exactly one stable tag at the tested merged commit', async () => {
  assert.deepEqual(await run(), { publish: 'true', tag: `v${manifest.version}`, commit: 'tested-commit' });
});

it('skips a version already released', async () => {
  assert.deepEqual(await run({ release: async () => ({ data: { draft: false } }) }), { publish: 'false' });
});

it('allows recovery for a matching annotated tag with no published release', async () => {
  assert.equal((await run({
    ref: async () => ({ data: { object: { type: 'tag', sha: 'annotation' } } }),
    tag: async () => ({ data: { object: { type: 'commit', sha: 'tested-commit' } } })
  })).publish, 'true');
});

it('refuses to move a tag pointing at a different commit', async () => {
  await assert.rejects(run({
    ref: async () => ({ data: { object: { type: 'commit', sha: 'different-commit' } } })
  }), /not the tested commit/);
});

it('rejects a mismatched trigger tag before publishing', async () => {
  await assert.rejects(run({ contextRef: 'refs/tags/v0.0.0' }), /does not match/);
});

it('does not mistake authentication or network errors for an unpublished version', async () => {
  await assert.rejects(run({
    release: async () => { throw Object.assign(new Error('denied'), { status: 403 }); }
  }), /denied/);
  await assert.rejects(run({
    ref: async () => { throw Object.assign(new Error('unavailable'), { status: 503 }); }
  }), /unavailable/);
});
