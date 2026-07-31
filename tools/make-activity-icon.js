// Generates media/bear.svg -- the activity bar icon.
//
// This is pixel art on a 16x16 grid mapped onto a 24-unit viewBox, so every
// shape is defined analytically and then sampled down to whole cells. Nudging a
// shape by a fraction of a cell visibly changes which pixels survive, so the
// motif is deliberately centred on an exact cell centre.
//
// Two constraints drive the whole design, and both come from how VS Code
// actually paints this file. It does not <img> it -- it uses it as a CSS mask:
//
//   mask: url(<icon>) no-repeat 50% 50%; mask-size: var(--activity-bar-icon-size, 24px)
//
// with the theme colour applied as background-color underneath. So:
//
//   1. Colour in this file is discarded. Only the alpha channel matters, which
//      is why everything is fill="currentColor".
//   2. There is no "dark". The eyes and nose have to be transparent holes
//      punched out of the head, not dark shapes drawn on top of it, and partial
//      opacity is the only way to get a second tone at all.
//
// Run with `npm run media:activity-icon`.
const fs = require('fs');
const path = require('path');

const N = 16;
const OUT = path.join(__dirname, '..', 'media', 'bear.svg');

const makeGrid = () => Array.from({ length: N }, () => new Array(N).fill(0));

// Coverage of an analytic shape over one cell, supersampled then thresholded so
// the result stays crisp pixel art instead of going soft at the edges.
// mode 'shadeOnSolid' only repaints cells that are already solid, which is how
// the muzzle and inner ears become a second tone without spilling off the head.
function stamp(g, test, alpha, mode) {
  const S = 4;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let hits = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          if (test(x + (sx + 0.5) / S, y + (sy + 0.5) / S)) hits++;
        }
      }
      if (hits / (S * S) < 0.5) continue;
      if (mode === 'shadeOnSolid') { if (g[y][x] > 0) g[y][x] = alpha; }
      else g[y][x] = alpha;
    }
  }
}

const ellipse = (cx, cy, rx, ry) => (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

const SHADE = 0.45;

function bearHead(g, s, dx, dy) {
  const T = (fn) => (x, y) => fn((x - dx) / s, (y - dy) / s);
  // ears first, then the head over the top, so they fuse into one silhouette
  stamp(g, T(ellipse(3.9, 4.6, 2.35, 2.3)), 1);
  stamp(g, T(ellipse(12.1, 4.6, 2.35, 2.3)), 1);
  stamp(g, T(ellipse(8, 9.4, 5.6, 5.1)), 1);
  stamp(g, T(ellipse(3.9, 4.7, 1.0, 0.95)), SHADE, 'shadeOnSolid');
  stamp(g, T(ellipse(12.1, 4.7, 1.0, 0.95)), SHADE, 'shadeOnSolid');
  stamp(g, T(ellipse(8, 12.0, 3.1, 2.3)), SHADE, 'shadeOnSolid');
  // holes, not dark fills -- see the note at the top of the file
  stamp(g, T(ellipse(5.7, 8.6, 1.0, 1.0)), 0);
  stamp(g, T(ellipse(10.3, 8.6, 1.0, 1.0)), 0);
  stamp(g, T(ellipse(8, 11.3, 1.2, 0.9)), 0);
}

// Overlays a motif with a thin knocked-out ring so it reads as sitting in front
// of the head rather than merging with it. Clearing a whole disc instead -- the
// obvious approach -- eats the ear and leaves the bear visibly lopsided.
function badge(g, draw, ring) {
  const m = makeGrid();
  draw(m);
  const halo = makeGrid();
  const r = Math.ceil(ring);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (m[y][x] <= 0) continue;
      for (let j = -r; j <= r; j++) {
        for (let i = -r; i <= r; i++) {
          const ny = y + j, nx = x + i;
          if (ny < 0 || nx < 0 || ny >= N || nx >= N) continue;
          if (Math.hypot(i, j) <= ring + 0.35) halo[ny][nx] = 1;
        }
      }
    }
  }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (halo[y][x] && m[y][x] <= 0) g[y][x] = 0;
      if (m[y][x] > 0) g[y][x] = m[y][x];
    }
  }
}

// The whole composition in one place, so it can be re-proportioned without
// touching the drawing code. Everything is in 16-cell grid units.
//
// The bear is as large as the snowflake allows. The flake radius cannot drop
// much below 4 cells: its arms sit at 60 degree steps, and once they are short
// the four diagonal ones alias into stair-steps that merge with each other, so
// the flake stops reading as a flake and turns into a hash mark. That sets the
// flake size, and the bear then takes everything that is left.
const LAYOUT = {
  bearScale: 0.82,
  bearDx: -1.06,
  bearDy: 3.79,
  flakeCx: 11.5,
  flakeCy: 4.5,
  flakeR: 4.2
};

function design(L = LAYOUT) {
  const g = makeGrid();
  bearHead(g, L.bearScale, L.bearDx, L.bearDy);
  // The flake needs long thin arms with the barbs set well out along them; a
  // shorter or fatter one collapses into an amorphous blob at 24px.
  const cx = L.flakeCx, cy = L.flakeCy, R = L.flakeR;
  const k = R / 4.0;
  const arm = (ang, len, wid) => (x, y) => {
    const dx = x - cx, dy = y - cy;
    const c = Math.cos(ang), s = Math.sin(ang);
    const along = dx * c + dy * s, across = -dx * s + dy * c;
    return along >= -0.5 * k && along <= len && Math.abs(across) <= wid;
  };
  badge(g, (m) => {
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      stamp(m, arm(a, R, 0.45 * k), 1);
      const bx = cx + Math.cos(a) * (R * 0.72), by = cy + Math.sin(a) * (R * 0.72);
      const br = 0.45 * k, off = 1.15 * k;
      stamp(m, ellipse(bx + Math.cos(a + 1.25) * off, by + Math.sin(a + 1.25) * off, br, br), 1);
      stamp(m, ellipse(bx + Math.cos(a - 1.25) * off, by + Math.sin(a - 1.25) * off, br, br), 1);
    }
  }, 0.9);
  return g;
}

// Cells are merged into horizontal runs and grouped by tone, which keeps the
// file to a couple of paths instead of one rect per pixel.
function toSvg(g) {
  const cs = 24 / N;
  const fmt = (n) => (Number.isInteger(n) ? String(n) : String(+n.toFixed(3)));
  const tones = new Map();
  for (let y = 0; y < N; y++) {
    let x = 0;
    while (x < N) {
      const a = g[y][x];
      if (a <= 0) { x++; continue; }
      let run = 1;
      while (x + run < N && g[y][x + run] === a) run++;
      const key = a.toFixed(2);
      if (!tones.has(key)) tones.set(key, []);
      tones.get(key).push(`M${fmt(x * cs)} ${fmt(y * cs)}h${fmt(run * cs)}v${fmt(cs)}h-${fmt(run * cs)}z`);
      x += run;
    }
  }
  const paths = [...tones.entries()]
    .sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]))
    .map(([a, ds]) => {
      const op = parseFloat(a) >= 1 ? '' : ` opacity="${parseFloat(a)}"`;
      return `  <path fill="currentColor"${op} d="${ds.join('')}"/>`;
    });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">\n${paths.join('\n')}\n</svg>\n`;
}

const svg = toSvg(design());
if (require.main === module) {
  fs.writeFileSync(OUT, svg);
  console.log(`${path.relative(path.join(__dirname, '..'), OUT)}  ${Buffer.byteLength(svg)} B`);
}

module.exports = { N, makeGrid, stamp, ellipse, bearHead, badge, design, toSvg, LAYOUT };
