// The CodeGraph reader and the links on the fleet fixture: a Next.js frontend that calls a FastAPI
// api through a proxy route, and a serverless function. The test indexes a copy of the fixture in a
// temporary folder, with the CodeGraph telemetry off.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { CodeGraphIndex } from '../src/index/codegraph.js';
import { IndexChartSource, importBindings, packageOf } from '../src/index/source.js';
import { NO_TELEMETRY } from '../src/index/run.js';
import { Atlas } from '../src/server/model.js';
import { isTestPath } from '../src/index/projects.js';
import { indexedCopy } from './helpers.js';

const FLEET = fileURLToPath(new URL('./fixtures/fleet', import.meta.url));

let index: CodeGraphIndex;
let atlas: Atlas;
beforeAll(async () => {
  const root = await indexedCopy(FLEET, 'fleet');
  index = CodeGraphIndex.open(root);
  atlas = await Atlas.build(index, root);
});
afterAll(() => index?.close());

const idOf = (file: string, name: string) => [...index.nodes.values()].find((n) => n.file === file && n.name === name)!.id;

describe('the CodeGraph reader', () => {
  it('reads the functions, the components and the routes, with the lines and the language', () => {
    const page = index.nodes.get(idOf('web/app/orders/page.tsx', 'OrdersPage'))!;
    expect(page).toMatchObject({ kind: 'function', range: '10-14', language: 'typescript', topLevel: true });
    const route = index.nodes.get(idOf('core/src/api/orders.py', 'GET /orders'))!;
    expect(route).toMatchObject({ kind: 'route', route: 'GET /orders', language: 'python' });
    expect(index.files.get('core/src/api/orders.py')).toBe('python');
  });

  it('reads the calls with their lines, and the route to its handler', () => {
    const list = idOf('core/src/api/orders.py', 'list_orders');
    expect(index.edgesFrom(list)).toContainEqual(expect.objectContaining({ to: idOf('core/src/api/orders.py', 'read_orders'), kind: 'calls', line: 18 }));
    expect(atlas.map.handlerOf.get(idOf('core/src/api/orders.py', 'GET /orders'))).toBe(list);
    expect(index.refs('core/src/api/orders.py').map((r) => r.line)).toEqual([18]);
  });

  it('binds an outside call to its package by the import lines; the standard library is not a package', () => {
    const src = new IndexChartSource(index);
    expect(src.libSites(idOf('csv-function/handler.py', 'handler'))).toEqual([{ line: 5, name: 'client', package: 'boto3' }]);
    expect(src.libSites(idOf('core/src/api/orders.py', 'read_orders'))).toEqual([]);
    expect(src.libSites(idOf('web/app/orders/page.tsx', 'OrdersPage'))).toEqual([{ line: 11, name: 'useState', package: 'react' }]);
    expect(src.callSites(idOf('core/src/api/orders.py', 'list_orders')).map((c) => [c.line, c.fn.name])).toEqual([[18, 'read_orders']]);
  });

  it('import bindings and packages', () => {
    const ts = importBindings([{ module: 'react', text: "import React, { useState as useS, type FC } from 'react';", line: 1 }, { module: 'node:fs', text: "import * as fs from 'node:fs';", line: 2 }], 'typescript');
    expect(Object.fromEntries(ts)).toEqual({ React: 'react', useS: 'react', fs: 'node:fs' });
    expect(ts.get('FC')).toBeUndefined();
    const py = importBindings([{ module: 'os', text: 'import os.path as osp', line: 1 }, { module: 'a.b', text: 'from a.b import c as d, e', line: 2 }], 'python');
    expect(Object.fromEntries(py)).toEqual({ osp: 'os.path', d: 'a.b', e: 'a.b' });
    const none = () => false;
    expect(packageOf('@scope/pkg/sub', 'typescript', none)).toBe('@scope/pkg');
    expect(packageOf('path', 'typescript', none)).toBe('node');
    expect(packageOf('./api', 'typescript', none)).toBeUndefined();
    expect(packageOf('os.path', 'python', none)).toBeUndefined();
    expect(packageOf('src.api', 'python', (m) => m === 'src')).toBeUndefined();
  });
});

describe('the links of the fleet', () => {
  it('finds the projects and their kinds: a frontend, an api and a function', async () => {
    const v = await atlas.view('system');
    expect(v.nodes.filter((n) => n.shape === 'project').map((n) => [n.label, n.group])).toEqual([
      ['fleet-web', 'kind:frontend'],
      ['core-api', 'kind:api'],
      ['csv-function', 'kind:worker'],
    ]);
    expect(v.groups.map((g) => g.label)).toContain('Functions and workers');
  });

  it('adds the mount prefix of the app to a FastAPI route (`prefix=settings.api_v1_str`)', async () => {
    const v = await atlas.view('project:core-api');
    expect(v.nodes.filter((n) => n.shape === 'route').map((n) => [n.method, n.label])).toEqual([['GET', '/v1/orders']]);
    expect(v.nodes[0]!.open).toBe(`fn:${idOf('core/src/api/orders.py', 'list_orders')}`);
  });

  it('a Next.js page route is a page; its call through the proxy route links to the api', async () => {
    const v = await atlas.view('project:fleet-web');
    const page = v.nodes.find((n) => n.shape === 'page' && n.label === '/orders')!;
    expect(page).toMatchObject({ open: `fn:${idOf('web/app/orders/page.tsx', 'OrdersPage')}` });
    expect(v.edges.filter((e) => e.from === page.id).map((e) => [e.kind, e.toPath])).toEqual([['http', ['project:core-api', 'ep:core-api:GET /v1/orders']]]);
    const sys = await atlas.view('system');
    expect(sys.edges).toContainEqual(expect.objectContaining({ from: 'project:fleet-web', to: 'project:core-api', kind: 'http', label: '2 HTTP calls' }));
  });

  it('test code is not product code: an e2e helper that calls the api is not an HTTP client or a link', async () => {
    for (const f of ['web/e2e/live/orders.ts', 'a/tests/x.ts', 'a/__tests__/x.tsx', 'a/test/x.ts', 'a/playwright/x.ts', 'a/cypress/x.ts', 'a/x.spec.ts', 'a/x.test.tsx', 'a/x.cy.ts', 'a/test_x.py', 'a/conftest.py'])
      expect(isTestPath(f), f).toBe(true);
    for (const f of ['web/app/orders/page.tsx', 'core/src/api/orders.py', 'a/latest/x.ts', 'a/contest.py']) expect(isTestPath(f), f).toBe(false);
    expect(atlas.calls.filter((c) => c.file.includes('/e2e/'))).toEqual([]);
    const v = await atlas.view('project:fleet-web');
    expect(v.nodes.map((n) => n.label)).not.toContain('seedOrder');
    const sys = await atlas.view('system');
    // The page through the proxy, and the Next.js route /api/audits: no call of the e2e helper.
    expect(sys.edges.filter((e) => e.kind === 'http' && e.role !== 'total').map((e) => e.label)).toEqual(['2 HTTP calls']);
  });

  it('the catch-all of a Next.js route is a prefix route', () => {
    expect(atlas.endpoints.find((e) => e.unit === 'fleet-web' && e.prefix)).toMatchObject({ method: 'GET', path: '/api/core-proxy', prefix: true });
  });

  it('Features: a page reaches the backend through a hook, a service and a Next.js API route', () => {
    const page = idOf('web/app/audit/list/page.tsx', 'AuditListPage');
    const links = atlas.pageLinks(page, 'fleet-web');
    expect(links.map((l) => [l.endpoint.unit, l.endpoint.key, l.via?.key, l.steps, l.direct, l.possible])).toEqual([
      ['core-api', 'GET /v1/orders', 'GET /api/audits', 2, false, false],
    ]);
    // The orders page calls the proxy in its own file: a direct link, no middle hop.
    const orders = atlas.pageLinks(idOf('web/app/orders/page.tsx', 'OrdersPage'), 'fleet-web');
    expect(orders.map((l) => [l.endpoint.key, l.via, l.direct])).toEqual([['GET /v1/orders', undefined, true]]);
    expect(atlas.pageLinks(idOf('web/app/audit/new/page.tsx', 'NewAuditPage'), 'fleet-web')).toEqual([]);
  });

  it('the env of a CodeGraph run turns the telemetry off', () => {
    expect(NO_TELEMETRY).toEqual({ CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1' });
  });
});
