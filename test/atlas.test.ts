// The atlas model and its API on the shop fixture: the system level, the pages and the
// endpoints that they call, the routes, the flow charts, search and the panel.

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server/http.js';
import { OTHER_ROUTES, isNextApiRoute, routeGroups, type Atlas, type Endpoint } from '../src/server/model.js';
import type { AtlasView } from '../src/server/view.js';
import { fnId, shop, type Shop } from './helpers.js';

let s: Shop;
beforeAll(async () => {
  s = await shop();
});
afterAll(() => s?.index.close());

const labels = (v: AtlasView, shape?: string) => v.nodes.filter((n) => !shape || n.shape === shape).map((n) => n.label);

describe('the system level', () => {
  it('shows each project with its kind, and the data stores', async () => {
    const v = await s.atlas.view('system');
    expect(v.level).toBe('system');
    const byId = new Map(v.nodes.map((n) => [n.id, n]));
    expect(byId.get('project:shop-web')).toMatchObject({ shape: 'project', group: 'kind:frontend', open: 'project:shop-web' });
    expect(byId.get('project:shop-api')).toMatchObject({ group: 'kind:api', sub: 'api · 2 routes' });
    expect(byId.get('project:shop-tool')).toMatchObject({ group: 'kind:cli' });
    expect(labels(v, 'store').sort()).toEqual(['cache', 'db']);
  });

  it('draws the HTTP calls between projects with a count, and the store of a client dependency', async () => {
    const v = await s.atlas.view('system');
    expect(v.edges).toContainEqual(expect.objectContaining({ from: 'project:shop-web', to: 'project:shop-api', kind: 'http', label: '2 HTTP calls' }));
    expect(v.edges).toContainEqual(expect.objectContaining({ from: 'project:shop-api', to: 'store:db', label: 'pg' }));
  });
});

describe('the project level', () => {
  it('a frontend shows its pages, with an edge to each endpoint in the view of the api, and no copy of the endpoints', async () => {
    const v = await s.atlas.view('project:shop-web');
    expect(v.kind).toBe('frontend');
    expect(labels(v, 'page')).toEqual(['App', 'StatusView']);
    expect(labels(v, 'endpoint')).toEqual([]);
    const app = v.nodes.find((n) => n.label === 'App')!;
    expect(v.edges.filter((e) => e.from === app.id).map((e) => [e.kind, e.label, e.toPath])).toEqual([
      ['http', '1 call', ['project:shop-api', 'ep:shop-api:GET /api/orders']],
      ['http', '1 call', ['project:shop-api', 'ep:shop-api:POST /api/orders']],
    ]);
  });

  it('a frontend shows its HTTP client functions: each one opens as a flow chart', async () => {
    const v = await s.atlas.view('project:shop-web');
    const client = v.nodes.filter((n) => n.group === 'client');
    expect(client.map((n) => n.label)).toEqual(['loadOrders', 'saveOrder']);
    expect(client[0]).toMatchObject({ shape: 'function', open: `fn:${fnId(s.atlas, 'web/src/api.ts/loadOrders().')}` });
  });

  it('a page with no HTTP call of its own, that App uses, has a note: it gets its data through App', async () => {
    const v = await s.atlas.view('project:shop-web');
    const status = v.nodes.find((n) => n.label === 'StatusView')!;
    expect(v.edges.some((e) => e.from === status.id)).toBe(false);
    expect(status.note).toMatch(/through App/);
    expect(v.nodes.find((n) => n.label === 'App')!.note).toBeUndefined();
  });

  it('an api shows its routes by prefix, and no copy of the callers in other projects', async () => {
    const v = await s.atlas.view('project:shop-api');
    expect(v.kind).toBe('api');
    expect(v.nodes.filter((n) => n.shape === 'route').map((n) => [n.method, n.label, n.group])).toEqual([
      ['GET', '/api/orders', 'prefix:/api'],
      ['POST', '/api/orders', 'prefix:/api'],
    ]);
    expect(v.nodes.filter((n) => n.shape === 'route').map((n) => n.id)).toEqual(['ep:shop-api:GET /api/orders', 'ep:shop-api:POST /api/orders']);
    expect(v.nodes.filter((n) => n.group?.startsWith('grp:'))).toEqual([]);
    expect(v.edges.filter((e) => e.kind === 'http')).toHaveLength(0);
  });

  it('route groups: the first segment; a large group splits by the first word of the next segment; a route alone goes to other', () => {
    const r = (path: string) => ({ segs: path.split('/').filter(Boolean), path });
    const api = [
      '/api/review', '/api/review/accept', '/api/story-thread', '/api/story-tests/send', '/api/story-progress',
      '/api/design', '/api/design/save', '/api/epic', '/api/session', '/api/drift', '/api/graph',
    ].map(r);
    const groups = routeGroups([...api, r('/design/x'), r('/figcraft')]);
    expect(groups.map(([g, l]) => [g, l.map((e) => e.path)])).toEqual([
      ['/api/design', ['/api/design', '/api/design/save']],
      ['/api/review', ['/api/review', '/api/review/accept']],
      ['/api/story*', ['/api/story-thread', '/api/story-tests/send', '/api/story-progress']],
      [OTHER_ROUTES, ['/api/drift', '/api/epic', '/api/graph', '/api/session', '/design/x', '/figcraft']],
    ]);
    // A small api stays in one group.
    expect(routeGroups([r('/api/a'), r('/api/b')]).map(([g]) => g)).toEqual(['/api']);
  });

  it('a project that the index does not know gives a note', async () => {
    const v = await s.atlas.view('project:nothing');
    expect(v.ok).toBe(false);
    expect(v.notes).toEqual(['This project is not in the index.']);
  });
});

describe('a cell of the Matrix: both projects, filtered to the calls of the cell', () => {
  it('the frontend shows only the pages and the client functions that call the api', async () => {
    const v = await s.atlas.view('project:shop-web?to=shop-api');
    expect(v.ok).not.toBe(false);
    expect(labels(v, 'page')).toEqual(['App']);
    expect(v.nodes.filter((n) => n.group === 'client').map((n) => n.label)).toEqual(['loadOrders', 'saveOrder']);
    expect(v.edges.length).toBeGreaterThan(0);
    for (const e of v.edges) expect(e.toPath?.[0]).toBe('project:shop-api');
    expect(v.notes?.join(' ')).toMatch(/only the calls from/);
  });

  it('the api shows only the routes that the frontend calls', async () => {
    const v = await s.atlas.view('project:shop-api?from=shop-web');
    expect(v.nodes.filter((n) => n.shape === 'route').map((n) => n.id)).toEqual(['ep:shop-api:GET /api/orders', 'ep:shop-api:POST /api/orders']);
    const none = await s.atlas.view('project:shop-api?from=shop-tool');
    expect(none.nodes.filter((n) => n.shape === 'route')).toEqual([]);
  });
});

describe('the flow charts', () => {
  it('a page: render, the hooks, a diamond for each condition in the JSX, and the event handlers', async () => {
    const v = await s.atlas.view(`fn:${fnId(s.atlas, 'web/src/App.tsx/App().')}`);
    expect(v.level).toBe('flow');
    expect(v.nodes[0]).toMatchObject({ shape: 'start', label: 'App' });
    expect(labels(v, 'decision')).toEqual(['open?', 'orders.length === 0?']);
    expect(labels(v, 'event')).toEqual(['onSave: void saveOrder(n)', 'onClick: setOpen(true)', 'onClick: reset', 'onClose: close']);
    const effect = v.nodes.find((n) => n.sub === 'useEffect')!;
    expect(effect.open).toMatch(/^at:19:/);
    const list = v.nodes.find((n) => n.label === 'render <OrderList>')!;
    expect(list).toMatchObject({ shape: 'call', open: `fn:${fnId(s.atlas, 'web/src/App.tsx/OrderList().')}` });
    const branch = v.nodes.find((n) => n.label === 'orders.length === 0?')!;
    expect(v.edges.filter((e) => e.from === branch.id).map((e) => e.label).sort()).toEqual(['no', 'yes']);
  });

  it('the event handlers are in one grid group with one edge from the render', async () => {
    const v = await s.atlas.view(`fn:${fnId(s.atlas, 'web/src/App.tsx/App().')}`);
    expect(v.groups).toContainEqual(expect.objectContaining({ id: 'events', label: 'Event handlers (4)', layout: 'grid' }));
    expect(v.nodes.filter((n) => n.shape === 'event').every((n) => n.group === 'events')).toBe(true);
    const into = v.edges.filter((e) => e.to === 'events' || v.nodes.find((n) => n.id === e.to)?.shape === 'event');
    expect(into).toEqual([expect.objectContaining({ to: 'events', label: 'events' })]);
  });

  it('a run of hook calls becomes one node for each kind of hook, and the panel lists the lines', async () => {
    const v = await s.atlas.view(`fn:${fnId(s.atlas, 'web/src/App.tsx/App().')}`);
    expect(v.nodes.filter((n) => n.id.startsWith('join:')).map((n) => n.label)).toEqual([
      'state: 2 useState',
      'refs: 1 useRef',
      'memo: 2 useCallback, 1 useMemo',
      'other: 1 step',
    ]);
    const memo = v.nodes.find((n) => n.label.startsWith('memo:'))!;
    expect(memo).toMatchObject({ sub: 'lines 23-25', line: 23 });
    expect(memo.items!.map((i) => i.line)).toEqual([23, 24, 25]);
    expect(v.nodes.find((n) => n.label === 'other: 1 step')!.items).toEqual([{ label: 'const Status = StatusView;', line: 26 }]);
    // The joined nodes make one chain from the start to the return.
    const next = (id: string) => v.edges.filter((e) => e.from === id && e.kind === 'flow').map((e) => e.to);
    const chain = ['n1'];
    while (next(chain.at(-1)!).length === 1 && chain.length < 10) chain.push(next(chain.at(-1)!)[0]!);
    expect(chain.map((id) => v.nodes.find((n) => n.id === id)!.shape)).toEqual(['start', 'step', 'step', 'step', 'call', 'step', 'end']);
  });

  it('a client function: an HTTP edge from the call step to the endpoint in the view of the api, and the step has the target', async () => {
    const v = await s.atlas.view(`fn:${fnId(s.atlas, 'web/src/api.ts/loadOrders().')}`);
    expect(v.nodes.some((n) => n.shape === 'cross' && n.id.startsWith('x:'))).toBe(false);
    const http = v.edges.filter((e) => e.kind === 'http');
    expect(http).toEqual([expect.objectContaining({ label: 'GET /api/orders', to: 'ep:shop-api:GET /api/orders', toPath: ['project:shop-api', 'ep:shop-api:GET /api/orders'] })]);
    const step = v.nodes.find((n) => n.id === http[0]!.from)!;
    expect(step.target).toEqual(['project:shop-api', 'ep:shop-api:GET /api/orders']);
    expect(step.detail).toContain('HTTP call at line 2: GET /api/orders · shop-api');
  });

  it('a route: method and path, then the handler; a return that calls a function opens it', async () => {
    const v = await s.atlas.view('route:api/src/server.ts#/api/orders');
    expect(v.title).toBe('GET /api/orders');
    expect(v.nodes.map((n) => n.shape)).toEqual(['start', 'end']);
    expect(v.nodes[1]).toMatchObject({ sub: 'return · listOrders()', open: `fn:${fnId(s.atlas, 'api/src/server.ts/listOrders().')}` });
  });

  it('a decision has yes and no branches, and a throw ends the flow', async () => {
    const v = await s.atlas.view(`fn:${fnId(s.atlas, 'api/src/server.ts/createOrder().')}`);
    expect(v.nodes.map((n) => [n.shape, n.sub ?? ''])).toEqual([
      ['start', ''],
      ['decision', ''],
      ['end', 'throw'],
      ['step', ''],
      ['end', 'return'],
    ]);
    expect(v.edges.map((e) => e.label ?? '')).toEqual(['', 'yes', 'no', '']);
  });
});

describe('the match of a client call to an endpoint', () => {
  const ep = (unit: string, method: string, path: string, prefix = false): Endpoint => {
    const segs = path.split('/').filter(Boolean);
    return { key: `${method} ${path}${prefix ? '/*' : ''}`, unit, method, path, segs, prefix, open: `route:${unit}`, file: `${unit}/x.ts`, line: 1 };
  };
  /** An atlas with these endpoints only. */
  const withEndpoints = (list: Endpoint[]): Atlas => Object.assign(Object.create(s.atlas) as Atlas, { endpoints: list });

  it('a call never links to a route of its own project', () => {
    const a = withEndpoints([ep('web', 'GET', '/api/orders')]);
    expect(a.match('GET', '/api/orders', 'web')).toEqual({});
  });

  it('a tie goes to the project that the caller imports, then to the only exact method and path', () => {
    const a = withEndpoints([ep('one', 'ANY', '/api/x'), ep('two', 'ANY', '/api/x')]);
    expect(a.match('GET', '/api/x', 'web', new Set(['web\ntwo'])).endpoint?.unit).toBe('two');
    const b = withEndpoints([ep('one', 'ANY', '/api/x'), ep('two', 'GET', '/api/x')]);
    expect(b.match('GET', '/api/x', 'web').endpoint?.unit).toBe('two');
  });

  it('if there is still a tie, the call has no endpoint, only possible endpoints', () => {
    const a = withEndpoints([ep('one', 'GET', '/api/x'), ep('two', 'GET', '/api/x')]);
    const fit = a.match('GET', '/api/x', 'web');
    expect(fit.endpoint).toBeUndefined();
    expect(fit.possible!.map((e) => e.unit).sort()).toEqual(['one', 'two']);
  });

  it('a catch-all "/api/*" is only possible, also in a project that the caller imports (a `startsWith` check is not a route)', () => {
    const a = withEndpoints([ep('atlas', 'ANY', '/api', true)]);
    expect(a.match('GET', '/api/state', 'server')).toEqual({ possible: [expect.objectContaining({ unit: 'atlas' })] });
    expect(a.match('GET', '/api/state', 'server', new Set(['server\natlas']))).toEqual({ possible: [expect.objectContaining({ unit: 'atlas' })] });
    const b = withEndpoints([ep('api', 'ANY', '/api/design', true)]);
    expect(b.match('GET', '/api/design/file', 'web').endpoint?.unit).toBe('api');
  });
});

it('a Next.js API route is a route handler in app/api or pages/api', () => {
  for (const f of ['shop-web/app/api/file/[id]/route.ts', 'app/api/route.js', 'web/src/app/(admin)/api/x/route.tsx', 'web/pages/api/orders.ts'])
    expect(isNextApiRoute(f), f).toBe(true);
  for (const f of ['shop-web/app/(store)/kiosk/offline-shell/cache-rules.ts', 'web/app/orders/page.tsx', 'api/src/routes/route.ts', 'web/app/api/x/helpers.ts'])
    expect(isNextApiRoute(f), f).toBe(false);
});

describe('search and the panel', () => {
  it('search finds routes first, then functions, each with the path of node IDs from the system level', () => {
    const hits = s.atlas.search('orders');
    expect(hits[0]).toMatchObject({ label: 'GET /api/orders', path: ['project:shop-api', 'ep:shop-api:GET /api/orders'] });
    expect(hits.find((h) => h.label === 'loadOrders')!.path).toEqual(['project:shop-web', `fn:${fnId(s.atlas, 'web/src/api.ts/loadOrders().')}`]);
    expect(hits.map((h) => h.label)).toContain('loadOrders');
    expect(s.atlas.search('  ')).toEqual([]);
  });

  it('the panel shows the file, the line, the absolute path, the callers and the callees', () => {
    const info = s.atlas.node(fnId(s.atlas, 'api/src/server.ts/createOrder().'));
    expect(info).toMatchObject({ ok: true, label: 'createOrder', file: 'api/src/server.ts', line: 9 });
    expect(info.path).toBe(`${s.root}/api/src/server.ts`);
    expect(info.callers.map((c) => c.label)).toEqual(['handle']);
  });
});

describe('the atlas API', () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    ({ server, url } = await startServer({ atlas: s.atlas, port: 0 }));
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  it('listens on 127.0.0.1 only', () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it('GET gives the views, search and the panel as JSON', async () => {
    const view = await (await fetch(`${url}api/view?id=project:shop-api`)).json();
    expect(view).toMatchObject({ ok: true, level: 'project', kind: 'api' });
    const search = await (await fetch(`${url}api/search?q=createOrder`)).json();
    expect(search.hits[0].label).toBe('createOrder');
    const info = await (await fetch(`${url}api/info`)).json();
    expect(info).toMatchObject({ ok: true, name: 'shop', root: s.root });
    expect((await fetch(`${url}api/node?id=nothing`)).status).toBe(404);
    expect((await fetch(`${url}api/approve`)).status).toBe(404);
  });

  it('refuses each method other than GET and HEAD', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(`${url}api/view?id=system`, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');
    }
  });

  it('refuses a request from another origin', async () => {
    expect((await fetch(`${url}api/info`, { headers: { origin: 'http://evil.example' } })).status).toBe(403);
    expect((await fetch(`${url}api/info`, { headers: { origin: url.replace(/\/$/, '') } })).status).toBe(200);
  });

  it('with no built page, the other paths give 404', async () => {
    expect((await fetch(`${url}index.html`)).status).toBe(404);
  });
});

describe('the page files', () => {
  it('serves the page, and a path out of the page folder gets the page, not the file', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const web = mkdtempSync(join(tmpdir(), 'atlas-web-'));
    writeFileSync(join(web, 'index.html'), '<p>atlas</p>');
    const { server, url } = await startServer({ atlas: s.atlas, web, port: 0 });
    try {
      expect(await (await fetch(url)).text()).toBe('<p>atlas</p>');
      const out = await fetch(`${url}..%2f..%2f..%2fetc%2fpasswd`);
      expect(await out.text()).not.toMatch(/root:/);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
