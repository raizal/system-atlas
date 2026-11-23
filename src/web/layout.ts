// The layout of the canvas, from the deepest open box up. An open box gets the size of its
// view; the level above places it as one node, so the other boxes move aside. A box with edges
// inside (a flow chart) uses ELK layered, top down, with orthogonal (elbow) edges. A box with no
// edges inside (pages, routes, groups) puts its boxes in rows that wrap, near the aspect of a screen.
//
// ELK reads the size of a node from `width` and `height`. The page draws each node at the size
// that the layout used, so the layout and the canvas agree.

import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api.js';
import type { AtlasView, Shape, ViewNode } from '../server/view.js';
import { buildTree, type Tree, type TreeNode } from './tree.js';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacedNode extends Box {
  /** The full ID of the box on the canvas. */
  id: string;
  /** The box that holds this box: its x and y are inside the parent. */
  parent?: string;
}

export interface Point {
  x: number;
  y: number;
}

/** An edge as ELK routed it: the points of its path and the box of its label, on the canvas. */
export interface PlacedEdge {
  id: string;
  points: Point[];
  label?: Box;
}

export interface Layout {
  /** The edges, with the coordinates on the canvas (ELK `edgeCoords: ROOT`). */
  edges: PlacedEdge[];
  /** The groups. A group in an open box has x and y inside the box. */
  groups: PlacedNode[];
  /** The nodes, parents first. A node in a group or an open box has x and y inside it. */
  nodes: PlacedNode[];
  width: number;
  height: number;
}

/** The space for one character of the node text (12 px type) and the padding of a node. */
export const CHAR = 6.8;
const LINE = 16;
const PAD_X = 28;
const PAD_Y = 20;
/** The space above the children of a group, for the label and the icon. */
export const GROUP_HEAD = 36;
/** The space above the view in an open box, for the name, the file and the close button. */
export const BOX_HEAD = 52;

const WIDTH: Partial<Record<Shape, [number, number]>> = {
  fold: [200, 280], feature: [190, 280],
  project: [170, 240], store: [140, 200], page: [170, 260], endpoint: [170, 260], route: [170, 260], command: [150, 240],
  function: [150, 240], start: [120, 220], end: [120, 240], step: [160, 260], call: [160, 260],
  cross: [190, 280], lib: [150, 240], event: [150, 240], loop: [160, 260], more: [120, 200], decision: [150, 220],
};

/**
 * The place where a long word can break, at most `chars` characters in: after "-", "_" or ".", or
 * before "/". -1: no such place.
 */
export function breakAt(word: string, chars: number): number {
  for (let i = Math.min(chars, word.length - 1); i >= 1; i--) {
    if ('-_.'.includes(word[i - 1]!) || word[i] === '/') return i;
  }
  return -1;
}

/**
 * The lines of a text in a box of `chars` characters. A word breaks only at a space, after "-", "_"
 * or ".", or before "/". A word with no such place ends with "…" (the box has the full text on hover).
 */
export function wrap(text: string, chars: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= chars) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
    while (line.length > chars) {
      const i = breakAt(line, chars);
      if (i > 0) {
        out.push(line.slice(0, i));
        line = line.slice(i);
      } else {
        out.push(`${line.slice(0, chars - 1)}…`);
        line = '';
      }
    }
  }
  if (line !== '') out.push(line);
  return out.length > 0 ? out : [''];
}

/** At most 3 lines of the label: the rest ends with "…". */
export const MAX_LINES = 3;

/** The size steps of a project box: the width range and the least height. A chip shows the name only. */
const STEP: Record<NonNullable<ViewNode['size']>, { width: [number, number]; height: number }> = {
  chip: { width: [90, 200], height: 30 },
  s: { width: [150, 210], height: 44 },
  m: { width: [190, 260], height: 58 },
  l: { width: [240, 320], height: 76 },
};

/** The size of a node: from its shape, its size step and its text. The page draws the node at this size. */
export function sizeOf(n: Pick<ViewNode, 'shape' | 'label' | 'sub' | 'method' | 'size'>): { width: number; height: number; lines: string[] } {
  if (n.size === 'chip') {
    const [min, max] = STEP.chip.width;
    const width = Math.round(Math.min(max, Math.max(min, n.label.length * CHAR + 44)));
    const chars = Math.max(6, Math.floor((width - 44) / CHAR));
    const line = n.label.length > chars ? `${n.label.slice(0, chars - 1)}…` : n.label;
    return { width, height: STEP.chip.height, lines: [line] };
  }
  const step = n.size ? STEP[n.size] : undefined;
  const [min, max] = step?.width ?? WIDTH[n.shape] ?? [150, 240];
  // A method pill ("GET") stands before the label: about 3 characters for each pill and its gap.
  const pill = n.method ? n.method.split(' ').reduce((sum, m) => sum + m.length + 3, 0) : 0;
  const longest = Math.max(n.label.length + pill, n.sub?.length ?? 0);
  const width = Math.round(Math.min(max, Math.max(min, longest * CHAR + PAD_X)));
  const chars = Math.max(8, Math.floor((width - PAD_X) / CHAR) - pill);
  let lines = wrap(n.label, chars);
  if (lines.length > MAX_LINES) lines = [...lines.slice(0, MAX_LINES - 1), `${lines[MAX_LINES - 1]!.slice(0, chars - 1)}…`];
  const subLines = n.sub ? 1 : 0;
  let height = PAD_Y + (lines.length + subLines) * LINE;
  // A diamond needs more room: its text sits in the middle half.
  if (n.shape === 'decision') return { width: width + 40, height: Math.max(80, height + 36), lines };
  if (n.shape === 'start' || n.shape === 'end') height = Math.max(40, height);
  return { width, height: Math.max(step?.height ?? 44, height), lines };
}

const elk = new ELK();

/** The size of an edge label: ELK keeps the label out of the boxes and the other labels. */
export const labelSize = (text: string) => ({ width: Math.round(text.length * 6 + 12), height: 16 });

/** A grid group: the columns, and the space between the cells. */
export const GRID_COLUMNS = 4;
/** A plain group with more boxes than this (and no open box) is packed in rows (see layoutBox). */
export const PACK_GROUP_MIN = 12;
const GRID_GAP = 12;
const GROUP_PAD = 16;

/** The places of the children of a grid group, and the size of the group. */
export function gridOf(children: Array<{ id: string; width: number; height: number }>): { width: number; height: number; places: PlacedNode[] } {
  const cols = Math.min(GRID_COLUMNS, children.length);
  const cell = Math.max(...children.map((c) => c.width));
  const rows: number[] = [];
  for (let i = 0; i < children.length; i += cols) rows.push(Math.max(...children.slice(i, i + cols).map((c) => c.height)));
  const places: PlacedNode[] = children.map((c, i) => {
    const row = Math.floor(i / cols);
    const y = GROUP_HEAD + rows.slice(0, row).reduce((sum, h) => sum + h + GRID_GAP, 0);
    return { id: c.id, x: GROUP_PAD + (i % cols) * (cell + GRID_GAP), y, width: c.width, height: c.height };
  });
  const width = GROUP_PAD * 2 + cols * cell + (cols - 1) * GRID_GAP;
  const height = GROUP_HEAD + rows.reduce((sum, h) => sum + h, 0) + (rows.length - 1) * GRID_GAP + GROUP_PAD;
  return { width, height, places };
}

const SPACING = {
  'elk.spacing.nodeNode': '28',
  'elk.layered.spacing.nodeNodeBetweenLayers': '40',
  'elk.spacing.edgeNode': '18',
  'elk.spacing.edgeEdge': '12',
  'elk.spacing.edgeLabel': '4',
  'elk.layered.spacing.edgeNodeBetweenLayers': '22',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
};

/** The least width of a group: its head shows the icon, the whole title and two buttons. */
export const groupHeadWidth = (label: string): number => Math.round(label.length * 7.4 + 104);

/** The least width of an open box: its head shows the name and the file. */
export function headWidth(n: Pick<ViewNode, 'label' | 'sub' | 'file' | 'line'>): number {
  const where = n.file ? `${n.file}${n.line ? `:${n.line}` : ''}` : (n.sub ?? '');
  return Math.round(Math.min(520, Math.max(220, Math.max(n.label.length * 7.6, where.length * 6.2) + 90)));
}

/** The aspect (width / height) of a packed box: near the aspect of a screen. */
export const PACK_RATIO = 1.6;
const PACK_GAP = 20;
const BOX_PAD = 18;
const ROOT_PAD = 24;
/** The shapes that a packed group shows in columns: one route on each line. */
const COLUMN: ReadonlySet<Shape> = new Set(['route', 'endpoint', 'command']);
/** The routes in one column of a group, before a new column starts (at most 3 columns). */
export const COLUMN_ROWS = 10;
const MAX_COLUMNS = 3;
/** The lanes of the System view: the aspect of a lane (a narrow column), and the space between lanes. */
export const LANE_RATIO = 0.35;
export const LANE_GAP = 240;
const STACK_GAP = 40;
const SHELF_GAP = 70;

type Size = { width: number; height: number };
type Sized = Size & { id: string };

/** Rows of boxes, left to right; a new row starts at the width `limit`. */
function shelf(items: readonly Sized[], limit: number, gap: number): { places: Map<string, Point>; width: number; height: number } {
  const places = new Map<string, Point>();
  let x = 0;
  let y = 0;
  let row = 0;
  let width = 0;
  for (const it of items) {
    if (x > 0 && x + it.width > limit) {
      y += row + gap;
      x = 0;
      row = 0;
    }
    places.set(it.id, { x, y });
    width = Math.max(width, x + it.width);
    x += it.width + gap;
    row = Math.max(row, it.height);
  }
  return { places, width, height: y + row };
}

/**
 * The places of boxes with no edges between them: rows that wrap, with an aspect near `ratio`.
 * `columns` (more than 0): that number of columns of the same width, in rows.
 */
export function packOf(items: readonly Sized[], ratio = PACK_RATIO, columns = 0, gap = PACK_GAP): { places: Map<string, Point>; width: number; height: number } {
  if (items.length === 0) return { places: new Map(), width: 0, height: 0 };
  const widest = Math.max(...items.map((i) => i.width));
  if (columns > 0) {
    const cells = items.map((i) => ({ ...i, width: widest }));
    return shelf(cells, columns * widest + (columns - 1) * gap, gap);
  }
  const area = items.reduce((sum, i) => sum + (i.width + gap) * (i.height + gap), 0);
  const base = Math.sqrt(area * ratio);
  let best: ReturnType<typeof shelf> | undefined;
  let score = Infinity;
  for (let f = 0.4; f <= 3; f += 0.1) {
    const out = shelf(items, Math.max(widest, base * f), gap);
    const miss = Math.abs(Math.log(out.width / Math.max(1, out.height) / ratio));
    if (miss < score - 1e-9) {
      best = out;
      score = miss;
    }
  }
  return best!;
}

/**
 * The layout of the tree of the canvas, from the deepest open box up. Each open box gets a fixed
 * size first; the level above then places it as one node.
 *
 * - If the boxes in a box have edges between them (a flow chart, the system), ELK layered places
 *   them top down. The groups in that box are in the same ELK pass.
 * - If they have no edges (pages, routes, groups), they go in rows that wrap, near the aspect of a
 *   screen. A group of routes has one route on each line, in 1 to 3 columns (10 routes in a column).
 *
 * ELK routes an edge only if its two ends are in the same pass. An edge that goes into another
 * open box has no route: the page draws it as a smooth step from handle to handle.
 */
export async function layoutTree(tree: Tree): Promise<Layout> {
  const ROOT = '';
  const groupOf = new Map(tree.groups.map((g) => [g.fid, g]));
  const nodeOf = new Map(tree.nodes.map((n) => [n.fid, n]));
  const parentOf = new Map<string, string>();
  const kids = new Map<string, string[]>();
  for (const x of [...tree.groups, ...tree.nodes]) {
    const p = x.parent ?? ROOT;
    parentOf.set(x.fid, p);
    kids.set(p, [...(kids.get(p) ?? []), x.fid]);
  }
  const size = new Map<string, Size>();
  /** x and y of each box inside its parent. */
  const rel = new Map<string, Point>();
  /** The edges that ELK routed, with x and y inside the box of the pass. */
  const routed: Array<{ box: string; edge: PlacedEdge }> = [];

  const isGrid = (fid: string) => groupOf.get(fid)?.grid === true;
  const isGroup = (fid: string) => groupOf.has(fid);
  const leafSize = (fid: string): Size => {
    if (isGrid(fid)) {
      const grid = gridOf((kids.get(fid) ?? []).map((c) => ({ id: c, ...sizeOf(nodeOf.get(c)!.node) })));
      for (const pl of grid.places) {
        rel.set(pl.id, { x: pl.x, y: pl.y });
        size.set(pl.id, { width: pl.width, height: pl.height });
      }
      return { width: grid.width, height: grid.height };
    }
    return sizeOf(nodeOf.get(fid)!.node);
  };

  /** The size of a box that is not open and not a plain group. */
  const atomSize = async (fid: string): Promise<Size> => {
    const n = nodeOf.get(fid);
    const s = n?.state === 'open' ? await layoutBox(fid) : leafSize(fid);
    size.set(fid, s);
    return s;
  };

  const slotOf = (fid: string) => groupOf.get(fid)?.group ?? nodeOf.get(fid)?.fold;

  /**
   * The lanes of the System view: each group is a narrow column, the lanes go left to right, the
   * groups of one lane stack. The shelves (Libraries, Support) are rows under the lanes. No ELK pass:
   * the page draws each edge across the gaps between the lanes (see crossRoute).
   */
  const lanes = async (): Promise<Size> => {
    const roots = kids.get(ROOT) ?? [];
    const sizeOfRoot = async (k: string, o: { ratio?: number; limit?: number }) => {
      if (isGroup(k) && !isGrid(k)) {
        for (const m of kids.get(k) ?? []) if (!isGroup(m)) await atomSize(m);
        size.set(k, packBox(k, GROUP_HEAD, GROUP_PAD, o));
      } else await atomSize(k);
      return size.get(k)!;
    };
    const byLane = new Map<number, string[]>();
    const shelves: string[] = [];
    for (const k of roots) {
      const slot = slotOf(k);
      if (slot?.shelf) shelves.push(k);
      else {
        const lane = slot?.lane ?? Number.MAX_SAFE_INTEGER;
        byLane.set(lane, [...(byLane.get(lane) ?? []), k]);
      }
    }
    let x = ROOT_PAD;
    let bottom = ROOT_PAD;
    /** A group with `middle` and the height of its lane: it moves to the middle of the tallest lane. */
    const middles: Array<{ keys: string[]; height: number }> = [];
    for (const lane of [...byLane.keys()].sort((a, b) => a - b)) {
      let y = ROOT_PAD;
      let w = 0;
      for (const k of byLane.get(lane)!) {
        const s = await sizeOfRoot(k, { ratio: slotOf(k)?.ratio ?? LANE_RATIO });
        rel.set(k, { x, y });
        y += s.height + STACK_GAP;
        w = Math.max(w, s.width);
      }
      if (byLane.get(lane)!.some((k) => slotOf(k)?.middle)) middles.push({ keys: byLane.get(lane)!, height: y - STACK_GAP - ROOT_PAD });
      bottom = Math.max(bottom, y - STACK_GAP);
      x += w + LANE_GAP;
    }
    for (const m of middles) {
      const dy = Math.max(0, (bottom - ROOT_PAD - m.height) / 2);
      for (const k of m.keys) rel.set(k, { x: rel.get(k)!.x, y: rel.get(k)!.y + dy });
    }
    const lanesWidth = Math.max(600, x - LANE_GAP - ROOT_PAD);
    const items: Sized[] = [];
    for (const k of shelves) items.push({ id: k, ...(await sizeOfRoot(k, { limit: lanesWidth - 2 * GROUP_PAD })) });
    const top = bottom + (byLane.size > 0 ? SHELF_GAP : 0);
    const row = shelf(items, lanesWidth, STACK_GAP);
    for (const [id, pl] of row.places) rel.set(id, { x: pl.x + ROOT_PAD, y: pl.y + top });
    return {
      width: Math.max(x - LANE_GAP, ROOT_PAD + row.width) + ROOT_PAD,
      height: (items.length > 0 ? top + row.height : bottom) + ROOT_PAD,
    };
  };

  /** Lay out the children of a box (an open node or the canvas) and give the size of the box. */
  const layoutBox = async (box: string): Promise<Size> => {
    if (box === ROOT && (kids.get(ROOT) ?? []).some((k) => { const sl = slotOf(k); return sl?.lane !== undefined || sl?.shelf === true; })) return lanes();
    const pad = box === ROOT ? { top: ROOT_PAD, side: ROOT_PAD } : { top: BOX_HEAD, side: BOX_PAD };
    // The scope of the pass: the children of the box, and the children of its plain groups.
    const atoms = new Set<string>();
    const plain = new Set<string>();
    const collect = (p: string) => {
      for (const k of kids.get(p) ?? []) {
        if (isGroup(k) && !isGrid(k)) {
          plain.add(k);
          collect(k);
        } else atoms.add(k);
      }
    };
    collect(box);
    // A large plain group (40 libraries) would be one or two very long ELK layers. It is packed in rows
    // that wrap, near the aspect of a screen, and ELK places it as one box. Its edges go to the group in
    // the pass; the page draws them around the boxes, as cross-box edges (faint until hover).
    for (const g of [...plain]) {
      const members = kids.get(g) ?? [];
      if (members.length <= PACK_GROUP_MIN || members.some((k) => isGroup(k) || nodeOf.get(k)?.state === 'open')) continue;
      plain.delete(g);
      for (const k of members) atoms.delete(k);
      atoms.add(g);
      size.set(g, packBox(g, GROUP_HEAD, GROUP_PAD));
    }
    for (const a of atoms) if (!size.has(a) || !isGroup(a)) await atomSize(a);
    const atomOf = (fid: string): string | undefined => {
      let x: string | undefined = fid;
      while (x !== undefined && x !== ROOT && x !== box) {
        if (atoms.has(x)) return x;
        x = parentOf.get(x);
      }
      return undefined;
    };
    const direct: typeof tree.edges = [];
    const lifted = new Map<string, { from: string; to: string }>();
    for (const e of tree.edges) {
      const from = atomOf(e.from);
      const to = atomOf(e.to);
      if (!from || !to || from === to) continue;
      if (from === e.from && to === e.to) direct.push(e);
      else lifted.set(`${from}>${to}`, { from, to });
    }
    for (const e of direct) lifted.delete(`${e.from}>${e.to}`);

    let inner: Size;
    if (direct.length + lifted.size > 0) inner = await layered(box, pad, atoms, plain, direct, [...lifted.values()]);
    else inner = packBox(box, pad.top, pad.side);
    const s = box === ROOT ? inner : boxSize(nodeOf.get(box)!.node, inner);
    return s;
  };

  const boxSize = (n: ViewNode, inner: Size): Size => ({
    width: Math.max(headWidth(n), inner.width),
    height: Math.max(BOX_HEAD + 40, inner.height),
  });

  /** Pack the children of a box or a group with no edges. The plain groups in it are packed first. */
  const packBox = (p: string, top: number, side: number, o: { ratio?: number; limit?: number } = {}): Size => {
    const list = kids.get(p) ?? [];
    const items: Sized[] = [];
    for (const k of list) {
      let s = size.get(k);
      if (!s) {
        s = isGroup(k) && !isGrid(k) ? packBox(k, GROUP_HEAD, GROUP_PAD) : leafSize(k);
        size.set(k, s);
      }
      items.push({ id: k, ...s });
    }
    const column = isGroup(p) && list.every((k) => nodeOf.get(k) && nodeOf.get(k)!.state !== 'open' && (COLUMN.has(nodeOf.get(k)!.node.shape) || nodeOf.get(k)!.node.shape === 'more'));
    const columns = column ? Math.min(MAX_COLUMNS, Math.ceil(list.length / COLUMN_ROWS)) : 0;
    const gap = isGroup(p) ? GRID_GAP : PACK_GAP;
    const out = o.limit !== undefined && columns === 0
      ? shelf(items, Math.max(o.limit, ...items.map((i) => i.width)), gap)
      : packOf(items, o.ratio ?? PACK_RATIO, columns, gap);
    for (const [id, pl] of out.places) rel.set(id, { x: pl.x + side, y: pl.y + top });
    const head = groupOf.get(p) ? groupHeadWidth(groupOf.get(p)!.group.label) : 0;
    return { width: Math.max(head, out.width + 2 * side), height: out.height + top + side };
  };

  /** One ELK layered pass over the children of a box, with its plain groups as compound nodes. */
  const layered = async (
    box: string, pad: { top: number; side: number }, atoms: Set<string>, plain: Set<string>,
    direct: typeof tree.edges, lifted: Array<{ from: string; to: string }>,
  ): Promise<Size> => {
    const build = (p: string): ElkNode[] =>
      (kids.get(p) ?? []).map((k): ElkNode => {
        if (plain.has(k)) {
          const min = `(${groupHeadWidth(groupOf.get(k)!.group.label)}, 0)`;
          return { id: k, layoutOptions: { ...SPACING, 'elk.padding': `[top=${GROUP_HEAD},left=16,bottom=16,right=16]`, 'elk.nodeSize.constraints': 'MINIMUM_SIZE', 'elk.nodeSize.minimum': min }, children: build(k) };
        }
        const s = size.get(k)!;
        return { id: k, width: s.width, height: s.height, ...(isGrid(k) ? { layoutOptions: { 'elk.layered.layering.layerConstraint': 'LAST' } } : {}) };
      });
    const edges: ElkExtendedEdge[] = [
      ...direct.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to], ...(e.label ? { labels: [{ text: e.label, ...labelSize(e.label) }] } : {}) })),
      ...lifted.map((e, i) => ({ id: `lift:${i}`, sources: [e.from], targets: [e.to] })),
    ];
    const graph: ElkNode = {
      id: box === ROOT ? 'root' : box,
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'DOWN',
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.hierarchyHandling': plain.size > 0 ? 'INCLUDE_CHILDREN' : 'SEPARATE_CHILDREN',
        'elk.json.edgeCoords': 'ROOT',
        ...SPACING,
        'elk.edgeLabels.placement': 'CENTER',
        'elk.layered.edgeLabels.sideSelection': 'SMART_DOWN',
        'elk.spacing.componentComponent': '48',
        'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
        'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
        'elk.padding': `[top=${pad.top},left=${pad.side},bottom=${pad.side},right=${pad.side}]`,
      },
      children: build(box),
      edges,
    };
    const out = await elk.layout(graph);
    const read = (n: ElkNode) => {
      rel.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
      if (plain.has(n.id)) size.set(n.id, { width: n.width ?? 0, height: n.height ?? 0 });
      for (const k of n.children ?? []) read(k);
    };
    for (const c of out.children ?? []) read(c);
    const readEdges = (n: ElkNode) => {
      for (const e of n.edges ?? []) {
        const sec = e.sections?.[0];
        if (!sec || e.id.startsWith('lift:')) continue;
        const lab = e.labels?.[0];
        routed.push({
          box,
          edge: {
            id: e.id, points: [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].map((p) => ({ x: p.x, y: p.y })),
            ...(lab ? { label: { x: lab.x ?? 0, y: lab.y ?? 0, width: lab.width ?? 0, height: lab.height ?? 0 } } : {}),
          },
        });
      }
      for (const k of n.children ?? []) readEdges(k);
    };
    readEdges(out);
    return { width: out.width ?? 0, height: out.height ?? 0 };
  };

  const whole = await layoutBox(ROOT);
  const groups: PlacedNode[] = [];
  const nodes: PlacedNode[] = [];
  const place = (fid: string): PlacedNode => {
    const p = parentOf.get(fid)!;
    const at = rel.get(fid) ?? { x: 0, y: 0 };
    const s = size.get(fid) ?? { width: 0, height: 0 };
    return { id: fid, x: at.x, y: at.y, width: s.width, height: s.height, ...(p !== ROOT ? { parent: p } : {}) };
  };
  for (const g of tree.groups) groups.push(place(g.fid));
  for (const n of tree.nodes) nodes.push(place(n.fid));
  const layout: Layout = { groups, nodes, edges: [], width: whole.width, height: whole.height };
  // The routes of a pass are inside its box: move them to the canvas.
  const abs = absolute(layout);
  layout.edges = routed.map(({ box, edge }) => {
    const o = box === ROOT ? { x: 0, y: 0 } : abs.get(box)!;
    return {
      ...edge,
      points: edge.points.map((p) => ({ x: p.x + o.x, y: p.y + o.y })),
      ...(edge.label ? { label: { ...edge.label, x: edge.label.x + o.x, y: edge.label.y + o.y } } : {}),
    };
  });
  return layout;
}

/** The layout of one view with no open box (the tests use it). */
export function layoutView(view: AtlasView): Promise<Layout> {
  return layoutTree(buildTree(view, () => undefined, new Set()));
}

/** The boxes on the canvas: x and y of each node and group, not inside its parent. */
export function absolute(layout: Layout): Map<string, PlacedNode> {
  const out = new Map<string, PlacedNode>();
  const all = new Map([...layout.groups, ...layout.nodes].map((b) => [b.id, b]));
  const at = (id: string): PlacedNode => {
    const have = out.get(id);
    if (have) return have;
    const b = all.get(id)!;
    const p = b.parent ? at(b.parent) : undefined;
    const box = { ...b, x: b.x + (p?.x ?? 0), y: b.y + (p?.y ?? 0) };
    out.set(id, box);
    return box;
  };
  for (const id of all.keys()) at(id);
  return out;
}

/** The least zoom of the first view: below it, the text is too small to read. */
export const MIN_FIRST_ZOOM = 0.5;
const PAD = 24;

/** The first viewport of a layout on a canvas of `w` x `h` px. */
export function firstView(layout: Layout, w: number, h: number): { x: number; y: number; zoom: number } {
  const lw = Math.max(1, layout.width);
  const lh = Math.max(1, layout.height);
  const fit = Math.min(1.1, (w - 2 * PAD) / lw, (h - 2 * PAD) / lh);
  if (fit >= MIN_FIRST_ZOOM) return { x: (w - lw * fit) / 2, y: (h - lh * fit) / 2, zoom: fit };
  // Too large: fit the width (not less than the least zoom), and show the top, where the chart starts.
  const zoom = Math.max(MIN_FIRST_ZOOM, Math.min(1, (w - 2 * PAD) / lw));
  const x = lw * zoom <= w - 2 * PAD ? (w - lw * zoom) / 2 : PAD;
  return { x, y: PAD, zoom };
}

/** The least zoom of the first view of a search lens: the text of the boxes stays readable. */
export const MIN_LENS_ZOOM = 0.6;

/**
 * The first view of a search lens: all of it if it fits at MIN_LENS_ZOOM or more (not above 1), else
 * MIN_LENS_ZOOM. The top left of the chart at the top left of the canvas.
 */
export function lensFirstView(layout: Layout, w: number, h: number): { x: number; y: number; zoom: number } {
  // The bounds of the boxes: the top left box is at the top left of the canvas, whatever the layout origin.
  const all = [...absolute(layout).values()];
  const x0 = all.length > 0 ? Math.min(...all.map((b) => b.x)) : 0;
  const y0 = all.length > 0 ? Math.min(...all.map((b) => b.y)) : 0;
  const lw = Math.max(1, all.length > 0 ? Math.max(...all.map((b) => b.x + b.width)) - x0 : layout.width);
  const lh = Math.max(1, all.length > 0 ? Math.max(...all.map((b) => b.y + b.height)) - y0 : layout.height);
  const zoom = Math.max(MIN_LENS_ZOOM, Math.min(1, (w - 2 * PAD) / lw, (h - 2 * PAD) / lh));
  return { x: PAD - x0 * zoom, y: PAD - y0 * zoom, zoom };
}

/** The least zoom when the page moves the camera to an open box. */
export const MIN_FOCUS_ZOOM = 0.4;
const FOCUS_PAD = 60;

/** The margin of an automatic fit at the top of the canvas (as in the first view), and of a pan to a box. */
export const VIEW_MARGIN = 24;

/** A viewport of the canvas: the pan (px) and the zoom. */
export type Viewport = { x: number; y: number; zoom: number };

/**
 * The part of the canvas that the reader sees: all of it, or the part left of the side panel when
 * the panel is open (`panel` is the width of the panel and its margin). Each automatic fit and pan
 * uses this area.
 */
export function visibleArea(w: number, h: number, panel: number): { w: number; h: number } {
  return { w: Math.max(1, w - Math.max(0, panel)), h };
}

/**
 * The least pan that shows all of a box in the area `w` x `h` (VIEW_MARGIN at each side). The zoom
 * does not change. A box that is in view does not move the camera. On an axis where the box is
 * larger than the area, the box fills the area: the pan is only so that no empty part shows.
 */
export function nudgeView(box: Box, view: Viewport, w: number, h: number, margin = VIEW_MARGIN): Viewport {
  const shift = (start: number, size: number, area: number): number => {
    const a = start, b = start + size;
    const lo = margin, hi = area - margin;
    if (size <= hi - lo) return a < lo ? lo - a : b > hi ? hi - b : 0;
    return a > lo ? lo - a : b < hi ? hi - b : 0;
  };
  const z = view.zoom;
  const dx = shift(box.x * z + view.x, box.width * z, w);
  const dy = shift(box.y * z + view.y, box.height * z, h);
  return dx === 0 && dy === 0 ? view : { x: view.x + dx, y: view.y + dy, zoom: z };
}

/** The y of an automatic fit: the top of the box at VIEW_MARGIN from the top of the canvas. */
const topOf = (box: Box, zoom: number) => VIEW_MARGIN - box.y * zoom;

/**
 * The viewport that shows a box that the reader opened, with some room around it for the boxes
 * near it. The top of the box is at the top of the canvas. If the box is too large at the least zoom,
 * the view shows its top left part.
 */
export function focusView(box: Box, w: number, h: number): Viewport {
  const bw = Math.max(1, box.width + 2 * FOCUS_PAD);
  const bh = Math.max(1, box.height + 2 * FOCUS_PAD);
  const zoom = Math.max(MIN_FOCUS_ZOOM, Math.min(1, w / bw, h / bh));
  const left = box.x - FOCUS_PAD;
  const x = bw * zoom <= w ? (w - bw * zoom) / 2 - left * zoom : VIEW_MARGIN - box.x * zoom;
  return { x, y: topOf(box, zoom), zoom };
}

/** The box that holds all the boxes. */
export function unionBox(boxes: readonly Box[]): Box | undefined {
  if (boxes.length === 0) return undefined;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
}

/**
 * The viewport of an automatic fit: all of the box if it fits at the zoom `min` or more; else the zoom
 * `min`. The middle of the box across; its top at the top of the canvas. The zoom is never less than `min`.
 */
export function clampView(box: Box, w: number, h: number, min: number): { x: number; y: number; zoom: number } {
  const bw = Math.max(1, box.width + 2 * FOCUS_PAD);
  const bh = Math.max(1, box.height + 2 * FOCUS_PAD);
  const zoom = Math.max(min, Math.min(1, w / bw, h / bh));
  const cx = box.x + box.width / 2;
  return { x: w / 2 - cx * zoom, y: topOf(box, zoom), zoom };
}

/**
 * The viewport that shows all of a box on a canvas of `w` x `h` px, with FOCUS_PAD around it, its top at the top of the canvas. No
 * value: the box does not fit at the zoom `min`.
 */
export function fitView(box: Box, w: number, h: number, min: number): { x: number; y: number; zoom: number } | undefined {
  const bw = Math.max(1, box.width + 2 * FOCUS_PAD);
  const bh = Math.max(1, box.height + 2 * FOCUS_PAD);
  const zoom = Math.min(1, w / bw, h / bh);
  if (zoom < min) return undefined;
  return { x: (w - bw * zoom) / 2 - (box.x - FOCUS_PAD) * zoom, y: topOf(box, zoom), zoom };
}

/** Two boxes overlap (a test of the layout). */
export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * The outer box of each end of an edge: the box that holds the end (or the end itself) at the
 * level where the paths of the two ends meet. `parentOf` gives the parent box of each box.
 */
export function outerEnds(parentOf: ReadonlyMap<string, string | undefined>, from: string, to: string): [string, string] {
  const chain = (fid: string): string[] => {
    const out = [fid];
    for (let p = parentOf.get(fid); p !== undefined; p = parentOf.get(p)) out.push(p);
    return out;
  };
  const a = chain(from);
  const b = chain(to);
  const inB = new Set(b);
  const i = a.findIndex((x) => inB.has(x));
  if (i === -1) return [a.at(-1)!, b.at(-1)!];
  const meet = a[i]!;
  return [a[Math.max(0, i - 1)]!, b[Math.max(0, b.indexOf(meet) - 1)]!];
}

/** The space between an edge and the outer box that it goes around. */
const ROUTE_GAP = 14;

/**
 * The orthogonal route of an edge between two boxes in different open boxes. The edge leaves the
 * source by the side that faces the target, goes straight out of the outer box of the source,
 * goes along the gap between the outer boxes, and goes into the side of the target. `os` and `ot`
 * are the outer boxes of the two ends (see outerEnds). It gives the points and the place of the label.
 */
export function crossRoute(s: Box, t: Box, os: Box, ot: Box): { points: Point[]; label: Point } {
  const right = (b: Box) => b.x + b.width;
  const midY = (b: Box) => b.y + b.height / 2;
  let exitRight: boolean;
  let enterLeft: boolean;
  let x: number;
  if (ot.x >= right(os)) {
    exitRight = true;
    enterLeft = true;
    x = (right(os) + ot.x) / 2;
  } else if (right(ot) <= os.x) {
    exitRight = false;
    enterLeft = false;
    x = (right(ot) + os.x) / 2;
  } else {
    // One outer box is above the other: go down (or up) along the side of both, on the side of the target.
    exitRight = t.x + t.width / 2 >= s.x + s.width / 2;
    enterLeft = !exitRight;
    x = exitRight ? Math.max(right(os), right(ot)) + ROUTE_GAP : Math.min(os.x, ot.x) - ROUTE_GAP;
  }
  const p0 = { x: exitRight ? right(s) : s.x, y: midY(s) };
  const q0 = { x: enterLeft ? t.x : right(t), y: midY(t) };
  const points = [p0, { x, y: p0.y }, { x, y: q0.y }, q0];
  return { points: points.filter((p, i) => i === 0 || p.x !== points[i - 1]!.x || p.y !== points[i - 1]!.y), label: { x, y: (p0.y + q0.y) / 2 } };
}

// ---------------------------------------------------------------- the edges across the lanes

/** The most characters of an edge label on the canvas: the rest ends with "…" (the full text is on hover). */
export const MAX_LABEL = 24;
export const shortLabel = (text: string): string => (text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text);

/** The size of an edge pill on the canvas. */
export const pillSize = (text: string) => ({ width: Math.round(text.length * 6.2 + 16), height: 18 });

export interface CrossEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  /** The size of the label pill (pillSize by default). */
  size?: { width: number; height: number };
  /** The label goes near this end, on the horizontal part of the edge: source (the default) or target (a data store). */
  near?: 'source' | 'target';
  /** A total of a group: the label sits on the vertical part, and moves along it rather than hide. */
  total?: boolean;
  /** The edge leaves from the head of its source (a frontend group), not from a port along its side. Its label goes near the target. */
  fromHead?: boolean;
  /** A target that sits right in its outer box (a lane group) bundles with the others of that box: one trunk into the group. */
  intoGroup?: boolean;
}

export interface CrossRoute {
  points: Point[];
  /** The box of the label, if the edge has a label. */
  label?: Box;
  /** The label hides: it overlaps another label. The page shows it on hover. */
  hidden?: boolean;
  /** The x of the vertical part of the edge (its track), if it has one. */
  track?: number;
  /** The key of the bundle of the edge: the edges into one target box share one track (the trunk). */
  bundle?: string;
  /** The label of the whole bundle: on the first edge of the bundle only. */
  bundleLabel?: { text: string; box: Box; hidden?: boolean };
}

export interface CrossOptions {
  /** The label of a bundle, from its edges ("19 pages · 23 endpoints"). */
  bundleText?: (edges: CrossEdge[]) => string | undefined;
}

/** The least number of edges into one target box that become a bundle. */
export const BUNDLE_MIN = 3;
/** The y of the port of an edge that leaves from the head of its source. */
const HEAD_PORT = GROUP_HEAD / 2;

/** The space between a label and the box or the lane next to it. */
const LABEL_GAP = 8;
/** The space between the tracks and the side of the gap: the arrow needs room at the target. */
const TRACK_IN = 10;
const TRACK_OUT = 18;
/** The least width of the part of a gap with the tracks. */
const TRACKS_MIN = 40;

const right = (b: Box) => b.x + b.width;
const bottom = (b: Box) => b.y + b.height;
const midY = (b: Box) => b.y + b.height / 2;

/** Two label boxes overlap (with a small margin). */
export function labelsOverlap(a: Box, b: Box, margin = 2): boolean {
  return a.x < right(b) + margin && b.x < right(a) + margin && a.y < bottom(b) + margin && b.y < bottom(a) + margin;
}

/** The count at the start of a label ("19 HTTP calls" → 19): a larger count keeps its label first. */
const countOf = (label: string | undefined): number => Number(/^(\d+)/.exec(label ?? '')?.[1] ?? 0);

/**
 * The routes of the edges that ELK does not route: between the lanes of the top view, and between
 * boxes in different open boxes. Each edge has its own track (the x of its vertical part) in the gap
 * in front of the outer box of its target; the tracks are in an order with few crossings. Each edge
 * leaves its source at its own port, and goes into its target at its own port. The label sits on the
 * horizontal part near the source (or near the target, for a data store). No two labels overlap: a
 * label that has no free place hides (`hidden`).
 *
 * Bundles: BUNDLE_MIN or more edges (in one direction) into the same box just inside the outer box of
 * the target share one track (the trunk). When they all end at that box, they share one end and one
 * arrowhead; else they fan out from the trunk into the open box. The labels of the members hide; the
 * lead route gets `bundleLabel` (text from `opts.bundleText`), on the trunk at the turn into the
 * target. Each member route has `bundle` (the key), so the page can draw a selected member on top.
 * An edge with `fromHead` leaves its source group at the head (y + HEAD_PORT), with its label near the
 * target.
 *
 * `where` gives the box of each node and group on the canvas (absolute), `parentOf` its parent.
 */
export function routeCross(edges: readonly CrossEdge[], where: ReadonlyMap<string, Box>, parentOf: ReadonlyMap<string, string | undefined>, opts: CrossOptions = {}): Map<string, CrossRoute> {
  const out = new Map<string, CrossRoute>();
  const roots = [...where].filter(([id]) => parentOf.get(id) === undefined).map(([, b]) => b);
  const placed: Box[] = [];
  // A free place overlaps no other label and no outer box: a label on a box (an edge between two
  // boxes in one column, say) hides and shows on hover.
  const free = (b: Box) => !placed.some((p) => labelsOverlap(p, b)) && !roots.some((p) => labelsOverlap(p, b, 0));
  /** Place a label at the first free candidate; else it hides at the first one. */
  const put = (r: CrossRoute, candidates: Box[]) => {
    if (candidates.length === 0) return;
    const ok = candidates.find(free);
    r.label = ok ?? candidates[0]!;
    if (ok) placed.push(ok);
    else r.hidden = true;
  };

  interface Run {
    e: CrossEdge;
    s: Box;
    t: Box;
    os: Box;
    ot: Box;
    /** The target box in the outer box of the target: the box that the bundle goes into. */
    unit: string;
    /** The key of the bundle, if the edge is in one. */
    bundle?: string;
    /** 1: the target is right of the source; -1: left. */
    dir: 1 | -1;
    sy: number;
    ty: number;
    lo: number;
    hi: number;
    size?: { width: number; height: number };
  }
  const runs: Run[] = [];
  const order = [...edges].sort((a, b) => countOf(b.label) - countOf(a.label) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const e of order) {
    const s = where.get(e.from);
    const t = where.get(e.to);
    if (!s || !t) continue;
    const size = e.label ? (e.size ?? pillSize(e.label)) : undefined;
    // A total in one group: a loop on the left side of the group.
    if (e.from === e.to) {
      const x = s.x - 60;
      const y0 = s.y + s.height * 0.35;
      const y1 = s.y + s.height * 0.65;
      const r: CrossRoute = { points: [{ x: s.x, y: y0 }, { x, y: y0 }, { x, y: y1 }, { x: s.x, y: y1 }], track: x };
      if (size) put(r, [0, 1, -1, 2, -2].map((k) => ({ x: x - size.width / 2, y: (y0 + y1) / 2 - size.height / 2 + k * (size.height + 6), ...size })));
      out.set(e.id, r);
      continue;
    }
    const [osId, otId] = outerEnds(parentOf, e.from, e.to);
    const os = where.get(osId) ?? s;
    const ot = where.get(otId) ?? t;
    const dir = ot.x >= right(os) ? 1 : right(ot) <= os.x ? -1 : 0;
    if (dir === 0) {
      // One outer box is above the other: the old route, along the side of both.
      const c = crossRoute(s, t, os, ot);
      const r: CrossRoute = { points: c.points };
      if (size) put(r, [{ x: c.label.x - size.width / 2, y: c.label.y - size.height / 2, ...size }]);
      out.set(e.id, r);
      continue;
    }
    // The box just inside the outer box of the target, on the path to the target.
    let unit = e.to;
    for (let p = parentOf.get(unit); p !== undefined && unit !== otId && p !== otId; p = parentOf.get(p)) unit = p;
    if (e.intoGroup && unit === e.to && parentOf.get(e.to) === otId) unit = otId;
    runs.push({ e, s, t, os, ot, unit, dir, sy: midY(s), ty: midY(t), lo: 0, hi: 0, ...(size ? { size } : {}) });
  }

  // The bundles: BUNDLE_MIN or more edges (not totals) into one target box, from one side.
  const bundles = new Map<string, Run[]>();
  for (const r of runs) if (!r.e.total) bundles.set(`${r.dir}|${r.unit}`, [...(bundles.get(`${r.dir}|${r.unit}`) ?? []), r]);
  for (const [k, list] of bundles) {
    if (list.length < BUNDLE_MIN) bundles.delete(k);
    else for (const r of list) r.bundle = k;
  }

  // The ports: the edges out of one side of a box leave at their own y, in the order of their targets.
  const spread = (key: (r: Run) => string, box: (r: Run) => Box, by: (r: Run) => number, set: (r: Run, y: number) => void) => {
    const groups = new Map<string, Run[]>();
    for (const r of runs) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => by(a) - by(b));
      list.forEach((r, i) => set(r, box(r).y + (box(r).height * (i + 1)) / (list.length + 1)));
    }
  };
  spread((r) => `${r.e.from}|${r.dir}${r.e.fromHead ? '|head' : ''}`, (r) => r.s, (r) => midY(r.t), (r, y) => (r.sy = y));
  spread((r) => `${r.e.to}|${r.dir}`, (r) => r.t, (r) => r.sy, (r, y) => (r.ty = y));
  // From the head: one port for all. Into one box of a bundle: one port, one arrow.
  for (const r of runs) if (r.e.fromHead) r.sy = r.s.y + Math.min(HEAD_PORT, r.s.height / 2);
  for (const list of bundles.values()) {
    if (list.every((r) => r.e.to === list[0]!.e.to)) for (const r of list) r.ty = midY(r.t);
  }

  // The gap in front of the outer box of the target: up to the nearest top box on the way.
  for (const r of runs) {
    const y0 = Math.min(r.sy, r.ty);
    const y1 = Math.max(r.sy, r.ty);
    const across = roots.filter((b) => b.y < y1 && bottom(b) > y0);
    if (r.dir === 1) {
      r.hi = r.ot.x;
      r.lo = Math.max(right(r.os), ...across.map(right).filter((x) => x <= r.ot.x));
    } else {
      r.lo = right(r.ot);
      r.hi = Math.min(r.os.x, ...across.map((b) => b.x).filter((x) => x >= right(r.ot)));
    }
  }

  // The labels near an end, on the horizontal part, in the gap next to the outer box of that end.
  const routes = new Map<Run, CrossRoute>();
  for (const r of runs) {
    const route: CrossRoute = { points: [] };
    routes.set(r, route);
    if (!r.size || r.e.total) continue;
    const { width, height } = r.size;
    const atTarget = r.e.near === 'target' || r.e.fromHead === true;
    const y = (atTarget ? r.ty : r.sy) - height / 2;
    // In a bundle, the label at the target gives its place to the label of the bundle: it shows on hover.
    if (atTarget && r.bundle) {
      route.label = { x: r.dir === 1 ? r.ot.x - LABEL_GAP - width : right(r.ot) + LABEL_GAP, y, width, height };
      route.hidden = true;
      continue;
    }
    let x0: number;
    let step = 0;
    if (atTarget) {
      x0 = r.dir === 1 ? r.ot.x - LABEL_GAP - width : right(r.ot) + LABEL_GAP;
    } else {
      x0 = r.dir === 1 ? right(r.os) + LABEL_GAP : r.os.x - LABEL_GAP - width;
      step = r.dir === 1 ? width + 6 : -(width + 6);
    }
    // A second place further along the line, only in the gap next to the source when the track is in
    // another gap: in the gap of the track, the labels at its side leave the room of the tracks.
    const second = { x: x0 + step, y, width, height };
    const room = atTarget ? undefined : r.dir === 1 ? [right(r.os), r.lo] : [r.hi, r.os.x];
    const ok = room !== undefined && room[1]! - room[0]! > 1 && second.x >= room[0]! && right(second) <= room[1]!;
    put(route, [{ x: x0, y, width, height }, ...(ok ? [second] : [])]);
  }

  // The tracks: each gap keeps clear the labels at its sides; the tracks share the rest. All the edges
  // into one gap (the side of the target's outer box) share one set of tracks, so no two get the same x.
  const channels = new Map<string, Run[]>();
  for (const r of runs) {
    const k = `${r.dir}:${Math.round(r.dir === 1 ? r.hi : r.lo)}`;
    channels.set(k, [...(channels.get(k) ?? []), r]);
  }
  for (const list of channels.values()) {
    const dir = list[0]!.dir;
    const lo = Math.max(...list.map((r) => r.lo));
    const hi = Math.min(...list.map((r) => r.hi));
    const mid = (lo + hi) / 2;
    let a = lo + (dir === 1 ? TRACK_IN : TRACK_OUT);
    let b = hi - (dir === 1 ? TRACK_OUT : TRACK_IN);
    for (const l of placed) {
      if (right(l) <= lo || l.x >= hi) continue;
      if (l.x + l.width / 2 < mid) a = Math.max(a, right(l) + 6);
      else b = Math.min(b, l.x - 6);
    }
    if (b - a < Math.min(TRACKS_MIN, (hi - lo) / 2)) {
      const w = Math.max(Math.min(TRACKS_MIN, hi - lo - 8), (hi - lo) * 0.3);
      a = mid - w / 2;
      b = mid + w / 2;
    }
    // One track for each edge, and one for each bundle (its trunk). From the source side: the units
    // that go down first (the lower source first), then the units that go up.
    const units = new Map<string, Run[]>();
    for (const r of list) units.set(r.bundle ?? `edge:${r.e.id}`, [...(units.get(r.bundle ?? `edge:${r.e.id}`) ?? []), r]);
    const mean = (xs: number[]) => xs.reduce((sum, v) => sum + v, 0) / xs.length;
    const items = [...units.values()].map((rs) => ({ rs, sy: mean(rs.map((r) => r.sy)), ty: mean(rs.map((r) => r.ty)) }));
    const down = items.filter((u) => u.ty > u.sy).sort((p, q) => q.sy - p.sy || q.ty - p.ty);
    const up = items.filter((u) => u.ty <= u.sy).sort((p, q) => p.sy - q.sy || p.ty - q.ty);
    const ranked = [...down, ...up];
    ranked.forEach((u, i) => {
      const f = (i + 0.5) / ranked.length;
      const x = dir === 1 ? a + f * (b - a) : b - f * (b - a);
      for (const r of u.rs) {
        const route = routes.get(r)!;
        route.track = x;
        const p0 = { x: r.dir === 1 ? right(r.s) : r.s.x, y: r.sy };
        const q0 = { x: r.dir === 1 ? r.t.x : right(r.t), y: r.ty };
        const pts = [p0, { x, y: p0.y }, { x, y: q0.y }, q0];
        route.points = pts.filter((p, j) => j === 0 || p.x !== pts[j - 1]!.x || p.y !== pts[j - 1]!.y);
      }
    });
  }

  // The label of each bundle: on the trunk, at the turn into the target (the top turn for a fan-out).
  for (const [k, list] of bundles) {
    const lead = routes.get(list[0]!)!;
    for (const r of list) routes.get(r)!.bundle = k;
    const text = opts.bundleText?.(list.map((r) => r.e));
    if (!text || lead.track === undefined) continue;
    const { width, height } = pillSize(text);
    const y = Math.min(...list.map((r) => r.ty)) - height / 2;
    const holder: CrossRoute = { points: [] };
    put(holder, [0, -1, 1, -2, 2].map((i) => ({ x: lead.track! - width / 2, y: y + i * (height + 4), width, height })));
    lead.bundleLabel = { text, box: holder.label!, ...(holder.hidden ? { hidden: true } : {}) };
  }

  // The totals: the label on the track, at the middle; it moves along the track rather than hide.
  for (const r of runs) {
    const route = routes.get(r)!;
    if (r.size && r.e.total && route.track !== undefined) {
      const { width, height } = r.size;
      const y = (r.sy + r.ty) / 2 - height / 2;
      put(route, [0, 1, -1, 2, -2, 3, -3].map((k) => ({ x: route.track! - width / 2, y: y + k * (height + 8), width, height })));
    }
    out.set(r.e.id, route);
  }
  return out;
}
