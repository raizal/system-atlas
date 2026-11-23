// The layout of the canvas. ELK gets the real size of each node (`width` and `height`), the
// siblings do not overlap at any depth, and each child is inside its parent (a group or an open box).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AtlasView, ViewNode } from '../src/server/view.js';
import {
  absolute, BOX_HEAD, packOf, firstView, lensFirstView, MIN_LENS_ZOOM, focusView, gridOf, GROUP_HEAD, layoutTree, layoutView, MIN_FIRST_ZOOM, MIN_FOCUS_ZOOM, overlaps, PACK_GROUP_MIN, sizeOf, wrap,
  type Layout, type PlacedNode,
} from '../src/web/layout.js';
import { buildTree, type Tree } from '../src/web/tree.js';
import { fnId, shop, type Shop } from './helpers.js';

let s: Shop;
beforeAll(async () => {
  s = await shop();
});
afterAll(() => s?.index.close());

/**
 * The rules of each layout, at each depth: each node has its real size (a closed box) or holds
 * its children (an open box); siblings do not overlap; each child is inside its parent, under the
 * head of the parent; no edge label is on a closed box.
 */
function check(tree: Tree, l: Layout): void {
  const placed = absolute(l);
  for (const n of tree.nodes) {
    const p = placed.get(n.fid);
    expect(p, n.fid).toBeDefined();
    if (n.state !== 'open') {
      const size = sizeOf(n.node);
      expect([n.fid, p!.width, p!.height]).toEqual([n.fid, size.width, size.height]);
    }
  }
  const all = [...l.groups, ...l.nodes];
  const byParent = new Map<string, PlacedNode[]>();
  for (const b of all) byParent.set(b.parent ?? '', [...(byParent.get(b.parent ?? '') ?? []), b]);
  for (const [parent, list] of byParent) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) expect(overlaps(list[i]!, list[j]!), `${list[i]!.id} / ${list[j]!.id}`).toBe(false);
    if (parent === '') continue;
    const p = all.find((b) => b.id === parent)!;
    const head = l.groups.some((g) => g.id === parent) ? GROUP_HEAD : BOX_HEAD;
    for (const c of list) {
      expect(c.x, c.id).toBeGreaterThanOrEqual(0);
      expect(c.y, c.id).toBeGreaterThanOrEqual(head);
      expect(c.x + c.width, c.id).toBeLessThanOrEqual(p.width + 0.5);
      expect(c.y + c.height, c.id).toBeLessThanOrEqual(p.height + 0.5);
    }
  }
  const closed = tree.nodes.filter((n) => n.state !== 'open').map((n) => placed.get(n.fid)!);
  for (const e of l.edges) if (e.label) for (const b of closed) expect(overlaps(e.label, b), `label of ${e.id} / ${b.id}`).toBe(false);
}

const one = (view: AtlasView) => buildTree(view, () => undefined, new Set());

describe('the layout', () => {
  it('the size of a node comes from its text, with at most 3 lines', () => {
    const short = sizeOf({ shape: 'step', label: 'x = 1' });
    const long = sizeOf({ shape: 'step', label: 'a very long line of code '.repeat(8) });
    expect(short.width).toBe(160);
    expect(long.width).toBe(260);
    expect(long.lines).toHaveLength(3);
    expect(long.lines[2]).toMatch(/…$/);
    expect(long.height).toBeGreaterThan(short.height);
    expect(sizeOf({ shape: 'decision', label: 'ok?' }).height).toBeGreaterThanOrEqual(80);
    expect(wrap('aa bb cc', 5)).toEqual(['aa bb', 'cc']);
  });

  it.each(['system', 'project:shop-web', 'project:shop-api', 'project:shop-tool'])('%s: no overlap, real sizes', async (id) => {
    const view = await s.atlas.view(id);
    check(one(view), await layoutView(view));
  });

  it('a flow chart goes top down, with no overlap', async () => {
    for (const end of ['web/src/App.tsx/App().', 'api/src/server.ts/createOrder().', 'web/src/api.ts/loadOrders().']) {
      const view = await s.atlas.view(`fn:${fnId(s.atlas, end)}`);
      const l = await layoutView(view);
      check(one(view), l);
      const start = l.nodes.find((n) => n.id === view.nodes[0]!.id)!;
      const ends = l.nodes.filter((n) => view.nodes.find((v) => v.id === n.id)!.shape === 'end');
      for (const e of ends) expect(e.y).toBeGreaterThan(start.y);
    }
  });

  it('a large chart of 60 steps with long labels has no overlap', async () => {
    const nodes: ViewNode[] = Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, shape: i % 7 === 3 ? 'decision' : 'step', label: `step ${i} ${'with a long label '.repeat(i % 4)}` }));
    const edges = nodes.slice(1).map((n, i) => ({ id: `e${i}`, from: nodes[i % 7 === 3 ? Math.max(0, i - 2) : i]!.id, to: n.id, kind: 'flow' as const }));
    const view: AtlasView = { ok: true, level: 'flow', id: 'fn:x', title: 'x', groups: [], nodes, edges, notes: [] };
    check(one(view), await layoutView(view));
  });

  it('a method pill makes the node wider', () => {
    expect(sizeOf({ shape: 'endpoint', label: '/api/a/long/path/x', method: 'GET' }).width).toBeGreaterThan(sizeOf({ shape: 'endpoint', label: '/api/a/long/path/x' }).width);
  });

  it('the event handlers: a grid of 4 in a row, one ELK box, one routed edge to the group', async () => {
    const view = await s.atlas.view(`fn:${fnId(s.atlas, 'web/src/App.tsx/App().')}`);
    const l = await layoutView(view);
    check(one(view), l);
    const events = l.nodes.filter((n) => n.parent === 'group:events');
    expect(events).toHaveLength(4);
    expect(new Set(events.map((n) => n.y)).size).toBe(1);
    const edge = l.edges.find((e) => e.id.endsWith('>events'))!;
    const g = l.groups.find((x) => x.id === 'group:events')!;
    expect(edge.points.at(-1)!.y).toBeCloseTo(g.y, 0);
    // The grid is in the last layer: the diamonds of the render stay near the return node, above the grid.
    for (const d of view.nodes.filter((n) => n.shape === 'decision')) expect(l.nodes.find((n) => n.id === d.id)!.y).toBeLessThan(g.y);
    const grid = gridOf(Array.from({ length: 9 }, (_, i) => ({ id: `e${i}`, width: 150, height: 52 })));
    expect(new Set(grid.places.map((p) => p.x)).size).toBe(4);
    expect(new Set(grid.places.map((p) => p.y)).size).toBe(3);
  });

  it('the System view has fixed lanes, left to right: Frontends, APIs, tools, Data stores; the shelves are under the lanes', async () => {
    const view = await s.atlas.view('system');
    const tree = one(view);
    const l = await layoutTree(tree);
    check(tree, l);
    const x = (id: string) => l.groups.find((g) => g.id === `group:${id}`)!.x;
    expect(x('kind:frontend')).toBeLessThan(x('kind:api'));
    expect(x('kind:api')).toBeLessThan(x('kind:cli'));
    expect(x('kind:cli')).toBeLessThan(x('stores'));
    // No ELK pass at the top: the page draws each edge across the gaps of the lanes.
    expect(l.edges).toEqual([]);
    // A shelf (Libraries: shop-core) is under all the lanes.
    const shelfBox = l.groups.find((g) => g.id === 'group:kind:library')!;
    for (const g of l.groups.filter((g) => g !== shelfBox)) expect(shelfBox.y).toBeGreaterThan(g.y + g.height);
  });

  it('a chip shows the name on one line; the size steps grow', () => {
    const chip = sizeOf({ shape: 'project', label: 'a-very-long-project-name-that-goes-on', sub: '3 pages', size: 'chip' });
    expect(chip.lines).toHaveLength(1);
    expect(chip.height).toBe(30);
    const w = (size: 's' | 'm' | 'l') => sizeOf({ shape: 'project', label: 'api', sub: 'API · 9 routes', size });
    expect(w('s').width).toBeLessThan(w('m').width);
    expect(w('m').width).toBeLessThan(w('l').width);
    expect(w('m').height).toBeLessThan(w('l').height);
  });

  it('the first view: the whole chart if it is legible; if not, the width at a zoom of 0.5 or more, from the top', () => {
    const small: Layout = { edges: [], groups: [], nodes: [], width: 400, height: 300 };
    expect(firstView(small, 1200, 800)).toMatchObject({ zoom: 1.1 });
    const tall: Layout = { ...small, width: 900, height: 9000 };
    const v = firstView(tall, 1200, 800);
    expect(v.zoom).toBe(1);
    expect(v.y).toBe(24);
    const wide: Layout = { ...small, width: 6000, height: 9000 };
    expect(firstView(wide, 1200, 800).zoom).toBe(MIN_FIRST_ZOOM);
  });

  it('the first view of a lens: a zoom of 0.6 to 1, at the top left', () => {
    const small: Layout = { edges: [], groups: [], nodes: [], width: 400, height: 300 };
    expect(lensFirstView(small, 1200, 800)).toEqual({ x: 24, y: 24, zoom: 1 });
    const big: Layout = { ...small, width: 6000, height: 9000 };
    expect(lensFirstView(big, 1200, 800)).toEqual({ x: 24, y: 24, zoom: MIN_LENS_ZOOM });
    expect(MIN_LENS_ZOOM).toBe(0.6);
    const mid: Layout = { ...small, width: 1500, height: 700 };
    expect(lensFirstView(mid, 1200, 800).zoom).toBeCloseTo((1200 - 48) / 1500);
    // The top left box goes to the top left of the canvas, also when the layout does not start at 0.
    const moved: Layout = { ...small, nodes: [{ id: 'a', x: 100, y: 50, width: 200, height: 80 } as Layout['nodes'][number]], width: 300, height: 130 };
    expect(lensFirstView(moved, 1200, 800)).toEqual({ x: 24 - 100, y: 24 - 50, zoom: 1 });
  });

  it('a large group (40 libraries that import each other) wraps in rows: the canvas is not one long row, and the first view starts at the top left', async () => {
    const libs: ViewNode[] = Array.from({ length: 40 }, (_, i) => ({ id: `project:lib${i}`, shape: 'project', label: `library-number-${i}`, sub: 'library · 3 exports', group: 'kind:library', tone: 4 }));
    const apps: ViewNode[] = [0, 1].map((i) => ({ id: `project:app${i}`, shape: 'project', label: `app-${i}`, sub: 'frontend · 2 pages', group: 'kind:frontend', tone: 0 }));
    const view: AtlasView = {
      ok: true, level: 'system', id: 'system', title: 'System', notes: [],
      groups: [{ id: 'kind:frontend', label: 'Frontends', icon: 'frontend', tone: 0 }, { id: 'kind:library', label: 'Libraries', icon: 'library', tone: 4 }],
      nodes: [...apps, ...libs],
      edges: [
        ...libs.map((l, i) => ({ id: `uses:a>${i}`, from: apps[i % 2]!.id, to: l.id, kind: 'uses' as const, label: '2 imports' })),
        ...libs.slice(1).map((l, i) => ({ id: `uses:l>${i}`, from: l.id, to: libs[0]!.id, kind: 'uses' as const })),
      ],
    };
    expect(libs.length).toBeGreaterThan(PACK_GROUP_MIN);
    const tree = buildTree(view, () => undefined, new Set());
    const l = await layoutTree(tree);
    check(tree, l);
    expect(l.width / l.height).toBeLessThan(3);
    const lib = l.groups.find((g) => g.id.endsWith('kind:library'))!;
    expect(lib.width / lib.height).toBeLessThan(3);
    const fe = l.groups.find((g) => g.id.endsWith('kind:frontend'))!;
    // The frontends are near the left edge, not in the middle of a very wide canvas.
    expect(fe.x).toBeLessThan(l.width / 2);
    // Taller than the view at the least zoom: the view starts at the top.
    const v = firstView(l, 1440, 600);
    expect(v.y).toBeCloseTo(24, 6);
    expect(v.x).toBeGreaterThanOrEqual(24);
  });

  it('focus on an open box: the box and some room around it, at a zoom of 0.4 or more', () => {
    const v = focusView({ x: 100, y: 200, width: 400, height: 300 }, 1200, 800);
    expect(v.zoom).toBe(1);
    // The box is in the middle across, and its top is 24 px from the top of the canvas.
    expect(v.x + 300 * v.zoom).toBeCloseTo(600, 0);
    expect(v.y + 200 * v.zoom).toBeCloseTo(24, 6);
    const huge = focusView({ x: 0, y: 0, width: 9000, height: 9000 }, 1200, 800);
    expect(huge.zoom).toBe(MIN_FOCUS_ZOOM);
    // Too large: the view shows the top left of the box.
    expect(huge.x).toBeCloseTo(24, 6);
    expect(huge.y).toBeCloseTo(24, 6);
  });
});

describe('the layout of open boxes', () => {
  const app = () => fnId(s.atlas, 'web/src/App.tsx/App().');
  const views = new Map<string, AtlasView>();
  const get = (id: string) => views.get(id);
  const load = async (...ids: string[]) => {
    for (const id of ids) views.set(id, await s.atlas.view(id));
  };

  it('a project open in the system: its pages are inside its box, and the other projects stay', async () => {
    await load('system', 'project:shop-web');
    const tree = buildTree(views.get('system')!, get, new Set(['project:shop-web']));
    const l = await layoutTree(tree);
    check(tree, l);
    const placed = absolute(l);
    const web = placed.get('project:shop-web')!;
    const page = placed.get(`project:shop-web§fn:${app()}`)!;
    expect(page.x).toBeGreaterThan(web.x);
    expect(page.y).toBeGreaterThan(web.y);
    expect(page.x + page.width).toBeLessThan(web.x + web.width);
    expect(page.y + page.height).toBeLessThan(web.y + web.height);
    expect(placed.get('project:shop-api')).toBeDefined();
    expect(placed.get('project:shop-tool')).toBeDefined();
  });

  it('three levels: a page and a call in it open inside the project, with no overlap at any depth', async () => {
    await load('system', 'project:shop-web', 'project:shop-api', `fn:${app()}`);
    const appView = views.get(`fn:${app()}`)!;
    const list = appView.nodes.find((n) => n.label === 'render <OrderList>')!;
    await load(list.open!);
    const page = `project:shop-web§fn:${app()}`;
    const tree = buildTree(views.get('system')!, get, new Set(['project:shop-web', 'project:shop-api', page, `${page}§${list.id}`]));
    expect(tree.nodes.filter((n) => n.state === 'open')).toHaveLength(4);
    const l = await layoutTree(tree);
    check(tree, l);
    const placed = absolute(l);
    const outer = placed.get(page)!;
    const diamonds = tree.nodes.filter((n) => n.container === page && n.node.shape === 'decision');
    expect(diamonds.length).toBeGreaterThan(0);
    for (const d of diamonds) {
      const b = placed.get(d.fid)!;
      expect(b.x).toBeGreaterThanOrEqual(outer.x);
      expect(b.y + b.height).toBeLessThanOrEqual(outer.y + outer.height);
    }
    // The chart of the call is inside the call.
    const call = placed.get(`${page}§${list.id}`)!;
    const inner = tree.nodes.filter((n) => n.container === `${page}§${list.id}`);
    expect(inner.length).toBeGreaterThan(0);
    for (const n of inner) {
      const b = placed.get(n.fid)!;
      expect(b.x).toBeGreaterThanOrEqual(call.x);
      expect(b.y).toBeGreaterThanOrEqual(call.y + BOX_HEAD);
      expect(b.x + b.width).toBeLessThanOrEqual(call.x + call.width);
    }
  });

  it('an open box with 30 boxes and no edges between them wraps them in rows, near the aspect of a screen', async () => {
    const inner: AtlasView = {
      ok: true, level: 'project', id: 'v:many', title: 'many', groups: [], edges: [], notes: [],
      nodes: Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, shape: 'page' as const, label: `page number ${i}` })),
    };
    const system: AtlasView = {
      ok: true, level: 'system', id: 'system', title: 'system', groups: [], notes: [],
      nodes: [{ id: 'project:a', shape: 'project', label: 'a', open: 'v:many' }, { id: 'project:b', shape: 'project', label: 'b' }],
      edges: [{ id: 'a>b', from: 'project:a', to: 'project:b', kind: 'uses' }],
    };
    const tree = buildTree(system, (id) => (id === 'v:many' ? inner : undefined), new Set(['project:a']));
    const l = await layoutTree(tree);
    check(tree, l);
    const a = absolute(l).get('project:a')!;
    expect(a.width / a.height).toBeGreaterThan(0.6);
    expect(a.width / a.height).toBeLessThan(2.5);
  });

  it('the api open: the route groups wrap, and each group has one route on each line', async () => {
    await load('system', 'project:shop-api');
    const tree = buildTree(views.get('system')!, get, new Set(['project:shop-api']));
    const l = await layoutTree(tree);
    check(tree, l);
    const placed = absolute(l);
    const api = placed.get('project:shop-api')!;
    expect(api.width / api.height).toBeLessThan(2.5);
    for (const g of tree.groups.filter((x) => x.container === 'project:shop-api')) {
      const routes = tree.nodes.filter((n) => n.parent === g.fid).map((n) => placed.get(n.fid)!);
      expect(new Set(routes.map((r) => r.x)).size, g.fid).toBe(1);
    }
  });

  it('an edge into another open box has no ELK route: the page draws it from handle to handle', async () => {
    await load('system', 'project:shop-web', 'project:shop-api');
    const tree = buildTree(views.get('system')!, get, new Set(['project:shop-web', 'project:shop-api']));
    const l = await layoutTree(tree);
    check(tree, l);
    const cross = tree.edges.filter((e) => e.kind === 'http');
    expect(cross.length).toBeGreaterThan(0);
    for (const e of cross) expect(l.edges.some((x) => x.id === e.id), e.id).toBe(false);
  });

  it('pack: rows that wrap near the aspect, or a number of columns', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, width: 200, height: 52 }));
    const p = packOf(items);
    expect(p.width / p.height).toBeGreaterThan(1);
    expect(p.width / p.height).toBeLessThan(2.5);
    const c = packOf(items.slice(0, 5), 1.6, 1);
    expect(new Set([...c.places.values()].map((x) => x.x)).size).toBe(1);
    const three = packOf(items.slice(0, 25), 1.6, 3);
    expect(new Set([...three.places.values()].map((x) => x.x)).size).toBe(3);
  });
});
