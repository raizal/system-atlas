// The HTTP server of the atlas. It listens on 127.0.0.1 only. The API is GET only and
// read only: it reads the CodeGraph index and the source files, and it does not write.
//   GET /api/info              the workspace: its folder, name and counts
//   GET /api/view?id=<id>      one level of the map (see view.ts)
//   GET /api/search?q=<words>  the functions, pages, routes and commands that fit the words
//   GET /api/lens?q=<query>    the search lens: a view with only the parts that fit the query (also /api/view?id=lens:<query>)
//   GET /api/node?id=<id>      the panel of a code node: file, line, callers and callees
//   GET /api/tests             the e2e specs and their cases, with the results of the last run
//   GET /api/case?id=<id>      the steps of one case, with their targets on the map
//   GET /api/coverage          the cases that touch each page and endpoint
// The server does not run the tests: `atlas test` runs them, and the server reads the last results.
// All other GET paths serve the built page (dist/web). A request with an Origin header from another
// host gets 403. All other methods get 405.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { Atlas } from './model.js';
import { lensView } from './lens.js';
import { TestModel } from './tests.js';

export const DEFAULT_PORT = 4890;
export const HOST = '127.0.0.1';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface AtlasServerOptions {
  atlas: Atlas;
  /** The Tests mode. No value: a model with the last results of `atlas test`. */
  tests?: TestModel;
  /** The folder of the built page. No value: the API only. */
  web?: string;
}

/** The request handler, for a test without a port. */
export function createHandler(opts: AtlasServerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { atlas, web } = opts;
  const tests = opts.tests ?? new TestModel(atlas);
  return async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('allow', 'GET, HEAD');
        return sendJson(res, 405, { ok: false, error: 'The atlas API is read only: use GET.' });
      }
      if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Origin does not match Host' });
      const url = new URL(req.url ?? '/', 'http://atlas');
      const path = url.pathname;
      if (path === '/api/info') return sendJson(res, 200, { ok: true, ...atlas.info() });
      if (path === '/api/lens') return sendJson(res, 200, await lensView(atlas, tests, url.searchParams.get('q') ?? ''));
      if (path === '/api/view') {
        const id = url.searchParams.get('id') ?? 'system';
        if (id.startsWith('lens:')) return sendJson(res, 200, await lensView(atlas, tests, id.slice('lens:'.length)));
        return sendJson(res, 200, (await tests.view(id)) ?? (await atlas.view(id)));
      }
      if (path === '/api/search') {
        const q = url.searchParams.get('q') ?? '';
        return sendJson(res, 200, { ok: true, hits: [...atlas.search(q), ...(await tests.search(q, 5))] });
      }
      if (path === '/api/tests') return sendJson(res, 200, await tests.info());
      if (path === '/api/case') {
        const info = await tests.caseInfo(url.searchParams.get('id') ?? '');
        return sendJson(res, info.ok ? 200 : 404, info);
      }
      if (path === '/api/coverage') return sendJson(res, 200, await tests.coverage());
      if (path === '/api/node') {
        const info = atlas.node(url.searchParams.get('id') ?? '');
        return sendJson(res, info.ok ? 200 : 404, info);
      }
      if (path.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: `No API at ${path}` });
      if (!web) return send(res, 404, TYPES['.html']!, 'The page is not built. Run `npm run build`.');
      return await serveFile(res, web, path);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
}

/** Start the server on 127.0.0.1. Port 0 picks a free port. */
export function startServer(opts: AtlasServerOptions & { port?: number }): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => void createHandler(opts)(req, res));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? DEFAULT_PORT, HOST, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({ server, url: `http://${HOST}:${port}/` });
    });
  });
}

/** No Origin header, or an Origin with the same host as Host (or one X-Forwarded-Host from a proxy). */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  if (host === (req.headers.host ?? '').toLowerCase()) return true;
  const forwarded = req.headers['x-forwarded-host'];
  return typeof forwarded === 'string' && !forwarded.includes(',') && host === forwarded.trim().toLowerCase();
}

async function serveFile(res: ServerResponse, web: string, path: string): Promise<void> {
  const rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
  const file = join(web, rel === '' ? 'index.html' : rel);
  // A path outside the folder of the page gets 404.
  if (file !== web && !file.startsWith(web.endsWith(sep) ? web : web + sep)) return send(res, 404, TYPES['.html']!, 'Not found');
  try {
    const body = await readFile(file);
    send(res, 200, TYPES[extname(file)] ?? 'application/octet-stream', body);
  } catch {
    // The page uses the URL hash for its state, so each other path gets the page.
    try {
      send(res, 200, TYPES['.html']!, await readFile(join(web, 'index.html')));
    } catch {
      send(res, 404, TYPES['.html']!, 'Not found');
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, TYPES['.json']!, JSON.stringify(body));
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}
