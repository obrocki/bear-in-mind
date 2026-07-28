'use strict';
// Generates media/icon.png — a 128x128 pixel-art iceberg with the bear on it,
// drawn on a 32x32 grid and upscaled 4x. Pure Node, no dependencies.
//
//   node tools/make-icon.js
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const S = 128;
const buf = Buffer.alloc(S * S * 4, 0);

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const o = (y * S + x) * 4;
  buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = a;
}
function hex(h) {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function rect(x, y, w, h, c) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(x + i, y + j, c[0], c[1], c[2]);
}

const N = 32;            // pixel-art grid, each cell is 4 real pixels
const cell = S / N;
const grid = [];
for (let y = 0; y < N; y++) grid.push(new Array(N).fill(null));
const put = (x, y, c) => { if (x >= 0 && y >= 0 && x < N && y < N) grid[y][x] = c; };

const SKY0 = hex('#071a35'), SKY1 = hex('#123a68'), SKY2 = hex('#2f7bab');
const SEA0 = hex('#061529'), SEA1 = hex('#0d3050');
const SNOW = hex('#ffffff'), ICE1 = hex('#dff2ff'), ICE2 = hex('#a9d8f2'), ICE3 = hex('#6fb0d8');
const UW = hex('#2c5f86'), K = hex('#12121c');

const waterY = 21;
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    put(x, y, y < 8 ? SKY0 : y < 15 ? SKY1 : y < waterY ? SKY2 : y < waterY + 2 ? SEA1 : SEA0);
  }
}
// stars
[[3, 3], [9, 2], [16, 4], [24, 3], [28, 6], [6, 7], [21, 6]].forEach(([x, y]) => put(x, y, SNOW));

// iceberg silhouette (top surface per column)
const cx = 16, halfW = 13, top = 9;
const prof = (u) => Math.pow(Math.cos((u * Math.PI) / 2), 0.55) * 0.74
  + 0.34 * Math.exp(-Math.pow((u + 0.3) / 0.28, 2))
  + 0.14 * Math.exp(-Math.pow((u - 0.45) / 0.3, 2));
const surf = {};
for (let x = cx - halfW; x <= cx + halfW; x++) {
  const u = (x - cx) / halfW;
  const t = waterY - Math.max(1, Math.round((waterY - top) * Math.min(1, prof(u))));
  surf[x] = t;
  const span = waterY - t;
  for (let y = t; y <= waterY; y++) {
    const f = (y - t) / Math.max(1, span);
    put(x, y, f < 0.18 ? SNOW : f < 0.5 ? ICE1 : f < 0.82 ? ICE2 : ICE3);
  }
}
// underwater mass
for (let x = cx - halfW - 3; x <= cx + halfW + 3; x++) {
  const u = (x - cx) / (halfW + 3);
  const d = Math.round(7 * Math.pow(Math.cos((u * Math.PI) / 2), 0.75));
  for (let y = waterY + 1; y <= waterY + d; y++) put(x, y, UW);
}

// polar bear (10x6 body + legs), standing on the right shoulder of the berg
const BODY = [
  '.......WW.',
  '..WWWW.WWW',
  '.WWWWWWWkW',
  'WWWWWWWWWW',
  'WWWWWWWWWW',
  '.WWWWWWWW.'
];
const bx = 11, by = surf[bx + 4] - 8;
for (let r = 0; r < BODY.length; r++) {
  for (let c = 0; c < 10; c++) {
    const ch = BODY[r][c];
    if (ch === '.') continue;
    put(bx + c, by + r, ch === 'k' ? K : SNOW);
  }
}
put(bx + 9, by + 3, K); // nose
[1, 2, 6, 7].forEach((c) => { put(bx + c, by + 6, SNOW); put(bx + c, by + 7, SNOW); });

for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) rect(x * cell, y * cell, cell, cell, grid[y][x]);

// PNG encode
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
let table = null;
function crc32(b) {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);
const out = process.argv[2] || path.join(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
