// The cases and steps of one e2e spec (Playwright, and the simple forms of Cypress), with tree-sitter.
// No LLM and no run: the steps come from the source, in source order.
//
//   test(title, fn)                 a case; `test.describe` blocks give its path
//   test.step(name, fn)             a group of steps
//   test.beforeEach(fn)             a group of steps at the start of each case below it
//   helper(page)                    a function of the same file, or of a file that the spec imports
//                                   (one level), is a group with the name of the helper
//   test.extend({ page: … })        a fixture of the imported `test`: its steps (`page.route` mocks)
//                                   are a group at the start of the case, "from the fixture"
//   page.goto(url)                  goto; consts and template strings resolve: `${INVOICE_ID}` → `:id`
//   locator.click() / fill() …      action, with the locator: `click button "Close invoice"`
//   expect(…)                       assert
//   page.route(glob, …)             mock
//   page.waitForResponse(…)         request; also `request.get(url)` of the API context

import { Parser, type Node } from 'web-tree-sitter';
import { loadGrammars } from '../flow/grammars.js';
import type { CaseStep, Locator, StepKind, TestCase } from './types.js';

export interface SourceFile {
  file: string;
  text: string;
}

/** The file of an import: `from` imports `spec` (a relative path). No value: not a file of the repo. */
export type Loader = (from: string, spec: string) => SourceFile | undefined;

export interface Parsers {
  ts: Parser;
  tsx: Parser;
}

let parsers: Promise<Parsers> | undefined;

export function testParsers(): Promise<Parsers> {
  parsers ??= loadGrammars().then((g) => {
    const ts = new Parser();
    ts.setLanguage(g.typescript);
    const tsx = new Parser();
    tsx.setLanguage(g.tsx);
    return { ts, tsx };
  });
  return parsers;
}

/** The cases of one spec file. */
export async function readCases(file: string, text: string, load: Loader): Promise<TestCase[]> {
  return extractCases(await testParsers(), file, text, load);
}

const ACTIONS = new Set([
  'click', 'dblclick', 'fill', 'type', 'press', 'pressSequentially', 'check', 'uncheck', 'setChecked', 'selectOption', 'hover', 'tap', 'focus', 'blur',
  'clear', 'setInputFiles', 'dragTo', 'selectText', 'dispatchEvent',
]);
/** An action whose first argument is a value: the text shows it. */
const VALUE_ACTIONS = new Set(['fill', 'type', 'press', 'pressSequentially', 'selectOption']);
const LOCATORS: Record<string, string> = {
  getByRole: 'role', getByText: 'text', getByTestId: 'testid', getByLabel: 'label', getByPlaceholder: 'placeholder', getByTitle: 'title', getByAltText: 'alt',
  locator: 'css', $: 'css', get: 'css', contains: 'text', findByRole: 'role', findByText: 'text', findByTestId: 'testid', findByLabelText: 'label',
};
const HTTP = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch']);
const PAGES = new Set(['page', 'frame', 'popup', 'newPage', 'context', 'cy']);
/** The most levels of helpers in helpers. */
const HELPER_DEPTH = 3;
const TEXT_MAX = 72;

interface Module {
  file: string;
  root: Node;
  consts: Map<string, Node>;
  functions: Map<string, Node>;
  /** A local name → the file and the name that it imports. */
  imports: Map<string, { spec: string; name: string }>;
  /** Each `const x = base.extend({...})` of the file: x → the name of its base and its fixtures. */
  extends: Map<string, { base: string; list: Map<string, { fn: Node; auto: boolean }> }>;
  /** The files of `export * from './x'`. */
  stars: string[];
  /** The local names of the test function: `test`, `it`, and the import of a `test`. */
  tests: Set<string>;
}

interface Seg {
  name: string;
  call: boolean;
  args: Node[];
  node: Node;
}

interface Ctx {
  m: Module;
  depth: number;
  /** The local functions and the local locator variables of the body. */
  local: Map<string, Node>;
  vars: Map<string, Seg[]>;
  fixture: boolean;
  /** The helpers on the way here (no loop). */
  stack: string[];
}

const kids = (n: Node | null | undefined): Node[] => (n ? n.namedChildren.filter((c): c is Node => c !== null) : []);
const lineOf = (n: Node) => n.startPosition.row + 1;
const isFn = (n: Node | null | undefined): boolean => !!n && (n.type === 'arrow_function' || n.type === 'function_expression' || n.type === 'function' || n.type === 'function_declaration' || n.type === 'generator_function');
const short = (s: string, max = TEXT_MAX) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const quote = (s: string) => `"${short(s, 40)}"`;

/** The name of a path parameter from a variable name: `INVOICE_ID` → `id`, `orderId` → `id`, `slug` → `slug`. */
export function paramName(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').split(/[_\W]+/).filter(Boolean);
  return (words.at(-1) ?? 'param').toLowerCase();
}

/** A URL or a glob as a path: no scheme and host, no query; empty → `/`. */
export function cleanPath(raw: string, glob = false): string {
  let s = raw.trim();
  s = s.replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, '');
  if (glob) s = s.replace(/^\*\*(?=\/|$)/, '');
  s = s.replace(/[?#].*$/, '');
  // `**/api/orders*` fits `/api/orders` and `/api/orders?page=2`: a star at the end of a name goes.
  if (glob) s = s.replace(/([^/*])\*+$/, '$1');
  if (s !== '' && !s.startsWith('/') && !s.startsWith('*') && !s.startsWith(':')) s = `/${s}`;
  return s === '' ? '/' : s;
}

export function extractCases(p: Parsers, file: string, text: string, load: Loader): TestCase[] {
  const modules = new Map<string, Module | undefined>();
  const moduleOf = (src: SourceFile): Module | undefined => {
    if (modules.has(src.file)) return modules.get(src.file);
    modules.set(src.file, undefined);
    const tree = (/\.[jt]sx$/.test(src.file) ? p.tsx : p.ts).parse(src.text);
    const m = tree ? readModule(src.file, tree.rootNode) : undefined;
    modules.set(src.file, m);
    return m;
  };
  const loadModule = (from: Module, spec: string): Module | undefined => {
    const src = load(from.file, spec);
    return src ? moduleOf(src) : undefined;
  };
  /** True if the module itself has the name (not as an import). */
  const owns = (m: Module, name: string) => m.consts.has(name) || m.functions.has(name) || m.extends.has(name);
  /**
   * The module that has the import `name` of `m`, and the name there. A barrel (`export { test } from
   * './x'`, `export * from './x'`) passes it on: at most four files.
   */
  const imported = (m: Module, name: string, depth = 0): { m: Module; name: string } | undefined => {
    if (depth > 4) return undefined;
    const imp = m.imports.get(name);
    if (imp) {
      const other = loadModule(m, imp.spec);
      if (!other) return undefined;
      if (owns(other, imp.name) || (!other.imports.has(imp.name) && other.stars.length === 0)) return { m: other, name: imp.name };
      return imported(other, imp.name, depth + 1) ?? { m: other, name: imp.name };
    }
    for (const spec of m.stars) {
      const other = loadModule(m, spec);
      if (!other) continue;
      if (owns(other, name)) return { m: other, name };
      const deeper = imported(other, name, depth + 1);
      if (deeper) return deeper;
    }
    return undefined;
  };

  // ---------------------------------------------------------------- values

  /** The value of a const: in the file, or exported by a file that it imports (two levels at most). */
  const constOf = (m: Module, name: string, depth = 0): { m: Module; node: Node } | undefined => {
    const own = m.consts.get(name);
    if (own) return { m, node: own };
    if (depth >= 2) return undefined;
    const imp = imported(m, name);
    return imp ? constOf(imp.m, imp.name, depth + 1) : undefined;
  };

  /** The text of a string expression; each part that is not known is `:name`. No value: no string. */
  const textOf = (m: Module, n: Node | null | undefined, local?: Map<string, Node>, depth = 0): string | undefined => {
    if (!n || depth > 6) return undefined;
    switch (n.type) {
      case 'string':
        return kids(n).map((c) => (c.type === 'escape_sequence' ? c.text.slice(1) : c.text)).join('');
      case 'template_string': {
        let out = '';
        let first = true;
        for (const c of kids(n)) {
          if (c.type === 'string_fragment') out += c.text;
          else if (c.type === 'escape_sequence') out += c.text.slice(1);
          else if (c.type === 'template_substitution') {
            const e = kids(c)[0];
            out += partOf(m, e, first && out === '', local, depth);
          }
          first = false;
        }
        return out;
      }
      case 'identifier': {
        const l = local?.get(n.text);
        if (l) return textOf(m, l, local, depth + 1);
        const c = constOf(m, n.text);
        return c ? textOf(c.m, c.node, undefined, depth + 1) : undefined;
      }
      case 'binary_expression': {
        if (n.childForFieldName('operator')?.text !== '+') return undefined;
        const a = n.childForFieldName('left');
        const b = n.childForFieldName('right');
        const left = textOf(m, a, local, depth + 1) ?? partOf(m, a, true, local, depth);
        const right = textOf(m, b, local, depth + 1) ?? partOf(m, b, false, local, depth);
        return left + right;
      }
      case 'parenthesized_expression':
      case 'as_expression':
      case 'satisfies_expression':
      case 'non_null_expression':
        return textOf(m, kids(n)[0], local, depth + 1);
      case 'regex':
        return regexPath(n.childForFieldName('pattern')?.text ?? '');
      default:
        return undefined;
    }
  };

  /** A part of a template: a path const goes in; another value is a parameter; a base URL at the start goes away. */
  const partOf = (m: Module, e: Node | undefined | null, lead: boolean, local: Map<string, Node> | undefined, depth: number): string => {
    if (!e) return ':param';
    const name = e.type === 'identifier' ? e.text : e.type === 'member_expression' ? (e.childForFieldName('property')?.text ?? 'param') : e.type === 'call_expression' ? 'param' : 'param';
    const v = e.type === 'identifier' ? textOf(m, e, local, depth + 1) : undefined;
    if (v !== undefined && (v.includes('/') || v.startsWith('http'))) return v;
    if (lead && /url|base|host|origin|server|root/i.test(name)) return '';
    return `:${paramName(name)}`;
  };

  // ---------------------------------------------------------------- steps

  const chainOf = (n: Node | null | undefined): Seg[] => {
    if (!n) return [];
    switch (n.type) {
      case 'await_expression':
      case 'parenthesized_expression':
      case 'non_null_expression':
      case 'as_expression':
        return chainOf(kids(n)[0]);
      case 'call_expression': {
        const f = n.childForFieldName('function');
        const args = kids(n.childForFieldName('arguments'));
        if (f?.type === 'member_expression') return [...chainOf(f.childForFieldName('object')), { name: f.childForFieldName('property')?.text ?? '', call: true, args, node: n }];
        return [{ name: f?.text ?? '', call: true, args, node: n }];
      }
      case 'member_expression':
        return [...chainOf(n.childForFieldName('object')), { name: n.childForFieldName('property')?.text ?? '', call: false, args: [], node: n }];
      default:
        return [{ name: n.text, call: false, args: [], node: n }];
    }
  };

  /** The locator of a chain: its last locator call. */
  const locatorOf = (m: Module, segs: Seg[], ctx: Ctx): Locator | undefined => {
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i]!;
      const by = LOCATORS[s.name];
      if (!s.call || !by) continue;
      if ((s.name === 'get' || s.name === 'contains') && segs[0]?.name !== 'cy') continue;
      const arg = s.args[0];
      const value = (arg?.type === 'regex' ? arg.childForFieldName('pattern')?.text : textOf(m, arg, ctx.local)) ?? arg?.text ?? '';
      const loc: Locator = { by, value };
      const opts = s.args[1];
      if (by === 'role' && opts?.type === 'object') {
        for (const pair of kids(opts)) {
          if (pair.type !== 'pair' || pair.childForFieldName('key')?.text !== 'name') continue;
          const v = pair.childForFieldName('value');
          const name = v?.type === 'regex' ? v.childForFieldName('pattern')?.text : textOf(m, v, ctx.local);
          if (name !== undefined) loc.name = name;
        }
      }
      return loc;
    }
    return undefined;
  };

  const locText = (l: Locator): string => {
    if (l.by === 'role') return l.name !== undefined ? `${l.value} ${quote(l.name)}` : l.value;
    if (l.by === 'css') return quote(l.value);
    return `${l.by} ${quote(l.value)}`;
  };

  /** A chain with its root variable replaced by the locator chain of the variable. */
  const expand = (segs: Seg[], ctx: Ctx): Seg[] => {
    const v = segs[0] && !segs[0].call ? ctx.vars.get(segs[0].name) : undefined;
    return v ? [...v, ...segs.slice(1)] : segs;
  };

  const step = (kind: StepKind, text: string, n: Node, ctx: Ctx, more: Partial<CaseStep> = {}): CaseStep => ({
    id: '', kind, text: short(text), file: ctx.m.file, line: lineOf(n), ...more, ...(ctx.fixture ? { fromFixture: true } : {}),
  });

  const urlArg = (m: Module, n: Node | undefined, ctx: Ctx, glob = false): string | undefined => {
    if (!n) return undefined;
    if (n.type === 'regex') return regexPath(n.childForFieldName('pattern')?.text ?? '');
    const t = textOf(m, n, ctx.local);
    return t === undefined ? undefined : cleanPath(t, glob);
  };

  const methodIn = (n: Node | undefined): string => methodsIn(n?.text ?? '')[0] ?? '*';

  /** The step of one call, or undefined: the walk goes into the call. */
  const callStep = (call: Node, ctx: Ctx): CaseStep | null | undefined => {
    const m = ctx.m;
    const raw = chainOf(call);
    const segs = expand(raw, ctx);
    const last = segs.at(-1)!;
    const root = segs[0]!;
    // test.step(name, fn)
    if (m.tests.has(root.name) && segs[1]?.name === 'step' && last.call) {
      const fn = last.args.find(isFn);
      const title = textOf(m, last.args[0], ctx.local) ?? 'step';
      return step('group', title, call, ctx, { group: 'step', steps: fn ? bodySteps(fn, ctx) : [] });
    }
    // expect(…)
    const head = root.name === 'expect' ? (root.call ? root : segs[1]?.call ? segs[1] : undefined) : undefined;
    if (head) {
      const subj = head.args[0];
      const sc = subj ? expand(chainOf(subj), ctx) : [];
      const loc = locatorOf(m, sc, ctx);
      const what = loc ? locText(loc) : sc.length === 1 ? sc[0]!.name : sc.length === 2 && sc[1]!.call && sc[1]!.args.length === 0 ? `${sc[0]!.name}.${sc[1]!.name}()` : short(subj?.text ?? '', 30);
      const matcher = last.call && last !== head ? last.name : 'ok';
      const not = segs.some((s) => s.name === 'not') ? 'not ' : '';
      const arg = last !== head ? last.args[0] : undefined;
      const val = arg ? (arg.type === 'number' ? arg.text : textOf(m, arg, ctx.local)) : undefined;
      // expect(invoiceApi.created()): a record of a fixture mock. It checks the requests of that mock.
      const api = !loc && sc.length >= 2 && sc[1]!.call === true ? apiOf(sc[0]!.name, sc[1]!.name) : undefined;
      return step('assert', `expect ${what} ${not}${matcher}${val !== undefined ? ` ${quote(val)}` : ''}`, call, ctx, {
        matcher: `${not}${matcher}`, ...(val !== undefined ? { value: val } : {}),
        ...(loc ? { locator: loc } : {}), ...(matcher === 'toHaveURL' && val ? { url: cleanPath(val) } : {}), ...(api ? { api } : {}),
      });
    }
    if (root.name === 'cy' && last.name === 'should') {
      const loc = locatorOf(m, segs, ctx);
      return step('assert', `expect ${loc ? locText(loc) : 'page'} ${textOf(m, last.args[0], ctx.local) ?? 'ok'}`, call, ctx, loc ? { locator: loc } : {});
    }
    // goto
    if (last.call && (last.name === 'goto' || (root.name === 'cy' && last.name === 'visit'))) {
      const url = urlArg(m, last.args[0], ctx);
      return step('goto', `goto ${url ?? short(last.args[0]?.text ?? '?', 40)}`, call, ctx, url !== undefined ? { url } : {});
    }
    // page.route(glob, handler) / cy.intercept([method,] url)
    if (last.call && ((last.name === 'route' && last.args.length >= 2) || (root.name === 'cy' && last.name === 'intercept'))) {
      const methods = methodsIn(last.args[1]?.text ?? '');
      let method = methods[0] ?? '*';
      let arg = last.args[0];
      if (last.name === 'intercept' && last.args.length >= 2 && /^['"`][A-Z]+['"`]$/.test(last.args[0]!.text)) {
        method = last.args[0]!.text.slice(1, -1);
        arg = last.args[1];
      }
      const glob = arg?.type === 'regex' ? `/${arg.childForFieldName('pattern')?.text ?? ''}/` : textOf(m, arg, ctx.local);
      const url = urlArg(m, arg, ctx, true);
      const all = last.name === 'route' && methods.length > 1 ? methods : undefined;
      return step('mock', `mock ${all ? `${all.join(', ')} ` : method === '*' ? '' : `${method} `}${url ?? glob ?? '?'}`, call, ctx, { method, ...(all ? { methods: all } : {}), ...(glob !== undefined ? { glob } : {}), ...(url !== undefined ? { url } : {}) });
    }
    // waitForResponse / waitForRequest
    if (last.call && (last.name === 'waitForResponse' || last.name === 'waitForRequest')) {
      const arg = last.args[0];
      let url = arg && !isFn(arg) ? urlArg(m, arg, ctx, true) : undefined;
      if (url === undefined && arg) {
        const lit = /['"`](\*{0,2}\/[^'"`\s]*api[^'"`\s]*|\/[\w-]+\/[^'"`\s]*)['"`]/.exec(arg.text);
        if (lit) url = cleanPath(lit[1]!, true);
      }
      const method = methodIn(arg);
      return step('request', `wait for ${method === '*' ? '' : `${method} `}${url ?? 'a response'}`, call, ctx, { method, ...(url !== undefined ? { url } : {}) });
    }
    // request.get(url) of the API context
    if (last.call && HTTP.has(last.name) && segs.length >= 2 && (segs.at(-2)!.name === 'request' || /^(api|request)\w*$/i.test(segs.at(-2)!.name))) {
      const method = last.name === 'fetch' ? '*' : last.name.toUpperCase();
      const url = urlArg(m, last.args[0], ctx);
      return step('request', `${method === '*' ? 'request' : method} ${url ?? '?'}`, call, ctx, { method, ...(url !== undefined ? { url } : {}) });
    }
    // An action on a locator, or on the page with a selector.
    if (last.call && ACTIONS.has(last.name)) {
      const recv = segs.slice(0, -1);
      let loc = locatorOf(m, recv, ctx);
      let args = last.args;
      if (!loc && recv.length === 1 && PAGES.has(recv[0]!.name) && last.args[0]) {
        const sel = textOf(m, last.args[0], ctx.local);
        if (sel !== undefined) loc = { by: 'css', value: sel };
        args = last.args.slice(1);
      }
      const keyboard = recv.at(-1)?.name === 'keyboard';
      if (!loc && !keyboard && !PAGES.has(recv[0]?.name ?? '') && !ctx.vars.has(raw[0]?.name ?? '')) return undefined;
      const val = VALUE_ACTIONS.has(last.name) ? textOf(m, args[0], ctx.local) : undefined;
      const text = `${last.name}${loc ? ` ${locText(loc)}` : ''}${val !== undefined ? ` ${quote(val)}` : ''}`;
      return step('action', text, call, ctx, { action: last.name, ...(loc ? { locator: loc } : {}) });
    }
    if (last.call && last.name === 'waitForURL') {
      const url = urlArg(m, last.args[0], ctx, true);
      return step('assert', `wait for URL ${url ?? '?'}`, call, ctx, url !== undefined ? { url } : {});
    }
    // A helper: a function of the file or of an imported file.
    if (last.call && segs.length === 1 && ctx.depth < HELPER_DEPTH && !ctx.stack.includes(last.name)) {
      const own = ctx.local.get(last.name) ?? m.functions.get(last.name);
      const hit = own ? { m, fn: own } : (() => {
        const imp = imported(m, last.name);
        const fn = imp && imp.m !== m ? imp.m.functions.get(imp.name) : undefined;
        return imp && fn ? { m: imp.m, fn } : undefined;
      })();
      if (hit) {
        const inner: Ctx = { ...ctx, m: hit.m, depth: ctx.depth + 1, local: hit.m === m ? ctx.local : new Map(), vars: new Map(), stack: [...ctx.stack, last.name] };
        const steps = bodySteps(hit.fn, inner);
        if (steps.length === 0) return null;
        return step('group', last.name, call, ctx, { group: 'helper', steps });
      }
      return undefined;
    }
    // Another call of the page: page.reload(), page.waitForTimeout(…), page.keyboard…
    if (last.call && PAGES.has(root.name) && root.name !== 'context' && segs.length >= 2 && !LOCATORS[last.name] && last.name !== 'on' && last.name !== 'once') {
      return step('other', `${segs.slice(1).map((s) => s.name).join('.')}`, call, ctx);
    }
    return undefined;
  };

  /** The steps of a function body, in source order. */
  const bodySteps = (fn: Node, ctx0: Ctx): CaseStep[] => {
    const ctx: Ctx = { ...ctx0, local: new Map(ctx0.local), vars: new Map(ctx0.vars) };
    const out: CaseStep[] = [];
    const body = fn.childForFieldName('body');
    if (!body) return out;
    // The local helpers and the locator variables of the body.
    for (const s of kids(body)) {
      if (s.type === 'function_declaration') {
        const name = s.childForFieldName('name')?.text;
        if (name) ctx.local.set(name, s);
      }
    }
    const visit = (n: Node) => {
      if (isFn(n) && n !== fn) return;
      if (n.type === 'variable_declarator') {
        const name = n.childForFieldName('name');
        const value = n.childForFieldName('value');
        if (name?.type === 'identifier' && value) {
          if (isFn(value)) {
            ctx.local.set(name.text, value);
            return;
          }
          const segs = expand(chainOf(value), ctx);
          if (segs.some((s) => s.call && LOCATORS[s.name]) && !segs.some((s) => s.call && (ACTIONS.has(s.name) || s.name === 'expect'))) {
            ctx.vars.set(name.text, segs);
            return;
          }
          if (value.type === 'string' || value.type === 'template_string' || value.type === 'binary_expression') ctx.local.set(name.text, value);
        }
      }
      if (n.type === 'call_expression') {
        const s = callStep(n, ctx);
        if (s) {
          out.push(s);
          return;
        }
        if (s === null) return;
      }
      for (const c of kids(n)) visit(c);
    };
    if (isFn(body)) return out;
    if (body.type !== 'statement_block') visit(body);
    else for (const s of kids(body)) visit(s);
    return out;
  };

  // ---------------------------------------------------------------- the cases

  const spec = moduleOf({ file, text });
  if (!spec) return [];
  /**
   * The fixtures of the `test` of the spec: a `base.extend({...})` in the spec, or in the file that the
   * spec imports `test` from (through barrels), and the fixtures of its base if the base is an extended
   * `test` too. A fixture of the outer `extend` wins.
   */
  type Fixture = { fn: Node; auto: boolean; m: Module };
  const fixturesOf = (m: Module, name: string, depth = 0): Map<string, Fixture> => {
    const out = new Map<string, Fixture>();
    if (depth > 4) return out;
    const own = m.extends.get(name);
    if (own) {
      const base = own.base && own.base !== name ? fixturesOf(m, own.base, depth + 1) : new Map<string, Fixture>();
      for (const [k, v] of base) out.set(k, v);
      for (const [k, v] of own.list) out.set(k, { ...v, m });
      return out;
    }
    const imp = imported(m, name);
    return imp && imp.m !== m ? fixturesOf(imp.m, imp.name, depth + 1) : out;
  };
  const fx = new Map<string, Fixture>();
  for (const name of spec.tests) for (const [k, v] of fixturesOf(spec, name)) if (!fx.has(k)) fx.set(k, v);
  const base = (m: Module): Ctx => ({ m, depth: 0, local: new Map(), vars: new Map(), fixture: false, stack: [] });

  /** The records of a fixture (`created: () => posted`) → the mock that fills them: `posted.push(…)` in a `page.route`. */
  const apis = new Map<string, Map<string, NonNullable<CaseStep['api']>>>();
  function apiOf(fixture: string, prop: string): CaseStep['api'] | undefined {
    const f = fx.get(fixture);
    if (!f) return undefined;
    let list = apis.get(fixture);
    if (!list) {
      list = new Map();
      apis.set(fixture, list);
      const mocks: Array<{ url: string; glob?: string; handler: string }> = [];
      const walk = (n: Node) => {
        if (n.type === 'call_expression') {
          const segs = chainOf(n);
          const last = segs.at(-1)!;
          if (last.call && last.name === 'route' && last.args.length >= 2) {
            const url = urlArg(f.m, last.args[0], base(f.m), true);
            const glob = textOf(f.m, last.args[0]);
            if (url) mocks.push({ url, ...(glob !== undefined ? { glob } : {}), handler: last.args[1]!.text });
          }
        }
        for (const c of kids(n)) walk(c);
      };
      walk(f.fn);
      const text = f.fn.text;
      const props = /(\w+)\s*:\s*(?:async\s*)?\(\s*\)\s*=>\s*\(?\s*(?:\[\s*\.\.\.\s*)?([A-Za-z_$][\w$]*)/g;
      for (let p = props.exec(text); p; p = props.exec(text)) {
        const v = p[2]!;
        const write = new RegExp(`\\b${v.replace(/\$/g, '\\$')}\\s*(?:\\.push\\(|\\+\\+|\\+=|=(?!=))`);
        for (const mk of mocks) {
          const at = mk.handler.search(write);
          if (at < 0) continue;
          // The method: the last `method() === 'X'` before the write, else the one method of the handler.
          const before = [...mk.handler.slice(0, at).matchAll(/method\(\)\s*===?\s*['"`](\w+)['"`]/gi)].at(-1)?.[1];
          const one = methodsIn(mk.handler);
          const method = (before ?? (one.length === 1 ? one[0] : '*'))!.toUpperCase();
          list.set(p[1]!, { method, url: mk.url, ...(mk.glob !== undefined ? { glob: mk.glob } : {}) });
          break;
        }
      }
    }
    return list.get(prop);
  }

  /** The fixtures that a case uses: its parameters, the auto fixtures, and the fixtures that those take. */
  const fixtureSteps = (fn: Node): CaseStep[] => {
    const used = new Set(paramNames(fn));
    for (let grew = true; grew; ) {
      grew = false;
      for (const [name, f] of fx) {
        if (!(used.has(name) || f.auto)) continue;
        for (const q of paramNames(f.fn)) {
          if (!fx.has(q) || used.has(q)) continue;
          used.add(q);
          grew = true;
        }
      }
    }
    const out: CaseStep[] = [];
    for (const [name, f] of fx) {
      if (!(name === 'page' || f.auto || used.has(name))) continue;
      const steps = bodySteps(f.fn, { ...base(f.m), fixture: true });
      if (steps.length > 0) out.push({ id: '', kind: 'group', text: `fixture ${name}`, file: f.m.file, line: lineOf(f.fn), group: 'fixture', steps, fromFixture: true });
    }
    return out;
  };

  const cases: TestCase[] = [];
  /** The Playwright tags of a test or describe: `@smoke` in the title, and `{ tag: '@a' }` or `{ tag: ['@a', '@b'] }`. */
  const tagsOf = (title: string, args: Node[]): string[] => {
    const out = [...title.matchAll(/(?:^|\s)(@[\w-]+)/g)].map((m) => m[1]!);
    for (const a of args.filter((x) => x.type === 'object')) {
      for (const pair of kids(a).filter((x) => x.type === 'pair' && x.childForFieldName('key')?.text === 'tag')) {
        const v = pair.childForFieldName('value');
        for (const x of v?.type === 'array' ? kids(v) : v ? [v] : []) {
          const t = x.type === 'string' ? x.text.slice(1, -1) : undefined;
          if (t?.startsWith('@')) out.push(t);
        }
      }
    }
    return [...new Set(out)];
  };
  const suite = (node: Node, path: string[], hooks: CaseStep[], tags: string[] = []) => {
    const local = [...hooks];
    const visit = (n: Node) => {
      if (isFn(n)) return;
      if (n.type === 'call_expression') {
        const segs = chainOf(n);
        const names = segs.map((s) => s.name);
        const last = segs.at(-1)!;
        const isTest = spec.tests.has(names[0]!) || names[0] === 'it' || names[0] === 'specify';
        const fn = last.args.find(isFn);
        const title = textOf(spec, last.args[0]) ?? last.args[0]?.text ?? '';
        if ((isTest && names.includes('describe')) || ['describe', 'context', 'suite'].includes(names[0]!)) {
          if (fn) suite(fn.childForFieldName('body') ?? fn, [...path, title], local, [...new Set([...tags, ...tagsOf(title, last.args)])]);
          return;
        }
        if (isTest && names.length >= 2 && names[1] === 'beforeEach' && fn) {
          const steps = bodySteps(fn, base(spec));
          if (steps.length > 0) local.push({ id: '', kind: 'group', text: 'beforeEach', file, line: lineOf(n), group: 'hook', steps });
          return;
        }
        if (isTest && fn && segs.every((s) => s.call || s === segs[0] || ['only', 'skip', 'fixme', 'fail', 'slow'].includes(s.name)) && (names.length === 1 || (names.length === 2 && ['only', 'skip', 'fixme', 'fail', 'slow'].includes(names[1]!)))) {
          const steps = [...fixtureSteps(fn), ...local.map(cloneStep), ...bodySteps(fn, base(spec))];
          number(steps, 's');
          const all = [...new Set([...tags, ...tagsOf(title, last.args)])];
          cases.push({ id: `${file}:${lineOf(n)}`, title, path, file, line: lineOf(n), ...(names[1] === 'skip' || names[1] === 'fixme' ? { skip: true } : {}), ...(all.length > 0 ? { tags: all } : {}), steps });
          return;
        }
      }
      for (const c of kids(n)) visit(c);
    };
    for (const c of node.type === 'statement_block' || node.type === 'program' ? kids(node) : [node]) visit(c);
  };
  suite(spec.root, [], []);
  return cases;
}

function cloneStep(s: CaseStep): CaseStep {
  return { ...s, ...(s.steps ? { steps: s.steps.map(cloneStep) } : {}) };
}

function number(steps: CaseStep[], prefix: string): void {
  steps.forEach((s, i) => {
    s.id = prefix === 's' ? `s${i + 1}` : `${prefix}.${i + 1}`;
    if (s.steps) number(s.steps, s.id);
  });
}

/** The names that a test function takes from its fixtures: `async ({ page, invoiceApi }) => …`. */
function paramNames(fn: Node): string[] {
  const params = fn.childForFieldName('parameters') ?? fn.childForFieldName('parameter');
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.type === 'shorthand_property_identifier_pattern') out.push(n.text);
    else if (n.type === 'pair_pattern') {
      const k = n.childForFieldName('key')?.text;
      if (k) out.push(k);
    } else for (const c of kids(n)) walk(c);
  };
  if (params) walk(params);
  return out;
}

/** A regex of a URL as a path: `\/api\/orders\/\d+` → `/api/orders/:param`. */
export function regexPath(src: string): string {
  let s = src.replace(/^\^/, '').replace(/\$$/, '');
  s = s.replace(/\\\//g, '/').replace(/\\\./g, '.');
  s = s.replace(/\([^)]*\)|\[[^\]]*\][*+?]?|\\[dw][*+?]?|\.[*+?]/g, ':param');
  s = s.replace(/[*+?]/g, '');
  const i = s.indexOf('/');
  s = i >= 0 ? s.slice(i) : `/${s}`;
  return cleanPath(s, true);
}

function readModule(file: string, root: Node): Module {
  const m: Module = { file, root, consts: new Map(), functions: new Map(), imports: new Map(), extends: new Map(), stars: [], tests: new Set(['test']) };
  const decl = (s: Node) => {
    if (s.type === 'function_declaration') {
      const name = s.childForFieldName('name')?.text;
      if (name) m.functions.set(name, s);
    }
    if (s.type === 'lexical_declaration' || s.type === 'variable_declaration') {
      for (const d of kids(s)) {
        if (d.type !== 'variable_declarator') continue;
        const name = d.childForFieldName('name');
        let value = d.childForFieldName('value');
        if (name?.type !== 'identifier' || !value) continue;
        while (value && (value.type === 'as_expression' || value.type === 'satisfies_expression' || value.type === 'parenthesized_expression')) value = kids(value)[0] ?? null;
        if (!value) continue;
        if (isFn(value)) m.functions.set(name.text, value);
        else m.consts.set(name.text, value);
        // const test = base.extend({...})
        const ext = extendOf(value);
        if (ext) {
          m.tests.add(name.text);
          m.extends.set(name.text, ext);
        }
      }
    }
  };
  for (const s of kids(root)) {
    if (s.type === 'import_statement') {
      const src = s.childForFieldName('source');
      const spec = src ? kids(src).map((c) => c.text).join('') : '';
      if (!spec.startsWith('.')) continue;
      for (const c of kids(s)) {
        if (c.type !== 'import_clause') continue;
        for (const k of kids(c)) {
          if (k.type === 'identifier') m.imports.set(k.text, { spec, name: 'default' });
          if (k.type === 'named_imports') {
            for (const sp of kids(k)) {
              if (sp.type !== 'import_specifier') continue;
              const name = sp.childForFieldName('name')?.text;
              const alias = sp.childForFieldName('alias')?.text ?? name;
              if (!name || !alias) continue;
              m.imports.set(alias, { spec, name });
              if (name === 'test') m.tests.add(alias);
            }
          }
        }
      }
    } else if (s.type === 'export_statement') {
      const d = s.childForFieldName('declaration');
      if (d) decl(d);
      const src = s.childForFieldName('source');
      const spec = src ? kids(src).map((c) => c.text).join('') : '';
      if (!spec.startsWith('.') || /^export\s+type\b/.test(s.text)) continue;
      // export { a, b as c } from './x' (a barrel); export * from './x'
      const clause = kids(s).find((c) => c.type === 'export_clause');
      if (!clause) {
        if (/^export\s*\*\s*from/.test(s.text)) m.stars.push(spec);
        continue;
      }
      for (const sp of kids(clause)) {
        if (sp.type !== 'export_specifier') continue;
        const name = sp.childForFieldName('name')?.text;
        const alias = sp.childForFieldName('alias')?.text ?? name;
        if (!name || !alias || sp.text.startsWith('type ')) continue;
        m.imports.set(alias, { spec, name });
        if (name === 'test') m.tests.add(alias);
      }
    } else decl(s);
  }
  return m;
}

/** The fixtures of `<x>.extend<…>({ name: async ({ page }, use) => …, other: [fn, { auto: true }] })`. */
function extendOf(n: Node): { base: string; list: Map<string, { fn: Node; auto: boolean }> } | undefined {
  if (n.type !== 'call_expression') return undefined;
  const f = n.childForFieldName('function');
  const fname = f?.type === 'member_expression' ? f.childForFieldName('property')?.text : undefined;
  if (fname !== 'extend') return undefined;
  const baseNode = f?.childForFieldName('object');
  const baseName = baseNode?.type === 'identifier' ? baseNode.text : '';
  const obj = kids(n.childForFieldName('arguments')).find((a) => a.type === 'object');
  if (!obj) return undefined;
  const out = new Map<string, { fn: Node; auto: boolean }>();
  for (const pair of kids(obj)) {
    if (pair.type !== 'pair' && pair.type !== 'method_definition') continue;
    const key = (pair.childForFieldName('key') ?? pair.childForFieldName('name'))?.text.replace(/^['"]|['"]$/g, '');
    if (!key) continue;
    if (pair.type === 'method_definition') {
      out.set(key, { fn: pair, auto: false });
      continue;
    }
    const v = pair.childForFieldName('value');
    if (isFn(v)) out.set(key, { fn: v!, auto: false });
    else if (v?.type === 'array') {
      const [fn, opts] = kids(v);
      if (isFn(fn)) out.set(key, { fn: fn!, auto: /auto\s*:\s*true/.test(opts?.text ?? '') });
    }
  }
  return { base: baseName, list: out };
}

/**
 * The HTTP methods that a route handler answers: `method() === 'GET'` branches give each method, and a
 * guard `method() !== 'GET'` (then `fallback()`) gives its method. No method: the handler answers all.
 */
export function methodsIn(text: string): string[] {
  const out: string[] = [];
  const re = /method\(\)\s*[!=]==?\s*['"`](\w+)['"`]|['"`](GET|POST|PUT|PATCH|DELETE)['"`]\s*[!=]==?\s*[\w.]*method\(\)/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const v = (m[1] ?? m[2]!).toUpperCase();
    if (!out.includes(v)) out.push(v);
  }
  return out;
}
