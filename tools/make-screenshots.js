'use strict';
// Regenerates the still screenshots in docs/media by loading tools/shot.html in
// headless Chromium/Edge and driving it over the DevTools protocol. Because it
// is a real browser, the HUD, fonts and CSS in the shots are genuine.
//
//   node tools/make-screenshots.js
//
// Set BROWSER_PATH if your Chrome/Edge install is somewhere unusual.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'media');
const PORT = Number(process.env.CDP_PORT || 9333);

const SHOTS = [
  { file: 'hero.png', page: 'shot.html', q: 'health=1&chrome=0&hud=0&pixelScale=4', w: 1200, h: 330, dsf: 1, settle: 9000 },
  { file: 'panel-full.png', page: 'shot.html', q: 'health=1', w: 330, h: 440, dsf: 2, settle: 6000 },
  { file: 'panel-mid.png', page: 'shot.html', q: 'health=0.54', w: 330, h: 440, dsf: 2, settle: 6500 },
  { file: 'panel-low.png', page: 'shot.html', q: 'health=0.16', w: 330, h: 440, dsf: 2, settle: 7000 },
  { file: 'panel-melted.png', page: 'shot.html', q: 'health=0', w: 330, h: 440, dsf: 2, settle: 6000 },
  { file: 'editor-view.png', page: 'shot.html', q: 'health=0.38&compact=0&chrome=0', w: 900, h: 520, dsf: 2, settle: 8000 },
  { file: 'melt-progression.png', page: 'grid.html', q: '', w: 1160, h: 330, dsf: 2, settle: 11000 },
  // The dashboard is static DOM, so it needs only long enough to paint.
  { file: 'dashboard.png', page: 'dashboard.html', q: '', w: 1180, h: 540, dsf: 2, settle: 1200 },
  { file: 'dashboard-empty.png', page: 'dashboard.html', q: 'empty', w: 1180, h: 330, dsf: 2, settle: 1200 }
];

function findBrowser() {
  if (process.env.BROWSER_PATH) return process.env.BROWSER_PATH;
  const candidates = {
    win32: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge'
    ]
  }[process.platform] || [];
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) {
    throw new Error('No Chrome/Edge found. Set BROWSER_PATH to the executable.');
  }
  return hit;
}

let nextId = 1;
const pending = new Map();

function send(ws, method, params, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevTools() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return await res.json();
    } catch {
      await sleep(200);
    }
  }
  throw new Error('the browser never opened its DevTools endpoint');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'iceberg-shots-'));
  const browser = spawn(
    findBrowser(),
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      '--no-first-run',
      '--disable-extensions',
      '--allow-file-access-from-files',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  const version = await waitForDevTools();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  });
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

  const { targetId } = await send(ws, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send(ws, 'Target.attachToTarget', { targetId, flatten: true });
  await send(ws, 'Page.enable', {}, sessionId);

  for (const shot of SHOTS) {
    await send(
      ws,
      'Emulation.setDeviceMetricsOverride',
      { width: shot.w, height: shot.h, deviceScaleFactor: shot.dsf, mobile: false },
      sessionId
    );
    const url = pathToFileURL(path.join(__dirname, shot.page)).href + (shot.q ? `?${shot.q}` : '');
    await send(ws, 'Page.navigate', { url }, sessionId);
    // The scene eases toward its target health and the bear wanders, so give it
    // real time to settle into a frame worth photographing.
    await sleep(shot.settle);
    const { data } = await send(ws, 'Page.captureScreenshot', { format: 'png' }, sessionId);
    const buf = Buffer.from(data, 'base64');
    fs.writeFileSync(path.join(OUT, shot.file), buf);
    console.log(`${shot.file}  ${shot.w * shot.dsf}x${shot.h * shot.dsf}  ${(buf.length / 1024).toFixed(1)} kB`);
  }

  await send(ws, 'Browser.close').catch(() => {});
  ws.close();
  browser.kill();
  // Best effort: on Windows the browser can still hold the profile open for a
  // moment after exiting, and a leftover temp directory is not worth failing on.
  await sleep(500);
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* ignore */
  }
  console.log('done');
  process.exit(0);
})().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});
