// The reader of a CodeGraph index (`<repo>/.codegraph/codegraph.db`, CodeGraph 1.6.4).
//
// The atlas opens the SQLite file read-only with node:sqlite and loads the code nodes and the edges
// between them once. It never writes to the index. CodeGraph makes the index (see run.ts).
//
// What the atlas takes from CodeGraph:
//   nodes    function, method, class, component (as function), route, file
//   edges    calls (with the line of the call), references, extends, implements, instantiates,
//            imports (file to file or symbol), contains (for nesting), navigates
//   calls with metadata synthesizedBy "jsx-render" are JSX renders (`<Panel />`): kind `renders`.
//   unresolved_refs   the calls into outside packages (`useState`, `os.path.join`), for the flow chart
//   import nodes      the import lines of a file, to find the package of an outside call

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { GraphNode, NodeKind, StoredRef, Trust } from './types.js';

export const CODEGRAPH_DIR = '.codegraph';
export const dbPathOf = (root: string): string => join(root, CODEGRAPH_DIR, 'codegraph.db');
export const hasIndex = (root: string): boolean => existsSync(dbPathOf(root));

export type IndexEdgeKind = 'calls' | 'references' | 'extends' | 'implements' | 'instantiates' | 'renders' | 'navigates';

export interface IndexEdge {
  from: string;
  to: string;
  kind: IndexEdgeKind;
  trust: Trust;
  line?: number;
}

/** An import line of a file: the module and the full statement text. */
export interface ImportLine {
  module: string;
  text: string;
  line: number;
}

/** A call that CodeGraph did not resolve: often a call into an outside package. */
export interface OpenCall {
  from: string;
  name: string;
  line: number;
}

const CODE_KINDS: Record<string, NodeKind> = { function: 'function', method: 'method', class: 'class', component: 'function', route: 'route', file: 'file' };
const EDGE_KINDS = ['calls', 'references', 'extends', 'implements', 'instantiates', 'navigates'];
const LANGUAGES: Record<string, string> = { typescript: 'typescript', tsx: 'typescript', javascript: 'typescript', jsx: 'typescript', python: 'python' };

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  file_path: string;
  language: string;
  start_line: number | null;
  end_line: number | null;
  is_exported: number | null;
}

interface EdgeRow {
  source: string;
  target: string;
  kind: string;
  metadata: string | null;
  line: number | null;
}

/** The trust of a CodeGraph edge: an import or a framework rule is sure; a name match is not. */
function trustOf(meta: Record<string, unknown>): Trust {
  const by = meta.resolvedBy;
  return by === 'import' || by === 'framework' || by === 'function-ref' ? 'exact' : 'name-match';
}

/** A type node of CodeGraph (the search lens). */
export interface TypeNode {
  id: string;
  /** interface, type_alias, enum or constant. */
  kind: string;
  name: string;
  file: string;
  line: number;
  /** The count of edges to the node (its users). */
  refs: number;
}

export class CodeGraphIndex {
  /** The code nodes and the file nodes, by ID. */
  readonly nodes = new Map<string, GraphNode>();
  /** The code nodes of each file (not the file node). */
  readonly nodesOfFile = new Map<string, GraphNode[]>();
  /** The source files that the atlas can read (TypeScript, JavaScript, Python), with the language. */
  readonly files = new Map<string, string>();
  /** Every file in the index, with its CodeGraph language. */
  readonly allFiles = new Map<string, string>();
  readonly out = new Map<string, IndexEdge[]>();
  readonly inn = new Map<string, IndexEdge[]>();
  /** A node → the node that holds it (a file, a class, a function). */
  readonly parent = new Map<string, string>();
  /** A file → the files it imports (file to file, or file to a symbol of a file). */
  readonly fileImports = new Map<string, Set<string>>();
  /** The keys of `project_metadata`. */
  readonly meta = new Map<string, string>();
  private readonly db: DatabaseSync;
  private readonly refCache = new Map<string, StoredRef[]>();

  private constructor(readonly root: string) {
    this.db = new DatabaseSync(dbPathOf(root), { readOnly: true });
    this.load();
  }

  static open(root: string): CodeGraphIndex {
    if (!hasIndex(root)) throw new Error(`No CodeGraph index in ${root}: ${dbPathOf(root)} is not there.`);
    return new CodeGraphIndex(root);
  }

  close(): void {
    this.db.close();
  }

  private load(): void {
    for (const r of this.db.prepare('SELECT key, value FROM project_metadata').all() as Array<{ key: string; value: string }>) this.meta.set(r.key, r.value);
    for (const r of this.db.prepare('SELECT path, language FROM files').all() as Array<{ path: string; language: string }>) {
      this.allFiles.set(r.path, r.language);
      const lang = LANGUAGES[r.language];
      if (lang) this.files.set(r.path, lang);
    }
    const kinds = Object.keys(CODE_KINDS);
    const rows = this.db.prepare(
      `SELECT id, kind, name, file_path, language, start_line, end_line, is_exported FROM nodes WHERE kind IN (${kinds.map(() => '?').join(',')})`,
    ).all(...kinds) as unknown as NodeRow[];
    for (const r of rows) {
      const language = LANGUAGES[r.language];
      if (!language) continue;
      const kind = CODE_KINDS[r.kind]!;
      const start = r.start_line ?? 0;
      const end = r.end_line ?? start;
      const n: GraphNode = {
        id: r.id, kind, name: kind === 'file' ? r.file_path.split('/').at(-1)! : r.name, file: r.file_path, range: `${start}-${end}`, language,
        ...(kind === 'route' ? { route: r.name } : {}), ...(r.is_exported ? { exported: true } : {}),
      };
      this.nodes.set(n.id, n);
      if (kind !== 'file') this.nodesOfFile.set(r.file_path, [...(this.nodesOfFile.get(r.file_path) ?? []), n]);
    }
    // Nesting: the holder of each code node. `const f = () => …` puts the function below a const
    // node: the holder of the const is the holder of the function.
    const consts = new Map<string, string>();
    const contains = this.db.prepare(
      "SELECT e.source, e.target, t.kind tk FROM edges e JOIN nodes t ON t.id = e.target WHERE e.kind = 'contains' AND t.kind IN ('function','method','class','component','constant','variable')",
    ).all() as Array<{ source: string; target: string; tk: string }>;
    for (const r of contains) {
      if (r.tk === 'constant' || r.tk === 'variable') consts.set(r.target, r.source);
      else this.parent.set(r.target, r.source);
    }
    for (const [child, holder] of this.parent) {
      const up = consts.get(holder);
      if (up !== undefined) this.parent.set(child, up);
    }
    for (const n of this.nodes.values()) {
      if (n.kind === 'file' || n.kind === 'route') continue;
      const p = this.parent.get(n.id);
      if (p === undefined || p.startsWith('file:')) n.topLevel = true;
    }
    // The edges between code nodes.
    const edgeRows = this.db.prepare(
      `SELECT source, target, kind, metadata, line FROM edges WHERE kind IN (${EDGE_KINDS.map(() => '?').join(',')})`,
    ).all(...EDGE_KINDS) as unknown as EdgeRow[];
    const seen = new Set<string>();
    for (const r of edgeRows) {
      if (!this.nodes.has(r.source) || !this.nodes.has(r.target) || r.source === r.target) continue;
      const meta = r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : {};
      const render = r.kind === 'calls' && meta.synthesizedBy === 'jsx-render';
      if (r.kind === 'calls' && meta.synthesizedBy !== undefined && !render) continue;
      const kind = (render ? 'renders' : r.kind) as IndexEdgeKind;
      const key = `${r.source}\n${r.target}\n${kind}\n${r.line ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // The line of a render edge is the first line of the function, not of the JSX: it is not kept.
      const e: IndexEdge = { from: r.source, to: r.target, kind, trust: render ? 'exact' : trustOf(meta), ...(r.line !== null && !render ? { line: r.line } : {}) };
      this.out.set(e.from, [...(this.out.get(e.from) ?? []), e]);
      this.inn.set(e.to, [...(this.inn.get(e.to) ?? []), e]);
    }
    const imports = this.db.prepare(
      "SELECT s.file_path a, t.file_path b FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target WHERE e.kind = 'imports' AND s.kind = 'file'",
    ).all() as Array<{ a: string; b: string }>;
    for (const r of imports) {
      if (r.a === r.b) continue;
      const set = this.fileImports.get(r.a) ?? new Set<string>();
      set.add(r.b);
      this.fileImports.set(r.a, set);
    }
  }

  /** The workspace manifests that CodeGraph found (package.json files), from the repo root. */
  manifests(): string[] {
    try {
      const v = JSON.parse(this.meta.get('js_workspace_manifests') ?? '{}') as { manifests?: string[] };
      return v.manifests ?? [];
    } catch {
      return [];
    }
  }

  edgesFrom(id: string): IndexEdge[] {
    return this.out.get(id) ?? [];
  }

  edgesTo(id: string): IndexEdge[] {
    return this.inn.get(id) ?? [];
  }

  /** The code nodes inside `id` (nested functions, methods), at any depth. */
  inside(id: string): string[] {
    const out: string[] = [];
    const n = this.nodes.get(id);
    if (!n?.file) return out;
    const kids = new Map<string, string[]>();
    for (const m of this.nodesOfFile.get(n.file) ?? []) {
      const p = this.parent.get(m.id);
      if (p !== undefined) kids.set(p, [...(kids.get(p) ?? []), m.id]);
    }
    for (const queue = [id]; queue.length > 0; ) {
      for (const k of kids.get(queue.shift()!) ?? []) {
        out.push(k);
        queue.push(k);
      }
    }
    return out;
  }

  /** The call sites in a file, in line order: the resolved calls of each code node of the file. */
  refs(file: string): StoredRef[] {
    let list = this.refCache.get(file);
    if (list) return list;
    list = [];
    for (const n of this.nodesOfFile.get(file) ?? []) {
      for (const e of this.edgesFrom(n.id)) {
        if (e.kind !== 'calls' || e.line === undefined) continue;
        list.push({ from: n.id, name: this.nodes.get(e.to)?.name ?? '', line: e.line, kind: 'calls', resolvedTo: e.to, resolvedTrust: e.trust });
      }
    }
    list.sort((a, b) => a.line - b.line || (a.from < b.from ? -1 : 1));
    this.refCache.set(file, list);
    return list;
  }

  /**
   * The type nodes (interfaces, type aliases, enums and exported constants) with their count of
   * references. The atlas does not load them in its graph: only the search lens reads them, once.
   */
  typeNodes(): TypeNode[] {
    const rows = this.db.prepare(
      "SELECT n.id, n.kind, n.name, n.file_path, n.start_line, (SELECT count(*) FROM edges e WHERE e.target = n.id AND e.kind <> 'contains') AS refs FROM nodes n WHERE n.kind IN ('interface', 'type_alias', 'enum') OR (n.kind = 'constant' AND n.is_exported = 1)",
    ).all() as Array<{ id: string; kind: string; name: string; file_path: string; start_line: number; refs: number }>;
    return rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, file: r.file_path, line: r.start_line, refs: r.refs }));
  }

  /** The import lines of a file. */
  imports(file: string): ImportLine[] {
    const rows = this.db.prepare("SELECT name, signature, start_line FROM nodes WHERE kind = 'import' AND file_path = ? ORDER BY start_line").all(file) as Array<{ name: string; signature: string | null; start_line: number }>;
    return rows.map((r) => ({ module: r.name, text: r.signature ?? '', line: r.start_line }));
  }

  /** The calls that CodeGraph did not resolve, from the given nodes. */
  openCalls(ids: string[]): OpenCall[] {
    if (ids.length === 0) return [];
    const rows = this.db.prepare(
      `SELECT from_node_id, reference_name, line FROM unresolved_refs WHERE reference_kind = 'calls' AND from_node_id IN (${ids.map(() => '?').join(',')})`,
    ).all(...ids) as Array<{ from_node_id: string; reference_name: string; line: number }>;
    return rows.map((r) => ({ from: r.from_node_id, name: r.reference_name, line: r.line }));
  }
}
