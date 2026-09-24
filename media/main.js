// @ts-check
/* Bear in Mind — pixel-art renderer.
 * Everything is drawn at a small internal resolution (roughly 200px wide) and
 * blown up with nearest-neighbour scaling, so every pixel stays a hard square.
 */
(function () {
  'use strict';

  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;

  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('scene'));
  const ctx = /** @type {CanvasRenderingContext2D} */ (
    canvas.getContext('2d', { alpha: false })
  );
  const stage = document.getElementById('stage');
  const meltedBadge = document.getElementById('melted');

  const el = {
    name: document.getElementById('bearName'),
    pct: document.getElementById('pct'),
    fill: document.getElementById('fill'),
    tokens: document.getElementById('tokens'),
    split: document.getElementById('split'),
    basis: document.getElementById('basis'),
    source: document.getElementById('source')
  };

  // ---------------------------------------------------------------- state ---

  const state = {
    health: 1,
    targetHealth: 1,
    input: 0,
    output: 0,
    total: 0,
    budget: 5000000,
    bearName: 'Nanuq',
    animate: true,
    pixelScale: 0
  };

  let W = 200;
  let H = 130;
  let scale = 2;

  /** Layout derived from W/H. */
  const view = {
    cx: 100,
    waterY: 88,
    maxHalfW: 80,
    minHalfW: 8,
    maxTop: 42,
    minTop: 3
  };

  // ------------------------------------------------------------- utilities --

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  /** Deterministic hash-based value noise so the berg keeps its identity. */
  function hash1(n) {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
    return s - Math.floor(s);
  }
  function noise1(x) {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    return lerp(hash1(i), hash1(i + 1), u) * 2 - 1;
  }

  function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  function mixRgb(a, b, t) {
    return [
      Math.round(lerp(a[0], b[0], t)),
      Math.round(lerp(a[1], b[1], t)),
      Math.round(lerp(a[2], b[2], t))
    ];
  }
  function css(rgb, alpha) {
    return alpha === undefined
      ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
      : `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
  }
  function shade(rgb, amount) {
    const t = amount < 0 ? -amount : amount;
    const target = amount < 0 ? [4, 10, 24] : [255, 255, 255];
    return mixRgb(rgb, target, t);
  }

  // --------------------------------------------------------------- palette --

  const SKY_COLD = ['#02060f', '#071a35', '#123a68', '#2f7bab', '#8fd0e8'].map(hexToRgb);
  const SKY_DUSK = ['#0a0620', '#241046', '#5c1f5e', '#b8455f', '#ff9d78'].map(hexToRgb);
  const SKY_WARM = ['#170410', '#490d18', '#93230f', '#dd5c1c', '#ffb257'].map(hexToRgb);
  const SEA_COLD = [hexToRgb('#061529'), hexToRgb('#0d3050')];
  const SEA_DUSK = [hexToRgb('#0a0a2a'), hexToRgb('#1e2a5c')];
  const SEA_WARM = [hexToRgb('#2c0f22'), hexToRgb('#7a2a1e')];
  const ICE_COLD = ['#eaf6ff', '#cfeaff', '#a9d8f2', '#6fb0d8', '#3d7fae'].map(hexToRgb);
  const ICE_DUSK = ['#f2ecff', '#ded2ff', '#c3b2e6', '#8f7fbe', '#584d86'].map(hexToRgb);
  const ICE_WARM = ['#ffeadb', '#ffd0b4', '#e0a894', '#a97a74', '#6b4a55'].map(hexToRgb);

  /** Palette for the current health, rebuilt only when health moves a notch. */
  let pal = null;
  let palKey = -1;

  /** Blue -> sunset -> scorched, so the mid-range never turns muddy. */
  function ramp(cold, dusk, warm, w) {
    return w <= 0.5
      ? cold.map((c, i) => mixRgb(c, dusk[i], w * 2))
      : dusk.map((c, i) => mixRgb(c, warm[i], (w - 0.5) * 2));
  }

  function buildPalette(h) {
    const warmth = Math.pow(clamp(1 - h, 0, 1), 1.7);
    const sky = ramp(SKY_COLD, SKY_DUSK, SKY_WARM, warmth);
    const sea = ramp(SEA_COLD, SEA_DUSK, SEA_WARM, warmth);
    const ice = ramp(ICE_COLD, ICE_DUSK, ICE_WARM, Math.min(1, warmth * 0.9));
    return {
      warmth,
      sky,
      sea,
      ice,
      sun: mixRgb(hexToRgb('#fff3cf'), hexToRgb('#ff5a2b'), warmth),
      snow: mixRgb(hexToRgb('#f1fbff'), hexToRgb('#ffd9c4'), warmth * 0.6),
      foam: mixRgb(hexToRgb('#cfeeff'), hexToRgb('#ffcaa8'), warmth)
    };
  }

  // ------------------------------------------------------------- primitives --

  function vline(x, y0, y1, color) {
    if (y1 < y0) return;
    ctx.fillStyle = color;
    ctx.fillRect(x, y0, 1, y1 - y0 + 1);
  }
  function px(x, y, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 1, 1);
  }
  function rect(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  }

  // -------------------------------------------------------------- the sky ---

  const BAYER = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5]
  ];

  let skyCanvas = document.createElement('canvas');
  let skyCtx = skyCanvas.getContext('2d');

  function renderSky() {
    const skyH = view.waterY + 2;
    skyCanvas.width = W;
    skyCanvas.height = skyH;
    const img = skyCtx.createImageData(W, skyH);
    const data = img.data;
    const stops = [0, 0.34, 0.58, 0.79, 1];

    for (let y = 0; y < skyH; y++) {
      const t = skyH === 1 ? 0 : y / (skyH - 1);
      let seg = 0;
      while (seg < stops.length - 2 && t > stops[seg + 1]) seg++;
      const local = (t - stops[seg]) / (stops[seg + 1] - stops[seg] || 1);
      const c0 = pal.sky[seg];
      const c1 = pal.sky[seg + 1];
      const brow = BAYER[y & 3];
      for (let x = 0; x < W; x++) {
        const c = local > brow[x & 3] / 16 ? c1 : c0;
        const o = (y * W + x) * 4;
        data[o] = c[0];
        data[o + 1] = c[1];
        data[o + 2] = c[2];
        data[o + 3] = 255;
      }
    }
    skyCtx.putImageData(img, 0, 0);
  }

  function drawStars(t, h) {
    const alpha = clamp(h * 1.1 - 0.05, 0, 1);
    if (alpha <= 0.02) return;
    const count = Math.round(W * 0.22);
    for (let i = 0; i < count; i++) {
      const sx = Math.floor(hash1(i * 3.3) * W);
      const sy = Math.floor(hash1(i * 7.7 + 1) * view.waterY * 0.46);
      const tw = 0.55 + 0.45 * Math.sin(t * 2.1 + i);
      px(sx, sy, css(pal.snow, alpha * tw * 0.9));
    }
  }

  function drawSun(t, h) {
    const size = Math.round(lerp(3, 7, 1 - h));
    const sx = Math.round(lerp(W * 0.78, W * 0.2, 1 - h));
    const sy = Math.round(lerp(view.waterY * 0.22, view.waterY * 0.72, 1 - h));
    const glow = 0.25 + 0.12 * Math.sin(t * 1.3);

    for (let r = size + 4; r >= size; r--) {
      ctx.fillStyle = css(pal.sun, (glow * (size + 5 - r)) / 12);
      circle(sx, sy, r);
    }
    ctx.fillStyle = css(pal.sun);
    circle(sx, sy, size);
    ctx.fillStyle = css(shade(pal.sun, 0.35));
    circle(sx - 1, sy - 1, Math.max(1, size - 2));
  }

  function circle(cx, cy, r) {
    for (let y = -r; y <= r; y++) {
      const span = Math.floor(Math.sqrt(Math.max(0, r * r - y * y)));
      ctx.fillRect(cx - span, cy + y, span * 2 + 1, 1);
    }
  }

  function drawAurora(t, h) {
    const strength = clamp((h - 0.4) / 0.6, 0, 1);
    if (strength <= 0.02) return;
    for (let b = 0; b < 3; b++) {
      const baseY = view.waterY * (0.18 + b * 0.11);
      const amp = 4 + b * 2;
      const col = b === 0 ? [140, 255, 200] : b === 1 ? [110, 220, 255] : [190, 150, 255];
      for (let x = 0; x < W; x += 2) {
        const wave =
          Math.sin(x * 0.06 + t * 0.6 + b) * amp +
          Math.sin(x * 0.021 - t * 0.35 + b * 2) * amp * 0.7;
        const top = Math.round(baseY + wave);
        if (top < 0) continue;
        const height = 3 + Math.round(2 * (1 + Math.sin(x * 0.09 + t * 0.9 + b)));
        const a = strength * 0.12 * (0.6 + 0.4 * Math.sin(x * 0.13 + t));
        if (a <= 0.015) continue;
        rect(x, top, 2, height, css(col, a));
        rect(x, top, 2, 1, css(col, a * 1.8));
      }
    }
  }

  function drawDistantBergs(t, h) {
    const horizon = view.waterY;
    const bergs = [
      { x: 0.13, w: 0.1, hh: 0.05, drift: 0.6, a: 0.45 },
      { x: 0.62, w: 0.14, hh: 0.07, drift: -0.4, a: 0.35 },
      { x: 0.88, w: 0.08, hh: 0.04, drift: 0.3, a: 0.4 }
    ];
    const tint = mixRgb(pal.sky[3], pal.ice[3], 0.45);
    for (const b of bergs) {
      const halfW = Math.max(2, Math.round(W * b.w * (0.55 + 0.45 * h)));
      const height = Math.max(2, Math.round(H * b.hh * (0.5 + 0.5 * h)));
      const cx = Math.round(((b.x * W + t * b.drift) % (W + 40)) - 20);
      for (let dx = -halfW; dx <= halfW; dx++) {
        const u = dx / halfW;
        const top = horizon - Math.round(height * Math.pow(Math.cos((u * Math.PI) / 2), 0.7));
        if (top >= horizon) continue;
        const x = cx + dx;
        if (x < 0 || x >= W) continue;
        vline(x, top, horizon - 1, css(tint, b.a));
      }
    }
  }

  // --------------------------------------------------------------- the sea --

  function waveY(x, t) {
    return (
      view.waterY +
      Math.round(Math.sin(x * 0.17 + t * 1.7) * 0.6 + Math.sin(x * 0.061 - t * 1.05) * 0.7)
    );
  }

  function drawSea(t) {
    const deep = css(pal.sea[0]);
    const near = css(pal.sea[1]);
    const seaTop = view.waterY - 2;
    for (let x = 0; x < W; x++) {
      const wy = waveY(x, t);
      vline(x, wy, H - 1, deep);
      vline(x, wy, Math.min(H - 1, wy + 2), near);
      px(x, wy, css(pal.foam, 0.5));
    }
    // Scrolling highlight dashes for a sense of motion.
    const rows = [4, 8, 13, 19, 26];
    for (let i = 0; i < rows.length; i++) {
      const y = view.waterY + rows[i];
      if (y >= H) break;
      const speed = 6 + i * 3;
      const period = 11 + i * 4;
      const off = Math.floor(t * speed) % period;
      for (let x = (off + i * 3) % period; x < W; x += period) {
        const len = 2 + (i % 2);
        rect(x, y, len, 1, css(pal.foam, 0.16 - i * 0.02));
      }
    }
  }

  // ----------------------------------------------------------- the iceberg --

  const surfaceY = new Int16Array(512);
  let bergHalfW = 40;
  let bergTopH = 20;
  let walkLo = 0;
  let walkHi = 0;

  function profile(u) {
    const a = clamp(u, -1, 1);
    const base = Math.pow(Math.cos((a * Math.PI) / 2), 0.5);
    const summit = 0.4 * Math.exp(-Math.pow((a + 0.32) / 0.21, 2));
    const shoulder = 0.16 * Math.exp(-Math.pow((a - 0.44) / 0.26, 2));
    const crag = (noise1(a * 3.4 + 11) * 0.1 + noise1(a * 8.1 + 3) * 0.05) * base;
    const raw = base * 0.66 + summit + shoulder + crag;
    // Terrace the profile so the berg reads as flat ice facets with sharp steps.
    const stepped = Math.round(raw / 0.13) * 0.13;
    return clamp(lerp(raw, stepped, 0.6), 0, 1);
  }

  function layoutBerg(h) {
    bergHalfW = Math.round(lerp(view.minHalfW, view.maxHalfW, Math.pow(h, 0.72)));
    bergTopH = Math.round(lerp(view.minTop, view.maxTop, Math.pow(h, 0.88)));
    surfaceY.fill(32767, 0, W);
    const x0 = Math.max(0, view.cx - bergHalfW);
    const x1 = Math.min(W - 1, view.cx + bergHalfW);
    for (let x = x0; x <= x1; x++) {
      const u = (x - view.cx) / bergHalfW;
      surfaceY[x] = view.waterY - Math.max(1, Math.round(bergTopH * profile(u)));
    }

    // The bear only roams the high ground: everything within `limit` of the
    // summit. That band is what shrinks as the token budget burns.
    let peakY = 32767;
    let peakX = view.cx;
    for (let x = x0; x <= x1; x++) {
      if (surfaceY[x] < peakY) {
        peakY = surfaceY[x];
        peakX = x;
      }
    }
    const limit = Math.max(3, Math.round(bergTopH * 0.5));
    walkLo = peakX;
    walkHi = peakX;
    while (walkLo - 1 >= x0 && surfaceY[walkLo - 1] <= peakY + limit) walkLo--;
    while (walkHi + 1 <= x1 && surfaceY[walkHi + 1] <= peakY + limit) walkHi++;
  }

  function drawBergUnderwater(t, h) {
    const halfW = Math.round(bergHalfW * 1.34) + 2;
    const maxDepth = Math.max(4, H - view.waterY - 3);
    const depth = Math.min(maxDepth, Math.round(bergTopH * 1.3 + 6));
    const tint = mixRgb(pal.ice[3], pal.sea[0], 0.35);
    const rim = mixRgb(pal.ice[1], pal.sea[1], 0.3);
    for (let dx = -halfW; dx <= halfW; dx++) {
      const x = view.cx + dx;
      if (x < 0 || x >= W) continue;
      const u = dx / halfW;
      let d = Math.round(
        depth * Math.pow(Math.cos((u * Math.PI) / 2), 0.7) * (0.85 + 0.15 * noise1(u * 5 + 7))
      );
      d = Math.round(d / 2) * 2; // chunky submerged facets
      if (d <= 0) continue;
      const top = view.waterY + 1;
      const bottom = Math.min(H - 1, top + d);
      const mid = Math.min(bottom, top + Math.round(d * 0.42));
      // Fade with depth so the mass sinks into the water instead of sitting on it.
      vline(x, mid + 1, bottom, css(tint, 0.3));
      vline(x, top, mid, css(tint, 0.5));
      vline(x, top, Math.min(bottom, top + 2), css(rim, 0.72));
      // Caustic shimmer along the submerged flank.
      if ((x + Math.floor(t * 4)) % 7 === 0) {
        px(x, top + 1 + (Math.floor(t * 3 + x) % Math.max(1, d)), css(pal.foam, 0.22));
      }
    }
    void h;
  }

  function drawBerg(t, h) {
    const x0 = Math.max(0, view.cx - bergHalfW);
    const x1 = Math.min(W - 1, view.cx + bergHalfW);
    const snow = css(pal.snow);
    const cracks = Math.floor((1 - h) * 6);

    for (let x = x0; x <= x1; x++) {
      const top = surfaceY[x];
      if (top === 32767) continue;
      const left = surfaceY[Math.max(x0, x - 2)];
      const right = surfaceY[Math.min(x1, x + 2)];
      // Light comes from the upper left: faces that rise to the right catch it.
      // Quantised to three levels so the ice reads as flat facets, not noise.
      const slope = left - right;
      const lit = slope >= 2 ? 0.17 : slope <= -2 ? -0.2 : 0;
      const flat = surfaceY[Math.max(x0, x - 1)] === top && surfaceY[Math.min(x1, x + 1)] === top;
      const span = view.waterY - top;

      const b1 = top + (flat ? 2 : 1);
      const b2 = top + Math.max(b1 - top + 1, Math.round(span * 0.46));
      const b3 = top + Math.max(b2 - top + 1, Math.round(span * 0.8));

      vline(x, top, b1 - 1, flat ? snow : css(shade(pal.snow, lit * 0.5)));
      vline(x, b1, b2 - 1, css(shade(pal.ice[1], lit)));
      vline(x, b2, b3 - 1, css(shade(pal.ice[2], lit)));
      vline(x, b3, view.waterY, css(shade(pal.ice[3], lit)));

      // Hard edge wherever a facet steps.
      const stepL = surfaceY[Math.max(x0, x - 1)];
      const stepR = surfaceY[Math.min(x1, x + 1)];
      if (Math.abs(stepL - stepR) >= 2) {
        px(x, top, stepL > stepR ? '#ffffff' : css(shade(pal.ice[2], -0.08)));
      }
      if (x === x0 || x === x1) vline(x, top, view.waterY, css(shade(pal.ice[3], -0.12)));
    }

    // Stress fractures open up as the budget burns.
    for (let i = 0; i < cracks; i++) {
      const u = (hash1(i * 5.5 + 2) * 2 - 1) * 0.8;
      const x = Math.round(view.cx + u * bergHalfW);
      if (x <= x0 + 1 || x >= x1 - 1) continue;
      const top = surfaceY[x];
      if (top === 32767) continue;
      const start = top + 2 + Math.round(hash1(i * 2.2) * 2);
      const len = Math.round((view.waterY - start) * (0.45 + hash1(i * 9.1) * 0.5));
      for (let k = 0; k < len; k++) {
        const jitter = Math.round(noise1(i * 3 + k * 0.55) * 1.3);
        px(clamp(x + jitter, x0, x1), start + k, css(shade(pal.ice[4], -0.3), 0.55));
      }
    }

    // Waterline foam collar.
    for (let x = x0; x <= x1; x++) {
      if (surfaceY[x] === 32767) continue;
      const wy = waveY(x, t);
      px(x, wy, css(pal.foam, 0.75));
      if ((x + Math.floor(t * 5)) % 5 === 0) px(x, wy - 1, css(pal.foam, 0.4));
    }
  }

  function drawReflection(t) {
    const halfW = bergHalfW;
    for (let dx = -halfW; dx <= halfW; dx += 1) {
      const x = view.cx + dx;
      if (x < 0 || x >= W) continue;
      const depth = 2 + ((Math.floor(x * 0.5 + t * 3) % 5) | 0);
      const y = view.waterY + depth;
      if (y < H) px(x, y, css(pal.ice[2], 0.12));
    }
  }

  // ---------------------------------------------------------- the polar bear -

  const BEAR_BODY = [
    '...........WW...',
    '..........WWWW..',
    '..WWWWWWW.WWWWWW',
    '.WWWWWWWWWWWWkWW',
    'WWWWWWWWWWWWWWWn',
    'WWWWWWWWWWWWWWw.',
    '.WWWWWWWWWWWgw..',
    '..wwwwwwwwwwww..'
  ];
  const BEAR_W = 16;
  const BEAR_H = 8;
  const EYE_COL = 13;
  const EYE_ROW = 3;

  /** Outline cells hugging the shaded side, so the bear never melts into the snow. */
  function buildOutline(shadowSide) {
    const solid = (r, c) =>
      r >= 0 && r < BEAR_H && c >= 0 && c < BEAR_W && BEAR_BODY[r][c] !== '.';
    const cells = [];
    for (let r = 0; r <= BEAR_H; r++) {
      for (let c = -1; c <= BEAR_W; c++) {
        if (solid(r, c)) continue;
        if (solid(r - 1, c) || solid(r, c - shadowSide)) cells.push([r, c]);
      }
    }
    return cells;
  }
  const OUTLINE_R = buildOutline(1);
  const OUTLINE_L = buildOutline(-1);

  const bear = {
    x: 0,
    dir: 1,
    pose: 'walk',
    phase: 0,
    timer: 1.2,
    blink: 0,
    hop: 0
  };

  function bearPalette() {
    const w = pal.warmth;
    return {
      W: css(mixRgb([255, 255, 255], [255, 226, 208], w * 0.7)),
      w: css(mixRgb([220, 234, 247], [235, 200, 186], w * 0.7)),
      g: css(mixRgb([170, 196, 218], [190, 150, 145], w * 0.7)),
      k: '#12121c',
      n: '#22222e'
    };
  }

  function bergBounds() {
    const margin = Math.max(3, Math.round(BEAR_W * 0.4));
    let lo = walkLo + margin;
    let hi = walkHi - margin;
    if (hi - lo < 2) {
      lo = hi = Math.round((walkLo + walkHi) / 2);
    }
    return [lo, hi];
  }

  function surfaceAt(x) {
    const xi = clamp(Math.round(x), 0, W - 1);
    let y = surfaceY[xi];
    if (y === 32767) y = view.waterY - 1;
    return y;
  }

  function updateBear(dt, h) {
    const [lo, hi] = bergBounds();
    const room = hi - lo;
    bear.timer -= dt;
    bear.blink -= dt;
    if (bear.hop > 0) bear.hop = Math.max(0, bear.hop - dt);
    if (bear.blink < -3) bear.blink = 0.14 + Math.random() * 0.1;

    if (h <= 0.04) {
      bear.pose = 'shiver';
    } else if (bear.timer <= 0) {
      const r = Math.random();
      if (room < 6) {
        bear.pose = r < 0.7 ? 'sit' : 'idle';
        bear.timer = 2 + Math.random() * 3;
      } else if (bear.pose === 'walk') {
        bear.pose = r < 0.45 ? 'sniff' : r < 0.8 ? 'idle' : 'sit';
        bear.timer = 0.8 + Math.random() * 2.2;
      } else {
        bear.pose = 'walk';
        bear.timer = 1.6 + Math.random() * 3.4;
        if (Math.random() < 0.35) bear.dir *= -1;
      }
    }

    if (bear.pose === 'walk' && room >= 6) {
      const speed = lerp(7, 15, clamp(h, 0, 1));
      bear.x += bear.dir * speed * dt;
      bear.phase = (bear.phase + dt / 0.52) % 1;
      if (bear.x > hi) {
        bear.x = hi;
        bear.dir = -1;
      } else if (bear.x < lo) {
        bear.x = lo;
        bear.dir = 1;
      }
      dropFootprint(bear.x, surfaceAt(bear.x));
    } else {
      bear.phase = 0;
    }
    bear.x = clamp(bear.x, lo, hi);
  }

  function drawBear(t) {
    const p = bearPalette();
    const flip = bear.dir < 0;
    const jitter = bear.pose === 'shiver' ? (Math.floor(t * 22) % 2 ? 1 : 0) : 0;
    const sx = Math.round(bear.x) - BEAR_W / 2 + jitter;
    // Average the ground under the paws so the body sits level on a slope.
    const groundA = surfaceAt(sx + 3);
    const groundB = surfaceAt(sx + 12);
    const footY = Math.round((groundA + groundB) / 2);

    let legH = 3;
    let bodyDrop = 0;
    if (bear.pose === 'sit' || bear.pose === 'shiver') {
      legH = 2;
      bodyDrop = 1;
    } else if (bear.pose === 'sniff') {
      bodyDrop = Math.sin(t * 5) > 0 ? 1 : 0;
    }

    const bob = bear.pose === 'walk' && Math.sin(bear.phase * Math.PI * 4) > 0.55 ? -1 : 0;
    const hop = bear.hop > 0 ? -Math.round(Math.sin((1 - bear.hop / 0.45) * Math.PI) * 4) : 0;
    const bodyY = footY - legH - BEAR_H + 1 + bodyDrop + bob + hop;

    const col = (c) => (flip ? sx + (BEAR_W - 1 - c) : sx + c);

    // Contact shadow so the white bear separates from the white snow.
    for (let i = 1; i < BEAR_W - 1; i++) {
      const x = sx + i;
      if (x < 0 || x >= W) continue;
      const sy = surfaceAt(x);
      const fade = i < 3 || i > BEAR_W - 4 ? 0.14 : 0.3;
      px(x, sy + 1, css(shade(pal.ice[3], -0.25), fade));
      px(x, sy + 2, css(shade(pal.ice[3], -0.2), fade * 0.5));
    }

    // Legs (far pair first so the near pair overlaps them).
    const legs = [
      { c: 5, phase: 0.5, far: true },
      { c: 13, phase: 0.0, far: true },
      { c: 2, phase: 0.5, far: false },
      { c: 10, phase: 0.0, far: false }
    ];
    for (const leg of legs) {
      let swing = 0;
      let lift = 0;
      if (bear.pose === 'walk') {
        const lp = (bear.phase + leg.phase) % 1;
        swing = Math.round(Math.sin(lp * Math.PI * 2) * 1.4) * (flip ? -1 : 1);
        lift = lp > 0.5 ? 1 : 0;
      } else if (bear.pose === 'sit' && leg.c < 8) {
        lift = 1;
      }
      const top = bodyY + BEAR_H - 1;
      const color = leg.far ? p.g : p.W;
      for (let d = 0; d < 2; d++) {
        const x = col(leg.c + d) + swing;
        if (x < 0 || x >= W) continue;
        // Each paw finds its own patch of ice, so slopes look natural.
        const bottom = surfaceAt(x) - 1 - lift;
        const hgt = clamp(bottom - top + 1, 2, 4);
        vline(x, top, top + hgt - 1, color);
        px(x, top + hgt - 1, leg.far ? p.g : p.w);
      }
    }

    // Tail.
    const wag = bear.pose === 'walk' ? (Math.sin(bear.phase * Math.PI * 2) > 0 ? 0 : 1) : 0;
    const tx = col(0);
    px(tx, bodyY + 3 + wag, p.W);
    px(tx, bodyY + 4 + wag, p.w);

    // Body + head.
    const outline = css(shade(pal.ice[3], -0.32), 0.55);
    for (const cell of flip ? OUTLINE_L : OUTLINE_R) {
      const x = col(cell[1]);
      const y = bodyY + cell[0];
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      px(x, y, outline);
    }
    for (let r = 0; r < BEAR_H; r++) {
      const row = BEAR_BODY[r];
      for (let c = 0; c < BEAR_W; c++) {
        const ch = row[c];
        if (ch === '.') continue;
        const x = col(c);
        const y = bodyY + r;
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        px(x, y, p[ch]);
      }
    }

    // Blink / squint.
    const blinking = bear.blink > 0 || bear.pose === 'shiver';
    if (blinking) px(col(EYE_COL), bodyY + EYE_ROW, p.W);

    // Sniff puff and shiver marks.
    if (bear.pose === 'sniff' && Math.sin(t * 3) > 0.4) {
      px(col(BEAR_W) + (flip ? -1 : 1), bodyY + 4, css(pal.foam, 0.7));
    }
    if (bear.pose === 'shiver') {
      const a = 0.4 + 0.3 * Math.sin(t * 9);
      px(col(-2), bodyY + 1, css(pal.foam, a));
      px(col(BEAR_W + 1), bodyY + 1, css(pal.foam, a));
    }
  }

  // ------------------------------------------------------------- particles --

  const footprints = [];
  const flakes = [];
  const drips = [];
  const chunks = [];
  let lastFootX = -999;

  function dropFootprint(x, y) {
    if (Math.abs(x - lastFootX) < 4) return;
    lastFootX = x;
    footprints.push({ x: Math.round(x), y: y, life: 5 });
    if (footprints.length > 40) footprints.shift();
  }

  function seedFlakes() {
    flakes.length = 0;
    const n = Math.round(W * 0.35);
    for (let i = 0; i < n; i++) {
      flakes.push({
        x: Math.random() * W,
        y: Math.random() * view.waterY,
        v: 4 + Math.random() * 10,
        d: Math.random() * 0.6 - 0.3
      });
    }
  }

  function updateParticles(dt, t, h) {
    for (let i = footprints.length - 1; i >= 0; i--) {
      footprints[i].life -= dt;
      if (footprints[i].life <= 0) footprints.splice(i, 1);
    }

    const snowy = clamp((h - 0.25) / 0.5, 0, 1);
    for (const f of flakes) {
      f.y += f.v * dt * (0.4 + snowy);
      f.x += (f.d + Math.sin(t * 0.7 + f.y * 0.05) * 0.5) * dt * 10;
      if (f.y > view.waterY) {
        f.y = -1;
        f.x = Math.random() * W;
      }
      if (f.x < 0) f.x += W;
      if (f.x >= W) f.x -= W;
    }

    // Melt water dripping off the flanks.
    if (h < 0.92 && Math.random() < (1 - h) * dt * 26) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const x = view.cx + side * Math.round(bergHalfW * (0.5 + Math.random() * 0.5));
      const y = surfaceAt(x) + Math.random() * Math.max(1, view.waterY - surfaceAt(x));
      drips.push({ x: x, y: y, v: 12 + Math.random() * 14, splash: 0 });
    }
    for (let i = drips.length - 1; i >= 0; i--) {
      const d = drips[i];
      if (d.splash > 0) {
        d.splash -= dt;
        if (d.splash <= 0) drips.splice(i, 1);
        continue;
      }
      d.v += 40 * dt;
      d.y += d.v * dt;
      if (d.y >= view.waterY) {
        d.y = view.waterY;
        d.splash = 0.35;
      }
    }

    for (let i = chunks.length - 1; i >= 0; i--) {
      const c = chunks[i];
      c.x += c.vx * dt;
      c.vy += 26 * dt;
      c.y += c.vy * dt;
      const rest = view.waterY - c.h + 1;
      if (c.y > rest) {
        c.y = rest;
        c.vy = -c.vy * 0.28;
        if (Math.abs(c.vy) < 4) c.vy = 0;
      }
      c.life -= dt;
      if (c.life <= 0 || c.x < -12 || c.x > W + 12) chunks.splice(i, 1);
    }
  }

  function calveChunk() {
    const side = Math.random() < 0.5 ? -1 : 1;
    const x = view.cx + side * bergHalfW;
    chunks.push({
      x: x,
      y: surfaceAt(x) - 2,
      vx: side * (5 + Math.random() * 8),
      vy: -8 - Math.random() * 6,
      w: 2 + Math.floor(Math.random() * 4),
      h: 2 + Math.floor(Math.random() * 3),
      life: 6 + Math.random() * 4
    });
  }

  function drawParticles(t, h) {
    for (const f of footprints) {
      const a = clamp(f.life / 5, 0, 1) * 0.5;
      px(Math.round(f.x), f.y + 1, css(pal.ice[3], a));
    }

    const snowy = clamp((h - 0.25) / 0.5, 0, 1);
    if (snowy > 0.02) {
      for (const f of flakes) {
        px(Math.floor(f.x), Math.floor(f.y), css(pal.snow, 0.25 + 0.5 * snowy));
      }
    }

    for (const d of drips) {
      if (d.splash > 0) {
        const r = Math.round((1 - d.splash / 0.35) * 2) + 1;
        px(d.x - r, view.waterY - 1, css(pal.foam, d.splash * 2));
        px(d.x + r, view.waterY - 1, css(pal.foam, d.splash * 2));
      } else {
        px(Math.round(d.x), Math.round(d.y), css(pal.foam, 0.8));
      }
    }

    for (const c of chunks) {
      const bobY = Math.round(c.y + (c.vy === 0 ? Math.sin(t * 2.4 + c.x) * 0.6 : 0));
      rect(Math.round(c.x), bobY, c.w, c.h, css(pal.ice[1]));
      rect(Math.round(c.x), bobY + c.h - 1, c.w, 1, css(pal.ice[3]));
    }

    // Heat haze once things get dire.
    if (h < 0.3) {
      const a = (0.3 - h) / 0.3;
      for (let i = 0; i < 10; i++) {
        const x = Math.round(view.cx + Math.sin(t * 0.8 + i * 2.1) * bergHalfW * 0.9);
        const y = Math.round(surfaceAt(x) - 3 - ((t * 9 + i * 7) % 14));
        if (y > 0) px(x, y, css(pal.foam, a * 0.25));
      }
    }
  }

  // ------------------------------------------------------------ frame loop --

  let lastT = performance.now();
  let clock = 0;
  let lastChunkHealth = 1;
  let dirty = true;

  function layout() {
    const rectBox = stage.getBoundingClientRect();
    const cw = Math.max(80, Math.floor(rectBox.width));
    const ch = Math.max(60, Math.floor(rectBox.height));
    scale = state.pixelScale > 0 ? state.pixelScale : clamp(Math.ceil(cw / 240), 1, 6);
    const nw = clamp(Math.floor(cw / scale), 96, 512);
    const nh = clamp(Math.floor(ch / scale), 64, 512);
    if (nw === W && nh === H && canvas.width === nw) return;
    W = nw;
    H = nh;
    canvas.width = W;
    canvas.height = H;
    canvas.style.width = W * scale + 'px';
    canvas.style.height = H * scale + 'px';
    ctx.imageSmoothingEnabled = false;

    view.cx = Math.round(W / 2);
    view.waterY = Math.round(H * 0.66);
    view.maxHalfW = Math.round(Math.min(W * 0.38, 84));
    view.minHalfW = Math.max(10, Math.round(W * 0.05));
    view.maxTop = Math.round(Math.min(H * 0.4, 50));
    view.minTop = 3;
    bear.x = view.cx;
    palKey = -1;
    dirty = true;
    seedFlakes();
    renderSkyIfNeeded(true);
  }

  function renderSkyIfNeeded(force) {
    const key = Math.round(state.health * 40);
    if (!force && key === palKey && pal) return;
    palKey = key;
    pal = buildPalette(state.health);
    renderSky();
  }

  function frame(now) {
    requestAnimationFrame(frame);

    const elapsed = now - lastT;
    if (elapsed < 31) return; // cap at ~30fps; this is a background ornament
    const dt = Math.min(0.05, Math.max(0, elapsed / 1000));
    lastT = now;

    const settled = Math.abs(state.health - state.targetHealth) < 0.0005;
    if (!state.animate && settled && !dirty) return;
    dirty = false;

    if (state.animate) clock += dt;

    // Ease the displayed health toward the reported value so melting is smooth.
    state.health += (state.targetHealth - state.health) * Math.min(1, dt * 2.2);
    if (Math.abs(state.health - state.targetHealth) < 0.0005) state.health = state.targetHealth;

    renderSkyIfNeeded(false);
    layoutBerg(state.health);

    if (lastChunkHealth - state.health > 0.05) {
      lastChunkHealth = state.health;
      calveChunk();
    } else if (state.health > lastChunkHealth) {
      lastChunkHealth = state.health;
    }

    const t = clock;
    updateBear(dt, state.health);
    updateParticles(dt, t, state.health);

    ctx.drawImage(skyCanvas, 0, 0);
    drawStars(t, state.health);
    drawSun(t, state.health);
    drawAurora(t, state.health);
    drawDistantBergs(t, state.health);
    drawSea(t);
    drawBergUnderwater(t, state.health);
    drawReflection(t);
    drawBerg(t, state.health);
    drawBear(t);
    drawParticles(t, state.health);
  }

  // ------------------------------------------------------------------ HUD ---

  function fmt(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
    if (n >= 1e4) return Math.round(n / 1e3) + 'k';
    return n.toLocaleString('en-US');
  }

  function applyState(s) {
    const first = state.total === 0 && s.total === 0;
    Object.assign(state, s);
    state.targetHealth = clamp(s.health, 0, 1);
    if (first) state.health = state.targetHealth;
    dirty = true;
    if (s.pixelScale !== undefined) layout();

    const pct = Math.round(state.targetHealth * 100);
    el.name.textContent = s.bearName || 'Nanuq';
    el.pct.textContent = pct + '%';
    el.fill.style.width = Math.max(0, state.targetHealth * 100) + '%';
    const prompt = s.basis === 'context' && s.context;
    el.tokens.textContent = prompt
      ? 'Prompt used ' + prompt.used.toLocaleString('en-US') + ' / limit ' + prompt.limit.toLocaleString('en-US') + ' tokens'
      : 'Counted ' + s.total.toLocaleString('en-US') + ' / target ' + s.budget.toLocaleString('en-US') + ' tokens';
    el.tokens.title = prompt
      ? 'Latest observed prompt / max_prompt_tokens; not the selected chat\'s full context window.'
      : 'Enabled token dimensions / iceberg.tokenBudget; a local visual target, not a Copilot spending cap.';
    el.split.textContent = 'local in ' + fmt(s.input) + ' · out ' + fmt(s.output);
    if (el.basis) {
      // The percentage means two different things depending on what the
      // telemetry can see, so say which one it is rather than leaving a bare
      // number to be misread.
      el.basis.textContent =
        prompt ? 'latest prompt free' : 'local budget remaining';
    }
    if (el.source) {
      el.source.textContent =
        prompt
          ? 'latest trace (any session)'
          : s.source === 'otel' ? 'local usage · OpenTelemetry' : 'local usage · transcripts';
      el.source.title = prompt
        ? (prompt.model || 'unknown model') + ' · ' + new Date(prompt.atMs).toISOString()
        : 'Observed across local sessions/workspaces, not the selected chat or account billing period.';
      el.source.dataset.live = s.source === 'otel' ? 'true' : 'false';
    }

    const accent = pct > 50 ? '#9fd8ff' : pct > 20 ? '#ffcf7a' : '#ff8a6b';
    document.documentElement.style.setProperty('--ice-accent', accent);
    el.fill.style.background =
      pct > 50
        ? 'linear-gradient(90deg,#6fc3ff,#d7f2ff)'
        : pct > 20
          ? 'linear-gradient(90deg,#e0a03c,#ffd88a)'
          : 'linear-gradient(90deg,#a83a20,#ff8a5c)';
    meltedBadge.hidden = pct > 0;
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg && msg.type === 'state') applyState(msg.state);
  });
  window.addEventListener('resize', layout);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(layout).observe(stage);
  }
  stage.addEventListener('click', (e) => {
    // Poke the bear: it hops, and heads toward where you clicked.
    const box = canvas.getBoundingClientRect();
    const x = (e.clientX - box.left) / Math.max(1, box.width / W);
    bear.dir = x < bear.x ? -1 : 1;
    bear.hop = 0.45;
    bear.pose = 'walk';
    bear.timer = 2.5;
    dirty = true;
  });
  // Guarded: the screenshot harnesses render a cut-down HUD, and a missing
  // optional control must never take the whole canvas down with it.
  const btnDashboard = document.getElementById('btnDashboard');
  if (btnDashboard) {
    btnDashboard.addEventListener('click', () => {
      vscode && vscode.postMessage({ type: 'dashboard' });
    });
  }

  layout();
  requestAnimationFrame(frame);
  vscode && vscode.postMessage({ type: 'ready' });
})();
