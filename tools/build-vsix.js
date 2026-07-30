#!/usr/bin/env node
'use strict';

/**
 * Builds the distributable `.vsix` — and then opens it back up and checks it.
 *
 * Packaging is the one step where a mistake is invisible until someone installs
 * the result: a stray `.vscodeignore` line can drop `dist/extension.js`, and the
 * extension still packages "successfully". So this does the build and then reads
 * the archive's central directory to confirm what actually shipped.
 *
 *   node tools/build-vsix.js [options]
 *
 *   --out-dir <dir>     Directory for the .vsix (default: repo root)
 *   --out <file>        Exact output path (overrides --out-dir and --label)
 *   --label <text>      Suffix the file name, e.g. --label 3f2a1c9 gives
 *                       bear-in-mind-0.4.0+3f2a1c9.vsix
 *   --version <x.y.z>   Package as this version without touching package.json
 *   --pre-release       Flag the build as a Marketplace pre-release
 *   --skip-typecheck    Don't run tsc
 *   --skip-bundle       Reuse whatever is already in dist/
 *   --no-verify         Skip the archive checks (not recommended)
 *   --github            Write GitHub Actions outputs and a job summary
 *   --quiet             Only print the final line
 *
 * Exit code is non-zero if any step or any check fails.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const opts = {
    outDir: repoRoot,
    out: null,
    label: null,
    version: null,
    preRelease: false,
    typecheck: true,
    bundle: true,
    verify: true,
    github: false,
    quiet: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) fail(`${arg} needs a value`);
      return value;
    };

    switch (arg) {
      case '--out-dir': opts.outDir = path.resolve(repoRoot, next()); break;
      case '--out': opts.out = path.resolve(repoRoot, next()); break;
      case '--label': opts.label = next().replace(/[^A-Za-z0-9._-]/g, '-'); break;
      case '--version': opts.version = next(); break;
      case '--pre-release': opts.preRelease = true; break;
      case '--skip-typecheck': opts.typecheck = false; break;
      case '--skip-bundle': opts.bundle = false; break;
      case '--no-verify': opts.verify = false; break;
      case '--github': opts.github = true; break;
      case '--quiet': opts.quiet = true; break;
      case '-h':
      case '--help': printHelp(); process.exit(0); break;
      default: fail(`unknown option: ${arg}`);
    }
  }

  if (opts.version && !/^\d+\.\d+\.\d+$/.test(opts.version)) {
    fail(`--version must be major.minor.patch (the Marketplace rejects anything else), got "${opts.version}"`);
  }

  return opts;
}

function printHelp() {
  const header = fs.readFileSync(__filename, 'utf8').split('*/')[0];
  console.log(header.replace(/^[\s\S]*?\/\*\*\n/, '').replace(/^ \* ?/gm, '').trim());
}

// ------------------------------------------------------------------ helpers

const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s) => (colour ? `\u001b[2m${s}\u001b[0m` : s);
const bold = (s) => (colour ? `\u001b[1m${s}\u001b[0m` : s);
const green = (s) => (colour ? `\u001b[32m${s}\u001b[0m` : s);
const red = (s) => (colour ? `\u001b[31m${s}\u001b[0m` : s);

function fail(message) {
  console.error(`${red('error')} ${message}`);
  process.exit(1);
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Runs a Node script directly rather than going through npx or a `.cmd` shim.
 * Node 20+ refuses to spawn `.cmd` files without `shell: true`, and turning the
 * shell on would mean quoting paths differently per platform.
 */
function runNode(scriptPath, args, { label, quiet }) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8'
  });

  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    if (quiet) {
      process.stderr.write(result.stdout || '');
      process.stderr.write(result.stderr || '');
    }
    fail(`${label} failed with exit code ${result.status}`);
  }
  return { ms: Date.now() - started, stdout: result.stdout || '' };
}

function binaryOf(pkg, binName) {
  const manifestPath = require.resolve(`${pkg}/package.json`, { paths: [repoRoot] });
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName];
  if (!bin) fail(`${pkg} does not expose a "${binName}" binary — try npm ci`);
  return path.resolve(path.dirname(manifestPath), bin);
}

// -------------------------------------------------------------- zip reading

/**
 * Lists a zip's entries straight from its central directory. A .vsix is just a
 * zip, and this keeps the check dependency-free — no unzip binary, no library.
 */
function readZipEntries(buf) {
  const EOCD = 0x06054b50;
  const CENTRAL = 0x02014b50;

  let eocd = -1;
  const floor = Math.max(0, buf.length - 66_000); // 64k comment + the 22-byte record
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record — this is not a zip');

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== CENTRAL) {
      throw new Error(`corrupt central directory at byte ${offset}`);
    }
    const compressed = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.push({ name, size, compressed });
    offset += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

// ------------------------------------------------------------ verifification

const REQUIRED = [
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/package.json',
  'extension/dist/extension.js',
  'extension/media/main.js',
  'extension/media/style.css',
  'extension/media/icon.png',
  'extension/media/iceberg.svg',
  'extension/readme.md',
  'extension/changelog.md',
  'extension/LICENSE.txt'
];

const FORBIDDEN = [
  [/^extension\/src\//i, 'TypeScript sources'],
  [/^extension\/node_modules\//i, 'node_modules'],
  [/^extension\/tools\//i, 'media generators'],
  [/^extension\/docs\//i, 'documentation media'],
  [/^extension\/\.github\//i, 'GitHub metadata'],
  [/\.map$/i, 'source maps'],
  [/^extension\/.+\.ts$/i, 'TypeScript sources']
];

const MIN_BUNDLE_BYTES = 10 * 1024;

function verify(vsixPath, manifest) {
  const problems = [];
  const entries = readZipEntries(fs.readFileSync(vsixPath));
  const byLowerName = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
  const has = (name) => byLowerName.get(name.toLowerCase());

  for (const required of REQUIRED) {
    if (!has(required)) problems.push(`missing ${required}`);
  }

  for (const entry of entries) {
    for (const [pattern, why] of FORBIDDEN) {
      if (pattern.test(entry.name)) problems.push(`${why} leaked into the package: ${entry.name}`);
    }
  }

  // A bundle that got truncated or emptied still packages fine, so size is the
  // only cheap signal that esbuild actually produced something real.
  const bundle = has('extension/dist/extension.js');
  if (bundle && bundle.size < MIN_BUNDLE_BYTES) {
    problems.push(`dist/extension.js is only ${humanSize(bundle.size)} — the bundle looks broken`);
  }

  // Every asset the manifest points at has to exist inside the archive, or the
  // view renders with a missing icon and the Marketplace listing has no art.
  const assets = new Set();
  if (manifest.icon) assets.add(manifest.icon);
  if (manifest.main) assets.add(manifest.main.replace(/^\.\//, ''));
  for (const container of Object.values(manifest.contributes?.viewsContainers ?? {}).flat()) {
    if (container.icon) assets.add(container.icon);
  }
  for (const view of Object.values(manifest.contributes?.views ?? {}).flat()) {
    if (typeof view.icon === 'string') assets.add(view.icon);
  }
  for (const asset of assets) {
    if (!has(`extension/${asset}`)) problems.push(`package.json references ${asset}, which is not in the package`);
  }

  // Catches the classic "declared a command, never registered a handler" bug,
  // which only shows up as "command 'x' not found" once a user clicks it.
  const bundlePath = path.join(repoRoot, 'dist', 'extension.js');
  if (fs.existsSync(bundlePath)) {
    const code = fs.readFileSync(bundlePath, 'utf8');
    for (const command of manifest.contributes?.commands ?? []) {
      if (!code.includes(command.command)) {
        problems.push(`command "${command.command}" is contributed but never appears in the bundle`);
      }
    }
  }

  return { entries, problems };
}

// ---------------------------------------------------------------------- main

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const say = (...args) => { if (!opts.quiet) console.log(...args); };
  const step = (name, detail) => say(`${green('▸')} ${bold(name.padEnd(10))} ${dim(detail)}`);

  const manifestPath = path.join(repoRoot, 'package.json');
  const diskManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const version = opts.version ?? diskManifest.version;
  const extensionId = `${diskManifest.publisher}.${diskManifest.name}`;

  let outPath = opts.out;
  if (!outPath) {
    const suffix = opts.label ? `+${opts.label}` : '';
    outPath = path.join(opts.outDir, `${diskManifest.name}-${version}${suffix}.vsix`);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.rmSync(outPath, { force: true });

  say('');
  say(bold(`Building ${extensionId} ${version}${opts.preRelease ? ' (pre-release)' : ''}`));
  say('');

  if (opts.typecheck) {
    const { ms } = runNode(binaryOf('typescript', 'tsc'), ['--noEmit'], { label: 'typecheck', quiet: opts.quiet });
    step('typecheck', `tsc --noEmit · ${ms} ms`);
  } else {
    step('typecheck', 'skipped');
  }

  if (opts.bundle) {
    const { ms } = runNode(path.join(repoRoot, 'esbuild.js'), ['--production'], { label: 'bundle', quiet: true });
    step('bundle', `esbuild --production · ${ms} ms`);
  } else {
    step('bundle', 'skipped — reusing dist/');
  }

  const vsceArgs = ['package', '--no-dependencies', '--out', outPath];
  if (opts.version) vsceArgs.push(opts.version, '--no-git-tag-version', '--no-update-package-json');
  if (opts.preRelease) vsceArgs.push('--pre-release');

  const { ms: packageMs } = runNode(binaryOf('@vscode/vsce', 'vsce'), vsceArgs, { label: 'vsce package', quiet: true });
  if (!fs.existsSync(outPath)) fail(`vsce reported success but ${outPath} does not exist`);
  step('package', `vsce package · ${packageMs} ms`);

  const size = fs.statSync(outPath).size;
  let entryCount = 0;

  if (opts.verify) {
    const packagedManifest = { ...diskManifest, version };
    const { entries, problems } = verify(outPath, packagedManifest);
    entryCount = entries.length;

    if (problems.length) {
      say('');
      console.error(red(`${problems.length} problem${problems.length === 1 ? '' : 's'} with the package:`));
      for (const problem of problems) console.error(`  ${red('✗')} ${problem}`);
      console.error('');
      console.error('Contents:');
      for (const entry of entries) console.error(`  ${humanSize(entry.size).padStart(9)}  ${entry.name}`);
      process.exit(1);
    }

    step('verify', `${entries.length} entries · required files present · nothing leaked`);

    if (!opts.quiet) {
      say('');
      for (const entry of entries) say(`  ${dim(humanSize(entry.size).padStart(9))}  ${entry.name}`);
    }
  } else {
    step('verify', 'skipped');
  }

  say('');
  console.log(`${bold(path.relative(repoRoot, outPath) || outPath)}  ${dim(`${humanSize(size)} · ${version} · ${extensionId}`)}`);
  say('');
  say(dim(`Install it with:  code --install-extension "${path.relative(repoRoot, outPath)}"`));
  say('');

  if (opts.github) writeGithubOutputs({ outPath, size, version, extensionId, entryCount, preRelease: opts.preRelease });
}

function writeGithubOutputs({ outPath, size, version, extensionId, entryCount, preRelease }) {
  const outputs = {
    vsix_path: outPath,
    vsix_name: path.basename(outPath),
    version,
    extension_id: extensionId,
    size_bytes: String(size),
    pre_release: String(preRelease)
  };

  if (process.env.GITHUB_OUTPUT) {
    const lines = Object.entries(outputs).map(([k, v]) => `${k}=${v}`).join('\n');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines}\n`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [
      `### 📦 ${path.basename(outPath)}`,
      '',
      '| | |',
      '| --- | --- |',
      `| Extension | \`${extensionId}\` |`,
      `| Version | \`${version}\`${preRelease ? ' (pre-release)' : ''} |`,
      `| Size | ${humanSize(size)} |`,
      `| Files | ${entryCount} |`,
      '',
      'Download it from the **Artifacts** section of this run, then:',
      '',
      '```bash',
      `code --install-extension ${path.basename(outPath)}`,
      '```',
      ''
    ].join('\n');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
}

main();
