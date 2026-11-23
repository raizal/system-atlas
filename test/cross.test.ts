// An edge between boxes in different open boxes goes around the outer boxes with
// straight segments. It leaves the source by the side that faces the target.

import { describe, expect, it } from 'vitest';
import { crossRoute, outerEnds, type Box, type Point } from '../src/web/layout.js';

const box = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height });
const right = (b: Box) => b.x + b.width;
const onLeft = (p: Point, b: Box) => p.x === b.x && p.y > b.y && p.y < b.y + b.height;
const onRight = (p: Point, b: Box) => p.x === right(b) && p.y > b.y && p.y < b.y + b.height;
const orthogonal = (pts: Point[]) => pts.slice(1).every((p, i) => p.x === pts[i]!.x || p.y === pts[i]!.y);
/** True if the vertical segments are out of the box. */
const outside = (pts: Point[], b: Box) =>
  pts.slice(1).every((p, i) => p.x !== pts[i]!.x || p.x <= b.x || p.x >= right(b));

describe('the outer boxes of an edge', () => {
  const parentOf = new Map<string, string | undefined>([
    ['ui', undefined], ['ui§page', 'ui'], ['ui§page§fetch', 'ui§page'],
    ['srv', undefined], ['srv§group:api', 'srv'], ['srv§ep', 'srv§group:api'],
  ]);
  it('the outer boxes are the boxes just under the box that holds both ends', () => {
    expect(outerEnds(parentOf, 'ui§page§fetch', 'srv§ep')).toEqual(['ui', 'srv']);
    expect(outerEnds(parentOf, 'ui§page§fetch', 'ui§page')).toEqual(['ui§page§fetch', 'ui§page']);
  });
  it('two ends in the same open box: the outer boxes are under that box', () => {
    const p = new Map(parentOf).set('ui§other', 'ui');
    expect(outerEnds(p, 'ui§page§fetch', 'ui§other')).toEqual(['ui§page', 'ui§other']);
  });
});

describe('the route of an edge between open boxes', () => {
  const os = box(0, 0, 400, 300);
  const s = box(40, 200, 100, 40);
  it('a target to the right and below: the edge leaves by the right side and goes along the gap', () => {
    const ot = box(600, 100, 400, 600);
    const t = box(700, 500, 100, 40);
    const { points, label } = crossRoute(s, t, os, ot);
    expect(orthogonal(points)).toBe(true);
    expect(onRight(points[0]!, s)).toBe(true);
    expect(onLeft(points.at(-1)!, t)).toBe(true);
    expect(outside(points, os) && outside(points, ot)).toBe(true);
    expect(label.x).toBe(500);
  });
  it('a target to the left: the edge leaves by the left side', () => {
    const ot = box(-700, 0, 400, 300);
    const t = box(-600, 50, 100, 40);
    const { points } = crossRoute(s, t, os, ot);
    expect(orthogonal(points)).toBe(true);
    expect(onLeft(points[0]!, s)).toBe(true);
    expect(onRight(points.at(-1)!, t)).toBe(true);
    expect(outside(points, os) && outside(points, ot)).toBe(true);
  });
  it('a target below: the edge goes down next to both outer boxes, on the side of the target', () => {
    const ot = box(100, 500, 400, 300);
    const t = box(380, 600, 100, 40);
    const { points } = crossRoute(s, t, os, ot);
    expect(orthogonal(points)).toBe(true);
    expect(onRight(points[0]!, s)).toBe(true);
    expect(onRight(points.at(-1)!, t)).toBe(true);
    expect(outside(points, os) && outside(points, ot)).toBe(true);
    expect(points[1]!.x).toBeGreaterThan(500);
  });
});
