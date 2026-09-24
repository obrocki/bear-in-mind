#!/usr/bin/env node
'use strict';

/** Bundle TypeScript with a VS Code stub, then run the Node test suite. */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const repoRoot = path.resolve(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bear-tests-'));

const ENTRIES = ['src/api.ts', 'src/otelParse.ts', 'src/otelSummary.ts', 'src/otelWatcher.ts', 'src/tokenMeter.ts'];

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
