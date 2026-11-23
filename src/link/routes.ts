// The server routes of a TypeScript file: the lines where a node server, Express, Fastify or
// Hono code picks a route. The http-calls linker matches a TypeScript client call to these routes
// too, not only to the FastAPI routes of the Python reader.
//
// A route line is one of these:
//   path === '/api/epic'              also `pathname`, `url`, `route`; `==` too
//   path.startsWith('/api/thread/')   a prefix route: each path below it matches
//   case '/api/epic':                 a switch on the path
//   app.get('/orders', handler)       a router call: app, router, server, api, fastify, express, hono
// The method is the method on the same line (`method === 'POST'`, the router call). If the line
// shows no method, the method comes from one of these, in this order:
//   a method table in the file          '/api/approve': 'POST',   (one route for each method)
//   a method test after the route line  if (req.method !== 'POST')   (before the next route line)
//   a method guard before the first route line: `if (req.method !== 'GET' && req.method !== 'HEAD')`
//     with a 405 in the next lines (the server takes only these methods)
// Else the method is ANY. The code does not guess more than the file shows.

export interface ServerRoute {
  /** The line of the route, 1-based. */
  line: number;
  /** GET, POST, ... or ANY when the line does not show a method. */
  method: string;
  /** The path with each parameter as `{}`, e.g. `/api/orders/{}`. */
  path: string;
  /** A `startsWith` route: each path below it matches. */
  prefix: boolean;
}

const EXACT_RE = /\b(?:path|pathname|url|route|p)\s*===?\s*(['"`])(\/[^'"`\s]*)\1/g;
const PREFIX_RE = /\b(?:path|pathname|url|route|p)\.startsWith\(\s*(['"`])(\/[^'"`\s]+)\1/g;
const CASE_RE = /^\s*case\s+(['"`])(\/[^'"`\s]*)\1\s*:/;
const ROUTER_RE = /\b(app|router|server|api|fastify|express|hono|\w+Router)\.(get|post|put|patch|delete|head|options|all)\(\s*(['"`])(\/[^'"`]*)\3\s*,/g;
const METHOD_RE = /\bmethod\s*===?\s*(['"])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\1/i;
/** A method test in the body of a route: `req.method !== 'POST'` or `req.method === 'GET'`. */
const BODY_METHOD_RE = /\bmethod\s*[!=]==?\s*(['"])(GET|POST|PUT|PATCH|DELETE)\1/i;
/** A line of a method table: `'/api/approve': 'POST',` or `'/api/epic': 'GET, HEAD',`. */
const TABLE_RE = /^\s*(['"`])(\/[^'"`\s]+)\1\s*:\s*(['"`])((?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)(?:\s*,\s*(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS))*)\3\s*,?\s*$/;
/** A method guard: `method !== 'GET'`, all the methods of the line. */
const GUARD_RE = /\bmethod\s*!==?\s*(['"])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\1/gi;
/** The lines after a route line that can hold its method test. */
const BODY_LINES = 8;

/** The methods of a table value: HEAD and OPTIONS go away; HEAD alone stays GET. */
function methodsOf(value: string): string[] {
  const all = value.split(',').map((m) => m.trim().toUpperCase());
  const main = all.filter((m) => m !== 'HEAD' && m !== 'OPTIONS');
  return main.length > 0 ? main : all.includes('HEAD') ? ['GET'] : [];
}
/** A cheap test before the line scan. */
const MAYBE_SERVER = /===?\s*['"`]\/|startsWith\(\s*['"`]\/|case\s+['"`]\/|\.(?:get|post|put|patch|delete|all)\(\s*['"`]\//;

/** A path with a word in it: `/api/orders`, not `/` or `/{id}`. */
const hasWord = (p: string): boolean => /[a-z]/i.test(p.replace(/\{[^}]*\}|:\w+/g, ''));

/** `/orders/:id` and `/orders/{id}` → `/orders/{}`. */
export function routeSegments(path: string): string[] {
  return path.split('/').filter((x) => x !== '').map((x) => (/^\{.*\}$|^:\w+$/.test(x) ? '{}' : x));
}

/** The server routes of one TypeScript file, in line order. */
export function serverRoutes(text: string): ServerRoute[] {
  if (!MAYBE_SERVER.test(text)) return [];
  const lines = text.split('\n');
  // The method table of the file: the methods of each path.
  const table = new Map<string, string[]>();
  for (const l of lines) {
    const t = TABLE_RE.exec(l);
    if (t) table.set(`/${routeSegments(t[2]!).join('/')}`, methodsOf(t[4]!));
  }
  const found: Array<ServerRoute & { slash: boolean }> = [];
  const routeLines = new Set<number>();
  lines.forEach((text, i) => {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(text)) return;
    const line = i + 1;
    const method = METHOD_RE.exec(text)?.[2]?.toUpperCase() ?? 'ANY';
    const push = (method: string, raw: string, prefix: boolean) => {
      if (!hasWord(raw)) return;
      found.push({ line, method, path: `/${routeSegments(raw).join('/')}`, prefix, slash: raw.endsWith('/') });
      routeLines.add(line);
    };
    for (const m of text.matchAll(ROUTER_RE)) push(m[2] === 'all' ? 'ANY' : m[2]!.toUpperCase(), m[4]!, false);
    for (const m of text.matchAll(EXACT_RE)) push(method, m[2]!, false);
    for (const m of text.matchAll(PREFIX_RE)) push(method, m[2]!, true);
    const c = CASE_RE.exec(text);
    if (c) push(method, c[2]!, false);
  });
  /** The method test in the lines after a route line, before the next route line. */
  const bodyMethod = (line: number): string | undefined => {
    for (let i = line; i < Math.min(lines.length, line + BODY_LINES); i++) {
      if (routeLines.has(i + 1)) return undefined;
      const m = BODY_METHOD_RE.exec(lines[i]!);
      if (m) return m[2]!.toUpperCase();
    }
    return undefined;
  };
  // The method guard of the server: before the first route line, a line that refuses the other
  // methods, with a 405 on that line or the next 3 lines.
  const first = Math.min(...routeLines);
  let guard: string[] = [];
  for (let i = 0; i < first - 1 && i < lines.length; i++) {
    const ms = [...lines[i]!.matchAll(GUARD_RE)].map((m) => m[2]!.toUpperCase());
    if (ms.length === 0 || !lines.slice(i, i + 4).some((l) => /\b405\b/.test(l))) continue;
    guard = methodsOf(ms.join(','));
  }
  const methodsFor = (r: ServerRoute & { slash: boolean }): string[] => {
    if (r.method !== 'ANY') return [r.method];
    if (!r.prefix) {
      const exact = table.get(r.path);
      if (exact && exact.length > 0) return exact;
    } else {
      // A prefix route: the methods of the paths below it. Without "/" at the end, the path itself matches too.
      const under = [...table].filter(([p]) => (p === r.path && !r.slash) || p.startsWith(`${r.path === '/' ? '' : r.path}/`)).flatMap(([, m]) => m);
      if (under.length > 0) return [...new Set(under)];
    }
    const body = bodyMethod(r.line);
    return body ? [body] : guard.length > 0 ? guard : ['ANY'];
  };
  const out: ServerRoute[] = [];
  const seen = new Set<string>();
  for (const r of found) {
    for (const method of methodsFor(r)) {
      const key = `${method} ${r.path} ${r.prefix}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ line: r.line, method, path: r.path, prefix: r.prefix });
    }
  }
  return out;
}

/**
 * How well a client call fits a route: the number of equal segments, or -1. A parameter in the route
 * fits each segment. A prefix route fits a longer call path too, with a lower score than a full route.
 */
export function routeFit(callMethod: string, callPath: string[], route: { method: string; path: string[]; prefix?: boolean }): number {
  if (!(callMethod === '*' || route.method === 'ANY' || callMethod === route.method)) return -1;
  if (route.prefix ? callPath.length < route.path.length : callPath.length !== route.path.length) return -1;
  let score = 0;
  for (let i = 0; i < route.path.length; i++) {
    if (route.path[i] === '{}') continue;
    if (callPath[i] !== route.path[i]) return -1;
    score++;
  }
  return route.prefix ? score - 0.5 : score;
}
