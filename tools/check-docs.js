#!/usr/bin/env node
'use strict';

/**
 * Checks the repository's markdown.
 *
 *   node tools/check-docs.js
 *
 * Three things, all of which have actually gone wrong here:
 *
 *   1. Unbalanced code fences. A block opened with ```` and closed with ```
 *      stays open, and GitHub renders everything after it — headings, images,
 *      tables — as one giant code block. It looks fine in most editors.
 *   2. Relative links and images that don't resolve on disk.
 *   3. Raw HTML. GitHub allows a subset of it, but plenty of renderers that
 *      show this README — the VS Code Marketplace, in-editor previews, docs
 *      sites, anything built on a sanitising markdown pipeline — escape it or
 *      drop it. A <table> of screenshots then disappears entirely. Every
 *      construct used here has a portable markdown equivalent, so require it.
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
  const prose = withoutCode(text.split(/\r?\n/)).join('\n');
  const targets = [
    ...[...prose.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]),
    ...[...prose.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1])
  ];

  return targets.filter((target) => {
    if (/^(https?:|mailto:|#|data:)/.test(target)) return false;
    const relative = target.split('#')[0];
    if (!relative) return false;
    return !fs.existsSync(path.resolve(path.dirname(file), relative));
  });
}

/** Tags whose content vanishes, or shows up as literal angle brackets, in a sanitising renderer. */
const HTML_TAGS =
  'div|span|table|thead|tbody|tr|td|th|img|picture|source|details|summary|center|font|' +
  'p|br|hr|sub|sup|kbd|b|i|u|s|em|strong|small|big|h[1-6]|ul|ol|li|dl|dt|dd|pre|code|blockquote|figure|figcaption';

/** Blank out fenced blocks and inline code spans so their contents aren't mistaken for markup. */
function withoutCode(lines) {
  const out = [];
  let fence = null;

  for (const line of lines) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (match && match[1][0] === fence.char && match[1].length >= fence.length && match[2].trim() === '') {
        fence = null;
      }
      out.push('');
      continue;
    }
    if (match) {
      fence = { char: match[1][0], length: match[1].length };
      out.push('');
      continue;
    }
    out.push(line.replace(/`[^`]*`/g, ''));
  }

  return out;
}

function rawHtml(lines) {
  const tagRe = new RegExp(`</?(?:${HTML_TAGS})(?:\\s[^>]*)?/?>`, 'gi');
  const found = [];

  withoutCode(lines).forEach((line, index) => {
    for (const match of line.matchAll(tagRe)) found.push({ line: index + 1, tag: match[0] });
  });

  return found;
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

  for (const tag of rawHtml(text.split(/\r?\n/))) {
    console.error(
      `${shown}:${tag.line}  raw HTML "${tag.tag}" — sanitising renderers drop it; use markdown instead`
    );
    problems++;
  }
}

if (problems) {
  console.error(`\n${problems} problem${problems === 1 ? '' : 's'} across ${files.length} markdown files.`);
  process.exit(1);
}

console.log(
  `${files.length} markdown files ok — fences balanced, relative links resolve, no raw HTML.`
);
