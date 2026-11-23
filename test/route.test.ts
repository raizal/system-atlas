// The edges across the lanes: each edge has its own track, and no two labels overlap.
// The names of the boxes break only at a space, "-", "_", "." or "/".

import { describe, expect, it } from 'vitest';
import { BUNDLE_MIN, breakAt, clampView, fitView, labelsOverlap, nudgeView, visibleArea, routeCross, sizeOf, wrap, type Box, type CrossEdge } from '../src/web/layout.js';
import { visibleEdges } from '../src/web/tree.js';

/** Three lanes (frontends, APIs, stores) with boxes in them, as the System view draws them. */
function lanes() {
  const where = new Map<string, Box>([
    ['group:fe', { x: 0, y: 0, width: 220, height: 600 }],
    ['group:api', { x: 460, y: 0, width: 220, height: 600 }],
    ['group:stores', { x: 920, y: 0, width: 200, height: 300 }],
  ]);
  const parentOf = new Map<string, string | undefined>([['group:fe', undefined], ['group:api', undefined], ['group:stores', undefined]]);
  const add = (id: string, group: string, b: Box) => {
    where.set(id, b);
    parentOf.set(id, group);
  };
  for (let i = 0; i < 6; i++) add(`fe${i}`, 'group:fe', { x: 16, y: 40 + i * 90, width: 188, height: 58 });
  for (let i = 0; i < 5; i++) add(`api${i}`, 'group:api', { x: 476, y: 40 + i * 100, width: 188, height: 58 });
  add('db', 'group:stores', { x: 936, y: 40, width: 168, height: 44 });
  add('cache', 'group:stores', { x: 936, y: 100, width: 168, height: 44 });
  return { where, parentOf };
}

describe('routeCross', () => {
  const { where, parentOf } = lanes();
  const edges: CrossEdge[] = [];
  for (let f = 0; f < 6; f++) for (let a = 0; a < 5; a++) if ((f + a) % 3 === 0) edges.push({ id: `e${f}${a}`, from: `fe${f}`, to: `api${a}`, label: `${f * 5 + a + 1} HTTP calls` });
  edges.push({ id: 's0', from: 'api0', to: 'db', label: '@prisma/client, prisma', near: 'target' });
  edges.push({ id: 's1', from: 'api3', to: 'db', label: 'psycopg2-binary', near: 'target' });
  edges.push({ id: 's2', from: 'api1', to: 'cache', label: 'redis', near: 'target' });
  const routes = routeCross(edges, where, parentOf);

  it('gives each edge in a gap its own track, inside the gap', () => {
    const gap1 = edges.filter((e) => e.from.startsWith('fe')).map((e) => routes.get(e.id)!.track!);
    expect(new Set(gap1.map((x) => Math.round(x * 10))).size).toBe(gap1.length);
    for (const x of gap1) expect(x > 220 && x < 460).toBe(true);
    const gap3 = ['s0', 's1', 's2'].map((id) => routes.get(id)!.track!);
    expect(new Set(gap3).size).toBe(3);
    for (const x of gap3) expect(x > 680 && x < 920).toBe(true);
  });

  it('leaves each source at its own port and keeps the route orthogonal', () => {
    for (const e of edges) {
      const pts = routes.get(e.id)!.points;
      expect(pts.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < pts.length; i++) expect(pts[i]!.x === pts[i - 1]!.x || pts[i]!.y === pts[i - 1]!.y).toBe(true);
    }
    const out = edges.filter((e) => e.from === 'fe0').map((e) => routes.get(e.id)!.points[0]!.y);
    expect(new Set(out).size).toBe(out.length);
  });

  it('puts no two shown labels on top of each other, and hides the rest', () => {
    const shown = edges.map((e) => routes.get(e.id)!).filter((r) => r.label && !r.hidden).map((r) => r.label!);
    for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) expect(labelsOverlap(shown[i]!, shown[j]!, 0)).toBe(false);
    for (const e of edges) expect(routes.get(e.id)!.label).toBeDefined();
    // The largest count keeps its label.
    expect(routes.get('e54')!.hidden).toBeUndefined();
  });

  it('hides a label that falls on an outer box (an edge between two boxes in one column)', () => {
    const where = new Map<string, Box>([
      ['group:a', { x: 400, y: 0, width: 200, height: 200 }],
      ['group:b', { x: 400, y: 260, width: 200, height: 200 }],
      ['group:c', { x: 0, y: 0, width: 200, height: 200 }],
      ['a0', { x: 416, y: 40, width: 168, height: 50 }],
      ['b0', { x: 416, y: 300, width: 168, height: 50 }],
    ]);
    const parentOf = new Map<string, string | undefined>([['group:a', undefined], ['group:b', undefined], ['group:c', undefined], ['a0', 'group:a'], ['b0', 'group:b']]);
    // In one column, the label falls on a box: it hides (the page shows it on hover).
    const r = routeCross([{ id: 'e', from: 'b0', to: 'a0', label: 'not run: mocked' }], where, parentOf).get('e')!;
    expect(r.hidden).toBe(true);
    // Between two columns, the label is in the gap: it shows, on no box.
    const c = routeCross([{ id: 'e', from: 'b0', to: 'group:c', label: 'not run: mocked' }], where, parentOf).get('e')!;
    expect(c.hidden).toBeUndefined();
    expect(['group:a', 'group:b', 'group:c'].some((id) => labelsOverlap(where.get(id)!, c.label!, 0))).toBe(false);
  });

  it('puts a label near the source, on the horizontal part, never on the track', () => {
    for (const e of edges.filter((x) => x.from.startsWith('fe'))) {
      const r = routes.get(e.id)!;
      if (r.hidden) continue;
      const sy = r.points[0]!.y;
      expect(r.label!.y).toBeLessThan(sy);
      expect(r.label!.y + r.label!.height).toBeGreaterThan(sy);
      expect(r.label!.x).toBeGreaterThanOrEqual(220);
      expect(r.label!.x > r.track! || r.label!.x + r.label!.width < r.track!).toBe(true);
    }
  });

  it('puts the label of a data store link next to the store, on its edge', () => {
    // Two links into one small store: the ports are too near for two labels; one shows on hover.
    expect(['s0', 's1'].filter((id) => !routes.get(id)!.hidden).length).toBe(1);
    expect(routes.get('s2')!.hidden).toBeUndefined();
    for (const id of ['s0', 's1', 's2']) {
      const r = routes.get(id)!;
      const end = r.points.at(-1)!;
      expect(r.label!.x + r.label!.width).toBeLessThanOrEqual(920);
      expect(r.label!.x).toBeGreaterThan(r.track!);
      expect(r.label!.y < end.y && r.label!.y + r.label!.height > end.y).toBe(true);
    }
  });

  it('orders the tracks so that two edges down from one source do not cross', () => {
    const a = routes.get('e00')!; // fe0 → api0
    const b = routes.get('e03')!; // fe0 → api3 (further down)
    // The edge that goes further turns first (nearer the source).
    expect(b.track!).toBeLessThan(a.track!);
  });

  it('draws a total in one group as a loop on its left side', () => {
    const r = routeCross([{ id: 't', from: 'group:fe', to: 'group:fe', label: 'Frontends → Frontends · 3 calls', total: true }], where, parentOf).get('t')!;
    expect(r.points.length).toBe(4);
    expect(Math.min(...r.points.map((p) => p.x))).toBeLessThan(0);
  });
});

describe('the bundles: many links into one target box', () => {
  const { where, parentOf } = lanes();
  // Five frontends into api2 (a bundle), and fe5 into api0 and api4 (one edge each).
  const edges: CrossEdge[] = [0, 1, 2, 3, 4].map((f) => ({ id: `b${f}`, from: `fe${f}`, to: 'api2', label: `${f + 1} endpoints` }));
  edges.push({ id: 'x0', from: 'fe5', to: 'api0', label: '7 endpoints' }, { id: 'x4', from: 'fe5', to: 'api4', label: '8 endpoints' });
  const routes = routeCross(edges, where, parentOf, { bundleText: (es) => `${es.length} frontends · 15 endpoints` });
  const bundle = ['b0', 'b1', 'b2', 'b3', 'b4'].map((id) => routes.get(id)!);

  it('share one trunk and go into the target at one point: one arrow', () => {
    expect(BUNDLE_MIN).toBeLessThanOrEqual(5);
    expect(new Set(bundle.map((r) => r.track)).size).toBe(1);
    expect(new Set(bundle.map((r) => JSON.stringify(r.points.at(-1))))).toHaveProperty('size', 1);
    expect(new Set(bundle.map((r) => r.bundle)).size).toBe(1);
    // Each edge still leaves its own source.
    expect(new Set(bundle.map((r) => JSON.stringify(r.points[0]))).size).toBe(5);
  });

  it('have one label for the whole bundle, on the trunk at the turn into the target', () => {
    const labels = bundle.filter((r) => r.bundleLabel);
    expect(labels.length).toBe(1);
    const l = labels[0]!.bundleLabel!;
    expect(l.text).toBe('5 frontends · 15 endpoints');
    expect(l.hidden).toBeUndefined();
    const end = bundle[0]!.points.at(-1)!;
    const t = bundle[0]!.track!;
    expect(l.box.x < t && l.box.x + l.box.width > t).toBe(true);
    expect(l.box.y < end.y && l.box.y + l.box.height > end.y).toBe(true);
    // It overlaps no label of a source.
    for (const r of [...bundle, routes.get('x0')!, routes.get('x4')!]) if (r.label && !r.hidden) expect(labelsOverlap(r.label, l.box, 0)).toBe(false);
  });

  it('keep the own tracks of the edges to other targets', () => {
    const tracks = [bundle[0]!.track, routes.get('x0')!.track, routes.get('x4')!.track];
    expect(new Set(tracks).size).toBe(3);
    expect(routes.get('x0')!.bundle).toBeUndefined();
  });

  it('fan out inside an open target: one trunk, one end for each endpoint', () => {
    const w = new Map(where);
    const p = new Map(parentOf);
    w.set('api3', { x: 476, y: 300, width: 188, height: 200 });
    for (let i = 0; i < 3; i++) {
      w.set(`ep${i}`, { x: 490, y: 340 + i * 50, width: 160, height: 36 });
      p.set(`ep${i}`, 'api3');
    }
    const r = routeCross([0, 1, 2].map((i) => ({ id: `f${i}`, from: `fe${i}`, to: `ep${i}` })), w, p, { bundleText: () => '3 pages · 3 endpoints' });
    const rs = [0, 1, 2].map((i) => r.get(`f${i}`)!);
    expect(new Set(rs.map((x) => x.track)).size).toBe(1);
    expect(new Set(rs.map((x) => x.points.at(-1)!.y)).size).toBe(3);
    expect(rs.filter((x) => x.bundleLabel).length).toBe(1);
  });

  it('links into the boxes of one lane group share one trunk into the group (the case view)', () => {
    const one = [0, 1, 2].map((i) => ({ id: `g${i}`, from: 'fe0', to: `api${i}` }));
    const apart = routeCross(one, where, parentOf);
    expect(new Set(one.map((e) => apart.get(e.id)!.track)).size).toBe(3);
    const r = routeCross(one.map((e) => ({ ...e, intoGroup: true })), where, parentOf, { bundleText: () => '1 page · 3 endpoints' });
    const rs = one.map((e) => r.get(e.id)!);
    expect(new Set(rs.map((x) => x.track)).size).toBe(1);
    expect(new Set(rs.map((x) => x.bundle))).toEqual(new Set(['1|group:api']));
    expect(new Set(rs.map((x) => x.points.at(-1)!.y)).size).toBe(3);
  });

  it('two links into one box stay apart (no bundle)', () => {
    const r = routeCross([{ id: 'a', from: 'fe0', to: 'api1' }, { id: 'b', from: 'fe1', to: 'api1' }], where, parentOf);
    expect(r.get('a')!.track).not.toBe(r.get('b')!.track);
    expect(r.get('a')!.bundle).toBeUndefined();
  });

  it('a link from the head of a group leaves at the head, and its label goes near the target', () => {
    const r = routeCross([{ id: 'h', from: 'group:fe', to: 'api2', label: '116 endpoints', fromHead: true }], where, parentOf).get('h')!;
    expect(r.points[0]!.y).toBe(18);
    expect(r.label!.x + r.label!.width).toBeLessThanOrEqual(476);
    expect(r.label!.x).toBeGreaterThan(r.track!);
  });
});

describe('the automatic fit', () => {
  it('never goes below the least zoom', () => {
    const big = { x: 0, y: 0, width: 5000, height: 3000 };
    const v = clampView(big, 1000, 800, 0.4);
    expect(v.zoom).toBe(0.4);
    // The middle of the box across, and its top 24 px from the top of the canvas.
    expect(v.x).toBeCloseTo(500 - 2500 * 0.4);
    expect(v.y).toBeCloseTo(24);
  });
  it('puts the top of the box at the top of the canvas (24 px), with no empty band above it', () => {
    const box = { x: 100, y: 300, width: 1800, height: 400 };
    const v = fitView(box, 1000, 900, 0.4)!;
    expect(v.y + box.y * v.zoom).toBeCloseTo(24);
    expect(clampView(box, 1000, 900, 0.4).y + box.y * v.zoom).toBeCloseTo(24);
  });
  it('uses only the part of the canvas left of the side panel when the panel is open', () => {
    expect(visibleArea(1440, 800, 344)).toEqual({ w: 1096, h: 800 });
    expect(visibleArea(1440, 800, 0)).toEqual({ w: 1440, h: 800 });
    const box = { x: 0, y: 0, width: 2000, height: 100 };
    const { w, h } = visibleArea(1440, 800, 344);
    const v = clampView(box, w, h, 0.4);
    // The right end of the box is left of the panel.
    expect((box.x + box.width) * v.zoom + v.x).toBeLessThanOrEqual(1096);
  });
});

describe('the pan to a selected box', () => {
  const view = { x: 0, y: 0, zoom: 1 };
  it('does not move the camera when the box is in view left of the panel', () => {
    const b = { x: 100, y: 100, width: 200, height: 80 };
    expect(nudgeView(b, view, 1096, 800)).toBe(view);
  });
  it('pans the least to bring a box under the panel into view, and keeps the zoom', () => {
    // The box is at x 1200..1400: under a panel at 1096.
    const b = { x: 1200, y: 100, width: 200, height: 80 };
    // At zoom 0.5 it is at 600..700 px: in view, no move.
    const half = { x: 0, y: 0, zoom: 0.5 };
    expect(nudgeView(b, half, 1096, 800)).toBe(half);
    // At zoom 1 the box is under the panel: the pan puts its right side at 1096 - 24 px; the zoom and y stay.
    const v1 = nudgeView(b, view, 1096, 800);
    expect(v1.zoom).toBe(1);
    expect(v1.y).toBe(0);
    expect((b.x + b.width) + v1.x).toBeCloseTo(1072);
    expect(b.x + v1.x).toBeGreaterThanOrEqual(24);
  });
  it('pans down to a box above the view, and left to a box out on the left', () => {
    const v = nudgeView({ x: -500, y: -300, width: 100, height: 50 }, view, 1096, 800);
    expect(v).toEqual({ x: 524, y: 324, zoom: 1 });
  });
  it('a box larger than the area that fills it does not move the camera', () => {
    const b = { x: -100, y: -100, width: 3000, height: 3000 };
    expect(nudgeView(b, view, 1096, 800)).toBe(view);
    // A large box that starts in the middle comes to the left side.
    expect(nudgeView({ x: 600, y: 0, width: 3000, height: 100 }, view, 1096, 800).x).toBe(24 - 600);
  });
});

describe('the automatic fit (more)', () => {
  it('fits a small box whole, at the middle', () => {
    const v = clampView({ x: 100, y: 100, width: 400, height: 200 }, 1000, 800, 0.4);
    expect(v.zoom).toBe(1);
    expect(v.x + 300 * v.zoom).toBeCloseTo(500);
  });
});

describe('the Features edges', () => {
  const parentOf = new Map<string, string | undefined>([['feature:fe:a', 'group:fe:fe'], ['feature:fe:b', 'group:fe:fe'], ['group:fe:fe', undefined], ['project:api', 'group:apis']]);
  const edges = [
    { id: 'sum', from: 'group:fe:fe', to: 'project:api', kind: 'http', role: 'sum' as const },
    { id: 'a', from: 'feature:fe:a', to: 'project:api', kind: 'http', role: 'detail' as const },
    { id: 'b', from: 'feature:fe:b', to: 'project:api', kind: 'http', role: 'detail' as const },
  ];
  it('show one edge for each frontend and API box at first', () => {
    expect(visibleEdges(edges, { imports: false, parentOf }).map((e) => e.id)).toEqual(['sum']);
  });
  it('show the edges of a feature when it is selected, and not the sum', () => {
    expect(visibleEdges(edges, { imports: false, selected: 'feature:fe:a', parentOf }).map((e) => e.id)).toEqual(['a']);
    expect(visibleEdges(edges, { imports: false, selected: 'project:api', parentOf }).map((e) => e.id).sort()).toEqual(['a', 'b']);
  });
});

describe('the break rules of a name', () => {
  it('breaks a long word after "-", "_" or ".", or before "/"', () => {
    expect(breakAt('csvimport-function', 12)).toBe(10);
    expect(breakAt('inventory_validation', 12)).toBe(10);
    expect(breakAt('/stock/inspections/:id/report/final', 30)).toBe(29);
    expect(breakAt('abcdefghijkl', 8)).toBe(-1);
  });

  it('never breaks in the middle of a word', () => {
    const cases: Array<[string, number]> = [
      ['csvimport-function', 16], ['billing-integration-service', 22], ['image-validation-function', 24], ['/stock/inspections/:id/report/final', 32],
    ];
    for (const [text, chars] of cases) {
      const lines = wrap(text, chars);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(chars);
      // Joined again, the lines give the name: each break is at a mark.
      expect(lines.join('')).toBe(text);
      for (const l of lines.slice(0, -1)) expect(/[-_.]$/.test(l) || lines[lines.indexOf(l) + 1]!.startsWith('/')).toBe(true);
    }
    expect(wrap('csvimport-function', 16)).toEqual(['csvimport-', 'function']);
    expect(wrap('/stock/inspections/:id/report/final', 32)).toEqual(['/stock/inspections/:id/report', '/final']);
  });

  it('ends a word with no break mark with "…"', () => {
    expect(wrap('FileCreateResponseSchemaThing', 12)).toEqual(['FileCreateR…']);
    expect(wrap('get FileCreateResponseSchemaThing now', 12)).toEqual(['get', 'FileCreateR…', 'now']);
  });

  it('gives a box the lines of its name with no break in a word', () => {
    const { lines } = sizeOf({ shape: 'project', label: 'billing-integration-service' });
    expect(lines.every((l) => l.endsWith('-') || l.endsWith('…') || lines.indexOf(l) === lines.length - 1)).toBe(true);
  });
});
