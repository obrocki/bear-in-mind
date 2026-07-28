#!/usr/bin/env node
'use strict';

/**
 * Checks the repository's markdown.
 *
 *   node tools/check-docs.js
 *
 * Two things, both of which have actually gone wrong here:
 *
 *   1. Unbalanced code fences. A block opened with ```` and closed with ```
 *      stays open, and GitHub renders everything after it — headings, images,
 *      tables — as one giant code block. It looks fine in most editors.
 *   2. Relative links and images that don't resolve on disk.
 */

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.shots', '.vscode-test']);

function markdownFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(full));
    else if (/\.md$/i.test(entry.name)) found.push(full);
  }
  return found;
}

/** CommonMark: a fence closes only on the same character, at least as long, with nothing trailing. */
function unclosedFences(lines) {
  let open = null;
  const problems = [];

  lines.forEach((line, index) => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) return;
    const [, marker, rest] = match;

    if (open) {
      if (marker[0] === open.char && marker.length >= open.length && rest.trim() === '') open = null;
      return;
    }
    open = { char: marker[0], length: marker.length, line: index + 1, info: rest.trim() };
  });

  if (open) problems.push(open);
  return problems;
}

function brokenTargets(file, text) {
  const targets = [
    ...[...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]),
    ...[...text.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1])
  ];

  return targets.filter((target) => {
    if (/^(https?:|mailto:|#|data:)/.test(target)) return false;
    const relative = target.split('#')[0];
    if (!relative) return false;
    return !fs.existsSync(path.resolve(path.dirname(file), relative));
  });
}

const files = markdownFiles(repoRoot).sort();
let problems = 0;

for (const file of files) {
  const shown = path.relative(repoRoot, file).split(path.sep).join('/');
  const text = fs.readFileSync(file, 'utf8');

  for (const fence of unclosedFences(text.split(/\r?\n/))) {
    console.error(
      `${shown}:${fence.line}  unclosed code fence ` +
        `"${fence.char.repeat(fence.length)}${fence.info}" — everything below it renders as code`
    );
    problems++;
  }

  for (const target of brokenTargets(file, text)) {
    console.error(`${shown}  link does not resolve: ${target}`);
    problems++;
  }
}

if (problems) {
  console.error(`\n${problems} problem${problems === 1 ? '' : 's'} across ${files.length} markdown files.`);
  process.exit(1);
}

console.log(`${files.length} markdown files ok — fences balanced, relative links resolve.`);
