// The tree of the canvas. An open box holds its view; an edge to a box of another view goes
// to the deepest box on its path that is on the canvas; a summary edge goes away when the edges
// inside its source show the same thing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AtlasView, ViewEdge, ViewNode } from '../src/server/view.js';
import { buildTree, cellTest, closeBox, hashOfOpen, hashOfState, joinLabels, liftEnd, openOfHash, openPath, SEP, stateOfHash, withoutChip, withShow } from '../src/web/tree.js';
import { fnId, shop, type Shop } from './helpers.js';

const view = (id: string, nodes: ViewNode[], edges: ViewEdge[] = []): AtlasView => ({ ok: true, level: 'flow', id, title: id, groups: [], nodes, edges, notes: [] });
const box = (id: string, open?: string): ViewNode => ({ id, shape: 'step', label: id, ...(open ? { open } : {}) });

// A small system: the frontend `ui` (a page with a fetch step) calls the endpoint `ep` of `srv`.
const views = new Map<string, AtlasView>([
  ['system', view('system', [box('project:ui', 'v:ui'), box('project:srv', 'v:srv'), box('project:lib', 'v:lib')], [
    { id: 'http:ui>srv', from: 'project:ui', to: 'project:srv', kind: 'http', label: '2 HTTP calls' },
    { id: 'uses:ui>lib', from: 'project:ui', to: 'project:lib', kind: 'uses' },
  ])],
  ['v:ui', view('v:ui', [box('page', 'v:page'), box('other')], [
    { id: 'page>ep', from: 'page', to: 'ep', toPath: ['project:srv', 'ep'], kind: 'http', label: '1 call' },
    { id: 'page>ep2', from: 'page', to: 'ep2', toPath: ['project:srv', 'ep2'], kind: 'http', label: '1 call' },
  ])],
  ['v:page', view('v:page', [box('start'), box('fetch')], [
    { id: 'start>fetch', from: 'start', to: 'fetch', kind: 'flow' },
    { id: 'fetch>ep', from: 'fetch', to: 'ep', toPath: ['project:srv', 'ep'], kind: 'http', label: 'GET /x' },
  ])],
  ['v:srv', view('v:srv', [box('ep', 'v:ep'), box('ep2')])],
  ['v:ep', view('v:ep', [box('handler')])],
  ['v:lib', view('v:lib', [])],
]);
const get = (id: string) => views.get(id);
const tree = (...open: string[]) => buildTree(views.get('system')!, get, new Set(open));
const ends = (t: ReturnType<typeof tree>) => t.edges.map((e) => `${e.from} -> ${e.to}${e.label ? ` [${e.label}]` : ''}`).sort();
const sorted = (list: string[]) => [...list].sort();
const UI = 'project:ui';
const SRV = 'project:srv';
const PAGE = `${UI}${SEP}page`;

describe('the tree of the canvas', () => {
  it('a closed box has no children; an open box holds the nodes of its view', () => {
    expect(tree().nodes.map((n) => [n.fid, n.state])).toEqual([[UI, 'closed'], [SRV, 'closed'], ['project:lib', 'closed']]);
    const t = tree(UI);
    expect(t.nodes.map((n) => n.fid)).toEqual([UI, PAGE, `${UI}${SEP}other`, SRV, 'project:lib']);
    expect(t.nodes.find((n) => n.fid === PAGE)).toMatchObject({ parent: UI, container: UI, state: 'closed', depth: 1 });
  });

  it('a box in the open set whose parent is closed is not on the canvas', () => {
    expect(tree(PAGE).nodes.some((n) => n.fid === PAGE)).toBe(false);
  });

  it('an open box with no view yet is loading; an open box with an empty view shows a note', () => {
    const t = buildTree(views.get('system')!, (id) => (id === 'v:ui' ? undefined : get(id)), new Set([UI, 'project:lib']));
    expect(t.nodes.find((n) => n.fid === UI)!.state).toBe('loading');
    expect(t.nodes.find((n) => n.fid === `project:lib${SEP}note`)).toMatchObject({ node: { shape: 'more' } });
  });
});

describe('the edges between levels', () => {
  it('an edge goes to the deepest box on its path that is on the canvas', () => {
    const shown = new Set([SRV, `${SRV}${SEP}ep`]);
    expect(liftEnd([SRV, 'ep'], shown)).toBe(`${SRV}${SEP}ep`);
    expect(liftEnd([SRV, 'ep'], new Set([SRV]))).toBe(SRV);
    expect(liftEnd([SRV, 'ep'], new Set())).toBeUndefined();
  });

  it('all closed: the summary edges of the system', () => {
    expect(ends(tree())).toEqual([`${UI} -> project:lib`, `${UI} -> ${SRV} [2 HTTP calls]`]);
  });

  it('open ui: the HTTP edge starts at the page and goes to the closed box of the server, as one edge', () => {
    expect(ends(tree(UI))).toEqual(sorted([`${PAGE} -> ${SRV} [2 calls]`, `${UI} -> project:lib`]));
  });

  it('open ui and the server: the edges go to the exact endpoints', () => {
    expect(ends(tree(UI, SRV))).toEqual(sorted([`${PAGE} -> ${SRV}${SEP}ep [1 call]`, `${PAGE} -> ${SRV}${SEP}ep2 [1 call]`, `${UI} -> project:lib`]));
  });

  it('open the page: the edge starts at the fetch step; the edge of the page to the same endpoint goes away', () => {
    expect(ends(tree(UI, SRV, PAGE))).toEqual(sorted([
      `${PAGE}${SEP}fetch -> ${SRV}${SEP}ep [GET /x]`,
      `${PAGE}${SEP}start -> ${PAGE}${SEP}fetch`,
      `${PAGE} -> ${SRV}${SEP}ep2 [1 call]`,
      `${UI} -> project:lib`,
    ]));
  });

  it('open the endpoint too: the edge still goes to the box of the endpoint, not into it', () => {
    expect(ends(tree(UI, SRV, PAGE, `${SRV}${SEP}ep`))).toContain(`${PAGE}${SEP}fetch -> ${SRV}${SEP}ep [GET /x]`);
  });

  it('labels of edges that became one: the same label, the sum of the counts, or the number of endpoints', () => {
    expect(joinLabels(['1 call', '1 call', '2 calls'])).toBe('4 calls');
    expect(joinLabels(['GET /x', 'GET /x'])).toBe('GET /x');
    expect(joinLabels(['GET /x', 'POST /y'])).toBe('2 endpoints');
    expect(joinLabels([undefined, undefined])).toBeUndefined();
  });
});

describe('the filter of a matrix cell', () => {
  it('keeps the two projects and their boxes; the other projects, their boxes and the links of groups fade; the lanes stay', () => {
    const t = cellTest({ from: 'shop-web', to: 'report-service' });
    expect(t('project:shop-web')).toBe(true);
    expect(t(`project:report-service${SEP}grp:/charts${SEP}ep:x`)).toBe(true);
    expect(t('project:shop-api')).toBe(false);
    expect(t(`project:partner-portal${SEP}page:a`)).toBe(false);
    expect(t('group:kind:library')).toBe(false);
    expect(t('group:kind:frontend', true)).toBe(true);
    expect(t(`project:shop-api${SEP}group:x`, true)).toBe(false);
  });
});

describe('the open set', () => {
  it('the URL hash keeps the open boxes', () => {
    const open = new Set([UI, PAGE]);
    const hash = hashOfOpen(open);
    expect(hash.startsWith('#/?open=')).toBe(true);
    expect(openOfHash(hash)).toEqual(open);
    expect(openOfHash('#/')).toEqual(new Set());
    expect(hashOfOpen(new Set())).toBe('#/');
  });

  it('to close a box closes the boxes inside it, and no other box', () => {
    expect(closeBox(new Set([UI, PAGE, SRV]), UI)).toEqual(new Set([SRV]));
  });

  it('a path opens each box on it but the last, and gives the full ID of the last', () => {
    expect(openPath(new Set(), [SRV, 'ep'])).toEqual({ open: new Set([SRV]), fid: `${SRV}${SEP}ep` });
  });
});

describe('the tree of the shop fixture', () => {
  let s: Shop;
  beforeAll(async () => {
    s = await shop();
  });
  afterAll(() => s?.index.close());

  it('the HTTP client function opens in the frontend: its call step has an edge to the endpoint in the api', async () => {
    const loadOrders = `fn:${fnId(s.atlas, 'web/src/api.ts/loadOrders().')}`;
    const cache = new Map<string, AtlasView>();
    for (const id of ['system', 'project:shop-web', 'project:shop-api', loadOrders]) cache.set(id, await s.atlas.view(id));
    const fn = `project:shop-web${SEP}${loadOrders}`;
    const closed = buildTree(cache.get('system')!, (id) => cache.get(id), new Set(['project:shop-web', fn]));
    const step = closed.edges.find((e) => e.from.startsWith(`${fn}${SEP}`) && e.kind === 'http')!;
    expect(step).toMatchObject({ to: 'project:shop-api', label: 'GET /api/orders' });
    const open = buildTree(cache.get('system')!, (id) => cache.get(id), new Set(['project:shop-web', 'project:shop-api', fn]));
    expect(open.edges.find((e) => e.from === step.from && e.kind === 'http')!.to).toBe(`project:shop-api${SEP}ep:shop-api:GET /api/orders`);
    // The summary edge of the system goes away: the edges inside the frontend show the calls.
    expect(open.edges.some((e) => e.from === 'project:shop-web' && e.kind === 'http')).toBe(false);
  });
});

describe('the search lens in the hash', () => {
  it('q= comes first and reads back', () => {
    const state = { ...stateOfHash('#/'), q: 'close invoice kind:endpoint impact:"a b"' };
    const hash = hashOfState(state);
    expect(hash).toMatch(/^#\/\?q=close%20invoice/);
    expect(stateOfHash(hash).q).toBe(state.q);
    expect(stateOfHash('#/').q).toBeUndefined();
    expect(stateOfHash('#/?q=%E0%A4%A').q).toBeUndefined();
  });
  it('a chip × takes its text out of the query', () => {
    expect(withoutChip('close kind:endpoint invoice', 'kind:endpoint')).toBe('close invoice');
    expect(withoutChip('impact:"save order" x', 'impact:"save order"')).toBe('x');
    expect(withoutChip('close', 'kind:page')).toBe('close');
  });
  it('Show more sets show:N, once', () => {
    expect(withShow('close invoice', 28)).toBe('close invoice show:28');
    expect(withShow('close show:28 invoice', 60)).toBe('close invoice show:60');
  });
});
