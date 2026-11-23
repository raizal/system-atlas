// The map of the atlas over a CodeGraph index: the projects, the code of each project, the entries
// of each project (routes, commands, pages, exports), the features of a library, and the drawn edges
// between code nodes (calls, renders, references, extends, implements).

import { findEntries, isVirtual, type Entry, type SystemEdge, type SystemEdgeKind } from './entries.js';
import { findFeatures, type Feature } from './features.js';
import { findUnits, isTestPath, type Unit } from './projects.js';
import type { CodeGraphIndex, IndexEdge } from './codegraph.js';
import type { GraphNode } from './types.js';

/** The edges that a node "holds": a caller of this kind makes a function not an entry. */
const HOLD_KINDS: readonly SystemEdgeKind[] = ['calls', 'references', 'renders', 'extends', 'implements'];
const ATOM_KINDS = new Set(['class', 'function', 'method', 'route']);
const REACH_LIMIT = 3000;
/** A route with a method: `POST /orders`. A route with no method is a page path (`/orders/:id`). */
const METHOD_ROUTE = /^[A-Z]+\s+\//;
/** A page component by its name or folder (the rule of entries.ts). */
const isPageLike = (n: GraphNode | undefined): boolean =>
  n !== undefined && n.kind === 'function' && /\.[jt]sx$/.test(n.file ?? '') && /^[A-Z]/.test(n.name) && (/(?:Page|View|Screen)$/.test(n.name) || /(?:^|\/)(?:pages|views|screens)\//.test(n.file ?? ''));

export interface CodeInfo {
  node: GraphNode;
  unit: string;
  test: boolean;
}

export interface MapUnit extends Unit {
  /** The code node IDs of the project (not the file nodes). */
  ids: string[];
}

interface Atom {
  id: string;
  unit: string;
  name: string;
  file?: string;
  range?: string;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class AtlasMap {
  readonly units = new Map<string, MapUnit>();
  /** The code nodes and the file nodes, with the project of each. */
  readonly code = new Map<string, CodeInfo>();
  /** A route node → the function that handles it. */
  readonly handlerOf = new Map<string, string>();
  readonly totals: { files: number };
  private readonly atoms = new Map<string, Atom>();
  private readonly out = new Map<string, SystemEdge[]>();
  private readonly inn = new Map<string, SystemEdge[]>();
  private readonly entriesOf = new Map<string, Entry[]>();
  private readonly featuresOf = new Map<string, Feature[]>();

  constructor(
    readonly index: CodeGraphIndex,
    private readonly read: (file: string) => string | undefined,
  ) {
    const { units, unitOf } = findUnits({ files: index.allFiles, manifests: index.manifests(), read });
    for (const u of units) this.units.set(u.key, { ...u, ids: [] });
    this.totals = { files: index.files.size };
    for (const n of index.nodes.values()) {
      const u = unitOf(n.file!);
      let unit = this.units.get(u.key);
      if (!unit) this.units.set(u.key, (unit = { ...u, ids: [] }));
      const test = isTestPath(n.file!);
      this.code.set(n.id, { node: n, unit: u.key, test });
      if (n.kind === 'file') continue;
      unit.ids.push(n.id);
      if (ATOM_KINDS.has(n.kind)) this.atoms.set(n.id, { id: n.id, unit: u.key, name: n.name, file: n.file!, range: n.range! });
    }
    // The handler of a route: the function that the route node calls or references.
    for (const n of index.nodes.values()) {
      if (n.kind !== 'route') continue;
      const h = index.edgesFrom(n.id).find((e) => (e.kind === 'calls' || e.kind === 'references') && ATOM_KINDS.has(index.nodes.get(e.to)?.kind ?? '') && index.nodes.get(e.to)?.kind !== 'route');
      if (h) this.handlerOf.set(n.id, h.to);
    }
    this.linkEdges();
    this.findAllEntries();
  }

  private link(e: SystemEdge, seen: Set<string>): void {
    const key = `${e.from}\n${e.to}\n${e.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    this.out.set(e.from, [...(this.out.get(e.from) ?? []), e]);
    this.inn.set(e.to, [...(this.inn.get(e.to) ?? []), e]);
  }

  private seen = new Set<string>();

  /** The drawn edges. A name match into another project counts only when the file of the caller imports the file of the target. */
  private linkEdges(): void {
    const kindOf = (e: IndexEdge): SystemEdgeKind | undefined =>
      e.kind === 'instantiates' ? 'references' : e.kind === 'navigates' ? undefined : (e.kind as SystemEdgeKind);
    for (const [from, list] of this.index.out) {
      const a = this.atoms.get(from);
      if (!a) continue;
      for (const e of list) {
        const b = this.atoms.get(e.to);
        const kind = kindOf(e);
        if (!b || !kind || e.trust === 'unresolved' || e.from === e.to) continue;
        if (e.trust === 'name-match' && a.unit !== b.unit && !this.index.fileImports.get(a.file!)?.has(b.file!)) continue;
        this.link({ from, to: e.to, kind, trust: e.trust, ...(e.line !== undefined ? { line: e.line } : {}) }, this.seen);
      }
    }
  }

  private isInside(id: string, holder: string): boolean {
    for (let p = this.index.parent.get(id); p !== undefined; p = this.index.parent.get(p)) if (p === holder) return true;
    return false;
  }

  private findAllEntries(): void {
    for (const [key, unit] of [...this.units].sort(([a], [b]) => cmp(a, b))) {
      const nodes = unit.ids.map((id) => this.code.get(id)!).filter((c) => !c.test && ATOM_KINDS.has(c.node.kind)).map((c) => c.node);
      const found = findEntries({
        nodes,
        read: this.read,
        refs: (f) => this.index.refs(f),
        // A caller inside the node (a method of the class, a nested function) or a route node does not count.
        // A page component that other code only names (a route table, `const Status = StatusView`) is still a page.
        callers: (id) => {
          const page = isPageLike(this.code.get(id)?.node);
          return (this.inn.get(id) ?? [])
            .filter((e) => HOLD_KINDS.includes(e.kind) && !(page && e.kind === 'references') && !this.isInside(e.from, id) && this.atoms.get(e.from)?.unit === key && this.code.get(e.from)?.node.kind !== 'route')
            .map((e) => e.from);
        },
        out: (id) => this.out.get(id) ?? [],
      });
      // A route with no method is a page of a frontend (Next.js app router): the entry is its page component.
      const entries: Entry[] = [];
      const pageIds = new Set<string>();
      const handlers = new Set(found.filter((e) => e.kind === 'route' && !isVirtual(e.id)).map((e) => this.handlerOf.get(e.id)).filter((h) => h !== undefined));
      for (const e of found) {
        if (e.kind !== 'route' || isVirtual(e.id)) continue;
        const n = this.code.get(e.id)!.node;
        if (METHOD_ROUTE.test(n.route ?? '')) continue;
        const h = this.handlerOf.get(e.id);
        const hn = h ? this.code.get(h)?.node : undefined;
        if (!hn || pageIds.has(hn.id)) continue;
        pageIds.add(hn.id);
        entries.push({ id: hn.id, kind: 'page', name: n.route ?? n.name, file: hn.file!, range: hn.range! });
      }
      for (const e of found) {
        if (e.kind === 'route' && !isVirtual(e.id) && !METHOD_ROUTE.test(this.code.get(e.id)?.node.route ?? '')) continue;
        if (pageIds.has(e.id)) continue;
        // The handler of a route (the `GET` function of a Next.js route file) is a part of the route, not an export.
        if (e.kind === 'export' && handlers.has(e.id)) continue;
        entries.push(e);
      }
      const order: Record<Entry['kind'], number> = { route: 0, command: 1, page: 2, export: 3 };
      entries.sort((a, b) => order[a.kind] - order[b.kind] || cmp(a.file, b.file) || Number(a.range.split('-')[0]) - Number(b.range.split('-')[0]) || cmp(a.id, b.id));
      this.entriesOf.set(key, entries);
      // The virtual entries of dispatch code: an atom with the calls of its lines.
      const blockTargets = new Map<string, Set<string>>();
      for (const e of entries) {
        if (!e.calls) continue;
        this.atoms.set(e.id, { id: e.id, unit: key, name: e.name, file: e.file, range: e.range });
        for (const c of e.calls) if (this.atoms.has(c.to)) this.link({ ...c, from: e.id }, this.seen);
        if (e.owner) {
          const set = blockTargets.get(e.owner) ?? new Set();
          for (const c of e.calls) set.add(c.to);
          blockTargets.set(e.owner, set);
        }
      }
      for (const [owner, targets] of blockTargets) this.dropBlockCalls(owner, targets, entries);
    }
  }

  /** A dispatch function keeps the calls on its own lines only: the calls in its blocks belong to the virtual entries. */
  private dropBlockCalls(owner: string, targets: Set<string>, entries: Entry[]): void {
    const atom = this.atoms.get(owner);
    if (!atom?.file) return;
    const blocks = entries.filter((e) => e.owner === owner).map((e) => e.range.split('-').map(Number) as [number, number]);
    const [start, end] = (atom.range ?? '0-0').split('-').map(Number) as [number, number];
    const keep = new Set<string>();
    for (const r of this.index.refs(atom.file)) {
      if (r.from !== owner || r.line < start || r.line > end || blocks.some(([a, b]) => r.line >= a && r.line <= b)) continue;
      keep.add(r.resolvedTo ?? r.name);
    }
    const drop = (e: SystemEdge) => e.from === owner && targets.has(e.to) && e.kind === 'calls' && !keep.has(e.to);
    this.out.set(owner, (this.out.get(owner) ?? []).filter((e) => !drop(e)));
    for (const t of targets) this.inn.set(t, (this.inn.get(t) ?? []).filter((e) => !drop(e)));
  }

  /** The entries of a project, in order. */
  entries(unit: string): Entry[] {
    return this.entriesOf.get(unit) ?? [];
  }

  /** The features of a project: route and command groups, folders, then clusters. */
  features(unit: string): Feature[] {
    let list = this.featuresOf.get(unit);
    if (!list) {
      const u = this.units.get(unit);
      list = u ? findFeatures({ dir: u.dir, entries: this.entries(unit), reach: (e) => this.reach(e.id, unit) }) : [];
      this.featuresOf.set(unit, list);
    }
    return list;
  }

  /** The atoms that `from` reaches in its own project. */
  reach(from: string, unit: string): Set<string> {
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length > 0 && seen.size < REACH_LIMIT) {
      const id = queue.shift()!;
      for (const e of this.edgesFrom(id)) {
        if (seen.has(e.to) || this.unitOf(e.to)?.unit !== unit) continue;
        seen.add(e.to);
        queue.push(e.to);
      }
    }
    return seen;
  }

  edgesFrom(id: string): SystemEdge[] {
    return this.out.get(id) ?? [];
  }

  edgesTo(id: string): SystemEdge[] {
    return this.inn.get(id) ?? [];
  }

  /** The project of a code node or a virtual entry. */
  unitOf(id: string): { unit: string; outside: boolean } | undefined {
    const a = this.atoms.get(id);
    if (a) return { unit: a.unit, outside: false };
    const c = this.code.get(id);
    return c ? { unit: c.unit, outside: false } : undefined;
  }

  /** The name of a code node or a virtual entry. */
  nameOf(id: string): string {
    return this.atoms.get(id)?.name ?? this.code.get(id)?.node.name ?? id;
  }
}
