// Tiny DOM builder. Strings become text nodes, so content is never parsed as HTML.

const SVG_NS = 'http://www.w3.org/2000/svg';
const expanded = new Set();

function build(el, attrs, children) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function h(tag, attrs = {}, ...children) {
  return build(document.createElement(tag), attrs, children);
}

/** The same builder for SVG elements. */
export function s(tag, attrs = {}, ...children) {
  return build(document.createElementNS(SVG_NS, tag), attrs, children);
}

export function disclosure(id, label, ...children) {
  return h('details', {
    class: 'disclosure',
    'data-detail': id,
    open: expanded.has(id),
    ontoggle: (event) => {
      const element = event.currentTarget;
      if (!element.isConnected) return;
      if (element.open) expanded.add(id);
      else expanded.delete(id);
    },
  }, h('summary', { 'data-focus-key': `detail-${id}` }, label), ...children);
}
