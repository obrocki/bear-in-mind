// Loopback HTTP server for one canvas instance: static UI, JSON API and SSE.

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const STATIC = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/dom.js', 'dom.js'],
  ['/markdown.js', 'markdown.js'],
  ['/style.css', 'style.css'],
]);
const MAX_BODY = 16 * 1024;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

/**
 * @param {{
 *   uiDir: string,
 *   api: {
 *     model(): Promise<unknown>, research(): Promise<string>,
 *     coverage(): Promise<unknown>, refresh(windowDays?: number): Promise<unknown>,
 *     getView(): string, setView(view: string): string, windowDays(): number,
 *   },
 * }} options
 */
export async function startCanvasServer({ uiDir, api }) {
  const clients = new Set();

  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port;
    // Loopback only, and reject foreign Host headers (DNS rebinding).
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
      send(res, 403, { error: 'forbidden' });
      return;
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const origin = req.headers.origin;
    if (
      req.method !== 'GET' &&
      origin &&
      origin !== `http://127.0.0.1:${port}` &&
      origin !== `http://localhost:${port}`
    ) {
      send(res, 403, { error: 'forbidden' });
      return;
    }
    try {
      if (req.method === 'GET' && STATIC.has(url.pathname)) {
        const file = STATIC.get(url.pathname);
        send(res, 200, await fs.readFile(path.join(uiDir, file)), MIME[path.extname(file)]);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write(`event: view\ndata: ${JSON.stringify({ view: api.getView() })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/model') {
        send(res, 200, await api.model());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/research') {
        send(res, 200, { markdown: await api.research() });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/coverage') {
        send(res, 200, await api.coverage());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/coverage') {
        const body = await readJson(req);
        const days = body.windowDays === undefined ? api.windowDays() : Number(body.windowDays);
        send(res, 200, await api.refresh(days));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/view') {
        send(res, 200, { view: api.getView() });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/view') {
        const body = await readJson(req);
        send(res, 200, { view: api.setView(String(body.view ?? '')) });
        return;
      }
      send(res, 404, { error: 'not found' });
    } catch (err) {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/`,
    broadcast(event, data) {
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const client of clients) client.write(frame);
    },
    async close() {
      for (const client of clients) client.end();
      clients.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
