// The setup of a React component in a flow chart: a component often starts with many hook
// calls, one node each, and the chart becomes one long column. This step joins a run of these
// nodes into one node for each kind of hook: "state: 14 useState", "memo: 9 useCallback, 3 useMemo".
// The panel shows the lines of a joined node, and each line opens as the node did before.
//
// A run is a chain of plain nodes at the top level of the function (steps, calls, callbacks), with
// one edge from each node to the next. A run is joined only when it has two or more hook calls.
// A kind with one node of one statement keeps that node as it was.

import type { ChartEdge, ChartNode } from '../flow/chart.js';
import type { ViewEdge, ViewItem, ViewNode } from './view.js';

/** The kinds of hooks, in the order of the joined nodes. `other`: the statements with no hook. */
export const HOOK_KINDS = ['state', 'context', 'refs', 'memo', 'effects', 'hooks', 'other'] as const;
export type HookKind = (typeof HOOK_KINDS)[number];

const KIND_OF: Record<string, HookKind> = {
  useState: 'state', useReducer: 'state', useContext: 'context', useRef: 'refs', useMemo: 'memo', useCallback: 'memo',
  useEffect: 'effects', useLayoutEffect: 'effects', useInsertionEffect: 'effects',
};
const HOOK_CALL = /\b(use[A-Z]\w*)\s*(?:<[^>]*>)?\s*\(/;
const PLAIN = new Set(['steps', 'call', 'nested', 'await']);

export const hookKind = (name: string): HookKind => KIND_OF[name] ?? 'hooks';

/** The hook that a line of code calls first, if any. */
export function hookOfLine(text: string): string | undefined {
  const t = text.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return undefined;
  return HOOK_CALL.exec(t)?.[1];
}

interface Line {
  kind: HookKind;
  hook?: string;
  /** The number of statements of the line: more than 1 for the rest of a run of statements. */
  weight: number;
  item: ViewItem;
  /** The view node that the line came from. */
  from: string;
}

/**
 * Join the hook runs of a flow chart. `lines` gives the source lines of the file (1-based), and
 * `view` maps a chart node ID to its view node. It gives the new nodes and edges.
 */
export function joinHooks(
  chart: { nodes: ChartNode[]; edges: ChartEdge[] },
  view: { nodes: ViewNode[]; edges: ViewEdge[] },
  lines: (n: number) => string | undefined,
): { nodes: ViewNode[]; edges: ViewEdge[] } {
  const outs = new Map<string, ChartEdge[]>();
  const ins = new Map<string, ChartEdge[]>();
  for (const e of chart.edges) {
    outs.set(e.from, [...(outs.get(e.from) ?? []), e]);
    ins.set(e.to, [...(ins.get(e.to) ?? []), e]);
  }
  const plain = (n: ChartNode) => PLAIN.has(n.kind) && n.depth === 0;
  // The runs: chains of plain nodes, each one the only next node of the one before.
  const runs: ChartNode[][] = [];
  let run: ChartNode[] = [];
  for (const n of chart.nodes) {
    const prev = run.at(-1);
    const linked = prev !== undefined && outs.get(prev.id)?.length === 1 && outs.get(prev.id)![0]!.to === n.id && ins.get(n.id)?.length === 1 && outs.get(prev.id)![0]!.kind === 'next';
    if (plain(n) && (prev === undefined || linked)) {
      run.push(n);
      continue;
    }
    if (run.length > 0) runs.push(run);
    run = plain(n) ? [n] : [];
  }
  if (run.length > 0) runs.push(run);

  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const replace = new Map<string, string>();
  const added = new Map<string, ViewNode[]>();
  const chains: ViewEdge[] = [];
  for (const r of runs) {
    const split = r.flatMap((n) => linesOf(n, byId.get(n.id)!, lines));
    if (r.length < 2 || split.filter((l) => l.hook).length < 2) continue;
    const groups = HOOK_KINDS.map((k) => split.filter((l) => l.kind === k)).filter((g) => g.length > 0);
    const joined: ViewNode[] = groups.map((g) => {
      const only = byId.get(g[0]!.from)!;
      // A node with one line of one statement keeps its look.
      if (g.length === 1 && g[0]!.weight === 1 && split.filter((l) => l.from === only.id).length === 1) return only;
      return joinedNode(g, only);
    });
    // Each old node maps to the first joined node that holds one of its lines.
    for (const n of r) replace.set(n.id, joined[groups.findIndex((g) => g.some((l) => l.from === n.id))]!.id);
    added.set(r[0]!.id, joined);
    for (let i = 1; i < joined.length; i++) chains.push({ id: `${joined[i - 1]!.id}>${joined[i]!.id}`, from: joined[i - 1]!.id, to: joined[i]!.id, kind: 'flow' });
    const first = joined[0]!.id;
    const last = joined.at(-1)!.id;
    // The edges into the run go to the first joined node; the edge out of the run leaves the last.
    for (const n of r) {
      replace.set(`in:${n.id}`, first);
      replace.set(`out:${n.id}`, last);
    }
  }
  if (added.size === 0) return view;

  const inRun = (id: string) => replace.has(`in:${id}`);
  const nodes: ViewNode[] = [];
  for (const n of view.nodes) {
    const add = added.get(n.id);
    if (add) nodes.push(...add);
    else if (!inRun(n.id)) nodes.push(n);
  }
  const edges: ViewEdge[] = [];
  const seen = new Set<string>();
  const push = (e: ViewEdge) => {
    if (e.from === e.to || seen.has(`${e.from}>${e.to}:${e.label ?? ''}`)) return;
    seen.add(`${e.from}>${e.to}:${e.label ?? ''}`);
    edges.push(e);
  };
  for (const e of view.edges) {
    const a = inRun(e.from);
    const b = inRun(e.to);
    if (a && b) continue; // the old chain inside a run
    if (b) push({ ...e, to: replace.get(`in:${e.to}`)! });
    else if (a && e.kind === 'http') push({ ...e, id: `${replace.get(e.from)}>${e.to}`, from: replace.get(e.from)! });
    else if (a) push({ ...e, from: replace.get(`out:${e.from}`)! });
    else push(e);
  }
  for (const e of chains) push(e);
  return { nodes, edges };
}

/** The lines of a node, each with its kind of hook. A run of statements gives one line for each hook call, and one line for the rest. */
function linesOf(n: ChartNode, v: ViewNode, lines: (n: number) => string | undefined): Line[] {
  if (n.kind !== 'steps' || (n.count ?? 1) <= 1) {
    const hook = n.hook ?? hookOfLine(lines(n.start) ?? n.text ?? '');
    return [{ kind: hook ? hookKind(hook) : 'other', ...(hook ? { hook } : {}), weight: 1, from: n.id, item: { label: v.label, line: n.start, ...(v.open ? { open: v.open } : {}) } }];
  }
  const out: Line[] = [];
  for (let i = n.start; i <= n.end; i++) {
    const text = lines(i);
    const hook = text === undefined ? undefined : hookOfLine(text);
    if (hook) out.push({ kind: hookKind(hook), hook, weight: 1, from: n.id, item: { label: text!.trim(), line: i } });
  }
  const rest = (n.count ?? 1) - out.length;
  if (rest > 0) {
    // The first line with no hook call shows where the rest of the statements start.
    let at = n.start;
    for (let i = n.start; i <= n.end; i++) {
      const t = lines(i)?.trim() ?? '';
      if (t !== '' && !/^[)}\]]/.test(t) && !out.some((l) => l.item.line === i) && !insideHook(out, i, lines)) {
        at = i;
        break;
      }
    }
    const text = lines(at)?.trim() ?? n.text ?? v.label;
    out.push({ kind: 'other', weight: rest, from: n.id, item: { label: rest === 1 ? text : `${rest} statements, the first: ${text}`, line: at } });
  }
  return out;
}

/** True if line `i` continues a hook call of an earlier line: the brackets of that call are not closed yet. */
function insideHook(out: Line[], i: number, lines: (n: number) => string | undefined): boolean {
  const before = out.filter((l) => (l.item.line ?? 0) < i).at(-1);
  if (!before) return false;
  let depth = 0;
  for (let k = before.item.line!; k < i; k++) for (const c of lines(k) ?? '') depth += '([{'.includes(c) ? 1 : ')]}'.includes(c) ? -1 : 0;
  return depth > 0;
}

function joinedNode(g: Line[], first: ViewNode): ViewNode {
  const kind = g[0]!.kind;
  const counts = new Map<string, number>();
  for (const l of g) if (l.hook) counts.set(l.hook, (counts.get(l.hook) ?? 0) + 1);
  const steps = g.reduce((sum, l) => sum + l.weight, 0);
  const text = kind === 'other'
    ? `${steps} ${steps === 1 ? 'step' : 'steps'}`
    : [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).map(([h, c]) => `${c} ${h}`).join(', ');
  const lines = g.map((l) => l.item.line ?? 0).filter((x) => x > 0);
  const start = Math.min(...lines);
  const end = Math.max(...lines);
  return {
    id: `join:${kind}:${g[0]!.from}`, shape: 'step', label: `${kind}: ${text}`, sub: start === end ? `line ${start}` : `lines ${start}-${end}`,
    ...(first.tone !== undefined ? { tone: first.tone } : {}), ...(first.file ? { file: first.file, line: start } : {}),
    items: g.map((l) => l.item),
  };
}
