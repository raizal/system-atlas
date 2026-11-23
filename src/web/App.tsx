// The atlas page. One canvas. To open a box is to draw its inner process inside the box:
// the box grows into a container, and the layout moves the other boxes aside. The URL hash keeps
// the set of open boxes, so a reload or a link shows the same canvas. A click selects a box: the
// strip shows its path of open boxes, and the panel shows its file, notes and links.
//
// The page loads the view of a box only when the reader opens it, and keeps each view it loaded.
//
// Four modes, a switch in the bar (in the hash too): System (all projects in lanes), Features (the
// pages of each frontend in features, and the endpoints that they reach), Matrix (frontends × APIs),
// Tests (the e2e cases: the steps of one case as a flow chart, the parts of the map that it touches,
// and a player that walks through the steps).

import { Background, BackgroundVariant, Controls, MarkerType, ReactFlow, ReactFlowProvider, useReactFlow, useStore, type Edge, type Node } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AtlasInfo, AtlasView, LensInfo, Matrix, NodeInfo, SearchHit, ViewEdge, ViewNode } from '../server/view.js';
import type { AreaHow, AreaItem, AreaLayer, CaseInfo, CaseTouch, Coverage, PlayStep, RunStatus, TestsInfo } from '../tests/types.js';
import { api } from './api.js';
import { edgeTypes, type ElkEdgeData } from './edge.js';
import { absolute, clampView, firstView, fitView, lensFirstView, focusView, layoutTree, MIN_FOCUS_ZOOM, nudgeView, routeCross, visibleArea, shortLabel, sizeOf, unionBox, type CrossEdge, type Layout, type PlacedEdge } from './layout.js';
import { nodeTypes, toneOf, type AtlasNodeData, type GroupData, type NodeBadge } from './nodes.js';
import {
  ancestors, buildTree, pinnedViewId, cellTest, closeBox, defaultFold, focusSet, groupId, hashOfState, inside, joinLabels, MODES, openPath, stateOfHash, toggleIn, viewIdOf, visibleEdges, withoutChip, withShow,
  type CellFilter, type Mode, type PageState, type Tree, type TreeEdge, type TreeNode,
} from './tree.js';

type Placed = { tree: Tree; layout: Layout };
/** What the camera does after the next layout. */
type Intent = { kind: 'first' } | { kind: 'expand'; fid: string } | { kind: 'select'; fid: string } | { kind: 'fit'; fids: string[] };

/** The width of the side panel and its margin: the camera keeps the boxes left of it. */
const PANEL_W = 344;

export function App() {
  return (
    <ReactFlowProvider>
      <Atlas />
    </ReactFlowProvider>
  );
}

/** The state of the page (the mode, the open boxes, the collapsed groups), in the URL hash. */
function usePage(): [PageState, (next: PageState) => void] {
  const [page, setPage] = useState(() => stateOfHash(window.location.hash));
  useEffect(() => {
    const on = () => setPage(stateOfHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const set = useCallback((next: PageState) => {
    window.history.replaceState(null, '', hashOfState(next));
    setPage(next);
  }, []);
  return [page, set];
}

/** The view at the top of each mode. */
const ROOT_VIEW: Record<Mode, string> = { system: 'system', features: 'features', matrix: 'system', tests: 'system' };
const MODE_TITLE: Record<Mode, string> = { system: 'System', features: 'Features', matrix: 'Matrix', tests: 'Tests' };
/** The time of one step of the player at speed 1, in ms. */
const STEP_MS = 1200;
/** The least zoom of the camera of the player: below it, the step and its map target do not show together. */
const PLAY_ZOOM = 0.45;
const SPEEDS = [0.5, 1, 2, 4] as const;
/** The shapes that always show a "Test cases" section in the panel (also with no case). */
const COVERED: ReadonlySet<string> = new Set(['page', 'endpoint', 'route']);
/** The shapes that take the focus when the reader selects them: the other boxes fade. */
const FOCUS: ReadonlySet<string> = new Set(['project', 'store', 'feature', 'page', 'endpoint', 'route', 'fold']);
/** Below this zoom, the canvas shows the groups, the large projects and the totals of the groups. */
const FAR_ZOOM = 0.6;
/** An open box comes into view with the heads of the boxes that hold it, if they are this near above it (px). */
const HEAD_ROOM = 160;

const failed = (id: string, e: unknown): AtlasView => ({
  ok: false, level: 'flow', id, title: id, groups: [], nodes: [], edges: [], notes: [`This box did not load: ${e instanceof Error ? e.message : String(e)}`],
});

/**
 * A function hit in a project ([project, fn]): the function is pinned, so its project box shows it as a
 * box in the "code" group, and its + opens its flow chart.
 */
function pinOf(pins: ReadonlySet<string> | undefined, path: readonly string[], fid: string): { pin?: Set<string> } {
  if (path.length !== 2 || !path[0]!.startsWith('project:') || !path[1]!.startsWith('fn:')) return pins ? { pin: new Set(pins) } : {};
  return { pin: new Set(pins).add(fid) };
}

function Atlas() {
  const [page, setPage] = usePage();
  const open = page.open;
  const setOpen = useCallback((next: Set<string>) => setPage({ ...page, open: next }), [page, setPage]);
  const [info, setInfo] = useState<AtlasInfo>();
  const [views, setViews] = useState<ReadonlyMap<string, AtlasView>>(new Map());
  const [error, setError] = useState<string>();
  const [placed, setPlaced] = useState<Placed>();
  const [selected, setSelected] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const asked = useRef(new Set<string>());
  const intent = useRef<Intent | undefined>({ kind: 'first' });
  const flow = useReactFlow();
  const box = useRef<HTMLElement>(null);

  useEffect(() => {
    void api.info().then(setInfo, () => undefined);
  }, []);

  const load = useCallback((id: string) => {
    if (asked.current.has(id)) return;
    asked.current.add(id);
    api.view(id).then(
      (v) => setViews((m) => new Map(m).set(id, v)),
      (e: unknown) => (id === 'system' || id === 'features' || id.startsWith('case:') || id.startsWith('lens:') ? setError(e instanceof Error ? e.message : String(e)) : setViews((m) => new Map(m).set(id, failed(id, e)))),
    );
  }, []);

  // The Tests mode: the list of the cases, or one case (the case view: its flow chart and the parts of the map that it touches).
  const caseId = page.mode === 'tests' ? page.case : undefined;
  const list = page.mode === 'tests' && !caseId;
  // The search lens: the map shows only the parts that fit the query (System mode).
  const lensId = page.q && page.mode === 'system' ? `lens:${page.q}` : undefined;
  const rootId = lensId ?? (caseId ? `case:${caseId}` : ROOT_VIEW[page.mode]);
  useEffect(() => load(rootId), [load, rootId]);
  const [testsInfo, setTestsInfo] = useState<TestsInfo>();
  useEffect(() => {
    if (page.mode !== 'tests' || testsInfo) return;
    void api.tests().then(setTestsInfo, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [page.mode, testsInfo]);
  const [caseInfo, setCaseInfo] = useState<CaseInfo>();
  useEffect(() => {
    setCaseInfo(undefined);
    if (!caseId) return;
    let live = true;
    void api.case(caseId).then((c) => live && setCaseInfo(c), (e: unknown) => live && setNotice(`The case did not load: ${e instanceof Error ? e.message : String(e)}`));
    return () => {
      live = false;
    };
  }, [caseId]);
  const showCover = page.tests === true && (page.mode === 'system' || page.mode === 'features');
  // The coverage: the badges (the Tests toggle), the "Test cases" section of the panel, the list.
  const [coverage, setCoverage] = useState<Coverage>();
  useEffect(() => {
    if (page.mode === 'matrix' || coverage) return;
    void api.coverage().then(setCoverage, () => undefined);
  }, [page.mode, coverage]);

  const system = views.get(rootId);
  // The flow chart of a case is a box inside the case view: its fixture setup starts collapsed too.
  const flowView = caseId ? views.get(`caseflow:${caseId}`) : undefined;
  const fold = useMemo(() => page.fold ?? defaultFold(system, caseId ? [[`flow:${caseId}`, flowView]] : []), [page.fold, system, caseId, flowView]);
  const tree = useMemo(
    () => (system && page.mode !== 'matrix' && !list ? buildTree(system, (id, fid) => views.get(pinnedViewId(viewIdOf(id, page.filter), fid, page.pin)), open, { fold, compact: page.compact }) : undefined),
    [system, views, open, fold, page.compact, page.mode, page.filter, page.pin, list],
  );
  const byFid = useMemo(() => new Map((tree?.nodes ?? []).map((n) => [n.fid, n])), [tree]);
  const loading = tree?.nodes.some((n) => n.state === 'loading') ?? true;

  // Load the view of each open box that has no view yet.
  useEffect(() => {
    for (const n of tree?.nodes ?? []) if (n.state === 'loading' && n.node.open) load(pinnedViewId(viewIdOf(n.node.open, page.filter), n.fid, page.pin));
  }, [tree, load, page.filter, page.pin]);

  // The layout of the whole tree. Only the last layout counts.
  useEffect(() => {
    if (!tree) return;
    let live = true;
    void layoutTree(tree).then(
      (layout) => live && setPlaced({ tree, layout }),
      (e: unknown) => live && setError(`The layout failed: ${e instanceof Error ? e.message : String(e)}`),
    );
    return () => {
      live = false;
    };
  }, [tree]);

  const toggle = useCallback(
    (fid: string) => {
      if (open.has(fid)) {
        setOpen(closeBox(open, fid));
        if (selected && selected.startsWith(`${fid}§`)) setSelected(fid);
        return;
      }
      intent.current = { kind: 'expand', fid };
      setOpen(new Set(open).add(fid));
    },
    [open, setOpen, selected],
  );

  /** Open each box on a path of node IDs from the system level, then select the last one. Search works in System mode. */
  const reveal = useCallback(
    (path: string[]) => {
      if (path.length === 0) return;
      const toSystem = page.mode === 'matrix';
      const next = openPath(toSystem ? new Set() : open, path);
      setNotice(undefined);
      intent.current = { kind: 'select', fid: next.fid };
      // A member of a collapsed group: expand the group.
      const top = (toSystem ? views.get('system') : system)?.nodes.find((n) => n.id === path[0]);
      const g = top?.group !== undefined ? groupId(undefined, top.group) : undefined;
      const f = page.fold ?? defaultFold(toSystem ? views.get('system') : system);
      setPage({ ...page, mode: toSystem ? 'system' : page.mode, open: next.open, ...pinOf(page.pin, path, next.fid), ...(g && f.has(g) ? { fold: toggleIn(f, g) } : {}) });
    },
    [open, page, setPage, system, views],
  );

  /** Search finds the boxes of the System view: the search goes to System mode. */
  const searchPick = useCallback(
    (path: string[]) => {
      if (page.mode === 'system' && !page.q) return reveal(path);
      const next = openPath(new Set(), path);
      setNotice(undefined);
      setSelected(undefined);
      intent.current = { kind: 'select', fid: next.fid };
      const sys = views.get('system');
      const top = sys?.nodes.find((n) => n.id === path[0]);
      const g = top?.group !== undefined ? groupId(undefined, top.group) : undefined;
      const f = page.fold ?? defaultFold(sys);
      const { q: _q, ...rest } = page;
      setPage({ ...rest, mode: 'system', open: next.open, ...pinOf(page.pin, path, next.fid), ...(g && f.has(g) ? { fold: toggleIn(f, g) } : {}) });
    },
    [page, reveal, setPage, views],
  );

  const setMode = useCallback(
    (mode: Mode) => {
      if (mode === page.mode && !(mode === 'tests' && page.case) && !page.q) return;
      setSelected(undefined);
      setNotice(undefined);
      setError(undefined);
      intent.current = { kind: 'first' };
      const { filter: _, case: _c, step: _s, q: _q, pin: _p, ...rest } = page;
      setPage({ ...rest, mode, open: new Set() });
    },
    [page, setPage],
  );

  /** The search lens: redraw the map with only the parts that fit the query. An empty query: the whole map. */
  const setLens = useCallback(
    (query: string) => {
      setSelected(undefined);
      setNotice(undefined);
      setError(undefined);
      intent.current = { kind: 'first' };
      const { filter: _, case: _c, step: _s, fold: _f, q: _q, pin: _p, ...rest } = page;
      const q = query.trim();
      setPage({ ...rest, mode: 'system', open: new Set(), ...(q ? { q } : {}) });
    },
    [page, setPage],
  );

  /** Open a test case in the Tests mode: its flow chart is open, and the player is before the first step. */
  const openCase = useCallback(
    (id: string) => {
      setSelected(undefined);
      setNotice(undefined);
      setError(undefined);
      intent.current = { kind: 'first' };
      const { filter: _, step: _s, fold: _f, ...rest } = page;
      setPage({ ...rest, mode: 'tests', case: id, open: new Set([`flow:${id}`]) });
    },
    [page, setPage],
  );
  const steps = useMemo(() => (caseInfo?.ok ? caseInfo.steps : []), [caseInfo]);
  const cur = caseId && steps.length > 0 ? Math.min(page.step ?? -1, steps.length - 1) : -1;
  const setStep = useCallback((n: number) => setPage({ ...page, step: Math.max(0, n) }), [page, setPage]);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  // Play: one step each STEP_MS / speed, until the last step.
  useEffect(() => {
    if (!playing) return;
    if (cur >= steps.length - 1) return setPlaying(false);
    const t = setTimeout(() => setStep(cur + 1), STEP_MS / speed);
    return () => clearTimeout(t);
  }, [playing, cur, steps.length, speed, setStep]);
  useEffect(() => setPlaying(false), [caseId]);

  /** Collapse or expand a group; make a group compact or not. */
  const onFold = useCallback((fid: string) => {
    setSelected((s) => (s && (s === fid || inside(s, fid)) ? undefined : s));
    setPage({ ...page, fold: toggleIn(fold, fid) });
  }, [page, fold, setPage]);
  const onCompact = useCallback((fid: string) => setPage({ ...page, compact: toggleIn(page.compact, fid) }), [page, setPage]);

  /** A cell of the matrix: System mode, the two projects open, the frontend selected. */
  const pickCell = useCallback(
    (row: string, col: string) => {
      const sys = views.get('system');
      const ids = [`project:${row}`, `project:${col}`];
      let f = page.fold ?? defaultFold(sys);
      for (const id of ids) {
        const g = sys?.nodes.find((n) => n.id === id)?.group;
        if (g !== undefined && f.has(groupId(undefined, g))) f = toggleIn(f, groupId(undefined, g));
      }
      setNotice(undefined);
      intent.current = { kind: 'fit', fids: ids };
      setPage({ ...page, mode: 'system', open: new Set(ids.filter((id) => sys?.nodes.some((n) => n.id === id && n.open))), fold: f, filter: { from: row, to: col } });
    },
    [page, setPage, views],
  );
  const clearFilter = useCallback(() => {
    const { filter: _, ...rest } = page;
    setPage(rest);
  }, [page, setPage]);

  const target = useCallback((_: string, n: ViewNode) => n.target && reveal(n.target), [reveal]);

  const parentOf = useMemo(() => new Map(placed ? [...placed.layout.groups, ...placed.layout.nodes].map((b) => [b.id, b.parent]) : []), [placed]);
  // The edges that show: the import edges only for "Show imports" or the selected box; the edges of
  // one feature only when it is selected. The page routes only the edges that show.
  const flowOf = useMemo(() => {
    if (!placed) return { nodes: [], edges: [] };
    const keep = new Set(visibleEdges(placed.tree.edges, { imports: page.imports, selected, parentOf }).map((e) => e.id));
    // The Tests mode shows all the links of the case.
    if (page.mode === 'tests') for (const e of placed.tree.edges) keep.add(e.id);
    return toFlow(placed.tree, placed.layout, { onToggle: toggle, onTarget: target, onFold, onCompact, compact: page.compact, keep, intoGroup: page.mode === 'tests' ? 'http' : lensId ? 'all' : undefined });
  }, [placed, toggle, target, onFold, onCompact, page.compact, page.imports, page.mode, selected, parentOf, lensId]);

  // The player: the current step and its targets are lit, the earlier steps stay a little lit, the rest fades.
  const play = useMemo(() => {
    if (!caseId || cur < 0) return undefined;
    const flowFid = `flow:${caseId}`;
    // A step in a collapsed group (the fixture setup) lights the group box.
    const groupOf = new Map((flowView?.nodes ?? []).filter((n) => n.group).map((n) => [n.id, n.group!]));
    const fidOf = (s: PlayStep) => {
      const g = groupOf.get(`step:${s.id}`);
      const gfid = g ? groupId(flowFid, g) : undefined;
      return gfid && fold.has(gfid) ? gfid : `${flowFid}§step:${s.id}`;
    };
    const state = new Map<string, 'lit' | 'played'>();
    for (let i = 0; i < cur; i++) {
      state.set(fidOf(steps[i]!), 'played');
      for (const t of steps[i]!.targets) state.set(t.node, 'played');
    }
    const now = steps[cur]!;
    // The page of the last goto stays lit until the next goto: the steps between happen on it.
    let page: string | undefined;
    for (let i = cur; i >= 0; i--) {
      const pages = steps[i]!.targets.filter((t) => t.kind === 'page');
      if (steps[i]!.kind !== 'goto' || pages.length === 0) continue;
      for (const t of pages) state.set(t.node, 'lit');
      page = pages[0]!.node;
      break;
    }
    state.set(fidOf(now), 'lit');
    for (const t of now.targets) state.set(t.node, 'lit');
    const played = new Set(steps.slice(0, cur).flatMap((s) => s.edges));
    return { flowFid, state, live: new Set(now.edges), played, step: now, ...(page ? { page } : {}) };
  }, [caseId, cur, steps, flowView, fold]);
  // The marks on the boxes: a mock and the result of each step (Tests mode), the count of test cases (coverage).
  const badges = useMemo(() => {
    const out = new Map<string, NodeBadge[]>();
    const add = (fid: string, b: NodeBadge) => {
      const l = out.get(fid) ?? [];
      if (!l.some((x) => x.kind === b.kind)) out.set(fid, [...l, b]);
    };
    if (caseId) {
      steps.forEach((s, i) => {
        const fid = `flow:${caseId}§step:${s.id}`;
        // In the player, a result shows when the step has played.
        const shown = cur < 0 || i <= cur;
        if (s.failed && shown) add(fid, { kind: 'fail', text: '✗', title: 'The last run failed at this step.' });
        else if (s.passed && s.kind === 'assert' && shown) add(fid, { kind: 'pass', text: '✓', title: 'The last run passed this assert.' });
        if (s.kind === 'mock') add(fid, { kind: 'mock', text: 'mock', title: 'The test answers this request itself (page.route).' });
        for (const t of s.targets) if (t.mock) add(t.node, { kind: 'mock', text: 'mock', title: 'The test mocks this endpoint: the real one does not run.' });
      });
    }
    if (showCover && coverage && placed) {
      for (const n of placed.tree.nodes) {
        // Pages, endpoints, components and handlers: the cases that touch the box.
        const k = touchesOf(coverage, n.node).length;
        if (k > 0) add(n.fid, { kind: 'cover', text: `${k}`, title: `${k} test case${k === 1 ? '' : 's'}. Click to see the list.`, onClick: () => setSelected(n.fid) });
        else if (n.node.shape === 'page') add(n.fid, { kind: 'none', text: '0', title: 'No test case opens this page.' });
      }
    }
    return out;
  }, [caseId, steps, cur, showCover, coverage, placed]);

  // A cross-box edge is faint. It has full strength if the pointer is on an end, or on a box that
  // holds an end, or if that box is the selection.
  const [hot, setHot] = useState<string | undefined>();
  // The focus: a selected project, feature, page or endpoint keeps its neighbours clear; the rest fades.
  const selNode = selected ? flowOf.nodes.find((n) => n.id === selected) : undefined;
  const focus = selNode && selNode.type !== 'group' && FOCUS.has((selNode.data as AtlasNodeData).node.shape) ? selected : undefined;
  const shownEdges = flowOf.edges;
  const clear = useMemo(() => {
    if (!focus) return undefined;
    const set = focusSet(shownEdges.filter((e) => (e.data as ElkEdgeData).role !== 'total').map((e) => ({ from: e.source, to: e.target })), focus, parentOf);
    return (fid: string) => set.has(fid) || inside(fid, focus);
  }, [focus, shownEdges, parentOf]);
  // The filter of a matrix cell: the boxes and the links out of its two projects fade.
  const cell = page.mode === 'system' ? page.filter : undefined;
  const inCell = useMemo(() => (cell ? cellTest(cell) : undefined), [cell]);
  // The main chain of a lens (the best seed and its chain): lit, and its links solid.
  const mainIds = system?.lens?.main;
  const main = useMemo(() => (lensId && mainIds && mainIds.length > 1 ? new Set(mainIds) : undefined), [lensId, mainIds]);
  const nodes = useMemo(() => {
    const dimmed0 = clear || inCell ? flowOf.nodes.map((n) => ((!clear || clear(n.id)) && (!inCell || inCell(n.id, n.type === 'group')) ? n : { ...n, className: 'dim' })) : flowOf.nodes;
    const dimmed = main ? dimmed0.map((n) => (main.has(n.id) ? { ...n, className: [n.className, 'lit', 'lens-main'].filter(Boolean).join(' ') } : n)) : dimmed0;
    if (!play && badges.size === 0) return dimmed;
    return dimmed.map((n) => {
      if (n.type === 'group') return n;
      const b = badges.get(n.id);
      // The start and the end of the flow chart keep their full strength.
      const ends = (n.data as AtlasNodeData).node.shape === 'start' || (n.data as AtlasNodeData).node.shape === 'end';
      const st = play && !ends ? (play.state.get(n.id) ?? (n.id === play.flowFid ? undefined : 'dim')) : undefined;
      if (!b && !st) return n;
      const cls = [n.className, st === 'lit' ? 'lit' : st === 'played' ? 'played' : st === 'dim' ? 'faded' : undefined].filter(Boolean).join(' ');
      return { ...n, ...(cls ? { className: cls } : {}), data: { ...(n.data as AtlasNodeData), ...(b ? { badges: b } : {}), ...(st ? { play: st } : {}) } };
    });
  }, [flowOf, clear, inCell, play, badges, main]);
  const edges = useMemo(() => {
    const marks = new Set([hot, selected].filter((x): x is string => x !== undefined));
    const holds = (fid: string) => {
      for (let f: string | undefined = fid; f !== undefined; f = parentOf.get(f)) if (marks.has(f)) return true;
      return false;
    };
    const mine = (fid: string) => focus !== undefined && (fid === focus || inside(fid, focus));
    // A bundle with one marked edge keeps its label; the marked edge is solid, on top of the others.
    const isOn = (e: Edge) => (focus ? mine(e.source) || mine(e.target) : holds(e.source) || holds(e.target));
    const live = new Set(shownEdges.filter((e) => (e.data as ElkEdgeData).bundle && isOn(e)).map((e) => (e.data as ElkEdgeData).bundle));
    const lift = (e: Edge, d: ElkEdgeData, on: boolean): Partial<Edge> =>
      on && d.bundle ? { zIndex: (e.zIndex ?? 0) + 2, style: { ...e.style, strokeDasharray: 'none' } } : {};
    return shownEdges.map((e) => {
      const d = e.data as ElkEdgeData;
      // The player: the link of the current step moves; the links of the earlier steps stay; the rest fades.
      if (play && !inside(e.id, play.flowFid)) {
        if (play.live.has(e.id)) return { ...e, className: 'edge-live', zIndex: (e.zIndex ?? 0) + 3, data: { ...d, faint: false, live: true }, style: { ...e.style, opacity: 1, strokeWidth: 2.6 } };
        if (play.played.has(e.id)) return { ...e, data: { ...d, faint: false }, style: { ...e.style, opacity: 0.6 } };
        return { ...e, data: { ...d, faint: true, dim: true }, style: { ...e.style, opacity: DIM_EDGE } };
      }
      // Out of the filter: almost gone, and no label.
      if (inCell && d.role !== 'total' && !(inCell(e.source) && inCell(e.target))) {
        return { ...e, data: { ...d, faint: true, dim: true }, style: { ...e.style, opacity: DIM_EDGE } };
      }
      const bundleOn = d.bundle !== undefined && live.has(d.bundle);
      if (focus && d.role !== 'total') {
        const on = isOn(e);
        const op = on ? 1 : DIM_EDGE;
        const l = lift(e, d, on);
        return { ...e, ...l, data: { ...d, faint: !on, ...(on ? {} : { dim: true }), bundleOn }, style: { ...e.style, ...l.style, opacity: d.possible ? op * POSSIBLE : op } };
      }
      if (main && main.has(e.source) && main.has(e.target) && !focus) {
        return { ...e, className: 'edge-main', zIndex: (e.zIndex ?? 0) + 2, data: { ...d, faint: false }, style: { ...e.style, opacity: 1, strokeWidth: 2.4, strokeDasharray: 'none' } };
      }
      if (!d.cross) return e;
      const on = isOn(e);
      const op = on ? 1 : FAINT;
      const l = lift(e, d, on);
      return { ...e, ...l, data: { ...d, faint: !on, bundleOn }, style: { ...e.style, ...l.style, opacity: d.possible ? op * POSSIBLE : op } };
    });
  }, [shownEdges, hot, selected, parentOf, focus, inCell, play, main]);
  const far = useStore((st) => st.transform[2] < FAR_ZOOM);

  /** The part of the canvas that the reader sees: left of the side panel when the panel is open. */
  const area = useCallback((panel: boolean) => {
    const { width, height } = box.current!.getBoundingClientRect();
    return visibleArea(width, height, panel ? PANEL_W : 0);
  }, []);
  /** The camera already shows the box that the page selects: the effect of the selection does not move it again. */
  const placedBySelf = useRef(false);
  /** Pan the least so that all of the box shows left of the panel; a box in view does not move the camera. */
  const nudge = useCallback(
    (fid: string, minZoom = 0) => {
      const b = placed && absolute(placed.layout).get(fid);
      if (!b || !box.current) return;
      const now = flow.getViewport();
      const { w, h } = area(true);
      const next = nudgeView(b, { ...now, zoom: Math.max(now.zoom, minZoom) }, w, h);
      if (next.x !== now.x || next.y !== now.y || next.zoom !== now.zoom) void flow.setViewport(next, { duration: 300 });
    },
    [placed, flow, area],
  );
  // The player: the camera shows the step and its targets on the map (or the lit page) together. If they
  // do not fit at a readable zoom, the map target wins: the bar of the player shows the text of the step.
  useEffect(() => {
    if (!play || !placed || intent.current || !box.current) return;
    const stepFid = `${play.flowFid}§step:${play.step.id}`;
    const onMap = play.step.targets.map((x) => x.node).filter((f) => byFid.has(f));
    const map = onMap.length > 0 ? onMap : play.page && byFid.has(play.page) ? [play.page] : [];
    const abs = absolute(placed.layout);
    const all = unionBox([stepFid, ...map].map((f) => abs.get(f)).filter((b): b is NonNullable<typeof b> => b !== undefined));
    requestAnimationFrame(() => {
      const { w, h } = area(true);
      const now = flow.getViewport();
      if (all && nudgeView(all, now, w, h) === now) return;
      const v = all && fitView(all, w, h, PLAY_ZOOM);
      if (v) void flow.setViewport(v, { duration: 300 });
      else nudge(map[0] ?? stepFid, MIN_FOCUS_ZOOM);
    });
    // Only a new step moves the camera: not a new layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play?.step]);

  // A new selection (a click, the strip, Escape) moves the camera only if the box is not all in view.
  useEffect(() => {
    if (!selected) return;
    if (placedBySelf.current) {
      placedBySelf.current = false;
      return;
    }
    if (intent.current) return;
    requestAnimationFrame(() => nudge(selected));
    // Only a new selection moves the camera: not a new layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // The camera: the first view shows the whole canvas; an open box comes into view with the boxes
  // near it, at the top; a found box comes into view left of the panel. To close a box does not move
  // the camera. Each fit and pan uses only the part of the canvas left of the side panel, when it is open.
  useEffect(() => {
    const want = intent.current;
    if (!placed || !want || !box.current || placed.tree !== tree) return;
    const { width, height } = box.current.getBoundingClientRect();
    const where = absolute(placed.layout);
    if (want.kind === 'first') {
      if (loading) return;
      intent.current = undefined;
      const layout = placed.layout;
      const fit = () => {
        const r = box.current?.getBoundingClientRect() ?? { width, height };
        return lensId ? lensFirstView(layout, r.width, r.height) : firstView(layout, r.width, r.height);
      };
      const first = fit();
      requestAnimationFrame(() => void flow.setViewport(first));
      // The bars above the canvas can change its size after the first paint (the lens bar, the strip):
      // set the first view again, if the reader did not move the camera.
      window.setTimeout(() => {
        const now = flow.getViewport();
        if (Math.abs(now.x - first.x) > 1 || Math.abs(now.y - first.y) > 1 || Math.abs(now.zoom - first.zoom) > 0.001) return;
        void flow.setViewport(fit());
      }, 250);
      return;
    }
    if (want.kind === 'expand') {
      const n = byFid.get(want.fid);
      if (n?.state === 'loading') return;
      intent.current = undefined;
      const b = where.get(want.fid);
      if (!b) return;
      // The open box and the boxes at the other end of its links, if they fit at the least zoom; else the open box.
      const mine = (f: string) => f === want.fid || inside(f, want.fid);
      const ends = placed.tree.edges
        .filter((e) => e.role !== 'import' && e.role !== 'total' && e.role !== 'detail' && mine(e.from) !== mine(e.to))
        .map((e) => where.get(mine(e.from) ? e.to : e.from))
        .filter((x): x is NonNullable<typeof x> => x !== undefined);
      // The heads of the group and the box that hold the open box, if they are near: the reader sees where it is.
      const heads: Array<{ x: number; y: number; width: number; height: number }> = [];
      for (let p = parentOf.get(want.fid), up = 0; p !== undefined && up < 2; p = parentOf.get(p), up++) {
        const pb = where.get(p);
        if (!pb || b.y - pb.y > HEAD_ROOM) break;
        heads.push({ x: b.x, y: pb.y, width: b.width, height: 1 });
      }
      const all = unionBox([b, ...heads, ...ends])!;
      const { w, h } = area(selected !== undefined);
      const view = fitView(all, w, h, MIN_FOCUS_ZOOM) ?? fitView(unionBox([b, ...heads])!, w, h, MIN_FOCUS_ZOOM) ?? focusView(unionBox([b, ...heads])!, w, h);
      requestAnimationFrame(() => void flow.setViewport(view, { duration: 300 }));
      return;
    }
    if (want.kind === 'fit') {
      // Wait until each box is on the canvas and its view is here.
      if (want.fids.some((f) => byFid.get(f)?.state === 'loading')) return;
      intent.current = undefined;
      const boxes = want.fids.map((f) => where.get(f)).filter((x): x is NonNullable<typeof x> => x !== undefined);
      const all = unionBox(boxes);
      const pick = want.fids[0] && byFid.has(want.fids[0]) ? want.fids[0] : undefined;
      if (pick) {
        if (pick !== selected) placedBySelf.current = true;
        setSelected(pick);
      }
      if (!all) return;
      // A fit is never below the least zoom: the boxes must stay readable.
      const { w, h } = area(pick !== undefined || selected !== undefined);
      const view = clampView(all, w, h, MIN_FOCUS_ZOOM);
      requestAnimationFrame(() => void flow.setViewport(view, { duration: 300 }));
      return;
    }
    // select: wait until the box is on the canvas, or until no box loads.
    let fid: string | undefined = want.fid;
    if (!byFid.has(fid)) {
      if (loading) return;
      fid = [...ancestors(want.fid)].reverse().find((a) => byFid.has(a));
      setNotice(fid ? 'The canvas does not show this item as a box. The page selected the box that holds it.' : 'The canvas does not show this item.');
    }
    intent.current = undefined;
    if (!fid) return;
    if (fid !== selected) placedBySelf.current = true;
    setSelected(fid);
    const found = fid;
    // A found box: readable (zoom 0.8 or more), and all in view left of the panel.
    requestAnimationFrame(() => nudge(found, 0.8));
  }, [placed, tree, loading, byFid, flow, selected, area, nudge, lensId, parentOf]);

  /** Select a box and bring it into view left of the panel (the least pan). The zoom does not change. */
  const panTo = useCallback(
    (fid: string) => {
      if (fid === selected) nudge(fid);
      else setSelected(fid);
    },
    [selected, nudge],
  );

  // Escape closes the deepest open box that holds the selection (or the selection, if it is open).
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !selected) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const holder = [...ancestors(selected), selected].reverse().find((f) => open.has(f));
      // No open box holds the selection: Escape clears the selection and the focus.
      if (!holder) return setSelected(undefined);
      setOpen(closeBox(open, holder));
      setSelected(holder);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [selected, open, setOpen]);

  const sel = selected ? byFid.get(selected) : undefined;
  const ready = placed !== undefined && placed.tree === tree && !loading;
  return (
    <div className="app">
      <header className="bar">
        <div className="brand">
          <span className="logo">◈</span> atlas <span className="root">{info?.name}</span>
        </div>
        <nav className="modes" aria-label="Mode">
          {MODES.map((m) => (
            <button key={m} type="button" className={m === page.mode ? 'mode now' : 'mode'} data-testid={`mode-${m}`} aria-pressed={m === page.mode} onClick={() => setMode(m)}>
              {MODE_TITLE[m]}
            </button>
          ))}
        </nav>
        {page.mode === 'system' && (
          <label className="toggle" title="Show the import edges between the projects">
            <input type="checkbox" data-testid="imports" checked={page.imports} onChange={(e) => setPage({ ...page, imports: e.target.checked })} />
            Show imports
          </label>
        )}
        {(page.mode === 'system' || page.mode === 'features') && (
          <label className="toggle" title="Show the count of e2e test cases on each page and endpoint">
            <input type="checkbox" data-testid="coverage" checked={page.tests === true} onChange={(e) => setPage({ ...page, tests: e.target.checked })} />
            Tests
          </label>
        )}
        <Search query={lensId ? page.q! : ''} onLens={setLens} onPick={(h) => (h.case ? openCase(h.case) : searchPick(h.path))} />
      </header>
      {lensId && <LensBar query={page.q!} lens={system?.lens} onQuery={setLens} />}
      {page.mode !== 'matrix' && !list && <Strip sel={sel} byFid={byFid} system={system} notice={notice} open={open} title={lensId ? 'Search' : MODE_TITLE[page.mode]} filter={page.mode === 'system' ? page.filter : undefined} onPick={panTo} onClose={toggle} onClearFilter={clearFilter} />}
      <main className={far ? 'canvas far' : 'canvas'} ref={box} data-testid="canvas" data-mode={page.mode} data-ready={ready || (page.mode === 'matrix' && system !== undefined) || (list && testsInfo !== undefined) ? 'true' : 'false'} data-step={cur} data-open={open.size} data-far={far ? 'true' : 'false'}>
        {!system && !error && <div className="status">Loading…</div>}
        {error && <div className="status error">{error}</div>}
        {page.mode === 'matrix' && system && <MatrixTable matrix={system.matrix} onPick={pickCell} />}
        {list && testsInfo && <TestsList info={testsInfo} coverage={coverage} onOpen={openCase} />}
        {page.mode !== 'matrix' && !list && placed && (
          <>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodeClick={(_, n) => {
                if (n.type === 'group') return;
                const fid = (n.data as AtlasNodeData).fid;
                // The "+N types" box of a lens: show the types.
                if (fid === LENS_TYPES && page.q) setLens(`${page.q} kind:type`);
                else setSelected(fid);
              }}
              onPaneClick={() => setSelected(undefined)}
              onlyRenderVisibleElements={false}
              onNodeMouseEnter={(_, n) => setHot(n.id)}
              onNodeMouseLeave={() => setHot(undefined)}
              zIndexMode="manual"
              elevateNodesOnSelect={false}
              elevateEdgesOnSelect={false}
              nodesDraggable={false}
              nodesConnectable={false}
              zoomOnDoubleClick={false}
              minZoom={0.05}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="#cfd5df" />
              <Controls showInteractive={false} position="bottom-right" />
            </ReactFlow>
            <Legend tree={placed.tree} />
          </>
        )}
        {caseId && !list && (
          <Player
            info={caseInfo}
            cur={cur}
            playing={playing}
            speed={speed}
            onStep={(n) => {
              setPlaying(false);
              if (n < 0) {
                const { step: _s, ...rest } = page;
                setPage(rest);
              } else setStep(n);
            }}
            onPlay={() => {
              if (!playing && cur >= steps.length - 1) setStep(0);
              setPlaying(!playing);
            }}
            onSpeed={setSpeed}
            onList={() => setMode('tests')}
          />
        )}
        {sel && page.mode !== 'matrix' && !list && (
          <Panel
            item={sel} root={info?.root} open={open.has(sel.fid)} onToggle={() => toggle(sel.fid)} onTarget={() => sel.node.target && reveal(sel.node.target)} onClose={() => setSelected(undefined)}
            {...(coverage && (COVERED.has(sel.node.shape) || touchesOf(coverage, sel.node).length > 0) ? { touches: touchesOf(coverage, sel.node), coverage } : {})}
            onCase={openCase}
            {...(lensId && system?.lens?.why[sel.fid] ? { why: system.lens.why[sel.fid] } : {})}
          />
        )}
        {!sel && caseId && !list && caseInfo?.ok && (
          <CasePanel
            info={caseInfo}
            onPick={(it) => {
              if (it.node && byFid.has(it.node)) {
                setNotice(undefined);
                setSelected(it.node);
              } else setNotice(`${it.label} is not a box on this map.${it.file ? ` It is in ${it.file}${it.line ? `:${it.line}` : ''}.` : ''}`);
            }}
          />
        )}
      </main>
    </div>
  );
}

/**
 * The strip under the bar: the path of open boxes to the selected box, its file and line, and its
 * notes. A part of the path selects that box and moves the camera to it; its × closes the box.
 */
function Strip({ sel, byFid, system, notice, open, title, filter, onPick, onClose, onClearFilter }: {
  sel: TreeNode | undefined; byFid: ReadonlyMap<string, TreeNode>; system: AtlasView | undefined; notice: string | undefined;
  open: ReadonlySet<string>; title: string; filter: CellFilter | undefined; onPick: (fid: string) => void; onClose: (fid: string) => void; onClearFilter: () => void;
}) {
  if (!system) return null;
  const n = sel?.node;
  const path = sel ? [...ancestors(sel.fid), sel.fid] : [];
  const holder = sel ? (sel.view ?? (sel.container ? byFid.get(sel.container)?.view : system)) : system;
  const notes = [...(notice ? [notice] : []), ...(n?.note ? [n.note] : []), ...(holder?.notes ?? [])];
  return (
    <section className="strip" data-testid="strip">
      <div className="title" data-testid="strip-path">
        {filter && (
          <span className="filter-chip" data-testid="filter-chip" title="The two projects show only the boxes of these calls">
            Filter: {nameIn(system, filter.from)} → {nameIn(system, filter.to)}
            <button type="button" className="path-close" data-testid="filter-clear" aria-label="Clear the filter" title="Clear the filter: show all of both projects" onClick={onClearFilter}>
              ×
            </button>
          </span>
        )}
        {path.length === 0 && <span className="path-part now">{title}</span>}
        {path.map((fid, i) => (
          <span key={fid} className={i === path.length - 1 ? 'path-part now' : 'path-part'}>
            {i > 0 && <span className="sep">›</span>}
            <button type="button" className="path-pick" data-testid="strip-part" data-id={fid} title="Select this box and move to it" onClick={() => onPick(fid)}>
              {byFid.get(fid)?.node.label ?? fid}
            </button>
            {open.has(fid) && (
              <button type="button" className="path-close" data-testid="strip-close" data-id={fid} aria-label={`Close ${byFid.get(fid)?.node.label ?? fid}`} title="Close this box" onClick={() => onClose(fid)}>
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      <div className="subtitle" data-testid="strip-where">
        {n ? `${n.shape}${n.file ? ` · ${n.file}${n.line ? `:${n.line}` : ''}` : ''}` : `${open.size} open ${open.size === 1 ? 'box' : 'boxes'} · click a box to select it, + opens it in place, Escape closes it`}
      </div>
      {notes.map((x) => (
        <div key={x} className="note">
          {x}
        </div>
      ))}
    </section>
  );
}

/** The label of a project on the canvas, by its key. */
const nameIn = (view: AtlasView | undefined, key: string) => view?.nodes.find((n) => n.id === `project:${key}`)?.label ?? key;

interface FlowActions {
  onToggle: (fid: string) => void;
  onTarget: (fid: string, n: ViewNode) => void;
  onFold: (fid: string) => void;
  onCompact: (fid: string) => void;
  compact: ReadonlySet<string>;
  /** The IDs of the edges that show. */
  keep: ReadonlySet<string>;
  /** The edges into the boxes of a lane group share one trunk into the group: the HTTP edges (the case view), or all (a lens). */
  intoGroup?: 'http' | 'all';
}

function toFlow(tree: Tree, layout: Layout, act: FlowActions): { nodes: Node[]; edges: Edge[] } {
  const { onToggle, onTarget, onFold } = act;
  const at = new Map([...layout.groups, ...layout.nodes].map((b) => [b.id, b]));
  // React Flow needs each parent before its children: the depth gives this order.
  const items = [
    ...tree.groups.map((g) => ({ depth: g.depth, group: g })),
    ...tree.nodes.map((n) => ({ depth: n.depth, node: n })),
  ].sort((a, b) => a.depth - b.depth);
  const nodes: Node[] = [];
  for (const it of items) {
    if ('group' in it && it.group) {
      const g = it.group;
      const p = at.get(g.fid);
      if (!p) continue;
      nodes.push({
        id: g.fid, type: 'group', position: { x: p.x, y: p.y }, data: { group: g.group, fid: g.fid, compact: act.compact.has(g.fid), onFold, onCompact: act.onCompact } satisfies GroupData,
        ...(g.parent ? { parentId: g.parent } : {}),
        style: { width: p.width, height: p.height }, width: p.width, height: p.height, selectable: false, zIndex: g.depth * 2,
      });
      continue;
    }
    const n = (it as { node: TreeNode }).node;
    const p = at.get(n.fid);
    if (!p) continue;
    const data: AtlasNodeData = { node: n.node, fid: n.fid, lines: sizeOf(n.node).lines, state: n.state, onToggle, onTarget, onFold, ...(n.fold ? { icon: n.fold.icon } : {}) };
    nodes.push({
      id: n.fid, type: n.state === 'open' ? 'box' : 'atlas', position: { x: p.x, y: p.y }, data,
      ...(n.parent ? { parentId: n.parent } : {}),
      style: { width: p.width, height: p.height }, width: p.width, height: p.height, zIndex: n.state === 'open' ? n.depth * 2 + 1 : LEAF_Z + n.depth,
    });
  }
  const placed = new Map(layout.edges.map((e) => [e.id, e]));
  const where = absolute(layout);
  const parentOf = new Map([...layout.groups, ...layout.nodes].map((b) => [b.id, b.parent]));
  const list = tree.edges.filter((e) => act.keep.has(e.id) && at.has(e.from) && at.has(e.to));
  // No ELK route: the edge goes between two boxes in different open boxes, or across the lanes of
  // the System view. Each edge has its own track; the totals (only when the zoom is small) apart.
  const byFid = new Map(tree.nodes.map((n) => [n.fid, n]));
  const cross = (e: TreeEdge): CrossEdge => {
    const text = e.label ? shortLabel(e.label) : undefined;
    const store = byFid.get(e.to)?.node.shape === 'store' || e.to === 'group:stores';
    // The sum of a frontend leaves from the head of its group: no feature card makes those calls.
    const head = e.role === 'sum' && !byFid.has(e.from);
    return {
      id: e.id, from: e.from, to: e.to, ...(text ? { label: text } : {}), ...(head ? { fromHead: true } : {}),
      ...((act.intoGroup === 'http' && e.kind === 'http') || act.intoGroup === 'all' ? { intoGroup: true } : {}),
      ...(e.role === 'total' ? { total: true, ...(text ? { size: totalSize(text) } : {}) } : store ? { near: 'target' as const } : {}),
    };
  };
  const loose = list.filter((e) => !placed.has(e.id));
  const treeEdge = new Map(list.map((e) => [e.id, e]));
  const bundleText = (members: CrossEdge[]) => {
    const es = members.map((m) => treeEdge.get(m.id)!);
    const n = new Set(es.map((e) => e.from)).size;
    const shape = byFid.get(es[0]!.from)?.node.shape;
    const [one, many] = NOUN[shape ?? ''] ?? (byFid.has(es[0]!.from) ? ['box', 'boxes'] : ['frontend', 'frontends']);
    const who = `${n} ${n === 1 ? one : many}`;
    if (es.every((e) => e.ends)) {
      const k = new Set(es.flatMap((e) => e.ends!)).size;
      return `${who} · ${k} endpoint${k === 1 ? '' : 's'}`;
    }
    const joined = joinLabels(es.map((e) => e.label));
    return joined && /^\d/.test(joined) ? `${who} · ${joined}` : `${who} · ${es.length} links`;
  };
  const routes = new Map([
    ...routeCross(loose.filter((e) => e.role !== 'total').map(cross), where, parentOf, { bundleText }),
    ...routeCross(loose.filter((e) => e.role === 'total').map(cross), where, parentOf),
  ]);
  const edges: Edge[] = list.map((e) => {
    const route = placed.get(e.id);
    if (route) return toEdge(e, route, false);
    // It is faint only if an end is in an open box.
    const r = routes.get(e.id);
    const deep = [e.from, e.to].some((f) => byFid.get(f)?.container !== undefined);
    const short = e.label ? shortLabel(e.label) : undefined;
    const title = short !== e.label ? [e.label, e.title].filter(Boolean).join('\n') : e.title;
    const shown: TreeEdge = { ...e, ...(short ? { label: short } : {}), ...(title ? { title } : {}) };
    const edge = toEdge(shown, r ? { id: e.id, points: r.points, ...(r.label ? { label: r.label } : {}) } : undefined, deep, r?.hidden);
    if (r?.bundle) edge.data = { ...edge.data!, bundle: r.bundle, ...(r.bundleLabel ? { bundleLabel: r.bundleLabel } : {}) };
    return edge;
  });
  return { nodes, edges };
}

/** The noun of the sources of a bundle, by their shape. */
const NOUN: Record<string, [string, string]> = {
  page: ['page', 'pages'], feature: ['feature', 'features'], function: ['function', 'functions'], project: ['project', 'projects'], endpoint: ['endpoint', 'endpoints'],
};

/** The pill of a total is large: it shows when the zoom is small (see the CSS of .far). */
const totalSize = (text: string) => ({ width: Math.round(text.length * 12.5 + 32), height: 34 });

type EdgeStyle = { stroke: string; dash?: string; width?: number };
const EDGE_STYLE: Record<ViewEdge['kind'], EdgeStyle> = {
  flow: { stroke: '#8b95a5' },
  branch: { stroke: '#8b95a5' },
  back: { stroke: '#a78bfa', dash: '5 4' },
  error: { stroke: '#e57373', dash: '5 4' },
  http: { stroke: '#2f6bd8', dash: '7 4', width: 2.6 },
  uses: { stroke: '#b0b8c4' },
};

// The order on the canvas, from the bottom: the open boxes and the groups (by depth), the edges
// between open boxes, the edges in a box, the closed boxes and the leaves, the labels (CSS).
/** The z of a closed box or a leaf: above all edges. */
const LEAF_Z = 1001;
/** The z of an edge in a box: above the open boxes. */
const EDGE_Z = 1000;
/** The z of an edge between two open boxes: under the closed boxes and the leaves. */
const CROSS_Z = 999;
/** The opacity of an edge between two open boxes when no end is hot. */
const FAINT = 0.35;
/** The opacity of the edges out of the focus: almost gone, and with no label. */
const DIM_EDGE = 0.08;
/** A possible link is lighter than a sure one. */
const POSSIBLE = 0.6;

function toEdge(e: TreeEdge, placed: PlacedEdge | undefined, cross: boolean, hidden?: boolean): Edge<ElkEdgeData> {
  const s = e.role === 'total' ? TOTAL_STYLE : e.possible ? POSSIBLE_STYLE : EDGE_STYLE[e.kind];
  const opacity = (cross ? FAINT : 1) * (e.possible ? POSSIBLE : 1);
  return {
    id: e.id, source: e.from, target: e.to, type: 'elk', zIndex: cross ? CROSS_Z : EDGE_Z,
    ...(e.role === 'total' ? { className: 'edge-total' } : e.possible ? { className: 'edge-possible' } : {}),
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: s.stroke },
    style: { stroke: s.stroke, strokeWidth: s.width ?? 1.2, ...(s.dash ? { strokeDasharray: s.dash } : {}), ...(opacity < 1 ? { opacity } : {}) },
    data: {
      kind: e.kind, ...(cross ? { cross: true, faint: true } : {}), ...(e.label ? { label: e.label } : {}), ...(e.title ? { title: e.title } : {}),
      ...(e.role ? { role: e.role } : {}), ...(e.possible ? { possible: true } : {}), ...(hidden ? { hidden: true } : {}),
      ...(placed ? { points: placed.points, ...(placed.label ? { box: placed.label } : {}) } : {}),
    },
  };
}

/** The total of the calls between two groups: only when the zoom is small. */
const TOTAL_STYLE: EdgeStyle = { stroke: '#2f6bd8', width: 5 };
/** A possible link (no sure endpoint): dashed and lighter. */
const POSSIBLE_STYLE: EdgeStyle = { stroke: '#7ea3e6', dash: '3 5', width: 1.6 };

function Search({ query, onPick, onLens }: { query: string; onPick: (h: SearchHit) => void; onLens: (q: string) => void }) {
  const [q, setQ] = useState(query);
  const [hits, setHits] = useState<SearchHit[]>([]);
  // The box shows the query of the lens; a new lens (a chip removed, Whole map) changes it.
  useEffect(() => setQ(query), [query]);
  useEffect(() => {
    if (q.trim().length < 2 || q === query) return setHits([]);
    let live = true;
    const t = setTimeout(() => void api.search(q).then((r) => live && setHits(r.hits), () => undefined), 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, query]);
  const pick = (h: SearchHit) => {
    onPick(h);
    setQ('');
    setHits([]);
  };
  return (
    <div className="search">
      <input
        type="search"
        data-testid="search"
        placeholder="Search the map (Enter), or pick a hit"
        title="Enter: show only the parts of the map that fit the words. Filters: project:, kind:, method:, path:, depth:, up:, down:, impact:&quot;…&quot;, untested"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            setHits([]);
            onLens(q);
          }
          if (e.key === 'Escape') setQ('');
        }}
      />
      {hits.length > 0 && (
        <ul className="hits" data-testid="hits">
          {hits.map((h) => (
            <li key={h.case ? `case:${h.case}` : h.path.join('/')}>
              <button type="button" onClick={() => pick(h)}>
                <span className="hit-label">{h.label}</span>
                <span className="hit-sub">{h.sub}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The box of the types that a free-word lens leaves out (LENS_TYPES of the server). */
const LENS_TYPES = 'lens:types';
/** The most parts of a lens (the server cap). */
const LENS_MAX = 60;

/** The bar of the search lens: the chips (× removes one), the count, the time, the errors and "Whole map". */
function LensBar({ query, lens, onQuery }: { query: string; lens: LensInfo | undefined; onQuery: (q: string) => void }) {
  return (
    <div className="lens-bar" data-testid="lens-bar" data-query={query}>
      <span className="lens-title">Search</span>
      <span className="lens-query" data-testid="lens-query">{query}</span>
      {lens?.chips.map((c) => (
        <span key={c.raw} className="lens-chip" data-testid="lens-chip" data-key={c.key}>
          {c.key}{c.value ? `:${c.value}` : ''}
          <button type="button" data-testid="lens-chip-remove" aria-label={`Remove ${c.raw}`} title="Remove this filter" onClick={() => onQuery(withoutChip(query, c.raw))}>
            ×
          </button>
        </span>
      ))}
      {lens && (
        <span className="lens-count" data-testid="lens-count">
          {lens.shown} {lens.shown === 1 ? 'part' : 'parts'}
          {lens.more > 0 && <span className="lens-more" data-testid="lens-more">{lens.wide ? ` · ${lens.more} more: make the query narrower` : ` · ${lens.more} more fit`}</span>}
        </span>
      )}
      {lens && !lens.wide && lens.more > 0 && (
        <span className="lens-show">
          {lens.seeds + 20 < Math.min(LENS_MAX, lens.seeds + lens.more) && (
            <button type="button" data-testid="lens-show-more" onClick={() => onQuery(withShow(query, lens.seeds + 20))}>Show 20 more</button>
          )}
          <button type="button" data-testid="lens-show-all" onClick={() => onQuery(withShow(query, Math.min(LENS_MAX, lens.seeds + lens.more)))}>
            Show all {Math.min(LENS_MAX, lens.seeds + lens.more)}
          </button>
        </span>
      )}
      {lens && <span className="lens-time" data-testid="lens-time" title="The time of the query on the server">{lens.ms} ms</span>}
      {lens?.errors.map((e) => (
        <span key={e} className="lens-error" data-testid="lens-error">{e}</span>
      ))}
      <button type="button" className="lens-clear" data-testid="lens-clear" onClick={() => onQuery('')}>
        Whole map
      </button>
    </div>
  );
}

function Panel({ item, root, open, onToggle, onTarget, onClose, touches, coverage, onCase, why }: {
  item: TreeNode; root: string | undefined; open: boolean; onToggle: () => void; onTarget: () => void; onClose: () => void;
  /** The test cases that touch the box, and how. */
  touches?: CaseTouch[];
  coverage?: Coverage;
  onCase?: (id: string) => void;
  /** The search lens: why the box is in the view. */
  why?: string[];
}) {
  const node = item.node;
  const [info, setInfo] = useState<NodeInfo>();
  useEffect(() => {
    setInfo(undefined);
    if (!node.ref) return;
    let live = true;
    void api.node(node.ref).then((i) => live && setInfo(i), () => undefined);
    return () => {
      live = false;
    };
  }, [node.ref]);
  const file = node.file;
  const abs = info?.path ?? (file && root ? `${root.replace(/\/$/, '')}/${file}` : undefined);
  return (
    <aside className="panel" data-testid="panel">
      <div className="panel-head">
        <span className={`chip tone-${toneOf(node.tone)}`}>{node.shape}</span>
        <button type="button" className="close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="panel-title">{node.method && !node.label.startsWith(`${node.method} `) ? `${node.method} ${node.label}` : node.label}</div>
      {node.sub && <div className="panel-sub">{node.sub}</div>}
      {file && (
        <div className="where" data-testid="where">
          {file}
          {node.line ? `:${node.line}` : ''}
        </div>
      )}
      <div className="actions">
        {node.open && (
          <button type="button" className="primary" data-testid="panel-toggle" onClick={onToggle}>
            {open ? 'Close the box' : 'Open the box'}
          </button>
        )}
        {node.target && (
          <button type="button" className="primary" data-testid="panel-target" onClick={onTarget}>
            Open the endpoint
          </button>
        )}
        {node.case && (
          <button type="button" className="primary" data-testid="panel-case" onClick={() => onCase?.(node.case!)}>
            Open the case
          </button>
        )}
        {abs && (
          <>
            <a href={`vscode://file/${abs}${node.line ? `:${node.line}` : ''}`}>Open in VS Code</a>
            <a href={`file://${abs}`}>Open the file</a>
          </>
        )}
      </div>
      {why && why.length > 0 && (
        <section className="links why" data-testid="why">
          <h4>Why it is here</h4>
          <ul>
            {why.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </section>
      )}
      {node.note && (
        <div className="panel-note" data-testid="panel-note">
          {node.note}
        </div>
      )}
      {node.items && node.items.length > 0 && (
        <section className="links" data-testid="items">
          <h4>
            Lines <span className="count">{node.items.length}</span>
          </h4>
          <ul>
            {node.items.map((it, i) => (
              <li key={`${i}:${it.label}`}>
                <span className="leaf">{it.label}</span>
                {it.line !== undefined && <span className="kind">:{it.line}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {node.detail && node.detail.length > 0 && (
        <ul className="detail">
          {node.detail.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
      {touches && coverage && <CaseSection touches={touches} coverage={coverage} onCase={(id) => onCase?.(id)} />}
      {info?.ok && (
        <>
          <Links title="Callers" list={info.callers} />
          <Links title="Callees" list={info.callees} />
        </>
      )}
    </aside>
  );
}

function Links({ title, list }: { title: string; list: NodeInfo['callers'] }) {
  return (
    <section className="links">
      <h4>
        {title} <span className="count">{list.length}</span>
      </h4>
      {list.length === 0 && <div className="none">None</div>}
      <ul>
        {list.slice(0, 40).map((l) => (
          <li key={l.id} title={`${l.label}\n${l.kind}${l.file ? ` · ${l.file}:${l.line ?? ''}` : ''}`}>
            <span className="leaf">{l.label}</span>
            <span className="kind">
              {l.kind}
              {l.file ? ` · ${l.file}:${l.line ?? ''}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const LEGEND: Array<[string, string]> = [
  ['project', 'Project'], ['fold', 'Collapsed group'], ['feature', 'Feature: pages by route'], ['store', 'Data store'], ['page', 'Page'], ['endpoint', 'Endpoint'], ['route', 'Route'], ['command', 'Command'], ['function', 'Function'],
  ['start', 'Start'], ['step', 'Step'], ['decision', 'Decision'], ['loop', 'Loop'], ['call', 'Call: open it'], ['cross', 'Call to another project'], ['lib', 'Library call'],
  ['event', 'Event handler'], ['more', 'Parts that the chart does not show'], ['end', 'Return or throw'], ['http', 'HTTP call'], ['possible', 'Possible link: no sure endpoint'], ['uses', 'Imports'],
];

function Legend({ tree }: { tree: Tree }) {
  // The key starts as one line, so that it covers no node at the first view.
  const [open, setOpen] = useState(false);
  const shapes = new Set<string>([...tree.nodes.map((n) => n.node.shape), ...tree.edges.map((e) => e.kind), ...(tree.edges.some((e) => e.possible) ? ['possible'] : [])]);
  const items = LEGEND.filter(([k]) => shapes.has(k));
  if (items.length === 0) return null;
  return (
    <div className={open ? 'legend open' : 'legend'} data-testid="legend">
      <button type="button" className="legend-toggle" data-testid="legend-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} Key
      </button>
      {open && (
        <>
          {items.map(([k, label]) => (
            <div key={k} className="legend-item">
              <span className={`swatch swatch-${k}`} />
              {label}
            </div>
          ))}
          <div className="legend-hint">+ or a double-click opens a box in place. − closes it. ⇢ opens the endpoint of an HTTP call. Click a box to see its links; Escape or a click on the canvas clears it.</div>
        </>
      )}
    </div>
  );
}

/**
 * The matrix: the frontends are the rows, the projects that they call are the columns. A cell shows
 * the calls: direct (a sure endpoint) and possible. A click on a cell opens the two projects in System mode.
 */
function MatrixTable({ matrix, onPick }: { matrix: Matrix | undefined; onPick: (row: string, col: string) => void }) {
  if (!matrix || matrix.rows.length === 0 || matrix.cols.length === 0) return <div className="status">No frontend calls another project.</div>;
  return (
    <div className="matrix-wrap">
      <table className="matrix" data-testid="matrix">
        <caption>HTTP calls from each frontend (rows) to each project (columns). Click a cell to open both projects.</caption>
        <thead>
          <tr>
            <th scope="col" />
            {matrix.cols.map((c) => (
              <th key={c.key} scope="col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              {matrix.cols.map((c) => {
                const cell = matrix.cells[`${r.key}\n${c.key}`];
                if (!cell) return <td key={c.key} className="empty" />;
                return (
                  <td key={c.key}>
                    <button type="button" className="cell" data-testid="matrix-cell" data-row={r.key} data-col={c.key} title={`${r.label} → ${c.label}`} onClick={() => onPick(r.key, c.key)}>
                      {cell.direct > 0 && <span className="direct">{cell.direct} direct</span>}
                      {cell.possible > 0 && <span className="possible">{cell.possible} possible</span>}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_TEXT: Record<RunStatus, string> = { passed: 'passed', failed: 'failed', skipped: 'skipped', timedOut: 'timed out', interrupted: 'stopped', flaky: 'flaky' };

/** The cases that touch a box: by its node ID, else by the graph ID of its code (a component, a handler). */
function touchesOf(cov: Coverage, node: ViewNode): CaseTouch[] {
  return cov.touches[node.id] ?? (node.ref ? (cov.touches[node.ref] ?? cov.touches[`fn:${node.ref}`]) : undefined) ?? [];
}

const HOW_TEXT: Record<AreaHow, string> = {
  visited: 'visited', clicked: 'clicked', filled: 'filled', asserted: 'asserted', mocked: 'mocked', seen: 'seen in a run',
  code: 'reached by code only', notRun: 'not run: the endpoint is mocked',
};
const LAYER_TITLE: Record<AreaLayer, string> = {
  feature: 'Feature area', page: 'Pages', component: 'Components and dialogs', handler: 'Handlers', route: 'Frontend API routes',
  endpoint: 'Backend endpoints', backend: 'Backend functions and stores',
};
const LAYERS: AreaLayer[] = ['feature', 'page', 'component', 'handler', 'route', 'endpoint', 'backend'];

function HowTags({ how }: { how: AreaHow[] }) {
  return (
    <span className="how-tags">
      {how.map((h) => (
        <span key={h} className={`how how-${h}`} data-testid="area-how" data-how={h}>
          {HOW_TEXT[h]}
        </span>
      ))}
    </span>
  );
}

/** The "Test cases" section of the panel: the cases that touch the box, by spec and describe, with how and the last result. */
function CaseSection({ touches, coverage, onCase }: { touches: CaseTouch[]; coverage: Coverage; onCase: (id: string) => void }) {
  // The specs, most cases first; each one is a group that opens.
  const specs = new Map<string, CaseTouch[]>();
  for (const t of touches) {
    const k = coverage.where[t.case]?.file ?? t.case.slice(0, t.case.lastIndexOf(':'));
    specs.set(k, [...(specs.get(k) ?? []), t]);
  }
  const list = [...specs].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  const mocks = touches.filter((t) => t.how.includes('mocked')).length;
  const real = touches.filter((t) => t.how.some((h) => h !== 'mocked' && h !== 'notRun')).length;
  const n = touches.length;
  const summary = [
    `${n} case${n === 1 ? '' : 's'}`,
    `${list.length} spec${list.length === 1 ? '' : 's'}`,
    ...(mocks > 0 ? [mocks === n ? 'all mock this endpoint' : `${mocks} mock this endpoint`] : []),
    `${real} ${real === 1 ? 'runs' : 'run'} it for real`,
  ].join(' · ');
  return (
    <section className="links" data-testid="cases">
      <h4>
        Test cases <span className="count">{n}</span>
      </h4>
      {n === 0 && <div className="none">No test case touches this box.</div>}
      {n > 0 && (
        <div className="case-summary" data-testid="cases-summary">
          {summary}
        </div>
      )}
      {list.map(([file, items]) => (
        <details key={file} className="case-group" data-testid="case-spec" open={list.length <= 2}>
          <summary className="case-group-name">
            {file} <span className="count">{items.length}</span>
          </summary>
          <ul>
            {items.map((t) => {
              const st = coverage.status[t.case];
              const path = coverage.where[t.case]?.path ?? [];
              return (
                <li key={t.case}>
                  <button type="button" className="case-link" data-testid="case-link" data-case={t.case} title="Open the case in the Tests mode" onClick={() => onCase(t.case)}>
                    {path.length > 0 && <span className="case-path">{path.join(' › ')} › </span>}
                    {coverage.titles[t.case] ?? t.case}
                  </button>
                  <span className="case-how">
                    <span className={`run run-${st ?? 'none'}`}>{st ? STATUS_TEXT[st] : 'not run'}</span>
                    <HowTags how={t.how} />
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
      ))}
    </section>
  );
}

/** The panel of an open case: the parts of the project that it touches, by layer, and what it checks. */
function CasePanel({ info, onPick }: { info: CaseInfo; onPick: (it: AreaItem) => void }) {
  const areas = info.areas ?? [];
  const checks = info.checks ?? [];
  return (
    <aside className="panel" data-testid="case-panel">
      <div className="panel-head">
        <span className="chip">test case</span>
      </div>
      <div className="panel-title">{info.title}</div>
      <div className="panel-sub">{[...info.path, info.projectName].filter(Boolean).join(' · ')}</div>
      <div className="where">
        {info.file}:{info.line}
      </div>
      <section className="links" data-testid="areas">
        <h4>
          Areas this case touches <span className="count">{areas.length}</span>
        </h4>
        {areas.length === 0 && <div className="none">The atlas found no part of the project for this case.</div>}
        {LAYERS.filter((l) => areas.some((a) => a.layer === l)).map((l) => (
          <div key={l} className="area-layer" data-testid="area-layer" data-layer={l}>
            <div className="case-group-name">{LAYER_TITLE[l]}</div>
            <ul>
              {areas.filter((a) => a.layer === l).map((a) => (
                <li key={a.key}>
                  <button type="button" className="area-item" data-testid="area-item" data-layer={a.layer} data-node={a.node ?? ''} data-how={a.how.join(' ')} title="Select it on the map" onClick={() => onPick(a)}>
                    {a.label}
                  </button>
                  <HowTags how={a.how} />
                  {(a.sub || a.file) && (
                    <span className="kind" title={a.file ? `${a.file}${a.line ? `:${a.line}` : ''}` : a.sub}>
                      {a.file ? `${a.file}${a.line ? `:${a.line}` : ''}` : a.sub}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {(info.fixtureExtra ?? []).map((x) => (
          <details key={x.fixture} className="fixture-extra" data-testid="fixture-extra">
            <summary>
              Fixture {x.fixture} also mocks {x.routes.length} route{x.routes.length === 1 ? '' : 's'} that this page does not call
            </summary>
            <ul>
              {x.routes.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </details>
        ))}
      </section>
      <section className="links" data-testid="checks">
        <h4>
          What this case checks <span className="count">{checks.length}</span>
        </h4>
        {checks.length === 0 && <div className="none">The case has no expect.</div>}
        <ol className="checks">
          {checks.map((c, i) => (
            <li key={`${i}:${c}`}>{c}</li>
          ))}
        </ol>
      </section>
    </aside>
  );
}

/** The group of a spec in the list: its project, else the first folder of its path (a test automation folder). */
const groupOfSpec = (s: TestsInfo['specs'][number]): string => s.projectName ?? s.file.split('/')[0] ?? s.file;

/** "Coverage by area": one row per feature of a frontend. A click filters the list to the cases of the area. */
function CoverageTable({ coverage, pick, onPick }: { coverage: Coverage; pick: string | undefined; onPick: (id: string | undefined) => void }) {
  if (coverage.areas.length === 0) return null;
  return (
    <details className="tests-project cover-areas" data-testid="coverage-areas" open>
      <summary>
        <h3>Coverage by area</h3>
        <span className="case-sub">one row per feature · click a row to show its cases</span>
      </summary>
      <table className="cover-table">
        <thead>
          <tr>
            <th scope="col">Area</th>
            <th scope="col">Cases</th>
            <th scope="col" title="The pages that a case opens, of all the pages of the area">Pages with a case</th>
            <th scope="col" title="Endpoints that a case reaches for real (not mocked)">Endpoints real</th>
            <th scope="col" title="Endpoints that only a mock touches">Mocked only</th>
            <th scope="col" title="Endpoints that no case touches">Not touched</th>
          </tr>
        </thead>
        <tbody>
          {coverage.areas.map((r) => (
            <tr key={r.id} className={pick === r.id ? 'now' : undefined} data-testid="coverage-area" data-area={r.id} onClick={() => onPick(pick === r.id ? undefined : r.id)}>
              <th scope="row">
                {r.label} <span className="case-sub">{r.project}</span>
              </th>
              <td>{r.cases.length}</td>
              <td>
                {r.pages.tested} / {r.pages.all}
              </td>
              <td>{r.endpoints.real}</td>
              <td>{r.endpoints.mocked}</td>
              <td className={r.endpoints.none > 0 ? 'cover-none' : undefined}>{r.endpoints.none}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/**
 * The e2e cases of the repo: one group per project (the most cases first; the first group is open),
 * then by spec and describe, with the result of the last run, the tags, and the areas of each case.
 * A filter box and a row of "Coverage by area" make the list shorter.
 */
function TestsList({ info, coverage, onOpen }: { info: TestsInfo; coverage: Coverage | undefined; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState('');
  const [area, setArea] = useState<string>();
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const fits = (s: TestsInfo['specs'][number], c: TestsInfo['specs'][number]['cases'][number]) => {
    if (area && !(coverage?.caseAreas[c.id] ?? []).includes(area)) return false;
    const text = [c.title, ...c.path, s.file, s.tag ?? '', ...(c.tags ?? []), groupOfSpec(s)].join(' ').toLowerCase();
    return words.every((w) => text.includes(w));
  };
  const groups = new Map<string, Array<TestsInfo['specs'][number]>>();
  for (const s of info.specs) {
    const cases = s.cases.filter((c) => fits(s, c));
    if (cases.length === 0) continue;
    const k = groupOfSpec(s);
    groups.set(k, [...(groups.get(k) ?? []), { ...s, cases }]);
  }
  const count = (specs: Array<TestsInfo['specs'][number]>) => specs.reduce((n, s) => n + s.cases.length, 0);
  const sorted = [...groups].sort(([a, x], [b, y]) => count(y) - count(x) || (a < b ? -1 : 1));
  const narrowed = words.length > 0 || area !== undefined;
  const areaLabel = area ? coverage?.areas.find((r) => r.id === area)?.label : undefined;
  return (
    <div className="tests-wrap" data-testid="tests-list">
      <p className="tests-head">
        Open a case to see its steps on the map. Run them with <code>atlas test &lt;repo&gt;</code>; the page shows the last results
        {info.results ? <> from <code>{info.results}</code></> : ' (no results yet)'}.
      </p>
      {info.notes.map((n) => (
        <div key={n} className="note">
          {n}
        </div>
      ))}
      {coverage && <CoverageTable coverage={coverage} pick={area} onPick={setArea} />}
      <div className="tests-filter">
        <input type="search" data-testid="tests-filter" placeholder="Filter: a title, describe, file or @tag" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {area && (
          <span className="chip" data-testid="area-filter">
            Area: {areaLabel ?? area}{' '}
            <button type="button" className="close" aria-label="Clear the area filter" onClick={() => setArea(undefined)}>
              ×
            </button>
          </span>
        )}
        <span className="case-sub">{sorted.reduce((n, [, x]) => n + count(x), 0)} cases</span>
      </div>
      {sorted.length === 0 && <div className="none">No case fits the filter.</div>}
      {sorted.map(([project, specs], i) => (
        <details key={`${project}:${narrowed ? 'n' : ''}`} className="tests-project" data-testid="tests-project" data-project={project} open={i === 0 || narrowed}>
          <summary>
            <h3>{project}</h3>
            <span className="case-sub" data-testid="tests-project-count">
              {count(specs)} case{count(specs) === 1 ? '' : 's'}
            </span>
          </summary>
          {specs.map((s) => {
            const byDescribe = new Map<string, typeof s.cases>();
            for (const c of s.cases) {
              const k = c.path.join(' › ');
              byDescribe.set(k, [...(byDescribe.get(k) ?? []), c]);
            }
            return (
              <div key={s.file} className="tests-spec">
                <div className="tests-file">
                  {s.file}
                  {s.runner === 'cypress' && <span className="chip">Cypress: review only</span>}
                  {s.tag && (
                    <span className="chip" data-testid="spec-tag" title={`This spec runs from its own Playwright config (${s.tag}), not the main one.`}>
                      {s.tag}
                    </span>
                  )}
                </div>
                {[...byDescribe].map(([d, cases]) => (
                  <div key={d} className="tests-describe">
                    {d && <div className="tests-describe-name">{d}</div>}
                    <ul>
                      {cases.map((c) => (
                        <li key={c.id}>
                          <button type="button" className="case-row" data-testid="case-row" data-case={c.id} onClick={() => onOpen(c.id)}>
                            <span className={`run run-${c.result?.status ?? 'none'}`} data-testid="case-status">
                              {c.result ? STATUS_TEXT[c.result.status] : 'not run'}
                            </span>
                            <span className="case-title">{c.title}</span>
                            {(c.tags ?? []).map((t) => (
                              <span key={t} className="chip case-tag" data-testid="case-tag">
                                {t}
                              </span>
                            ))}
                            <span className="case-sub">
                              {c.steps} step{c.steps === 1 ? '' : 's'} · line {c.line}
                              {c.skip ? ' · skipped' : ''}
                            </span>
                            {coverage?.summaries[c.id] && (
                              <span className="case-areas" data-testid="case-areas" title="The parts of the project that the case touches. Open the case to see them.">
                                {coverage.summaries[c.id]}
                              </span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            );
          })}
        </details>
      ))}
    </div>
  );
}

/** The player of a case: Play or Pause, Back, Step, a slider, the speed, and the text of the current step. */
function Player({ info, cur, playing, speed, onStep, onPlay, onSpeed, onList }: {
  info: CaseInfo | undefined; cur: number; playing: boolean; speed: number;
  onStep: (n: number) => void; onPlay: () => void; onSpeed: (s: number) => void; onList: () => void;
}) {
  const steps = info?.ok ? info.steps : [];
  const now = cur >= 0 ? steps[cur] : undefined;
  const n = steps.length;
  return (
    <div className="player" data-testid="player">
      <div className="player-row">
        <button type="button" className="player-list" data-testid="all-cases" title="Back to the list of cases" onClick={onList}>
          ‹ All cases
        </button>
        <button type="button" data-testid="step-back" aria-label="Back one step" title="Back one step" disabled={cur < 0} onClick={() => onStep(cur - 1)}>
          ◂
        </button>
        <button type="button" className="primary" data-testid="play" aria-label={playing ? 'Pause' : 'Play'} disabled={n === 0} onClick={onPlay}>
          {playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <button type="button" data-testid="step-next" aria-label="Next step" title="Next step" disabled={cur >= n - 1} onClick={() => onStep(cur + 1)}>
          ▸
        </button>
        <input
          type="range" data-testid="step-slider" aria-label="Step" min={-1} max={Math.max(n - 1, -1)} value={cur}
          onChange={(e) => onStep(Number(e.target.value))}
        />
        <span className="player-count" data-testid="step-count">
          {cur + 1} / {n}
        </span>
        <select data-testid="speed" aria-label="Speed" value={speed} onChange={(e) => onSpeed(Number(e.target.value))}>
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        {info?.result && <span className={`run run-${info.result.status}`}>last run: {STATUS_TEXT[info.result.status]}</span>}
      </div>
      <div className="player-step" data-testid="step-text">
        {!info && 'Loading the case…'}
        {info && !now && (n === 0 ? 'This case has no steps.' : 'Press Step or Play to walk through the case.')}
        {now && (
          <>
            <span className={`step-kind kind-${now.kind}`}>{now.kind}</span> {now.text}
            <span className="step-where"> · {now.file}:{now.line}</span>
            {now.failed && <span className="badge badge-fail"> ✗ failed here</span>}
            {now.targets.length > 0 && <span className="step-targets"> → {now.targets.map((t) => `${t.label}${t.mock ? ' (mock)' : ''}${t.seen ? ' (seen in the run)' : t.possible ? ' (possible)' : ''}`).join(', ')}</span>}
            {now.notes.length > 0 && <span className="step-notes"> · {now.notes.join(' · ')}</span>}
          </>
        )}
      </div>
      {info?.result?.error && cur >= 0 && steps.slice(0, cur + 1).some((s) => s.failed) && <pre className="player-error">{info.result.error.message.split('\n').slice(0, 6).join('\n')}</pre>}
    </div>
  );
}
