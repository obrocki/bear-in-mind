#!/usr/bin/env node
'use strict';

/**
 * Runs the unit tests.
 *
 *   node tools/run-tests.js
 *
 * The code under test is TypeScript, and there is no compile step in the normal
 * loop, so the modules are bundled to a scratch directory with esbuild first and
 * the tests import that. Only `vscode`-free modules can be covered this way,
 * which is exactly why the parsing and aggregation live in their own files.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const repoRoot = path.resolve(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bear-tests-'));

const ENTRIES = ['src/otelParse.ts', 'src/otelSummary.ts', 'src/tokenMeter.ts', 'src/reportingAdapter.ts'];

/**
 * `src/tokenMeter.ts` imports `vscode`, which does not exist outside the
 * extension host. Pointing the bundler at a stub is what makes the accounting
 * testable at all — it is the riskiest code here, so "it imports vscode" was
 * not a good enough reason to leave it uncovered.
 */
const vscodeStub = {
  name: 'vscode-stub',
  setup(build) {
    build.onResolve({ filter: /^vscode$/ }, () => ({
      path: path.join(repoRoot, 'test', 'vscode-stub.js')
    }));
  }
};

async function main() {
  await esbuild.build({
    entryPoints: ENTRIES.map((e) => path.join(repoRoot, e)),
    outdir: outDir,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    plugins: [vscodeStub],
    logLevel: 'warning'
  });

  const testDir = path.join(repoRoot, 'test');
  const testFiles = fs
    .readdirSync(testDir)
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => path.join(testDir, name));

  const result = spawnSync(
    process.execPath,
    ['--test', ...testFiles],
    { stdio: 'inherit', env: { ...process.env, BEAR_TEST_BUILD: outDir } }
  );

  fs.rmSync(outDir, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}

main().catch((err) => {
  console.error(err);
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
});
