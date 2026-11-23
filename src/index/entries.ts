// The entries of a project : the places where a call into the
// project starts. An entry is a route, a CLI command, a page or view, or an exported function that
// no code in the project calls. A route or a command in a dispatch function is a "virtual" entry:
// it has no node of its own, so it has the calls of its lines of code.

import { posix } from 'node:path';
import type { GraphNode, StoredRef, Trust } from './types.js';

export type EntryKind = 'route' | 'command' | 'page' | 'export';

/** An edge of the System map. `renders` is a JSX use of a component (`<Panel />`). */
export type SystemEdgeKind = 'calls' | 'references' | 'extends' | 'implements' | 'renders';

/** An edge between two atoms: a code node ID, or the ID of a virtual entry. */
export interface SystemEdge {
  from: string;
  to: string;
  kind: SystemEdgeKind;
  trust: Trust;
  /** The line of the call, if the reader knows it. */
  line?: number;
}

export interface Entry {
  /** A code node ID, or `route:<file>#<path>` and `command:<file>#<name>` for a virtual entry. */
  id: string;
  kind: EntryKind;
  name: string;
  file: string;
  /** First and last line, as `12-20`. */
  range: string;
  /** A virtual entry: the code node that holds its lines. */
  owner?: string;
  /** A virtual entry: the calls in its lines, in source order. */
  calls?: SystemEdge[];
  /** A route: the paths on the line. */
  paths?: string[];
}

/** What findEntries reads. SystemMap gives it from the store; a test gives it from fake data. */
export interface EntryFacts {
  /** The code nodes of the project that are not tests: files, classes, functions, methods, routes. */
  nodes: GraphNode[];
  /** The text of a repo file, or undefined. */
  read(file: string): string | undefined;
  /** The call sites in a file, in line order. */
  refs(file: string): StoredRef[];
  /** The code in the project that is not a test or a file node and has an edge to `id`. */
  callers(id: string): string[];
  /** The edges from `id`. */
  out(id: string): SystemEdge[];
}

const ROUTE_RE = /(?:===?\s*|startsWith\(\s*|case\s+|\.(?:get|post|put|patch|delete|all|route)\(\s*)(['"`])(\/[^'"`\s]+)\1/g;
const COMMAND_RE = /\b(?:command|cmd|subcommand)\s*===?\s*(['"])([a-z][\w-]*)\1/g;
/** A dispatch line: an `if`, a `case` or a router call. A ternary or a plain compare is not a block. */
const DISPATCH_RE = /^\s*(?:\}\s*)?(?:else\s+)?if\s*\(|^\s*case\b|\.(?:get|post|put|patch|delete|all|route)\(/;
/** A route path with a word in it, not a placeholder only: `/api/orders`, not `//` or `/{id}`. */
const isRoutePath = (p: string): boolean => /[a-z]/i.test(p.replace(/\{[^}]*\}|:\w+/g, '')) && !p.startsWith('/dev/');
const PAGE_RE = /(?:Page|View|Screen)$/;
const PAGE_DIR_RE = /(?:^|\/)(?:pages|views|screens)\//;
const SCRIPT_RE = /\.(?:[cm]?[jt]sx?)$/;

/** A virtual entry of dispatch code: `route:<file>#<path>` or `command:<file>#<name>`. A CodeGraph route node ID (`route:<file>:<line>:…`) has no `#`. */
export const isVirtual = (id: string): boolean => /^(?:route|command):[^#]*#/.test(id);

const lineRange = (range: string | undefined): [number, number] => {
  const [a, b] = (range ?? '0-0').split('-').map(Number);
  return [a ?? 0, b ?? a ?? 0];
};

/** The entries of one project, in a fixed order: routes, commands, pages, exports; then by file and line. */
export function findEntries(facts: EntryFacts): Entry[] {
  const byFile = new Map<string, GraphNode[]>();
  for (const n of facts.nodes) {
    if (n.file === undefined) continue;
    const list = byFile.get(n.file) ?? [];
    list.push(n);
    byFile.set(n.file, list);
  }
  const files = [...byFile.keys()].sort();

  // 1. Routes and commands: the lines of dispatch code.
  const virtual: Entry[] = [];
  for (const file of files) {
    if (!SCRIPT_RE.test(file)) continue;
    const text = facts.read(file);
    if (text === undefined) continue;
    virtual.push(...dispatchEntries(file, text.split('\n'), byFile.get(file)!, facts));
  }
  // A route line in a function that a route block calls is a part of that route, not an entry.
  const calledByBlock = new Set(virtual.flatMap((e) => (e.calls ?? []).map((c) => c.to)));
  const kept = virtual.filter((e) => e.owner === undefined || !calledByBlock.has(e.owner));
  // A dispatch function is the sum of its routes and commands, not an entry of its own.
  const owners = new Set(kept.map((e) => e.owner));

  // 2. Functions: Python routes, pages and views, and exported functions with no caller.
  const fns: Entry[] = [];
  for (const file of files) {
    const nodes = byFile.get(file)!;
    const text = facts.read(file);
    const lines = text?.split('\n');
    for (const n of nodes) {
      if (n.kind === 'route') {
        fns.push({ id: n.id, kind: 'route', name: n.route ?? n.name, file, range: n.range ?? '' });
        continue;
      }
      // A method is a part of its class, not an entry of the project. An exported class is an entry.
      if (n.kind !== 'function' && n.kind !== 'class') continue;
      if (owners.has(n.id) || !isExported(n, lines)) continue;
      if (facts.callers(n.id).length > 0) continue;
      const page = n.kind === 'function' && /\.[jt]sx$/.test(file) && /^[A-Z]/.test(n.name) && (PAGE_RE.test(n.name) || PAGE_DIR_RE.test(file));
      fns.push({ id: n.id, kind: page ? 'page' : 'export', name: n.name, file, range: n.range ?? '' });
    }
  }
  const order: Record<EntryKind, number> = { route: 0, command: 1, page: 2, export: 3 };
  const at = (e: Entry) => lineRange(e.range)[0];
  return [...kept, ...fns].sort((a, b) => order[a.kind] - order[b.kind] || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || at(a) - at(b) || (a.id < b.id ? -1 : 1));
}

/** Is the function or class a part of the module API: `export` on its first lines, or a public top-level Python def or class. */
function isExported(n: GraphNode, lines: string[] | undefined): boolean {
  if (n.language === 'python') return !n.name.startsWith('_') && n.topLevel === true;
  if (n.exported) return true;
  if (!lines) return false;
  const [start, end] = lineRange(n.range);
  for (let i = start; i <= Math.min(end, start + 2); i++) {
    const line = lines[i - 1] ?? '';
    if (/^\s*export\b/.test(line)) return true;
    if (line.trim() !== '' && !/^\s*(?:\/\/|\/\*|\*|@)/.test(line)) break;
  }
  return false;
}

/** The innermost function, method or route of a file that holds `line`. */
function holder(nodes: GraphNode[], line: number): GraphNode | undefined {
  let best: GraphNode | undefined;
  let size = Infinity;
  for (const n of nodes) {
    if (n.kind !== 'function' && n.kind !== 'method' && n.kind !== 'route') continue;
    const [a, b] = lineRange(n.range);
    if (a <= line && line <= b && b - a < size) {
      best = n;
      size = b - a;
    }
  }
  return best;
}

/** The route and command entries of one file. */
function dispatchEntries(file: string, lines: string[], nodes: GraphNode[], facts: EntryFacts): Entry[] {
  const out: Entry[] = [];
  let refs: StoredRef[] | undefined;
  const seen = new Set<string>();
  // A dispatch line inside an earlier block is a part of that block.
  const inBlock = (line: number) => out.some((e) => {
    const [a, b] = lineRange(e.range);
    return line > a && line <= b;
  });
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
    if (!DISPATCH_RE.test(line) || inBlock(i + 1)) continue;
    const routes = [...line.matchAll(ROUTE_RE)].map((m) => m[2]!).filter(isRoutePath);
    const commands = routes.length > 0 ? [] : [...line.matchAll(COMMAND_RE)].map((m) => m[2]!);
    if (routes.length === 0 && commands.length === 0) continue;
    const start = i + 1;
    const end = blockEnd(lines, i, /^\s*case\b/.test(line));
    const owner = holder(nodes, start);
    refs ??= facts.refs(file);
    const calls = blockCalls(refs.filter((r) => r.line >= start && r.line <= end), owner, facts);
    const kind: EntryKind = routes.length > 0 ? 'route' : 'command';
    const names = [...new Set(routes.length > 0 ? routes : commands)];
    const id = `${kind}:${file}#${names[0]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id, kind, name: names.join(' · '), file, range: `${start}-${end}`,
      ...(owner ? { owner: owner.id } : {}), calls,
      ...(kind === 'route' ? { paths: names } : {}),
    });
  }
  return out;
}

/** The last line of the block that starts on line `i` (0-based): the matching brace, or the end of the statement. */
function blockEnd(lines: string[], i: number, isCase: boolean): number {
  if (isCase) {
    let depth = 0;
    for (let j = i; j < lines.length; j++) {
      if (j > i && depth === 0 && /^\s*(?:case\b|default\s*:)/.test(lines[j]!)) return j;
      depth += braces(lines[j]!);
      if (depth < 0) return j;
    }
    return lines.length;
  }
  const first = lines[i]!;
  const open = first.lastIndexOf('{');
  // A one-line statement: `if (cmd === 'x') return run(x);`.
  if (open < 0 || braces(first) <= 0) return i + 1;
  let depth = 0;
  for (let j = i; j < lines.length; j++) {
    depth += braces(lines[j]!);
    if (depth <= 0) return j + 1;
  }
  return lines.length;
}

/** The count of `{` less the count of `}` in a line, with strings and line comments removed. */
function braces(line: string): number {
  const bare = line.replace(/\/\/.*$/, '').replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '');
  let n = 0;
  for (const ch of bare) {
    if (ch === '{') n++;
    else if (ch === '}') n--;
  }
  return n;
}

/** The calls of a block of lines: the target of each call site, in line order, one edge per target. */
function blockCalls(refs: StoredRef[], owner: GraphNode | undefined, facts: EntryFacts): SystemEdge[] {
  const out: SystemEdge[] = [];
  const seen = new Set<string>();
  const outOf = new Map<string, SystemEdge[]>();
  for (const r of refs) {
    if (r.kind !== 'calls') continue;
    let to = r.resolvedTo;
    let trust: Trust = r.resolvedTrust ?? 'exact';
    if (to === undefined) {
      const from = r.from;
      if (!outOf.has(from)) outOf.set(from, facts.out(from));
      const hit = outOf.get(from)!.find((e) => e.kind === 'calls' && e.trust !== 'unresolved' && nameOf(e.to) === r.name);
      if (!hit) continue;
      to = hit.to;
      trust = hit.trust;
    }
    if (to === owner?.id || seen.has(to)) continue;
    seen.add(to);
    out.push({ from: '', to, kind: 'calls', trust, line: r.line });
  }
  return out;
}

/** The short name in a symbol ID: `.../orders.ts/getOrder().` → `getOrder`. */
export function nameOf(id: string): string {
  const m = /([\w$]+)(?:\(\+?\d*\))?\.?$/.exec(id.replace(/\(\)\.$/, '').replace(/#$/, ''));
  return m?.[1] ?? id;
}

/** The words of a path or a name, for the names of feature groups. */
export function wordsOf(text: string): string[] {
  return text
    .replace(/\.[a-z]+$/, '')
    .split(/[/\\._\-\s]+|(?<=[a-z0-9])(?=[A-Z])/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 1);
}

/** The folder of a file, below `root`, or '' for a file in `root`. */
export function folderBelow(file: string, root: string): string {
  const rel = root === '' ? file : file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
  const dir = posix.dirname(rel);
  return dir === '.' ? '' : dir.split('/')[0]!;
}
