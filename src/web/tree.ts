// The tree of the canvas: the system view, and inside each open box the view of that box.
// The page has one canvas. To open a box is to draw its view inside the box; the other boxes stay.
//
// Each box on the canvas has a full ID: the node IDs from the system level to the box, joined
// with SEP ("project:shop-web§fn:…App()."). The same view can open in two places, so the node ID
// of a view is not unique on the canvas; the full ID is.
//
// An edge to a box of another view has `toPath`. The edge goes to the deepest box on that path
// that is on the canvas: a closed box stands for all the boxes inside it. A summary edge (an HTTP
// edge from a box) goes away when an edge from inside that box goes to the same end or into it.

import type { AtlasView, ViewEdge, ViewGroup, ViewNode } from '../server/view.js';

/** The separator of the parts of a full ID. */
export const SEP = '§';

/** leaf: no view to open. closed: it can open. loading: open, and its view is not here yet. open: the view is inside the box. */
export type BoxState = 'leaf' | 'closed' | 'loading' | 'open';

export interface TreeNode {
  fid: string;
  /** The full ID of the parent box on the canvas: a group or an open node. No value: the top level. */
  parent?: string;
  /** The full ID of the open node that holds this node. No value: the system level. */
  container?: string;
  node: ViewNode;
  state: BoxState;
  /** A collapsed group: this node stands for the group and all its members. */
  fold?: ViewGroup;
  /** The view inside the box, if the state is open. */
  view?: AtlasView;
  /** The number of boxes (open nodes and groups) that hold this node. */
  depth: number;
}

export interface TreeGroup {
  fid: string;
  parent?: string;
  container?: string;
  group: ViewGroup;
  depth: number;
  /** grid: the children sit in rows (no child is open). */
  grid: boolean;
  /** compact: the children are chips (the name only). */
  compact?: boolean;
}

export interface TreeEdge {
  id: string;
  from: string;
  to: string;
  kind: ViewEdge['kind'];
  label?: string;
  title?: string;
  role?: ViewEdge['role'];
  possible?: boolean;
  /** The endpoint IDs that the edge stands for (Features mode). */
  ends?: string[];
}

export interface Tree {
  /** Each parent comes before its children. */
  nodes: TreeNode[];
  groups: TreeGroup[];
  edges: TreeEdge[];
}

export const childId = (container: string | undefined, id: string): string => (container ? `${container}${SEP}${id}` : id);
export const groupId = (container: string | undefined, id: string): string => childId(container, `group:${id}`);

/** The full IDs of the open boxes that hold a box, top first. */
export function ancestors(fid: string): string[] {
  const parts = fid.split(SEP);
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join(SEP));
}

/** True if `inner` is inside the box `outer` (at any depth). */
export const inside = (inner: string, outer: string): boolean => inner.startsWith(`${outer}${SEP}`);

/**
 * The end of an edge with `toPath`: the deepest box on the path that is on the canvas. No value:
 * the first box of the path is not on the canvas.
 */
export function liftEnd(path: readonly string[], shown: ReadonlySet<string>, alias?: ReadonlyMap<string, string>): string | undefined {
  let best: string | undefined;
  for (let i = 0; i < path.length; i++) {
    const fid = childId(best, path[i]!);
    if (!shown.has(fid)) {
      // A member of a collapsed group: the edge goes to the collapsed group.
      const a = alias?.get(fid);
      if (a) best = a;
      break;
    }
    best = fid;
  }
  return best;
}

export interface TreeOptions {
  /** The full IDs of the collapsed groups. */
  fold?: ReadonlySet<string>;
  /** The full IDs of the compact groups: their members are chips. */
  compact?: ReadonlySet<string>;
}

/** A cell of the matrix: the HTTP calls from one project (a frontend) to another. Project keys. */
export interface CellFilter {
  from: string;
  to: string;
}

/**
 * The test of the filter of a matrix cell: a box is in the filter if it is one of the two projects or
 * in one of them. A group that is in no project (a lane) does not fade.
 */
export function cellTest(filter: CellFilter): (fid: string, group?: boolean) => boolean {
  const keys = new Set([`project:${filter.from}`, `project:${filter.to}`]);
  return (fid, group = false) => {
    const top = fid.split(SEP)[0]!;
    if (keys.has(top)) return true;
    return group && !top.startsWith('project:');
  };
}

/**
 * The view ID that a box opens. With a cell filter, the two projects of the cell open their cell
 * views: only the pages, functions and endpoints of those calls (see the server).
 */
export function viewIdOf(open: string, filter: CellFilter | undefined): string {
  if (!filter) return open;
  if (open === `project:${filter.from}`) return `${open}?to=${filter.to}`;
  if (open === `project:${filter.to}`) return `${open}?from=${filter.from}`;
  return open;
}

/**
 * The view ID of an open box with its pinned functions (picked search hits): `<id>?pin=fn:<id>,…`.
 * Only a project box takes pins.
 */
export function pinnedViewId(viewId: string, fid: string, pins: ReadonlySet<string> | undefined): string {
  if (!pins || pins.size === 0 || !viewId.startsWith('project:')) return viewId;
  const mine = [...pins].filter((p) => inside(p, fid) && !p.slice(fid.length + SEP.length).includes(SEP)).map((p) => p.slice(fid.length + SEP.length)).sort();
  return mine.length > 0 ? `${viewId}?pin=${mine.join(',')}` : viewId;
}

/** The text of a collapsed group: "25 libraries". */
export const foldText = (g: ViewGroup, n: number): string => {
  const [one, many] = g.noun ?? ['item', 'items'];
  return `${n} ${n === 1 ? one : many}`;
};

/** The note of an open box with an empty view: one node, so that the box is not empty. */
function noteNode(view: AtlasView): ViewNode {
  return { id: 'note', shape: 'more', label: view.notes[0] ?? 'This box is empty.' };
}

/**
 * The tree of the canvas. `views` gives the views that the page has (by view ID); `open` has the
 * full IDs of the open boxes. A box in `open` whose parent is not open is not on the canvas.
 */
export function buildTree(system: AtlasView, views: (id: string, fid: string) => AtlasView | undefined, open: ReadonlySet<string>, opts: TreeOptions = {}): Tree {
  const tree: Tree = { nodes: [], groups: [], edges: [] };
  const raw: Array<{ container?: string; edge: ViewEdge }> = [];
  /** A member of a collapsed group → the collapsed group. */
  const alias = new Map<string, string>();

  const visit = (view: AtlasView, container: string | undefined, depth: number) => {
    const nodes = view.nodes.length > 0 ? view.nodes : container ? [noteNode(view)] : [];
    const groups = new Map(view.groups.map((g) => [g.id, g]));
    const used = new Set(nodes.map((n) => n.group).filter((g): g is string => g !== undefined && groups.has(g)));
    // A grid group (the event handlers) becomes a plain group if one of its children is open.
    const openIn = (g: string) => nodes.some((n) => n.group === g && open.has(childId(container, n.id)) && n.open);
    const folded = new Set<string>();
    for (const g of view.groups) {
      if (!used.has(g.id)) continue;
      const gfid = groupId(container, g.id);
      if (opts.fold?.has(gfid)) {
        folded.add(g.id);
        const members = nodes.filter((n) => n.group === g.id);
        const node: ViewNode = { id: `group:${g.id}`, shape: 'fold', label: g.label, sub: foldText(g, members.length), tone: g.tone };
        tree.nodes.push({ fid: gfid, node, state: 'leaf', fold: g, depth: depth + 1, ...(container ? { parent: container, container } : {}) });
        for (const m of members) alias.set(childId(container, m.id), gfid);
        continue;
      }
      tree.groups.push({
        fid: gfid, group: g, depth: depth + 1, grid: g.layout === 'grid' && !openIn(g.id),
        ...(opts.compact?.has(gfid) ? { compact: true } : {}),
        ...(container ? { parent: container, container } : {}),
      });
    }
    for (const raw0 of nodes) {
      if (raw0.group !== undefined && folded.has(raw0.group)) continue;
      const fid = childId(container, raw0.id);
      const inGroup = raw0.group !== undefined && used.has(raw0.group);
      const compact = inGroup && opts.compact?.has(groupId(container, raw0.group!)) && !(raw0.open && open.has(fid));
      const n: ViewNode = compact ? { ...raw0, size: 'chip' } : raw0;
      const parent = inGroup ? groupId(container, n.group!) : container;
      const inner = n.open && open.has(fid) ? views(n.open, fid) : undefined;
      const state: BoxState = !n.open ? 'leaf' : !open.has(fid) ? 'closed' : inner ? 'open' : 'loading';
      const d = depth + (inGroup ? 2 : 1);
      tree.nodes.push({ fid, node: n, state, depth: d, ...(parent ? { parent } : {}), ...(container ? { container } : {}), ...(inner ? { view: inner } : {}) });
      if (inner) visit(inner, fid, d);
    }
    for (const e of view.edges) raw.push({ ...(container ? { container } : {}), edge: e });
  };
  visit(system, undefined, -1);

  const shown = new Set([...tree.nodes.map((n) => n.fid), ...tree.groups.map((g) => g.fid)]);
  const groupIds = new Set([...tree.groups.map((g) => g.fid), ...tree.nodes.filter((n) => n.fold).map((n) => n.fid)]);
  const endOf = (container: string | undefined, id: string) => {
    const g = groupId(container, id);
    if (groupIds.has(g)) return g;
    const fid = childId(container, id);
    return alias.get(fid) ?? fid;
  };
  const lifted: TreeEdge[] = [];
  for (const { container, edge: e } of raw) {
    const from = endOf(container, e.from);
    const to = e.toPath ? liftEnd(e.toPath, shown, alias) : endOf(container, e.to);
    if (!to || !shown.has(from) || !shown.has(to)) continue;
    // No edge from a box to itself, to a box inside it, or to a box that holds it.
    // A total in one group (Frontends → Frontends) stays: the page draws it as a loop.
    if ((from === to && e.role !== 'total') || inside(to, from) || inside(from, to)) continue;
    lifted.push({
      id: childId(container, e.id), from, to, kind: e.kind, ...(e.label ? { label: e.label } : {}), ...(e.title ? { title: e.title } : {}),
      ...(e.role ? { role: e.role } : {}), ...(e.possible ? { possible: true } : {}), ...(e.ends ? { ends: e.ends } : {}),
    });
  }
  // A summary edge goes away if an edge from inside its source goes to the same end, or into it.
  // The totals of the groups stay: the page shows them only when the zoom is small.
  const http = lifted.filter((e) => e.kind === 'http' && e.role !== 'total');
  const kept = lifted.filter((e) => e.kind !== 'http' || e.role === 'total' || !http.some((x) => inside(x.from, e.from) && (x.to === e.to || inside(x.to, e.to))));
  // The edges with the same ends, kind and role become one edge. A possible link stays apart from a sure one.
  const byEnds = new Map<string, TreeEdge[]>();
  for (const e of kept) {
    const k = `${e.from}>${e.to}:${e.kind}${e.role ? `:${e.role}` : ''}${e.possible ? ':possible' : ''}`;
    byEnds.set(k, [...(byEnds.get(k) ?? []), e]);
  }
  for (const [k, list] of byEnds) {
    const first = list[0]!;
    const ends = list.every((e) => e.ends) ? [...new Set(list.flatMap((e) => e.ends!))].sort() : undefined;
    // Edges with their endpoints: the label counts the endpoints once.
    const label = list.length > 1 && ends ? `${ends.length} endpoint${ends.length === 1 ? '' : 's'}` : joinLabels(list.map((e) => e.label));
    const title = [...new Set(list.map((e) => e.title).filter((t) => t !== undefined))].join('\n');
    tree.edges.push({
      id: list.length === 1 ? first.id : k, from: first.from, to: first.to, kind: first.kind, ...(label ? { label } : {}), ...(title ? { title } : {}),
      ...(first.role ? { role: first.role } : {}), ...(first.possible ? { possible: true } : {}), ...(ends ? { ends } : {}),
    });
  }
  return tree;
}

/** The label of edges that became one edge: the same label, the sum of the counts ("3 calls"), or the number of endpoints. */
export function joinLabels(labels: Array<string | undefined>): string | undefined {
  const set = [...new Set(labels.filter((l): l is string => l !== undefined))];
  const counts = labels.map((l) => (l === undefined ? undefined : /^(\d+) ([\w ]*?\w)s?$/.exec(l)));
  if (labels.length > 1 && counts.every((m) => m)) {
    const total = counts.reduce((sum, m) => sum + Number(m![1]), 0);
    const word = counts[0]![2]!;
    return `${total} ${word}${total === 1 ? '' : 's'}`;
  }
  if (set.length <= 1) return set[0];
  return `${set.length} endpoints`;
}

export type Mode = 'system' | 'features' | 'matrix' | 'tests';
export const MODES: readonly Mode[] = ['system', 'features', 'matrix', 'tests'];

/** The state of the page in the URL hash. */
export interface PageState {
  mode: Mode;
  open: Set<string>;
  /** The collapsed groups. No value: the defaults of the view (large groups of libraries start collapsed). */
  fold?: Set<string>;
  /** The compact groups. */
  compact: Set<string>;
  /** Show the import edges. */
  imports: boolean;
  /** A cell of the matrix: the two open projects show only the boxes of its calls. */
  filter?: CellFilter;
  /** The open test case (Tests mode). */
  case?: string;
  /** The current step of the player (an index, from 0). */
  step?: number;
  /** Show the test coverage badges (System and Features). */
  tests?: boolean;
  /** The query of the search lens: the map shows only the parts that fit it. */
  q?: string;
  /** The functions that a picked search hit shows as boxes in their project (full box IDs). */
  pin?: Set<string>;
}

const listOf = (hash: string, key: string): Set<string> | undefined => {
  const m = new RegExp(`[?&]${key}=([^&]*)`).exec(hash);
  if (!m) return undefined;
  if (m[1] === '') return new Set();
  return new Set(m[1]!.split(',').map((p) => { try { return decodeURIComponent(p); } catch { return ''; } }).filter((p) => p !== ''));
};
const listText = (key: string, set: ReadonlySet<string>) => `${key}=${[...set].sort().map((p) => encodeURIComponent(p)).join(',')}`;

/** The page state in the URL hash: `#/?mode=features&open=<id>,<id>&fold=<id>&compact=<id>&imports=1`. */
export function stateOfHash(hash: string): PageState {
  const mode = /[?&]mode=(\w+)/.exec(hash)?.[1];
  const fold = listOf(hash, 'fold');
  return {
    mode: MODES.includes(mode as Mode) ? (mode as Mode) : 'system',
    open: listOf(hash, 'open') ?? new Set(),
    ...(fold ? { fold } : {}),
    compact: listOf(hash, 'compact') ?? new Set(),
    imports: /[?&]imports=1(&|$)/.test(hash),
    ...filterOf(hash),
    ...caseOf(hash),
    ...(/[?&]tests=1(&|$)/.test(hash) ? { tests: true } : {}),
    ...queryOf(hash),
    ...((pin) => (pin && pin.size > 0 ? { pin } : {}))(listOf(hash, 'pin')),
  };
}

/** The lens query in the hash: `q=<query>` (URL-encoded). */
function queryOf(hash: string): { q?: string } {
  const m = /[?&]q=([^&]*)/.exec(hash);
  if (!m) return {};
  try {
    const q = decodeURIComponent(m[1]!).trim();
    return q === '' ? {} : { q };
  } catch {
    return {};
  }
}

/** The query with show:N (the "Show more" buttons of the lens): an old show: goes. */
export function withShow(query: string, n: number): string {
  return `${query.replace(/(^|\s)show:\S*/gi, ' ').replace(/\s+/g, ' ').trim()} show:${n}`.trim();
}

/** The query without one chip (its text in the query): the × of the chip. */
export function withoutChip(query: string, raw: string): string {
  const i = query.indexOf(raw);
  if (i < 0) return query;
  return `${query.slice(0, i)} ${query.slice(i + raw.length)}`.replace(/\s+/g, ' ').trim();
}

/** The test case and the step in the hash: `case=<id>&step=<n>`. */
function caseOf(hash: string): { case?: string; step?: number } {
  const m = /[?&]case=([^&]+)/.exec(hash);
  if (!m) return {};
  let id: string;
  try {
    id = decodeURIComponent(m[1]!);
  } catch {
    return {};
  }
  const step = Number(/[?&]step=(\d+)/.exec(hash)?.[1]);
  return { case: id, ...(Number.isFinite(step) ? { step } : {}) };
}

/** The cell filter in the hash: `filter=<from>><to>` (two project keys, URL-encoded). */
function filterOf(hash: string): { filter?: CellFilter } {
  const m = /[?&]filter=([^&>]+)>([^&]+)/.exec(hash);
  if (!m) return {};
  try {
    return { filter: { from: decodeURIComponent(m[1]!), to: decodeURIComponent(m[2]!) } };
  } catch {
    return {};
  }
}

export function hashOfState(s: PageState): string {
  const parts = [
    ...(s.q ? [`q=${encodeURIComponent(s.q)}`] : []),
    ...(s.mode !== 'system' ? [`mode=${s.mode}`] : []),
    ...(s.open.size > 0 ? [listText('open', s.open)] : []),
    ...(s.fold ? [listText('fold', s.fold)] : []),
    ...(s.compact.size > 0 ? [listText('compact', s.compact)] : []),
    ...(s.imports ? ['imports=1'] : []),
    ...(s.filter ? [`filter=${encodeURIComponent(s.filter.from)}>${encodeURIComponent(s.filter.to)}`] : []),
    ...(s.case ? [`case=${encodeURIComponent(s.case)}`] : []),
    ...(s.case && s.step !== undefined ? [`step=${s.step}`] : []),
    ...(s.tests ? ['tests=1'] : []),
    ...(s.pin && s.pin.size > 0 ? [listText('pin', s.pin)] : []),
  ];
  return parts.length === 0 ? '#/' : `#/?${parts.join('&')}`;
}

/** The open boxes in the URL hash: `#/?open=<id>,<id>`. Each ID is URL-encoded. */
export function openOfHash(hash: string): Set<string> {
  return stateOfHash(hash).open;
}

export function hashOfOpen(open: ReadonlySet<string>): string {
  return hashOfState({ mode: 'system', open: new Set(open), compact: new Set(), imports: false });
}

/** The groups that start collapsed: the groups with `fold` of the top view, and of the inner views (box ID, view) given. */
export function defaultFold(view: AtlasView | undefined, inner: ReadonlyArray<[string, AtlasView | undefined]> = []): Set<string> {
  const out = new Set((view?.groups ?? []).filter((g) => g.fold).map((g) => groupId(undefined, g.id)));
  for (const [box, v] of inner) for (const g of v?.groups ?? []) if (g.fold) out.add(groupId(box, g.id));
  return out;
}

/** Collapse or expand a group. */
export function toggleIn(set: ReadonlySet<string>, fid: string): Set<string> {
  const next = new Set(set);
  if (next.has(fid)) next.delete(fid);
  else next.add(fid);
  return next;
}

/**
 * The edges that the page draws. An import edge shows only if the reader asks for the imports, or
 * if one of its ends is the selected box (or inside it).
 */
export function visibleEdges<E extends { from: string; to: string; kind?: string; role?: TreeEdge['role'] | undefined }>(
  edges: readonly E[],
  o: { imports: boolean; selected?: string | undefined; parentOf?: ReadonlyMap<string, string | undefined> },
): E[] {
  const touches = (e: E) => o.selected !== undefined && [e.from, e.to].some((f) => f === o.selected || inside(f, o.selected!));
  const shown = edges.filter((e) => (e.role !== 'import' || o.imports || touches(e)) && (e.role !== 'detail' || touches(e)));
  // A sum edge (all the features of a frontend) goes away when an edge from one of its features shows.
  const under = (fid: string, box: string): boolean => {
    for (let f: string | undefined = fid; f !== undefined; f = o.parentOf?.get(f) ?? ancestors(f).at(-1)) if (f === box) return true;
    return false;
  };
  return shown.filter((e) => e.role !== 'sum' || !shown.some((x) => x !== e && x.role !== 'sum' && x.role !== 'total' && x.kind === 'http' && under(x.from, e.from)));
}

/**
 * The boxes that stay clear when a box has the focus: the box, the boxes inside it, the boxes at the
 * other end of its edges, and the boxes that hold them. `parentOf` gives the parent of each box.
 */
export function focusSet(edges: ReadonlyArray<Pick<TreeEdge, 'from' | 'to'>>, selected: string, parentOf: ReadonlyMap<string, string | undefined>): Set<string> {
  const out = new Set<string>([selected]);
  const add = (fid: string) => {
    for (let f: string | undefined = fid; f !== undefined && !out.has(f); f = parentOf.get(f)) out.add(f);
  };
  for (let p = parentOf.get(selected); p !== undefined; p = parentOf.get(p)) out.add(p);
  const mine = (f: string) => f === selected || inside(f, selected);
  for (const e of edges) {
    if (mine(e.from)) add(e.to);
    if (mine(e.to)) add(e.from);
  }
  return out;
}

/** Close a box: the boxes inside it close too. */
export function closeBox(open: ReadonlySet<string>, fid: string): Set<string> {
  return new Set([...open].filter((x) => x !== fid && !inside(x, fid)));
}

/** Open each box on a path of node IDs from the system level, but not the last one. It gives the full ID of the last one. */
export function openPath(open: ReadonlySet<string>, path: readonly string[]): { open: Set<string>; fid: string } {
  const next = new Set(open);
  let fid: string | undefined;
  for (let i = 0; i < path.length; i++) {
    fid = childId(fid, path[i]!);
    if (i < path.length - 1) next.add(fid);
  }
  return { open: next, fid: fid ?? '' };
}
