'use strict';
// Renders docs/media/melt.gif by driving media/main.js headlessly and encoding
// the frames as a GIF89a. No native dependencies, no browser.
//
//   node tools/make-gif.js [outfile]

const fs = require('fs');
const path = require('path');
const { createScene } = require('./scene-harness');

const ROOT = path.resolve(__dirname, '..');
const OUTFILE = process.argv[2] || path.join(ROOT, 'docs', 'media', 'melt.gif');
const VIEW_W = 420;
const VIEW_H = 240;
const ZOOM = 2;
const DELAY = 7; // hundredths of a second per frame
const TRANSPARENT = 255; // palette slot reserved for "unchanged since last frame"

// --------------------------------------------------------------- storyboard --
const STORYBOARD = [
  { health: 1, frames: 26 }, // the bear roams a full berg
  ...Array.from({ length: 46 }, (_, i) => ({ health: 1 - (i + 1) / 46, frames: 1 })), // the melt
  { health: 0, frames: 20 }, // an empty sea
  { health: 1, frames: 14 } // refreeze
];

function stateFor(health) {
  return {
    health,
    input: 0,
    output: 0,
    total: 0,
    budget: 0,
    requests: 0,
    basis: 'demo',
    source: 'none',
    meltdownDemo: true,
    bearName: 'Nanuq',
    animate: true,
    pixelScale: 0
  };
}

// ------------------------------------------------------------ quantisation --
const chan = (c, axis) => (axis === 0 ? (c >> 16) & 255 : axis === 1 ? (c >> 8) & 255 : c & 255);

function widestAxis(colors) {
  let best = { axis: 0, range: -1 };
  for (let a = 0; a < 3; a++) {
    let lo = 255;
    let hi = 0;
    for (const c of colors) {
      const v = chan(c, a);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi - lo > best.range) best = { axis: a, range: hi - lo };
  }
  return best;
}

/** Median-cut down to at most 255 entries, weighted by how often each colour appears. */
function buildPalette(frames, pixels) {
  const counts = new Map();
  for (const f of frames) {
    for (let i = 0; i < pixels; i++) {
      const key = (f[i * 3] << 16) | (f[i * 3 + 1] << 8) | f[i * 3 + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const uniq = [...counts.keys()];
  if (uniq.length <= 255) return { palette: uniq, exact: true };

  let boxes = [uniq];
  while (boxes.length < 255) {
    let pick = -1;
    let widest = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      const { range } = widestAxis(boxes[i]);
      if (range > widest) {
        widest = range;
        pick = i;
      }
    }
    if (pick < 0) break;
    const { axis } = widestAxis(boxes[pick]);
    const sorted = boxes[pick].slice().sort((a, b) => chan(a, axis) - chan(b, axis));
    const mid = sorted.length >> 1;
    boxes.splice(pick, 1, sorted.slice(0, mid), sorted.slice(mid));
  }

  const palette = boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (const c of box) {
      const w = counts.get(c);
      r += ((c >> 16) & 255) * w;
      g += ((c >> 8) & 255) * w;
      b += (c & 255) * w;
      n += w;
    }
    return ((Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n)) >>> 0;
  });
  return { palette, exact: false, unique: uniq.length };
}

// --------------------------------------------------------------------- lzw --
function lzwEncode(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let dict = new Map();
  const out = [];
  let acc = 0;
  let accBits = 0;

  const emit = (code) => {
    acc |= code << accBits;
    accBits += codeSize;
    while (accBits >= 8) {
      out.push(acc & 255);
      acc >>= 8;
      accBits -= 8;
    }
  };

  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 4096 + k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    dict.set(key, next);
    if (next === 1 << codeSize) {
      if (codeSize < 12) {
        codeSize++;
      } else {
        emit(clear);
        dict = new Map();
        next = eoi;
        codeSize = minCodeSize + 1;
      }
    }
    next++;
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (accBits > 0) out.push(acc & 255);
  return Buffer.from(out);
}

function blockify(buf) {
  const parts = [];
  for (let i = 0; i < buf.length; i += 255) {
    const slice = buf.subarray(i, Math.min(i + 255, buf.length));
    parts.push(Buffer.from([slice.length]), slice);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------- drive --
const scene = createScene(ROOT, VIEW_W, VIEW_H);
scene.step(16); // first frame establishes the internal resolution
scene.setState(stateFor(1));
for (let i = 0; i < 200; i++) scene.step(33); // let the eased health and the bear settle

const W = scene.canvas.width;
const H = scene.canvas.height;
const frames = [];
for (const beat of STORYBOARD) {
  scene.setState(stateFor(beat.health));
  for (let f = 0; f < beat.frames; f++) {
    scene.step(33);
    scene.step(33);
    const rgb = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      rgb[i * 3] = scene.canvas.data[i * 4];
      rgb[i * 3 + 1] = scene.canvas.data[i * 4 + 1];
      rgb[i * 3 + 2] = scene.canvas.data[i * 4 + 2];
    }
    frames.push(rgb);
  }
}
console.log(`${frames.length} frames, internal ${W}x${H}, output ${W * ZOOM}x${H * ZOOM}`);

const { palette, exact, unique } = buildPalette(frames, W * H);
console.log(exact ? `${palette.length} colours (exact)` : `${unique} colours quantised to ${palette.length}`);

const lookup = new Map();
palette.forEach((c, i) => {
  if (i < 255 && !lookup.has(c)) lookup.set(c, i);
});
function indexOf(c) {
  const hit = lookup.get(c);
  if (hit !== undefined) return hit;
  const r = (c >> 16) & 255;
  const g = (c >> 8) & 255;
  const b = c & 255;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.length && i < 255; i++) {
    const p = palette[i];
    const dr = r - ((p >> 16) & 255);
    const dg = g - ((p >> 8) & 255);
    const db = b - (p & 255);
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  lookup.set(c, best);
  return best;
}

const indexed = frames.map((f) => {
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    out[i] = indexOf((f[i * 3] << 16) | (f[i * 3 + 1] << 8) | f[i * 3 + 2]);
  }
  return out;
});

// -------------------------------------------------------------------- gif --
const parts = [Buffer.from('GIF89a', 'ascii')];

const lsd = Buffer.alloc(7);
lsd.writeUInt16LE(W * ZOOM, 0);
lsd.writeUInt16LE(H * ZOOM, 2);
lsd[4] = 0xf7; // global colour table, 256 entries, 8 bits per channel
parts.push(lsd);

const gct = Buffer.alloc(768);
for (let i = 0; i < 256; i++) {
  const c = i < palette.length ? palette[i] : 0;
  gct[i * 3] = (c >> 16) & 255;
  gct[i * 3 + 1] = (c >> 8) & 255;
  gct[i * 3 + 2] = c & 255;
}
parts.push(gct);

// NETSCAPE2.0 application extension: loop forever.
parts.push(
  Buffer.from([0x21, 0xff, 0x0b]),
  Buffer.from('NETSCAPE2.0', 'ascii'),
  Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00])
);

let prev = null;
for (const cur of indexed) {
  // Only encode the bounding box of what changed, and mark unchanged pixels
  // transparent so the previous frame shows through.
  let x0 = 0;
  let y0 = 0;
  let x1 = W - 1;
  let y1 = H - 1;
  const diffed = prev !== null;
  if (diffed) {
    x0 = W; y0 = H; x1 = -1; y1 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (cur[y * W + x] !== prev[y * W + x]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < x0) { x0 = 0; y0 = 0; x1 = 0; y1 = 0; } // nothing moved
  }

  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const sub = new Uint8Array(bw * ZOOM * bh * ZOOM);
  for (let y = 0; y < bh * ZOOM; y++) {
    const sy = y0 + ((y / ZOOM) | 0);
    for (let x = 0; x < bw * ZOOM; x++) {
      const sx = x0 + ((x / ZOOM) | 0);
      const v = cur[sy * W + sx];
      sub[y * bw * ZOOM + x] = diffed && v === prev[sy * W + sx] ? TRANSPARENT : v;
    }
  }

  const gce = Buffer.alloc(8);
  gce[0] = 0x21;
  gce[1] = 0xf9;
  gce[2] = 0x04;
  gce[3] = (1 << 2) | (diffed ? 1 : 0); // disposal method 1 (leave in place)
  gce.writeUInt16LE(DELAY, 4);
  gce[6] = TRANSPARENT;
  parts.push(gce);

  const desc = Buffer.alloc(10);
  desc[0] = 0x2c;
  desc.writeUInt16LE(x0 * ZOOM, 1);
  desc.writeUInt16LE(y0 * ZOOM, 3);
  desc.writeUInt16LE(bw * ZOOM, 5);
  desc.writeUInt16LE(bh * ZOOM, 7);
  parts.push(desc, Buffer.from([8]), blockify(lzwEncode(sub, 8)));

  prev = cur;
}
parts.push(Buffer.from([0x3b]));

const gif = Buffer.concat(parts);
fs.mkdirSync(path.dirname(OUTFILE), { recursive: true });
fs.writeFileSync(OUTFILE, gif);
console.log(`wrote ${path.relative(ROOT, OUTFILE)} — ${(gif.length / 1024).toFixed(0)} kB`);
