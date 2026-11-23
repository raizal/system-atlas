// The HTTP client calls of a TypeScript file.
//
// Client calls (tree-sitter):
//   fetch(url [, { method }])          also ky(url, …), axios(url, …), ofetch / $fetch
//   axios({ url, method })             a config object as the only argument
//   <client>.get|post|put|patch|delete|head|options(url, …)   axios, ky, or an instance of them
// The URL is a string, a template string, a `+` of strings, or a top-level string const; each part
// that is not known is a parameter. `${base}/api/…` and `http://host/api/…` lose the base. A URL in a
// wrapper call (`fetch(at('api/epic'))`) or in a const of the function is read too, and a relative
// `api/epic` is `/api/epic`.

import { Parser, type Node } from 'web-tree-sitter';
import { loadGrammars, stringValue } from '../flow/grammars.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const FETCHERS = new Set(['fetch', 'ky', 'axios', 'ofetch', '$fetch']);
/** Receivers that define server routes in TypeScript (Express, Fastify, Hono), not client calls. */
const SERVERS = new Set(['app', 'router', 'server', 'fastify', 'express', 'api_router']);
/** A file may have a client call: a cheap test before parsing. */
const MAYBE_CLIENT = /\b(fetch|ky|axios|ofetch|\$fetch)\s*[(<]|\.(get|post|put|patch|delete|head|options|request)\s*[(<]/;
/** A path segment that is a parameter. */
const PARAM = '{}';

/** One client call in a TypeScript file. `method` `*` is a method the linker cannot read. */
export interface ClientCall {
  line: number;
  method: string;
  /** The path with each unknown part as `{}`, e.g. `/api/orders/{}`. */
  path: string;
}

// ---------------------------------------------------------------- client calls

let parsers: Promise<{ ts: Parser; tsx: Parser }> | undefined;

function tsParsers(): Promise<{ ts: Parser; tsx: Parser }> {
  parsers ??= loadGrammars().then((g) => {
    const ts = new Parser();
    ts.setLanguage(g.typescript);
    const tsx = new Parser();
    tsx.setLanguage(g.tsx);
    return { ts, tsx };
  });
  return parsers;
}

/** The HTTP client calls of one TypeScript file. */
export async function readClientCalls(file: string, text: string, external: readonly HttpHelper[] = []): Promise<ClientCall[]> {
  return clientCalls(await tsParsers(), file, text, external);
}

/**
 * The HTTP client calls of one TypeScript file. `external`: the HTTP helpers of the files that it
 * imports (see `httpHelpers`): `callApi('/orders', { method: 'POST' })` is a call too.
 */
export function clientCalls(p: { ts: Parser; tsx: Parser }, file: string, text: string, external: readonly HttpHelper[] = []): ClientCall[] {
  const used = external.filter((h) => text.includes(`${h.name}(`) || text.includes(`${h.name}<`));
  if (!MAYBE_CLIENT.test(text) && used.length === 0) return [];
  const tree = (file.endsWith('.tsx') ? p.tsx : p.ts).parse(text);
  if (!tree) return [];
  try {
    const consts = topLevelStrings(tree.rootNode);
    const out: ClientCall[] = [];
    const wrappers: Wrapper[] = used.map((h) => ({ name: h.name, index: h.index, method: h.method, ...(h.prefix ? { prefix: h.prefix } : {}), options: true }));
    const visit = (node: Node) => {
      if (node.type === 'call_expression') {
        const call = clientCall(node, consts, wrappers);
        if (call) out.push(call);
      }
      for (const c of node.namedChildren) visit(c);
    };
    visit(tree.rootNode);
    // A helper with the URL as a parameter: `const get = (url) => fetch(at(url))`. Each call of the
    // helper in the file with a known URL is a client call on the line of that call.
    if (wrappers.length > 0) {
      const byName = new Map(wrappers.map((w) => [w.name, w]));
      const calls = (node: Node) => {
        if (node.type === 'call_expression') {
          const fn = calleeOf(node);
          const w = fn?.type === 'identifier' ? byName.get(fn.text) : undefined;
          const arg = w ? node.childForFieldName('arguments')?.namedChildren[w.index] : undefined;
          const raw = arg && w ? urlText(arg, consts) : undefined;
          const path = raw === undefined ? undefined : clientPath(`${w?.prefix ?? ''}${raw.startsWith('/') || raw.startsWith('http') ? '' : '/'}${raw}`);
          // A helper of another file takes the method in its options: `{ method: 'POST' }`.
          const opts = w?.options ? node.childForFieldName('arguments')?.namedChildren[w.index + 1] : undefined;
          const m = opts?.type === 'object' ? property(opts, 'method') : undefined;
          const method = m ? (stringValue(m)?.toUpperCase() ?? '*') : w?.method;
          if (w && path !== undefined) out.push({ line: node.startPosition.row + 1, method: method!, path });
        }
        for (const c of node.namedChildren) calls(c);
      };
      calls(tree.rootNode);
      out.sort((a, b) => a.line - b.line);
    }
    return out;
  } finally {
    tree.delete();
  }
}

/** `const API = '/api'` at the top level (also exported): API → /api. */
function topLevelStrings(root: Node): Map<string, string> {
  const out = new Map<string, string>();
  for (let stmt of root.namedChildren) {
    if (stmt.type === 'export_statement') stmt = stmt.namedChildren.find((c) => c.type === 'lexical_declaration') ?? stmt;
    if (stmt.type !== 'lexical_declaration') continue;
    for (const d of stmt.namedChildren.filter((c) => c.type === 'variable_declarator')) {
      const name = d.childForFieldName('name');
      const value = stringValue(d.childForFieldName('value'));
      if (name?.type === 'identifier' && value !== undefined) out.set(name.text, value);
    }
  }
  return out;
}

/** A function that gives its parameter `index` to a client call as the URL. */
interface Wrapper {
  name: string;
  index: number;
  method: string;
  /** The path that the helper puts before the URL (`/v1`). */
  prefix?: string;
  /** The method comes from the options argument after the URL. */
  options?: boolean;
}

/** An HTTP helper of a file, for the files that import it: `callApi(path, opts)`. */
export interface HttpHelper {
  name: string;
  /** The index of the URL parameter. */
  index: number;
  /** The method when the options give none. */
  method: string;
  prefix?: string;
}

const URL_PARAM = /^(url|path|endpoint|route|uri|href|resource)$|(Url|Path|Endpoint|Route)$/;

/**
 * The HTTP helpers of a file: top-level functions with a URL parameter (`path`, `url` …) that build a
 * client call with it, or call another helper with it. `${BASE}/v1${path}` gives the prefix `/v1`. The
 * method is the default of the options (`opts.method ?? 'GET'`), else GET.
 */
export async function readHttpHelpers(file: string, text: string, external: readonly HttpHelper[] = []): Promise<HttpHelper[]> {
  return httpHelpers(await tsParsers(), file, text, external);
}

export function httpHelpers(p: { ts: Parser; tsx: Parser }, file: string, text: string, external: readonly HttpHelper[] = []): HttpHelper[] {
  if (!MAYBE_CLIENT.test(text) && !external.some((h) => text.includes(`${h.name}(`))) return [];
  const tree = (file.endsWith('.tsx') ? p.tsx : p.ts).parse(text);
  if (!tree) return [];
  try {
    const fns: Array<{ name: string; params: string[]; body: Node }> = [];
    for (let stmt of tree.rootNode.namedChildren) {
      if (stmt.type === 'export_statement') stmt = stmt.namedChildren.find((c) => c.type === 'function_declaration' || c.type === 'lexical_declaration') ?? stmt;
      const add = (name: string | undefined, f: Node | null | undefined) => {
        const body = f?.childForFieldName('body');
        if (!name || !f || !body) return;
        const ps = f.childForFieldName('parameters')?.namedChildren.map((c) => (c.childForFieldName('pattern') ?? c).text) ?? [f.childForFieldName('parameter')?.text ?? ''];
        fns.push({ name, params: ps, body });
      };
      if (stmt.type === 'function_declaration') add(stmt.childForFieldName('name')?.text, stmt);
      if (stmt.type === 'lexical_declaration') {
        for (const d of stmt.namedChildren.filter((c) => c.type === 'variable_declarator')) {
          const v = d.childForFieldName('value');
          if (v && ['arrow_function', 'function_expression', 'function'].includes(v.type)) add(d.childForFieldName('name')?.text, v);
        }
      }
    }
    const out: HttpHelper[] = [];
    const known = () => [...external, ...out];
    for (let grew = true; grew; ) {
      grew = false;
      for (const f of fns) {
        if (out.some((h) => h.name === f.name)) continue;
        const index = f.params.findIndex((x) => URL_PARAM.test(x));
        if (index < 0) continue;
        const param = f.params[index]!;
        const body = f.body.text;
        if (!new RegExp(`\\b${param}\\b`).test(body)) continue;
        // Another helper with the parameter as its URL: its prefix and method.
        const inner = known().find((h) => new RegExp(`\\b${h.name}\\s*(?:<[^>]*>)?\\(\\s*${param}\\b`).test(body));
        let prefix: string | undefined;
        let method = /\bmethod\s*:\s*[\w.]+\s*(?:\?\?|\|\|)\s*['"`](\w+)['"`]/.exec(body)?.[1]?.toUpperCase() ?? 'GET';
        if (inner) {
          prefix = inner.prefix;
          method = inner.method;
        } else {
          if (!MAYBE_CLIENT.test(body)) continue;
          // `${BASE}/v1${path}`: the text between the base and the parameter.
          const t = new RegExp(`\`\\$\\{[^}]*\\}((?:/[\\w.-]+)+)\\$\\{\\s*${param}\\b`).exec(body);
          if (t) prefix = t[1];
          else if (!new RegExp(`\\$\\{\\s*${param}\\b|\\+\\s*${param}\\b|\\(\\s*${param}\\s*[,)]`).test(body)) continue;
        }
        out.push({ name: f.name, index, method, ...(prefix ? { prefix } : {}) });
        grew = true;
      }
    }
    return out;
  } finally {
    tree.delete();
  }
}

/** The name and the parameter index when `id` is a parameter of a named function: `const get = (url) => …`. */
function paramOf(id: Node): { name: string; index: number } | undefined {
  if (id.type !== 'identifier') return undefined;
  for (let p = id.parent; p; p = p.parent) {
    if (!['arrow_function', 'function_declaration', 'function_expression', 'function'].includes(p.type)) continue;
    const params = (p.childForFieldName('parameters')?.namedChildren ?? []).map((c) => (c.childForFieldName('pattern') ?? c).text);
    const single = p.childForFieldName('parameter')?.text;
    const index = single !== undefined ? (single === id.text ? 0 : -1) : params.indexOf(id.text);
    if (index < 0) continue;
    const owner = p.type === 'function_declaration' ? p.childForFieldName('name') : p.parent?.type === 'variable_declarator' ? p.parent.childForFieldName('name') : null;
    return owner ? { name: owner.text, index } : undefined;
  }
  return undefined;
}

/** The function of a call. tree-sitter reads `await f<T>(x)` as a call of `await f`: this gives `f`. */
function calleeOf(node: Node): Node | null {
  const fn = node.childForFieldName('function');
  return fn?.type === 'await_expression' && fn.namedChildCount === 1 ? (fn.namedChildren[0] ?? null) : fn;
}

function clientCall(node: Node, consts: Map<string, string>, wrappers: Wrapper[] = []): ClientCall | undefined {
  const fn = calleeOf(node);
  const args = node.childForFieldName('arguments')?.namedChildren ?? [];
  if (!fn || args.length === 0) return undefined;
  let method: string | undefined;
  let urlNode: Node | undefined;
  let options: Node | undefined;
  if (fn.type === 'identifier' && FETCHERS.has(fn.text)) {
    if (args[0]!.type === 'object') {
      urlNode = property(args[0]!, 'url');
      options = args[0];
    } else {
      urlNode = args[0];
      options = args[1];
    }
  } else if (fn.type === 'member_expression') {
    const name = fn.childForFieldName('property')?.text ?? '';
    const receiver = fn.childForFieldName('object')?.text ?? '';
    if (SERVERS.has(receiver)) return undefined;
    if (METHODS.includes(name)) {
      if (args.slice(1).some((a) => ['arrow_function', 'function_expression', 'function'].includes(a.type))) return undefined; // a route handler
      method = name.toUpperCase();
      urlNode = args[0];
    } else if (name === 'request' && args[0]!.type === 'object') {
      urlNode = property(args[0]!, 'url');
      options = args[0];
    } else {
      return undefined;
    }
  } else {
    return undefined;
  }
  if (!urlNode) return undefined;
  const raw = urlText(urlNode, consts);
  const path = raw === undefined ? undefined : clientPath(raw);
  if (path === undefined) {
    // The URL is a parameter of a helper function (also inside a URL wrapper: `fetch(at(url))`).
    const inner = urlNode.type === 'call_expression' ? urlNode.childForFieldName('arguments')?.namedChildren[0] : urlNode;
    const param = inner ? paramOf(inner) : undefined;
    if (param) {
      const m = options?.type === 'object' ? property(options, 'method') : undefined;
      const known = method ?? (m === undefined ? (options === undefined || options.type === 'object' ? 'GET' : '*') : (stringValue(m)?.toUpperCase() ?? '*'));
      wrappers.push({ ...param, method: known });
    }
    return undefined;
  }
  if (method === undefined) {
    const m = options?.type === 'object' ? property(options, 'method') : undefined;
    method = m === undefined ? 'GET' : (stringValue(m)?.toUpperCase() ?? '*');
  }
  return { line: node.startPosition.row + 1, method, path };
}

/** The value of `key: value` (or the shorthand `key`) in an object literal. */
function property(obj: Node, key: string): Node | undefined {
  for (const c of obj.namedChildren) {
    if (c.type === 'pair' && c.childForFieldName('key')?.text.replace(/^['"]|['"]$/g, '') === key) return c.childForFieldName('value') ?? undefined;
    if (c.type === 'shorthand_property_identifier' && c.text === key) return c;
  }
  return undefined;
}

/** The text of a URL expression; each part the linker cannot know is `{}`. */
function urlText(node: Node, consts: Map<string, string>): string | undefined {
  switch (node.type) {
    case 'string':
      return stringValue(node);
    case 'template_string': {
      let out = '';
      let at = node.startIndex + 1;
      for (const c of node.namedChildren) {
        if (c.type !== 'template_substitution') continue;
        out += node.text.slice(at - node.startIndex, c.startIndex - node.startIndex);
        const inner = c.namedChildren[0];
        out += (inner && urlText(inner, consts)) ?? PARAM;
        at = c.endIndex;
      }
      return out + node.text.slice(at - node.startIndex, -1);
    }
    case 'binary_expression': {
      if (node.childForFieldName('operator')?.text !== '+') return PARAM;
      const l = node.childForFieldName('left');
      const r = node.childForFieldName('right');
      return (l ? (urlText(l, consts) ?? PARAM) : PARAM) + (r ? (urlText(r, consts) ?? PARAM) : PARAM);
    }
    case 'parenthesized_expression':
      return node.namedChildren[0] ? urlText(node.namedChildren[0], consts) : undefined;
    case 'identifier':
      return consts.get(node.text) ?? localString(node) ?? PARAM;
    case 'call_expression': {
      // A URL helper: `at('api/epic')`, `url(\`/api/x/${id}\`)`. Its first argument is the path.
      const first = node.childForFieldName('arguments')?.namedChildren[0];
      const inner = first && ['string', 'template_string', 'binary_expression', 'identifier'].includes(first.type) ? urlText(first, consts) : undefined;
      return inner ?? PARAM;
    }
    default:
      return PARAM;
  }
}

/** The string value of `const name = '…'` (or a template) in a function around the node, before it. */
function localString(id: Node): string | undefined {
  for (let scope = id.parent; scope; scope = scope.parent) {
    if (scope.type !== 'statement_block') continue;
    for (const stmt of scope.namedChildren) {
      if (stmt.startIndex >= id.startIndex) break;
      if (stmt.type !== 'lexical_declaration' || !stmt.text.startsWith('const')) continue;
      for (const d of stmt.namedChildren.filter((c) => c.type === 'variable_declarator')) {
        if (d.childForFieldName('name')?.text !== id.text) continue;
        const value = d.childForFieldName('value');
        if (!value) return undefined;
        if (value.type === 'string') return stringValue(value);
        if (value.type === 'template_string' || value.type === 'binary_expression') return urlText(value, new Map());
        return undefined;
      }
    }
  }
  return undefined;
}

/** `/api/orders/{}` from a URL text, or undefined when it is not a path. */
export function clientPath(raw: string): string | undefined {
  let s = raw.trim().replace(/^https?:\/\/[^/]*/i, '').replace(/[?#].*$/, '');
  while (s.startsWith(`${PARAM}/`)) s = s.slice(PARAM.length); // a base URL in a variable
  if (/^[a-z][\w.-]*\//i.test(s)) s = `/${s}`; // a relative URL: `api/epic` → `/api/epic`
  if (!s.startsWith('/')) return undefined;
  const segs = s.split('/').filter((x) => x !== '').map((x) => (x.includes(PARAM) ? PARAM : x));
  if (segs.length === 0 || segs.every((x) => x === PARAM)) return undefined;
  return `/${segs.join('/')}`;
}
