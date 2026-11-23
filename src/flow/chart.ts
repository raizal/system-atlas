// The flowchart of one function: the control flow of its body, made from the tree-sitter
// syntax tree. The file is parsed again,; graph.db does not keep
// the chart.
//
// A run of plain statements is one node ("3 statements", with its first line). A condition is a
// diamond: if / else if / else, switch and match cases, and `?:`, `&&` and `||` when they decide a
// return or a throw. A loop is a node with a back edge. try, catch, finally, except and with have
// their own nodes, and return, throw, raise, break, continue, await and yield are clear exits. A call
// to a function that the graph knows is on the node of its line, so the reader can open the chart of
// that function. A nested function or callback is one node that the reader can open. Each node has
// its line range. A branch deeper than MAX_DEPTH folds into one node ("+N steps"). The chart does
// not guess: a language with no reader gets the note "no flowchart for this language".
//
// The options of the atlas: `limit` keeps a chart small (fewer levels first, then "+N more" with
// the file and line of the rest), `libraries` puts the calls into outside packages on the nodes,
// and `block` gives the chart of one route block in a dispatch function. A React component gets an
// `event` node for each JSX event handler (`onClick={save}`) after its render, and a hook call
// (`useEffect`, `useQuery`) has its name on the node.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Parser, type Language, type Node } from 'web-tree-sitter';
import type { GraphNode, NodeKind, Trust } from '../index/types.js';
import { loadGrammars, spanning } from './grammars.js';

/** A function that a chart step calls. */
export interface FlowFunction {
  id: string;
  name: string;
  kind: NodeKind;
  file: string;
  /** The first line of the function, 1-based. */
  line: number;
  /** First and last line, as `12-20`. */
  range?: string;
}

/** A call in the function to a function of the repo. */
export interface CallSite {
  line: number;
  fn: FlowFunction;
  trust: Exclude<Trust, 'unresolved'>;
}

/** What a chart reads from the index. */
export interface ChartSource {
  node(id: string): GraphNode | undefined;
  /** The calls of the function to functions of the repo, in line order. */
  callSites(id: string): CallSite[];
  /** The calls of the function into outside packages, in line order. */
  libSites(id: string): ChartLib[];
}

/** The note of a function in a language with no reader. */
export const NO_FLOWCHART = 'no flowchart for this language';
/** Branches deeper than this fold into one node, until the reader opens them. */
export const MAX_DEPTH = 3;

const CHART_KINDS: readonly NodeKind[] = ['function', 'method', 'route', 'test'];
const MAX_LABEL = 60;

export type ChartNodeKind =
  | 'start' | 'steps' | 'call' | 'nested' | 'decision' | 'loop' | 'try' | 'catch' | 'finally' | 'with'
  | 'return' | 'throw' | 'break' | 'continue' | 'await' | 'yield' | 'fold' | 'end' | 'event' | 'more';

/** A call into an outside package on the lines of a node: a leaf, the reader cannot open it. */
export interface ChartLib {
  line: number;
  name: string;
  package: string;
}

/** A call on the lines of a node to a function that the graph knows. */
export interface ChartCall {
  line: number;
  fn: FlowFunction;
  trust: Exclude<Trust, 'unresolved'>;
}

/** A nested function or callback: the reader opens its chart with `at`. */
export interface ChartNested {
  name: string;
  /** The first line of the nested function. */
  at: number;
  /** First and last line, as `12-20`. */
  lines: string;
}

export interface ChartNode {
  id: string;
  kind: ChartNodeKind;
  label: string;
  /** The first line of the code of the node, trimmed. */
  text?: string;
  /** First and last line, 1-based. For a condition, a loop or a try: the lines of its head only. */
  start: number;
  end: number;
  /** `12-20`, or `12` for one line. */
  lines: string;
  /** The number of statements in a run (`steps`) or in a folded branch (`fold`). */
  count?: number;
  calls?: ChartCall[];
  nested?: ChartNested[];
  /** The calls into outside packages, with `libraries` only. */
  libs?: ChartLib[];
  /** The hook that the statement calls: `useEffect`, `useQuery`. */
  hook?: string;
  /** An `event` node: the JSX attribute, e.g. `onClick`. A `more` node of the cut event handlers has `more`. */
  event?: string;
  /** A render branch: the components that the branch renders, e.g. `['Present']`. */
  renders?: string[];
  /** The node waits (`await`) or gives a value back (`yield`) on its lines. */
  await?: boolean;
  /** The number of compound statements around the node in the function body. */
  depth: number;
}

export type ChartEdgeKind = 'next' | 'branch' | 'back' | 'error';

export interface ChartEdge {
  from: string;
  to: string;
  kind: ChartEdgeKind;
  /** `yes`, `no`, a case value, `each`, `done`, `error`. */
  label?: string;
}

/** The structure of the chart, for the layout: a node, its branches, or the body of a loop. */
export interface ChartBlock {
  node: string;
  branches?: ChartBranch[];
  loop?: ChartBlock[];
}

export interface ChartBranch {
  label: string;
  body: ChartBlock[];
}

export interface CodeChart {
  ok: boolean;
  /** The graph ID of the function (of the outer function for a nested one). */
  target: string;
  name: string;
  kind?: NodeKind;
  file?: string;
  language?: string;
  /** The first line of a nested function. */
  at?: number;
  /** The box that owns the function. */
  box?: string;
  /** The first line of `code`, 1-based. */
  start: number;
  /** The full code of the function. */
  code?: string;
  nodes: ChartNode[];
  edges: ChartEdge[];
  body: ChartBlock[];
  /** What the chart cannot show, for example folded branches or a language with no reader. */
  notes: string[];
}

export interface ChartOptions {
  /** The first line of a nested function inside the target: the chart of that function. */
  at?: number;
  /** The first lines of the folded branches that the reader opened. */
  open?: readonly number[];
  /** The most nodes in the chart: fewer levels first, then "+N more" for the rest. */
  limit?: number;
  /** Put the calls into outside packages on the nodes. */
  libraries?: boolean;
  /** The first line of a statement block in the function (a route in a dispatch function): the chart of that block. */
  block?: number;
  /** The name of the start node of a block chart. */
  blockName?: string;
}

/** The flowchart of the function `target` (a graph ID or a name), or of a function nested in it (`opts.at`). */
export async function codeChart(store: ChartSource, root: string, target: string, opts: ChartOptions = {}): Promise<CodeChart> {
  const empty = { start: 0, nodes: [], edges: [], body: [] };
  const n = store.node(target);
  if (!n) return { ok: false, target, name: target, ...empty, notes: ['not found'] };
  if (n.targetOnly || n.file === undefined || n.range === undefined || !CHART_KINDS.includes(n.kind)) {
    return { ok: false, target: n.id, name: n.name, ...empty, notes: ['this is not a function of the repo'] };
  }
  const base = { target: n.id, name: n.name, kind: n.kind, file: n.file, language: n.language };
  let text: string;
  try {
    text = readFileSync(join(root, n.file), 'utf8');
  } catch {
    return { ok: false, ...base, ...empty, notes: [`the file ${n.file} is not in the repo`] };
  }
  const lines = text.split('\n');
  const [first, last] = n.range.split('-').map(Number) as [number, number];
  const code = (s: number, e: number) => lines.slice(s - 1, e).join('\n');
  const sites = store.callSites(n.id);
  const withBox = {};
  if (n.language !== 'typescript' && n.language !== 'python') {
    return { ok: true, ...base, ...withBox, start: first, code: code(first, last), nodes: [], edges: [], body: [], notes: [NO_FLOWCHART] };
  }
  const grammars = await loadGrammars();
  const language: Language = n.language === 'python' ? grammars.python : /\.[jt]sx$|\.js$/.test(n.file) ? grammars.tsx : grammars.typescript;
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(text);
  try {
    const found = tree ? spanning(tree.rootNode, first - 1, last - 1) : undefined;
    let fn = found ? functionOf(found) : undefined;
    if (!fn) return { ok: false, ...base, ...withBox, ...empty, start: first, code: code(first, last), notes: ['the atlas did not find the body of this function in the file'] };
    let start = first;
    let end = last;
    let name = n.name;
    if (opts.at !== undefined) {
      const inner = nestedAt(fn, opts.at - 1);
      if (!inner) return { ok: false, ...base, ...withBox, at: opts.at, ...empty, start: first, code: code(first, last), notes: [`no nested function starts at line ${opts.at}`] };
      fn = inner;
      start = inner.startPosition.row + 1;
      end = inner.endPosition.row + 1;
      name = nestedName(inner);
    }
    let blockStmt: Node | undefined;
    if (opts.block !== undefined) {
      blockStmt = blockAt(fn, opts.block - 1);
      if (!blockStmt) return { ok: false, ...base, ...withBox, ...empty, start: first, code: code(first, last), notes: [`no route block starts at line ${opts.block}`] };
      start = blockStmt.startPosition.row + 1;
      end = blockStmt.endPosition.row + 1;
      name = opts.blockName ?? firstLine(blockStmt);
    }
    const mine = sites.filter((s) => s.line >= start && s.line <= end);
    const libs = opts.libraries ? store.libSites(n.id).filter((s) => s.line >= start && s.line <= end) : [];
    const make = (depth: number) => {
      const b = new ChartBuilder(n.language as 'typescript' | 'python', mine, new Set(opts.open ?? []), { depth, libs, file: n.file!, ...(opts.limit !== undefined ? { limit: opts.limit } : {}) });
      const body = blockStmt ? b.block(blockStmt, name) : b.function(fn!, name);
      return { b, body };
    };
    // A chart over the limit folds more levels first; then the limit cuts the rest into "+N more".
    let built = make(MAX_DEPTH);
    for (let depth = MAX_DEPTH - 1; opts.limit !== undefined && built.b.nodes.length > opts.limit && depth >= 1; depth--) built = make(depth);
    const { b, body } = built;
    return {
      ok: true, ...base, name, ...(opts.at !== undefined ? { at: opts.at } : {}), ...(opts.block !== undefined ? { at: opts.block } : {}), ...withBox,
      start, code: code(start, end), nodes: b.nodes, edges: b.edges, body, notes: b.notes,
    };
  } finally {
    tree?.delete();
    parser.delete();
  }
}


// --- the syntax tree ---

const FUNCTION_TYPES = new Set([
  'function_declaration', 'generator_function_declaration', 'function_expression', 'function', 'generator_function',
  'arrow_function', 'method_definition', 'function_definition',
]);
const COMMENT_TYPES = new Set(['comment', 'empty_statement', 'pass_statement', 'html_comment']);

/**
 * A statement that is only a string: a Python docstring, or a JS directive ("use client"). It does
 * nothing at run time, so the chart does not show it as a step.
 */
export const isDocString = (c: Node): boolean =>
  c.type === 'expression_statement' && c.namedChildren.length === 1 && ['string', 'template_string', 'concatenated_string'].includes(c.namedChildren[0]!.type);

/** The function node in a declaration: through `export`, `const x =`, a class field and a decorator. */
function functionOf(n: Node): Node | undefined {
  if (FUNCTION_TYPES.has(n.type)) return n;
  for (const c of n.namedChildren) {
    if (c.type === 'decorator') continue;
    const f = functionOf(c);
    if (f) return f;
    if (!['export_statement', 'lexical_declaration', 'variable_declaration', 'variable_declarator', 'decorated_definition', 'public_field_definition'].includes(n.type)) break;
  }
  return undefined;
}

/** The function or class that starts at `row`, inside `fn`. */
function nestedAt(fn: Node, row: number): Node | undefined {
  let found: Node | undefined;
  const walk = (c: Node): void => {
    if (found || c.endPosition.row < row || c.startPosition.row > row) return;
    if (c !== fn && c.startPosition.row === row && FUNCTION_TYPES.has(c.type)) {
      found = c;
      return;
    }
    for (const k of c.namedChildren) walk(k);
  };
  walk(fn);
  return found;
}

const BLOCK_TYPES = new Set(['if_statement', 'switch_case', 'expression_statement', 'case_clause', 'elif_clause']);

/** The innermost route block that starts on `row`: an `if`, a `case`, or a router call statement. */
function blockAt(fn: Node, row: number): Node | undefined {
  let found: Node | undefined;
  const walk = (c: Node): void => {
    if (c.endPosition.row < row || c.startPosition.row > row) return;
    if (c !== fn && c.startPosition.row === row && BLOCK_TYPES.has(c.type)) found = c;
    for (const k of c.namedChildren) walk(k);
  };
  walk(fn);
  return found;
}

/** The name of a nested function: its own name, the name it is given to, or the call it is an argument of. */
function nestedName(n: Node): string {
  const own = n.childForFieldName('name')?.text;
  if (own) return own;
  const p = n.parent;
  if (p?.type === 'variable_declarator' || p?.type === 'pair' || p?.type === 'assignment_expression') {
    const key = p.childForFieldName('name') ?? p.childForFieldName('key') ?? p.childForFieldName('left');
    if (key) return key.text;
  }
  if (p?.type === 'arguments') {
    const call = p.parent?.childForFieldName('function');
    if (call) return `callback of ${call.text.split('.').pop()}`;
  }
  return 'callback';
}

const firstLine = (n: Node): string => cut(n.text.split('\n')[0]!.trim());
const cut = (s: string): string => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s);
const oneLine = (s: string): string => cut(s.replace(/\s+/g, ' ').trim());
const unparen = (n: Node): Node => (n.type === 'parenthesized_expression' && n.namedChildren.length === 1 ? unparen(n.namedChildren[0]!) : n);

/** The last row of the head of a compound statement: the row of the token before its body. */
function headRow(s: Node, body: Node | null | undefined): number {
  if (!body) return s.startPosition.row;
  return (body.previousSibling ?? body).endPosition.row;
}

function statementsOf(n: Node | null | undefined): Node[] {
  if (!n) return [];
  if (n.type === 'statement_block' || n.type === 'block' || n.type === 'program' || n.type === 'module') return n.namedChildren.filter((c) => !COMMENT_TYPES.has(c.type) && !isDocString(c));
  if (n.type === 'else_clause' || n.type === 'finally_clause') return statementsOf(n.childForFieldName('body') ?? n.namedChildren.find((c) => c.type === 'block' || c.type === 'statement_block') ?? n.namedChildren[0]);
  return COMMENT_TYPES.has(n.type) ? [] : [n];
}

/** True when the subtree has a node of a type, not inside a nested function. */
function has(n: Node, types: ReadonlySet<string>): boolean {
  if (types.has(n.type)) return true;
  for (const c of n.namedChildren) if (!FUNCTION_TYPES.has(c.type) && c.type !== 'lambda' && has(c, types)) return true;
  return false;
}

/** The nested functions and callbacks with a body in a statement; not the functions inside them. */
function nestedIn(n: Node): Node[] {
  const out: Node[] = [];
  const walk = (c: Node): void => {
    if (isNested(c)) {
      out.push(c);
      return;
    }
    for (const k of c.namedChildren) walk(k);
  };
  walk(n);
  return out;
}

function isNested(c: Node): boolean {
  if (c.type === 'arrow_function') return c.childForFieldName('body')?.type === 'statement_block';
  return FUNCTION_TYPES.has(c.type) || c.type === 'class_declaration' || c.type === 'class_definition' || c.type === 'class';
}

const AWAIT = new Set(['await_expression', 'await']);
const YIELD = new Set(['yield_expression', 'yield']);
const COMPOUND = new Set([
  'if_statement', 'switch_statement', 'match_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement',
  'try_statement', 'with_statement', 'statement_block', 'labeled_statement',
]);

/** The statements in a subtree, nested functions left out: the size of a folded branch. */
function countStatements(n: Node): number {
  let count = 0;
  const walk = (c: Node, top: boolean): void => {
    if (!top && (isNested(c) || c.type === 'lambda')) return;
    if (!top && !COMMENT_TYPES.has(c.type) && c.type !== 'statement_block' && c.type !== 'block' && (/_statement$|_declaration$/.test(c.type) || c.type === 'expression_statement')) count++;
    for (const k of c.namedChildren) walk(k, false);
  };
  walk(n, true);
  return Math.max(count, 1);
}

/** The hook that a statement calls first: `useEffect(…)`, `const q = useQuery(…)`. */
function hookOf(s: Node): string | undefined {
  let found: string | undefined;
  const walk = (c: Node): void => {
    if (found || isNested(c)) return;
    if (c.type === 'call_expression') {
      const f = c.childForFieldName('function');
      const name = f?.type === 'member_expression' ? f.childForFieldName('property')?.text : f?.text;
      if (name !== undefined && /^use[A-Z]\w*$/.test(name)) {
        found = name;
        return;
      }
    }
    for (const k of c.namedChildren) walk(k);
  };
  walk(s);
  return found;
}

/** The most conditional render parts in one chart. */
export const RENDER_LIMIT = 16;

/** The components (capital tags) of a JSX tree, in order, once each, without nested functions. */
function componentsIn(n: Node): string[] {
  const out: string[] = [];
  const walk = (c: Node): void => {
    if (c.type === 'jsx_opening_element' || c.type === 'jsx_self_closing_element') {
      const name = c.childForFieldName('name')?.text ?? c.namedChildren[0]?.text ?? '';
      if (/^[A-Z][\w$]*$/.test(name) && !out.includes(name)) out.push(name);
    }
    for (const k of c.namedChildren) if (!isNested(k)) walk(k);
  };
  walk(n);
  return out;
}

const hasJsx = (n: Node): boolean => n.type.startsWith('jsx_') || n.namedChildren.some((c) => !isNested(c) && hasJsx(c));

function enclosingFunction(n: Node): Node | undefined {
  for (let p = n.parent; p; p = p.parent) if (FUNCTION_TYPES.has(p.type)) return p;
  return undefined;
}

/** A function named `name` in the body of `fn`: `function save()` or `const save = () => …`. */
function localFunction(fn: Node, name: string): Node | undefined {
  let found: Node | undefined;
  const walk = (c: Node): void => {
    if (found) return;
    if (c.type === 'function_declaration' && c.childForFieldName('name')?.text === name) {
      found = c;
      return;
    }
    if (c.type === 'variable_declarator' && c.childForFieldName('name')?.text === name) {
      const v = c.childForFieldName('value');
      if (v && FUNCTION_TYPES.has(v.type)) {
        found = v;
        return;
      }
      // `const save = useCallback(() => …, [])`: the callback.
      const cb = v?.type === 'call_expression' ? v.childForFieldName('arguments')?.namedChildren.find((a) => FUNCTION_TYPES.has(a.type)) : undefined;
      if (cb) {
        found = cb;
        return;
      }
    }
    for (const k of c.namedChildren) walk(k);
  };
  walk(fn.childForFieldName('body') ?? fn);
  return found;
}

// --- the builder ---

/** An open edge: it goes to the next node that the builder adds. */
interface End {
  from: string;
  kind?: ChartEdgeKind;
  label?: string;
}

interface Jump {
  kind: 'loop' | 'switch';
  /** The loop node, the target of `continue`. */
  head?: string;
  label?: string;
  breaks: End[];
}

interface Ctx {
  depth: number;
  jumps: Jump[];
  /** The throws inside a try with a handler: they go to the handler. */
  tries: string[][];
}

interface Seq {
  blocks: ChartBlock[];
  ends: End[];
}

interface BuildLimits {
  /** Branches deeper than this fold. */
  depth: number;
  /** The most nodes; the rest go into "+N more". */
  limit?: number;
  libs: readonly ChartLib[];
  file: string;
}

class ChartBuilder {
  readonly nodes: ChartNode[] = [];
  readonly edges: ChartEdge[] = [];
  readonly notes: string[] = [];
  private folds = 0;
  private cut = 0;
  private readonly maxDepth: number;
  private readonly libs: readonly ChartLib[];

  constructor(
    private readonly language: 'typescript' | 'python',
    private readonly sites: readonly CallSite[],
    private readonly open: ReadonlySet<number>,
    private readonly limits: BuildLimits = { depth: MAX_DEPTH, libs: [], file: '' },
  ) {
    this.maxDepth = limits.depth;
    this.libs = limits.libs;
  }

  /** The chart of one route block: its body, with a start node named after the route. */
  block(stmt: Node, name: string): ChartBlock[] {
    const head = this.node('start', name, stmt, stmt.startPosition.row, stmt.startPosition.row, 0, { text: firstLine(stmt) });
    const ctx: Ctx = { depth: 0, jumps: [], tries: [] };
    let stmts: Node[];
    if (stmt.type === 'if_statement' || stmt.type === 'elif_clause') stmts = statementsOf(stmt.childForFieldName('consequence'));
    else if (stmt.type === 'switch_case') {
      const value = stmt.childForFieldName('value');
      stmts = stmt.namedChildren.filter((k) => (value === null || k.startIndex !== value.startIndex) && !COMMENT_TYPES.has(k.type));
    } else if (stmt.type === 'case_clause') stmts = statementsOf(stmt.childForFieldName('consequence') ?? stmt.namedChildren.find((k) => k.type === 'block'));
    else stmts = [stmt];
    const seq = this.seq(stmts, [{ from: head }], ctx);
    const blocks: ChartBlock[] = [{ node: head }, ...seq.blocks];
    if (seq.ends.length > 0) {
      const end = this.node('end', 'end of the route', stmt, stmt.endPosition.row, stmt.endPosition.row, 0);
      this.link(seq.ends, end);
      blocks.push({ node: end });
    }
    this.closeNotes();
    return blocks;
  }

  private closeNotes(): void {
    if (this.folds > 0) this.notes.push(`${this.folds} ${this.folds === 1 ? 'branch is' : 'branches are'} deeper than ${this.maxDepth} levels and folded. Open a folded node to see its steps.`);
    if (this.cut > 0) this.notes.push(`The chart has more than ${this.limits.limit} steps. ${this.cut} ${this.cut === 1 ? 'part shows' : 'parts show'} as "+N more", with the file and the line.`);
  }

  function(fn: Node, name: string): ChartBlock[] {
    const head = this.node('start', name, fn, fn.startPosition.row, fn.startPosition.row, 0, { text: firstLine(fn) });
    const body = fn.childForFieldName('body');
    const ctx: Ctx = { depth: 0, jumps: [], tries: [] };
    let seq: Seq;
    if (body && body.type !== 'statement_block' && body.type !== 'block') {
      // An arrow function with an expression body: it gives the value back.
      seq = this.exit(body, 'return', [{ from: head }], ctx, body);
    } else {
      seq = this.seq(statementsOf(body), [{ from: head }], ctx);
    }
    const blocks: ChartBlock[] = [{ node: head }, ...seq.blocks];
    if (seq.ends.length > 0) {
      const end = this.node('end', 'end of the function', fn, fn.endPosition.row, fn.endPosition.row, 0);
      this.link(seq.ends, end);
      blocks.push({ node: end });
    }
    this.closeNotes();
    return blocks;
  }

  private node(kind: ChartNodeKind, label: string, at: Node, startRow: number, endRow: number, depth: number, extra: Partial<ChartNode> = {}): string {
    const id = `n${this.nodes.length + 1}`;
    const start = startRow + 1;
    const end = endRow + 1;
    const node: ChartNode = { id, kind, label: cut(label), start, end, lines: start === end ? `${start}` : `${start}-${end}`, depth, ...extra };
    const calls = this.sites.filter((s) => s.line >= start && s.line <= end);
    const plain = kind !== 'start' && kind !== 'end' && kind !== 'fold' && kind !== 'more';
    if (calls.length > 0 && plain) node.calls = calls.map((s) => ({ line: s.line, fn: s.fn, trust: s.trust }));
    const libs = this.libs.filter((s) => s.line >= start && s.line <= end);
    if (libs.length > 0 && plain && kind !== 'event') node.libs = libs;
    this.nodes.push(node);
    return id;
  }

  private link(ends: readonly End[], to: string): void {
    for (const e of ends) this.edges.push({ from: e.from, to, kind: e.kind ?? 'next', ...(e.label !== undefined ? { label: e.label } : {}) });
  }

  private seq(stmts: readonly Node[], ends: End[], ctx: Ctx): Seq {
    const blocks: ChartBlock[] = [];
    let run: Node[] = [];
    let open = ends;
    const flush = () => {
      if (run.length === 0) return;
      const first = run[0]!;
      const last = run[run.length - 1]!;
      const id = this.node('steps', run.length === 1 ? firstLine(first) : `${run.length} statements`, first, first.startPosition.row, last.endPosition.row, ctx.depth, {
        text: firstLine(first), count: run.length,
      });
      this.link(open, id);
      blocks.push({ node: id });
      open = [{ from: id }];
      run = [];
    };
    for (const [i, s] of stmts.entries()) {
      if (this.limits.limit !== undefined && this.nodes.length >= this.limits.limit) {
        flush();
        const rest = stmts.slice(i);
        const n = rest.reduce((sum, r) => sum + (COMPOUND.has(r.type) ? countStatements(r) + 1 : 1), 0);
        const at = rest[0]!.startPosition.row;
        this.cut++;
        const id = this.node('more', `+${n} more`, rest[0]!, at, rest[rest.length - 1]!.endPosition.row, ctx.depth, { text: `${this.limits.file}:${at + 1}`, count: n });
        this.link(open, id);
        blocks.push({ node: id });
        return { blocks, ends: [{ from: id }] };
      }
      if (COMPOUND.has(s.type) || this.isExit(s) || this.stands(s)) {
        flush();
        const out = this.statement(s, open, ctx);
        blocks.push(...out.blocks);
        open = out.ends;
      } else {
        run.push(s);
      }
    }
    flush();
    return { blocks, ends: open };
  }

  /** A plain statement that is a node of its own: a known call, a callback, await or yield. */
  private stands(s: Node): boolean {
    const start = s.startPosition.row + 1;
    const end = s.endPosition.row + 1;
    if (this.sites.some((c) => c.line >= start && c.line <= end) || nestedIn(s).length > 0 || has(s, AWAIT) || has(s, YIELD)) return true;
    // A call into a library that the statement makes for its effect (not a declaration) is a step of its own.
    return s.type === 'expression_statement' && this.libs.some((c) => c.line >= start && c.line <= end);
  }

  private isExit(s: Node): boolean {
    return ['return_statement', 'throw_statement', 'raise_statement', 'break_statement', 'continue_statement'].includes(s.type);
  }

  private statement(s: Node, ends: End[], ctx: Ctx): Seq {
    if (s.type === 'statement_block' || s.type === 'block') return this.seq(statementsOf(s), ends, ctx);
    if (s.type === 'labeled_statement') {
      const inner = s.childForFieldName('body') ?? s.namedChildren.at(-1)!;
      return this.statement(inner, ends, { ...ctx, jumps: ctx.jumps });
    }
    if (COMPOUND.has(s.type) && ctx.depth >= this.maxDepth && !this.open.has(s.startPosition.row + 1)) return this.fold(s, ends, ctx);
    switch (s.type) {
      case 'return_statement':
        return this.exit(s, 'return', ends, ctx);
      case 'throw_statement':
      case 'raise_statement':
        return this.exit(s, 'throw', ends, ctx);
      case 'break_statement':
      case 'continue_statement':
        return this.jump(s, ends, ctx);
      case 'if_statement':
        return this.ifChain(s, ends, ctx);
      case 'switch_statement':
        return this.switch(s, ends, ctx);
      case 'match_statement':
        return this.match(s, ends, ctx);
      case 'for_statement':
      case 'for_in_statement':
      case 'while_statement':
      case 'do_statement':
        return this.loop(s, ends, ctx);
      case 'try_statement':
        return this.try(s, ends, ctx);
      case 'with_statement':
        return this.with(s, ends, ctx);
    }
    return this.plain(s, ends, ctx);
  }

  /** A statement with a known call, a callback, a nested function, await or yield. */
  private plain(s: Node, ends: End[], ctx: Ctx): Seq {
    const nested = nestedIn(s).map((f): ChartNested => ({
      name: nestedName(f), at: f.startPosition.row + 1, lines: `${f.startPosition.row + 1}-${f.endPosition.row + 1}`,
    }));
    const waits = has(s, AWAIT);
    const gives = has(s, YIELD);
    const start = s.startPosition.row + 1;
    const end = s.endPosition.row + 1;
    const calls = this.sites.some((c) => c.line >= start && c.line <= end) || this.libs.some((c) => c.line >= start && c.line <= end);
    const kind: ChartNodeKind = nested.length > 0 ? 'nested' : calls ? 'call' : gives ? 'yield' : waits ? 'await' : 'steps';
    const label = kind === 'nested' && isNested(s) ? `${s.type.startsWith('class') ? 'class' : 'function'} ${nested[0]!.name}` : firstLine(s);
    const hook = this.language === 'typescript' ? hookOf(s) : undefined;
    const id = this.node(kind, label, s, s.startPosition.row, s.endPosition.row, ctx.depth, {
      text: firstLine(s), ...(kind === 'steps' ? { count: 1 } : {}), ...(nested.length > 0 ? { nested } : {}), ...(waits || gives ? { await: true } : {}),
      ...(hook !== undefined ? { hook } : {}),
    });
    this.link(ends, id);
    return { blocks: [{ node: id }], ends: [{ from: id }] };
  }

  /** return, throw, raise: an end node. `?:`, `&&` and `||` that decide the value give a diamond first. */
  private exit(s: Node, kind: 'return' | 'throw', ends: End[], ctx: Ctx, value?: Node): Seq {
    const word = kind === 'return' ? 'return' : this.language === 'python' ? 'raise' : 'throw';
    const expr = value ?? s.namedChildren.find((c) => !COMMENT_TYPES.has(c.type));
    const decide = expr ? this.decides(unparen(expr.type === 'await_expression' || expr.type === 'await' ? expr.namedChildren[0] ?? expr : expr)) : undefined;
    const row = s.startPosition.row;
    const lastRow = s.endPosition.row;
    if (decide) {
      const d = this.node('decision', `${oneLine(decide.cond.text)}?`, decide.cond, row, lastRow, ctx.depth, { text: firstLine(s) });
      this.link(ends, d);
      const a = this.node(kind, `${word} ${oneLine(decide.yes.text)}`, s, row, lastRow, ctx.depth + 1, { text: firstLine(s) });
      const b = this.node(kind, `${word} ${oneLine(decide.no.text)}`, s, row, lastRow, ctx.depth + 1, { text: firstLine(s) });
      this.edges.push({ from: d, to: a, kind: 'branch', label: 'yes' }, { from: d, to: b, kind: 'branch', label: 'no' });
      if (kind === 'throw') this.toHandler(ctx, a, b);
      return { blocks: [{ node: d, branches: [{ label: 'yes', body: [{ node: a }] }, { label: 'no', body: [{ node: b }] }] }], ends: [] };
    }
    const label = expr ? `${word} ${oneLine(expr.text)}` : word;
    const id = this.node(kind, label, s, row, lastRow, ctx.depth, {
      text: firstLine(s), ...(has(s, AWAIT) ? { await: true } : {}),
      ...(value === undefined && nestedIn(s).length > 0 ? { nested: nestedIn(s).map((f) => ({ name: nestedName(f), at: f.startPosition.row + 1, lines: `${f.startPosition.row + 1}-${f.endPosition.row + 1}` })) } : {}),
    });
    this.link(ends, id);
    if (kind === 'throw') this.toHandler(ctx, id);
    const jsx = kind === 'return' && expr && this.language === 'typescript';
    const branches = jsx ? [...this.renderBranches(expr, id, ctx), ...this.events(expr, id, ctx)] : [];
    if (branches.length > 0) return { blocks: [{ node: id, branches }], ends: [] };
    return { blocks: [{ node: id }], ends: [] };
  }

  /**
   * The conditional parts of a rendered tree: `{a && <B />}` and `{a ? <B /> : <C />}`. Each one
   * is a diamond after the render, with a node for each branch that names the components it renders.
   * A conditional inside a branch stays in that branch. At most RENDER_LIMIT diamonds.
   */
  private renderBranches(expr: Node, from: string, ctx: Ctx): ChartBranch[] {
    if (!hasJsx(expr)) return [];
    const found: Array<{ cond: Node; yes: Node; no?: Node; at: Node }> = [];
    const walk = (c: Node): void => {
      if (c.type === 'jsx_expression') {
        const inner = c.namedChildren[0] ? unparen(c.namedChildren[0]) : undefined;
        const d = inner ? this.decides(inner) : undefined;
        if (inner && d && (hasJsx(d.yes) || (inner.type === 'ternary_expression' && hasJsx(d.no)))) {
          found.push({ cond: d.cond, yes: d.yes, ...(inner.type === 'ternary_expression' ? { no: d.no } : {}), at: c });
          return;
        }
      }
      for (const k of c.namedChildren) if (!isNested(k)) walk(k);
    };
    walk(expr);
    // With a limit, the diamonds use at most a third of the steps that are left.
    const room = this.limits.limit === undefined ? RENDER_LIMIT : Math.max(0, Math.floor((this.limits.limit - this.nodes.length) / 3 / 2));
    const show = Math.min(RENDER_LIMIT, room);
    const shown = found.slice(0, show).map((f): ChartBranch => {
      const d = this.node('decision', `${oneLine(f.cond.text)}?`, f.cond, f.at.startPosition.row, f.at.startPosition.row, ctx.depth + 1, { text: firstLine(f.at) });
      this.edges.push({ from, to: d, kind: 'branch', label: 'render' });
      const branches: ChartBranch[] = [];
      for (const [label, part] of [['yes', f.yes], ['no', f.no]] as const) {
        if (!part || !hasJsx(part)) continue;
        const names = componentsIn(part);
        const text = names.length > 0 ? `render ${names.slice(0, 3).map((n) => `<${n}>`).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}` : `render ${oneLine(part.text)}`;
        const id = this.node('steps', text, part, part.startPosition.row, part.endPosition.row, ctx.depth + 2, { text: firstLine(part), count: 1, ...(names.length > 0 ? { renders: names } : {}) });
        this.edges.push({ from: d, to: id, kind: 'branch', label });
        branches.push({ label, body: [{ node: id }] });
      }
      return { label: 'render', body: [{ node: d, branches }] };
    });
    const cut: ChartBranch[] = [];
    if (found.length > show) {
      // The cut is a node at its place: "+N more conditions", with the line of the first one that is cut.
      const rest = found.slice(show);
      const first = rest[0]!.at;
      const n = rest.length;
      this.notes.push(`The render has ${found.length} conditional parts. The chart shows the first ${show}.`);
      const id = this.node('more', `+${n} more ${n === 1 ? 'condition' : 'conditions'}`, first, first.startPosition.row, rest[n - 1]!.at.endPosition.row, ctx.depth + 1, { text: `${this.limits.file}:${first.startPosition.row + 1}`, count: n });
      this.edges.push({ from, to: id, kind: 'branch', label: 'render' });
      cut.push({ label: 'render', body: [{ node: id }] });
    }
    return [...shown, ...cut];
  }

  /** The JSX event handlers of a rendered tree: one `event` node for each, an entry branch from the render. */
  private events(expr: Node, from: string, ctx: Ctx): ChartBranch[] {
    if (!hasJsx(expr)) return [];
    const fn = enclosingFunction(expr);
    const found: Array<[string, Node]> = [];
    const walk = (c: Node): void => {
      if (c.type === 'jsx_attribute') {
        const name = c.namedChildren[0]?.text ?? '';
        const value = c.namedChildren[1];
        if (/^on[A-Z]\w*$/.test(name) && value?.type === 'jsx_expression') {
          const inner = value.namedChildren[0];
          if (inner) found.push([name, inner]);
        }
      }
      for (const k of c.namedChildren) if (!isNested(k)) walk(k);
    };
    walk(expr);
    // With a limit, at most `limit` event handlers. The page shows them in one group, not in the column of steps.
    const room = this.limits.limit === undefined ? found.length : this.limits.limit;
    const out = found.slice(0, room).map(([name, inner]) => this.event(name, inner, fn, from, ctx));
    if (found.length > room) {
      const rest = found.slice(room);
      const first = rest[0]![1];
      this.notes.push(`The render has ${found.length} event handlers. The chart shows the first ${room}.`);
      const id = this.node('more', `+${rest.length} more ${rest.length === 1 ? 'event handler' : 'event handlers'}`, first, first.startPosition.row, rest[rest.length - 1]![1].endPosition.row, ctx.depth + 1, { text: `${this.limits.file}:${first.startPosition.row + 1}`, count: rest.length, event: 'more' });
      this.edges.push({ from, to: id, kind: 'branch', label: 'events' });
      out.push({ label: 'events', body: [{ node: id }] });
    }
    return out;
  }

  private event(name: string, handler: Node, fn: Node | undefined, from: string, ctx: Ctx): ChartBranch {
    const row = handler.startPosition.row;
    let nested: ChartNested[] = [];
    let label = `${name}: ${oneLine(handler.text)}`;
    if (isNested(handler) || handler.type === 'arrow_function') {
      nested = [{ name: `${name} handler`, at: row + 1, lines: `${row + 1}-${handler.endPosition.row + 1}` }];
      label = `${name}: ${oneLine(handler.text.split('=>')[1] ?? 'handler')}`;
    } else if (handler.type === 'identifier' && fn) {
      const local = localFunction(fn, handler.text);
      if (local) nested = [{ name: handler.text, at: local.startPosition.row + 1, lines: `${local.startPosition.row + 1}-${local.endPosition.row + 1}` }];
      label = `${name}: ${handler.text}`;
    }
    const id = this.node('event', label, handler, row, handler.endPosition.row, ctx.depth + 1, { text: firstLine(handler), event: name, ...(nested.length > 0 ? { nested } : {}) });
    this.edges.push({ from, to: id, kind: 'branch', label: name });
    return { label: name, body: [{ node: id }] };
  }

  /** The condition of a return value: `c ? a : b`, `a && b`, `a || b`, `a if c else b`, `a and b`, `a or b`. */
  private decides(e: Node): { cond: Node; yes: Node; no: Node } | undefined {
    if (e.type === 'ternary_expression') {
      const [cond, yes, no] = [e.childForFieldName('condition'), e.childForFieldName('consequence'), e.childForFieldName('alternative')];
      return cond && yes && no ? { cond, yes, no } : undefined;
    }
    if (e.type === 'conditional_expression') {
      const [yes, cond, no] = e.namedChildren;
      return cond && yes && no ? { cond, yes, no } : undefined;
    }
    if (e.type === 'binary_expression' || e.type === 'boolean_operator') {
      const op = e.childForFieldName('operator')?.text;
      const left = e.childForFieldName('left');
      const right = e.childForFieldName('right');
      if (!left || !right) return undefined;
      // `a && b`: if a, the value is b; else a. `a || b`: if a, the value is a; else b.
      if (op === '&&' || op === 'and') return { cond: left, yes: right, no: left };
      if (op === '||' || op === 'or' || op === '??') return { cond: left, yes: left, no: right };
    }
    return undefined;
  }

  private toHandler(ctx: Ctx, ...ids: string[]): void {
    const handler = ctx.tries[ctx.tries.length - 1];
    if (handler) handler.push(...ids);
  }

  private jump(s: Node, ends: End[], ctx: Ctx): Seq {
    const brk = s.type === 'break_statement';
    const label = s.namedChildren.find((c) => c.type === 'statement_identifier' || c.type === 'identifier')?.text;
    const id = this.node(brk ? 'break' : 'continue', firstLine(s).replace(/;$/, ''), s, s.startPosition.row, s.endPosition.row, ctx.depth);
    this.link(ends, id);
    const targets = [...ctx.jumps].reverse();
    const target = label !== undefined ? targets.find((j) => j.label === label) : brk ? targets[0] : targets.find((j) => j.kind === 'loop');
    if (target) {
      if (brk) target.breaks.push({ from: id, label: 'break' });
      else if (target.head) this.edges.push({ from: id, to: target.head, kind: 'back', label: 'continue' });
    }
    return { blocks: [{ node: id }], ends: [] };
  }

  /** if / else if / else, and if / elif / else. */
  private ifChain(s: Node, ends: End[], ctx: Ctx): Seq {
    const cond = s.childForFieldName('condition')!;
    const consequence = s.childForFieldName('consequence');
    const d = this.node('decision', `${oneLine(unparen(cond).text)}?`, s, s.startPosition.row, headRow(s, consequence ?? cond), ctx.depth, { text: firstLine(s) });
    this.link(ends, d);
    const inner = { ...ctx, depth: ctx.depth + 1 };
    const yes = this.seq(statementsOf(consequence), [{ from: d, kind: 'branch', label: 'yes' }], inner);
    const alts = s.childrenForFieldName('alternative').filter((c): c is Node => c !== null);
    const no = this.alternatives(alts, [{ from: d, kind: 'branch', label: 'no' }], ctx);
    return {
      blocks: [{ node: d, branches: [{ label: 'yes', body: yes.blocks }, { label: 'no', body: no.blocks }] }],
      ends: [...yes.ends, ...no.ends],
    };
  }

  private alternatives(alts: readonly Node[], ends: End[], ctx: Ctx): Seq {
    const [first, ...rest] = alts;
    if (!first) return { blocks: [], ends };
    if (first.type === 'elif_clause') {
      const cond = first.childForFieldName('condition')!;
      const consequence = first.childForFieldName('consequence');
      const d = this.node('decision', `${oneLine(cond.text)}?`, first, first.startPosition.row, headRow(first, consequence ?? cond), ctx.depth, { text: firstLine(first) });
      this.link(ends, d);
      const yes = this.seq(statementsOf(consequence), [{ from: d, kind: 'branch', label: 'yes' }], { ...ctx, depth: ctx.depth + 1 });
      const no = this.alternatives(rest, [{ from: d, kind: 'branch', label: 'no' }], ctx);
      return { blocks: [{ node: d, branches: [{ label: 'yes', body: yes.blocks }, { label: 'no', body: no.blocks }] }], ends: [...yes.ends, ...no.ends] };
    }
    // else: `else if` is an if statement in the else clause; it stays on the same depth.
    const stmts = statementsOf(first);
    if (stmts.length === 1 && stmts[0]!.type === 'if_statement' && first.type === 'else_clause' && this.language === 'typescript') return this.ifChain(stmts[0]!, ends, ctx);
    return this.seq(stmts, ends, { ...ctx, depth: ctx.depth + 1 });
  }

  private switch(s: Node, ends: End[], ctx: Ctx): Seq {
    const value = s.childForFieldName('value');
    const body = s.childForFieldName('body');
    const d = this.node('decision', `switch ${oneLine(value?.text ?? '')}`, s, s.startPosition.row, headRow(s, body), ctx.depth, { text: firstLine(s) });
    this.link(ends, d);
    const jump: Jump = { kind: 'switch', breaks: [] };
    const inner: Ctx = { ...ctx, depth: ctx.depth + 1, jumps: [...ctx.jumps, jump] };
    const branches: ChartBranch[] = [];
    let fall: End[] = [];
    let pending: string[] = [];
    let hasDefault = false;
    const cases = (body?.namedChildren ?? []).filter((c) => c.type === 'switch_case' || c.type === 'switch_default');
    for (const c of cases) {
      const label = c.type === 'switch_default' ? 'default' : `case ${oneLine(c.childForFieldName('value')?.text ?? '')}`;
      if (c.type === 'switch_default') hasDefault = true;
      const value = c.childForFieldName('value');
      const stmts = c.namedChildren.filter((k) => (value === null || k.startIndex !== value.startIndex) && !COMMENT_TYPES.has(k.type));
      if (stmts.length === 0) {
        // `case a: case b:` share the body of the next case.
        pending.push(label);
        continue;
      }
      const all = [...pending, label].join(', ');
      pending = [];
      const out = this.seq(stmts, [{ from: d, kind: 'branch', label: all }, ...fall], inner);
      branches.push({ label: all, body: out.blocks });
      fall = out.ends;
    }
    const other: End[] = hasDefault ? [] : [{ from: d, kind: 'branch', label: 'no case' }];
    if (!hasDefault) branches.push({ label: 'no case', body: [] });
    return { blocks: [{ node: d, branches }], ends: [...fall, ...jump.breaks, ...other] };
  }

  private match(s: Node, ends: End[], ctx: Ctx): Seq {
    const subject = s.childForFieldName('subject') ?? s.namedChildren[0];
    const body = s.childForFieldName('body') ?? s.namedChildren.find((c) => c.type === 'block');
    const d = this.node('decision', `match ${oneLine(subject?.text ?? '')}`, s, s.startPosition.row, s.startPosition.row, ctx.depth, { text: firstLine(s) });
    this.link(ends, d);
    const inner = { ...ctx, depth: ctx.depth + 1 };
    const branches: ChartBranch[] = [];
    const out: End[] = [];
    let wild = false;
    for (const c of (body?.namedChildren ?? []).filter((k) => k.type === 'case_clause')) {
      const consequence = c.childForFieldName('consequence') ?? c.namedChildren.find((k) => k.type === 'block');
      const head = c.text.slice(0, (consequence?.startIndex ?? c.endIndex) - c.startIndex).replace(/:\s*$/, '');
      const label = oneLine(head);
      if (/^case\s+_\s*$/.test(label)) wild = true;
      const seq = this.seq(statementsOf(consequence), [{ from: d, kind: 'branch', label }], inner);
      branches.push({ label, body: seq.blocks });
      out.push(...seq.ends);
    }
    if (!wild) {
      branches.push({ label: 'no case', body: [] });
      out.push({ from: d, kind: 'branch', label: 'no case' });
    }
    return { blocks: [{ node: d, branches }], ends: out };
  }

  private loop(s: Node, ends: End[], ctx: Ctx): Seq {
    const body = s.childForFieldName('body');
    const doWhile = s.type === 'do_statement';
    const headEnd = doWhile ? s.endPosition.row : headRow(s, body);
    const headText = doWhile ? `do … while ${oneLine(s.childForFieldName('condition')?.text ?? '')}` : oneLine(s.text.slice(0, (body?.startIndex ?? s.endIndex) - s.startIndex).replace(/[:{]\s*$/, ''));
    const head = this.node('loop', headText, s, doWhile ? s.endPosition.row : s.startPosition.row, headEnd, ctx.depth, { text: firstLine(s) });
    const label = s.parent?.type === 'labeled_statement' ? s.parent.childForFieldName('label')?.text ?? s.parent.namedChildren[0]?.text : undefined;
    const jump: Jump = { kind: 'loop', head, breaks: [], ...(label !== undefined ? { label } : {}) };
    const inner: Ctx = { ...ctx, depth: ctx.depth + 1, jumps: [...ctx.jumps, jump] };
    let blocks: ChartBlock[];
    let exits: End[];
    if (doWhile) {
      // The body runs first, then the condition decides if it runs again.
      const seq = this.seq(statementsOf(body), ends, inner);
      this.link(seq.ends, head);
      const first = this.edges.find((e) => seq.blocks[0] && e.to === seq.blocks[0].node);
      if (first) this.edges.push({ from: head, to: first.to, kind: 'back', label: 'again' });
      blocks = [{ node: head, loop: seq.blocks }];
      exits = [{ from: head, kind: 'branch', label: 'done' }];
    } else {
      this.link(ends, head);
      const seq = this.seq(statementsOf(body), [{ from: head, kind: 'branch', label: 'each' }], inner);
      for (const e of seq.ends) this.edges.push({ from: e.from, to: head, kind: 'back', ...(e.label !== undefined ? { label: e.label } : {}) });
      if (seq.blocks.length === 0) this.edges.push({ from: head, to: head, kind: 'back', label: 'each' });
      blocks = [{ node: head, loop: seq.blocks }];
      exits = [{ from: head, kind: 'branch', label: 'done' }];
    }
    // Python: the else of a loop runs when the loop ends with no break.
    const orelse = s.childForFieldName('alternative');
    if (orelse) {
      const seq = this.seq(statementsOf(orelse), exits, { ...ctx, depth: ctx.depth + 1 });
      blocks.push(...seq.blocks);
      exits = seq.ends;
    }
    return { blocks, ends: [...exits, ...jump.breaks] };
  }

  private try(s: Node, ends: End[], ctx: Ctx): Seq {
    const body = s.childForFieldName('body');
    const t = this.node('try', 'try', s, s.startPosition.row, s.startPosition.row, ctx.depth, { text: firstLine(s) });
    this.link(ends, t);
    const inner = { ...ctx, depth: ctx.depth + 1 };
    const handlers = this.language === 'python'
      ? s.namedChildren.filter((c) => c.type === 'except_clause' || c.type === 'except_group_clause')
      : [s.childForFieldName('handler')].filter((c): c is Node => c !== null);
    const throws: string[] = [];
    const run = this.seq(statementsOf(body), [{ from: t }], handlers.length > 0 ? { ...inner, tries: [...ctx.tries, throws] } : inner);
    const runBlocks = [...run.blocks];
    let runEnds = run.ends;
    const orelse = this.language === 'python' ? s.namedChildren.find((c) => c.type === 'else_clause') : undefined;
    if (orelse) {
      const id = this.node('steps', 'else: no error', orelse, orelse.startPosition.row, orelse.startPosition.row, inner.depth, { text: firstLine(orelse) });
      this.link(runEnds, id);
      const seq = this.seq(statementsOf(orelse), [{ from: id }], inner);
      runBlocks.push({ node: id }, ...seq.blocks);
      runEnds = seq.ends;
    }
    const branches: ChartBranch[] = [{ label: 'try', body: runBlocks }];
    const out: End[] = [...runEnds];
    for (const h of handlers) {
      const hb = h.childForFieldName('body') ?? h.namedChildren.find((c) => c.type === 'block' || c.type === 'statement_block');
      const head = oneLine(h.text.slice(0, (hb?.startIndex ?? h.endIndex) - h.startIndex).replace(/[:{]\s*$/, ''));
      const c = this.node('catch', head, h, h.startPosition.row, headRow(h, hb), inner.depth, { text: firstLine(h) });
      this.edges.push({ from: t, to: c, kind: 'error', label: 'error' });
      for (const id of throws) this.edges.push({ from: id, to: c, kind: 'error', label: 'error' });
      const seq = this.seq(statementsOf(hb), [{ from: c }], inner);
      branches.push({ label: 'error', body: [{ node: c }, ...seq.blocks] });
      out.push(...seq.ends);
    }
    const blocks: ChartBlock[] = [{ node: t, branches }];
    const fin = this.language === 'python' ? s.namedChildren.find((c) => c.type === 'finally_clause') : s.childForFieldName('finalizer');
    if (fin) {
      const f = this.node('finally', 'finally', fin, fin.startPosition.row, fin.startPosition.row, ctx.depth, { text: firstLine(fin) });
      // finally runs on each way out. When the try and each handler end with an exit, the exit goes on after it.
      if (out.length > 0) this.link(out, f);
      else this.edges.push({ from: t, to: f, kind: 'next', label: 'always' });
      const seq = this.seq(statementsOf(fin), [{ from: f }], inner);
      blocks.push({ node: f }, ...seq.blocks);
      return { blocks, ends: out.length > 0 ? seq.ends : [] };
    }
    return { blocks, ends: out };
  }

  private with(s: Node, ends: End[], ctx: Ctx): Seq {
    const body = s.childForFieldName('body');
    const head = oneLine(s.text.slice(0, (body?.startIndex ?? s.endIndex) - s.startIndex).replace(/:\s*$/, ''));
    const w = this.node('with', head, s, s.startPosition.row, headRow(s, body), ctx.depth, { text: firstLine(s) });
    this.link(ends, w);
    const seq = this.seq(statementsOf(body), [{ from: w }], { ...ctx, depth: ctx.depth + 1 });
    return { blocks: [{ node: w }, ...seq.blocks], ends: seq.ends };
  }

  /** A compound statement deeper than MAX_DEPTH: one node, "+N steps". */
  private fold(s: Node, ends: End[], ctx: Ctx): Seq {
    const n = countStatements(s);
    this.folds++;
    const id = this.node('fold', `+${n} ${n === 1 ? 'step' : 'steps'}`, s, s.startPosition.row, s.endPosition.row, ctx.depth, { text: firstLine(s), count: n });
    this.link(ends, id);
    return { blocks: [{ node: id }], ends: [{ from: id }] };
  }
}
