'use strict';
// Shared headless Canvas2D shim. Runs media/main.js in a Node vm so the real
// renderer can be driven frame by frame without a browser or VS Code.
//
// media/main.js only ever uses fillRect, createImageData, putImageData and
// drawImage, so this is a complete implementation of what it needs — not a mock.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function parseColor(s) {
  if (typeof s !== 'string') return [255, 0, 255, 1];
  s = s.trim();
  if (s[0] === '#') {
    const v = parseInt(s.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 1];
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return [255, 0, 255, 1];
  const p = m[1].split(',').map((x) => parseFloat(x));
  return [p[0] | 0, p[1] | 0, p[2] | 0, p.length > 3 ? p[3] : 1];
}

class Ctx {
  constructor(canvas) {
    this.canvas = canvas;
    this._fill = [255, 0, 255, 1];
    this.imageSmoothingEnabled = false;
  }
  set fillStyle(v) {
    this._fill = parseColor(v);
  }
  get fillStyle() {
    return this._fill;
  }
  fillRect(x, y, w, h) {
    const c = this.canvas;
    const [r, g, b, a] = this._fill;
    if (a <= 0) return;
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    for (let j = 0; j < h; j++) {
      const yy = y + j;
      if (yy < 0 || yy >= c.height) continue;
      for (let i = 0; i < w; i++) {
        const xx = x + i;
        if (xx < 0 || xx >= c.width) continue;
        const o = (yy * c.width + xx) * 4;
        const d = c.data;
        if (a >= 1) {
          d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
        } else {
          d[o] += (r - d[o]) * a;
          d[o + 1] += (g - d[o + 1]) * a;
          d[o + 2] += (b - d[o + 2]) * a;
          d[o + 3] = 255;
        }
      }
    }
  }
  createImageData(w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }
  putImageData(img, dx, dy) {
    this._blit(img, img.width, img.height, dx, dy);
  }
  drawImage(src, dx, dy) {
    this._blit(src, src.width, src.height, dx, dy);
  }
  _blit(src, sw, sh, dx, dy) {
    const c = this.canvas;
    for (let y = 0; y < sh; y++) {
      const ty = y + dy;
      if (ty < 0 || ty >= c.height) continue;
      for (let x = 0; x < sw; x++) {
        const tx = x + dx;
        if (tx < 0 || tx >= c.width) continue;
        const so = (y * sw + x) * 4;
        const to = (ty * c.width + tx) * 4;
        c.data[to] = src.data[so];
        c.data[to + 1] = src.data[so + 1];
        c.data[to + 2] = src.data[so + 2];
        c.data[to + 3] = 255;
      }
    }
  }
}

class Canvas {
  constructor() {
    this._w = 0;
    this._h = 0;
    this.style = {};
    this.data = new Uint8ClampedArray(0);
    this.ctx = new Ctx(this);
  }
  get width() { return this._w; }
  set width(v) { this._w = v | 0; this._alloc(); }
  get height() { return this._h; }
  set height(v) { this._h = v | 0; this._alloc(); }
  _alloc() { this.data = new Uint8ClampedArray(Math.max(0, this._w * this._h * 4)); }
  getContext() { return this.ctx; }
}

/**
 * Loads media/main.js into a sandbox and returns handles for driving it.
 * @param {string} root repository root
 * @param {number} viewW stage width in CSS pixels
 * @param {number} viewH stage height in CSS pixels
 */
function createScene(root, viewW, viewH) {
  const listeners = {};
  const els = {};
  const mkEl = (id) => ({
    id,
    style: {},
    textContent: '',
    hidden: false,
    addEventListener() {},
    getBoundingClientRect: () => ({ width: viewW, height: viewH })
  });
  for (const id of ['stage', 'melted', 'bearName', 'pct', 'fill', 'tokens', 'split', 'basis', 'source', 'btnDashboard']) {
    els[id] = mkEl(id);
  }
  const canvas = new Canvas();
  els.scene = canvas;

  let rafCb = null;
  let nowMs = 0;

  const sandbox = {
    window: {
      addEventListener: (type, cb) => {
        (listeners[type] || (listeners[type] = [])).push(cb);
      },
      requestAnimationFrame: (cb) => { rafCb = cb; return 1; }
    },
    document: {
      getElementById: (id) => els[id] || mkEl(id),
      createElement: () => new Canvas(),
      documentElement: { style: { setProperty() {} } },
      addEventListener() {}
    },
    performance: { now: () => nowMs },
    requestAnimationFrame: (cb) => { rafCb = cb; return 1; },
    console,
    acquireVsCodeApi: undefined
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8'), sandbox, {
    filename: 'main.js'
  });

  return {
    canvas,
    els,
    /** Advance the animation clock by `ms` and run one frame. */
    step(ms) {
      nowMs += ms;
      const cb = rafCb;
      rafCb = null;
      if (cb) cb(nowMs);
    },
    /** Push a state message exactly as the extension host would. */
    setState(state) {
      for (const cb of listeners.message || []) cb({ data: { type: 'state', state } });
    }
  };
}

module.exports = { createScene, Canvas };
