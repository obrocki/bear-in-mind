// Minimal, safe markdown → DOM for the committed research doc.
// Builds nodes with textContent only; never assigns HTML strings.

import { h } from './dom.js';

function inline(text) {
  const nodes = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[([^\]]+)\]\(([^)\s]+)\))|(\*(?!\s)[^*]+?(?<!\s)\*)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1]) nodes.push(h('code', {}, m[1].slice(1, -1)));
    else if (m[2]) nodes.push(h('strong', {}, ...inline(m[2].slice(2, -2))));
    else if (m[6]) nodes.push(h('em', {}, ...inline(m[6].slice(1, -1))));
    else if (m[3]) {
      const href = m[5];
      nodes.push(
        /^https?:\/\//i.test(href)
          ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, ...inline(m[4]))
          : h('span', { title: href }, ...inline(m[4])),
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function cells(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

export function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const root = h('div', { class: 'md' });
  let i = 0;
  let paragraph = [];

  const flush = () => {
    if (paragraph.length) root.append(h('p', {}, ...inline(paragraph.join(' '))));
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      const pre = h('pre', {});
      if (fence[2] === 'mermaid')
        pre.append(h('span', { class: 'caption' }, 'Mermaid diagram — rendered as entities in the Data model tab'));
      pre.append(h('code', {}, body.join('\n')));
      root.append(pre);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length + 1, 5);
      root.append(h(`h${level}`, {}, ...inline(heading[2])));
      i++;
      continue;
    }
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      flush();
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      root.append(
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, ...head.map((c) => h('th', {}, ...inline(c))))),
          h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, ...inline(c)))))),
        ),
      );
      continue;
    }
    const item = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[2]);
      const list = h(ordered ? 'ol' : 'ul', {});
      while (i < lines.length) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        let text = m[3];
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
          text += ' ' + lines[i++].trim();
        }
        list.append(h('li', {}, ...inline(text)));
      }
      root.append(list);
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    paragraph.push(line.trim());
    i++;
  }
  flush();
  return root;
}
