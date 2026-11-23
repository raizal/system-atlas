// The model of the atlas: the views of the map, made from one CodeGraph index.
//   system   the projects and the data stores; the HTTP calls and the imports between projects
//   project  frontend: its pages and its HTTP client functions; an edge from each page to the endpoints that it calls
//            api: its routes by prefix
//            cli: its commands
//            library: the feature groups of its exported functions
//   flow     the flow chart of a page, a route, a command or a function (codeChart of src/flow)
//
// The page opens a box in place: it draws the view of the box inside the box. An edge to a box of
// another view (an HTTP call to an endpoint) has `toPath`, the node IDs from the system level to
// the endpoint. The page draws the edge to the deepest box on this path that is on the canvas.
//
// The model reads the index and the source files only. It does not write to the repo.
// The same index gives the same views.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeChart, type ChartCall, type ChartNode } from '../flow/chart.js';
import type { CodeGraphIndex } from '../index/codegraph.js';
import { isVirtual, type Entry } from '../index/entries.js';
import { AtlasMap, type CodeInfo } from '../index/map.js';
import { isTestPath } from '../index/projects.js';
import { IndexChartSource } from '../index/source.js';
import type { GraphNode } from '../index/types.js';
import { readClientCalls, readHttpHelpers, type HttpHelper } from '../link/client.js';
import { pythonMounts } from '../link/mounts.js';
import { routeFit, routeSegments, serverRoutes, type ServerRoute } from '../link/routes.js';
import { joinHooks } from './hooks.js';
import { featureGroups, reachCalls, REACH_DEPTH, REACH_FANOUT } from './reach.js';
import { clientStores, composeStores, COMPOSE_FILES, manifestOf, projectKind, type DataStore, type Manifest, type ReadFile } from './kinds.js';
import { applyFeatureConfig, CONFIG_FILE, FOLD_MIN, GROUP_NOUN, GROUP_ORDER, GROUP_TITLE, groupOf, matrixOf, parseConfig, sizeStep, SLOTS, type AtlasConfig, type SystemGroup } from './system.js';
import type { AtlasInfo, AtlasView, Matrix, NodeInfo, NodeLink, ProjectKind, SearchHit, Shape, ViewEdge, ViewGroup, ViewNode } from './view.js';

/** The most steps in a flow chart. The rest go into one "+N more" step. */
export const STEP_LIMIT = 60;
/** The most nodes in one group of the project level. */
export const GROUP_LIMIT = 30;
const REACH_LIMIT = 3000;
const TONES = 8;
const FN_KINDS = new Set(['function', 'method', 'class', 'route']);
/** A catch-all at the end of a route path: `/:path*` (Next.js rewrites), `/[...slug]`, `/{rest:path}` (FastAPI). */
const CATCH_ALL = /\/(?::\w+[*+]|\[\[?\.\.\.\w+\]\]?|\{\w+:path\})$/;
/** A proxy route of a frontend: `/api/backend-proxy/v1/jobs` → the word `backend` and the path `/v1/jobs`. */
const PROXY = /^\/api\/([a-z0-9]+(?:-[a-z0-9]+)*?)-proxy(\/.*)?$/i;

export interface Project {
  key: string;
  name: string;
  dir: string;
  kind: ProjectKind;
  tone: number;
  manifest?: Manifest;
}

/** A route that a client can call. */
export interface Endpoint {
  /** `<method> <path>`, unique in its project. */
  key: string;
  unit: string;
  method: string;
  /** The path with each parameter as `{}`. */
  path: string;
  segs: string[];
  prefix: boolean;
  /** The view of its flow chart. */
  open: string;
  file: string;
  line: number;
}

/** An HTTP call in the client code, with the function that holds it and the endpoint it fits. */
export interface Call {
  unit: string;
  file: string;
  line: number;
  method: string;
  path: string;
  /** The innermost function that holds the call. */
  owner?: string;
  endpoint?: Endpoint;
  /** The endpoints that the call can fit, if the match is not sure. The atlas draws no edge for them. */
  possible?: Endpoint[];
}

/** An endpoint that a page reaches (the Features mode). */
export interface PageLink {
  endpoint: Endpoint;
  /** The least steps from the page component to the call (0: a call in the page component). */
  steps: number;
  /** A call in the file of the page. */
  direct: boolean;
  /** Only a possible match: no sure call reaches the endpoint. */
  possible: boolean;
  /** The Next.js API route between the page and the endpoint: the page calls it, and it calls the endpoint. */
  via?: Endpoint;
}

export interface FeatureInfo {
  slug: string;
  label: string;
  pages: Array<{ entry: Entry; links: PageLink[] }>;
}

export interface FrontendFeatures {
  unit: string;
  features: FeatureInfo[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const firstLine = (range: string | undefined): number => Number((range ?? '0').split('-')[0]) || 0;
const lastLine = (range: string | undefined): number => Number((range ?? '0').split('-').at(-1)) || 0;
/** The ID of the node of an endpoint in the view of its project. */
export const endpointId = (e: Pick<Endpoint, 'unit' | 'key'>): string => `ep:${e.unit}:${e.key}`;
/** The node IDs from the system level to an endpoint. */
export const endpointPath = (e: Pick<Endpoint, 'unit' | 'key'>): string[] => [`project:${e.unit}`, endpointId(e)];
/** A group with more routes than this splits by the next segment. */
export const ROUTE_SPLIT = 10;
/** The key of the group of the routes that are alone in their group. */
export const OTHER_ROUTES = 'other';

/**
 * The route groups of an api, by label. The first segment makes a group ("/api"). A group with more
 * than ROUTE_SPLIT routes splits by the first word of the next segment: "/api/story*" holds
 * /api/story-thread and /api/story-tests. The routes that are alone in a group go to "other".
 */
export function routeGroups<T extends Pick<Endpoint, 'segs'>>(list: readonly T[]): Array<[string, T[]]> {
  const by = (items: readonly T[], key: (e: T) => string) => {
    const out = new Map<string, T[]>();
    for (const e of items) out.set(key(e), [...(out.get(key(e)) ?? []), e]);
    return out;
  };
  const groups = new Map<string, T[]>();
  for (const [first, items] of by(list, (e) => e.segs[0] ?? '')) {
    if (items.length <= ROUTE_SPLIT) {
      groups.set(`/${first}`, items);
      continue;
    }
    for (const [word, sub] of by(items, (e) => (e.segs[1] ?? '').split('-')[0]!)) {
      const same = sub.every((e) => e.segs[1] === word || e.segs[1] === undefined);
      groups.set(word === '' ? `/${first}` : `/${first}/${word}${same ? '' : '*'}`, sub);
    }
  }
  const out = [...groups].sort(([a], [b]) => cmp(a, b));
  if (out.length <= 1) return out;
  const alone = out.filter(([, l]) => l.length === 1);
  if (alone.length <= 1) return out;
  return [...out.filter(([, l]) => l.length > 1), [OTHER_ROUTES, alone.flatMap(([, l]) => l)]];
}

/** A route handler of Next.js: `app/api/**\/route.ts` (app router) or `pages/api/**` (pages router). */
export const isNextApiRoute = (file: string): boolean => /(^|\/)app\/(.*\/)?api\/(.*\/)?route\.[cm]?[jt]sx?$|(^|\/)pages\/api\/.*\.[cm]?[jt]sx?$/.test(file);

/** The HTTP methods of a set of endpoints, most first: "GET 9 · POST 4". ANY counts as "any". */
export function methodMix(methods: ReadonlyArray<string | undefined>): string {
  const n = new Map<string, number>();
  for (const m of methods) if (m) n.set(m === 'ANY' ? 'any' : m, (n.get(m === 'ANY' ? 'any' : m) ?? 0) + 1);
  return [...n].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).map(([m, k]) => `${m} ${k}`).join(' · ');
}

export const endpointLabel = (e: Pick<Endpoint, 'method' | 'path' | 'prefix'>): string => `${e.method === 'ANY' ? '' : `${e.method} `}${e.path}${e.prefix ? '/*' : ''}`;

export class Atlas {
  readonly projects = new Map<string, Project>();
  readonly endpoints: Endpoint[] = [];
  readonly calls: Call[] = [];
  readonly stores: DataStore[] = [];
  /** project → store id → the client dependencies. */
  readonly storeLinks = new Map<string, Map<string, string[]>>();
  private readonly entryById = new Map<string, Entry & { unit: string }>();
  private readonly fnsOfFile = new Map<string, GraphNode[]>();
  private readonly callsOf = new Map<string, Call[]>();
  private readonly callsInFile = new Map<string, Call[]>();
  /** A function → its calls to a Next.js API route of its own project (only the Features mode uses them). */
  private readonly ownCallsOf = new Map<string, Call[]>();
  /** The calls of a file to a route of its own project, by file. */
  private readonly ownCallsInFile = new Map<string, Call[]>();
  private readonly backendCache = new Map<string, Endpoint[]>();
  /** A file → the files that it imports, in its own project. */
  private readonly importsOf = new Map<string, Set<string>>();
  /** A file → its file node, with the project. */
  private readonly fileInfo = new Map<string, CodeInfo>();
  private readonly read: ReadFile;
  readonly map: AtlasMap;
  private readonly source: IndexChartSource;

  private constructor(
    readonly index: CodeGraphIndex,
    readonly root: string,
  ) {
    const cache = new Map<string, string | undefined>();
    this.read = (file) => {
      if (!cache.has(file)) cache.set(file, readText(join(root, file)));
      return cache.get(file);
    };
    this.map = new AtlasMap(index, this.read);
    this.source = new IndexChartSource(index);
  }

  /** The atlas of a CodeGraph index. It reads the client calls of each TypeScript file. */
  static async build(index: CodeGraphIndex, root: string): Promise<Atlas> {
    const atlas = new Atlas(index, root);
    await atlas.load();
    return atlas;
  }

  private async load(): Promise<void> {
    const index = this.map;
    for (const c of index.code.values()) if (c.node.kind === 'file' && c.node.file) this.fileInfo.set(c.node.file, c);
    // The functions of each file, for the owner of a line. A local function (a `const get = async () => …`
    // in a function) is a part of the function that holds it: the call belongs to the outer function.
    const isLocal = (id: string) => {
      const kind = this.index.nodes.get(this.index.parent.get(id) ?? '')?.kind;
      return kind === 'function' || kind === 'method';
    };
    for (const c of index.code.values()) {
      const n = c.node;
      if (c.test || n.targetOnly || n.file === undefined || !FN_KINDS.has(n.kind) || n.kind === 'class' || isLocal(n.id)) continue;
      this.fnsOfFile.set(n.file, [...(this.fnsOfFile.get(n.file) ?? []), n]);
    }
    // The projects: the packages in the repo with code that is not a test.
    const keys = [...index.units.values()]
      .filter((u) => u.ids.some((id) => { const c = index.code.get(id)!; return !c.test && FN_KINDS.has(c.node.kind); }))
      .map((u) => u.key)
      .sort(cmp);
    keys.forEach((key, i) => {
      const u = index.units.get(key)!;
      for (const e of this.map.entries(key)) this.entryById.set(e.id, { ...e, unit: key });
      const routes = this.map.entries(key).filter((e) => e.kind === 'route').length;
      const manifest = manifestOf(u.dir, this.read);
      // The rest of a package with a web part: its kind comes from its own code (routes, bin), not from the page.
      const split = u.part !== 'web' && [...index.units.values()].some((x) => x.part === 'web' && (u.dir === '' || x.dir.startsWith(`${u.dir}/`)));
      const kind = u.part === 'web' ? 'frontend' : projectKind(split && manifest ? { ...manifest, deps: [], html: false } : manifest, routes, u.dir);
      this.projects.set(key, { key, name: u.name, dir: u.dir, kind, tone: i % TONES, ...(manifest ? { manifest } : {}) });
    });
    for (const [from, tos] of this.index.fileImports) {
      const a = this.fileInfo.get(from);
      for (const to of tos) {
        const b = this.fileInfo.get(to);
        if (!a || !b || a.unit !== b.unit || a.test || b.test) continue;
        const set = this.importsOf.get(from) ?? new Set<string>();
        set.add(to);
        this.importsOf.set(from, set);
      }
    }
    this.loadEndpoints();
    await this.loadCalls();
    this.loadStores();
  }

  private loadEndpoints(): void {
    const routesOf = new Map<string, ServerRoute[]>();
    for (const p of this.projects.values()) {
      const seen = new Set<string>();
      let mounts: Map<string, string> | undefined;
      const add = (e: Entry, method: string, raw: string, prefix: boolean, line: number, open?: string) => {
        if (CATCH_ALL.test(raw)) {
          raw = raw.replace(CATCH_ALL, '');
          prefix = true;
        }
        const segs = routeSegments(raw);
        const path = `/${segs.join('/')}`;
        const key = `${method} ${path}${prefix ? '/*' : ''}`;
        if (seen.has(key)) return;
        seen.add(key);
        this.endpoints.push({ key, unit: p.key, method, path, segs, prefix, open: open ?? (isVirtual(e.id) ? e.id : `fn:${e.id}`), file: e.file, line });
      };
      for (const e of this.map.entries(p.key)) {
        if (e.kind !== 'route') continue;
        const line = firstLine(e.range);
        const node = this.map.code.get(e.id)?.node;
        if (node?.route) {
          // A route node of CodeGraph: `POST /api-keys`. The flow chart is the chart of its handler.
          const [method, raw] = node.route.includes(' ') ? node.route.split(/\s+/, 2) : ['ANY', node.route];
          let path = raw!;
          if (node.language === 'python') {
            mounts ??= pythonMounts(this.pythonFiles(p.key), this.read, (f) => this.index.imports(f));
            const mount = mounts.get(e.file);
            if (mount && !path.startsWith(`${mount}/`) && path !== mount) path = `${mount}${path === '/' ? '' : path}`;
          }
          const handler = this.map.handlerOf.get(e.id);
          const h = handler ? this.map.code.get(handler)?.node : undefined;
          add(h ? { ...e, file: h.file!, range: h.range! } : e, method!.toUpperCase(), path, false, h ? firstLine(h.range) : line, handler ? `fn:${handler}` : undefined);
          continue;
        }
        let routes = routesOf.get(e.file);
        if (!routes) routesOf.set(e.file, (routes = serverRoutes(this.read(e.file) ?? '')));
        // The graph makes one route entry for each path. The lines with the same path and another
        // method (GET and POST on /api/orders) are more endpoints of this entry.
        const paths = new Set((e.paths ?? [e.name]).map((x) => `/${routeSegments(x).join('/')}`));
        const here = routes.filter((r) => r.line === line || paths.has(r.path));
        if (here.length > 0) for (const r of here) add(e, r.method, r.path, r.prefix, line);
        else for (const path of e.paths ?? [e.name]) add(e, 'ANY', path, false, line);
      }
    }
  }

  /** The Python files of a project, without tests. */
  private pythonFiles(unit: string): string[] {
    return [...this.fileInfo.values()].filter((c) => c.unit === unit && !c.test && c.node.language === 'python').map((c) => c.node.file!).sort();
  }

  private async loadCalls(): Promise<void> {
    const imports = new Set(this.importCounts().map(([k]) => k));
    const files: Array<{ file: string; unit: string; text: string }> = [];
    for (const c of [...this.map.code.values()].sort((a, b) => cmp(a.node.id, b.node.id))) {
      const n = c.node;
      if (n.kind !== 'file' || n.targetOnly || n.file === undefined || c.test || isTestPath(n.file) || !/\.[cm]?[jt]sx?$/.test(n.file)) continue;
      if (!this.projects.has(c.unit)) continue;
      const text = this.read(n.file);
      if (text !== undefined) files.push({ file: n.file, unit: c.unit, text });
    }
    // The HTTP helpers of each file (`callApi(path, opts)`), two rounds: a helper may call a helper of another file.
    const helpers = new Map<string, HttpHelper[]>();
    const importedHelpers = (file: string): HttpHelper[] => [...(this.index.fileImports.get(file) ?? [])].flatMap((g) => helpers.get(g) ?? []);
    for (let round = 0; round < 2; round++) {
      for (const f of files) {
        const list = await readHttpHelpers(f.file, f.text, importedHelpers(f.file));
        if (list.length > 0) helpers.set(f.file, list);
      }
    }
    for (const { file, unit, text } of files) {
      for (const call of await readClientCalls(file, text, importedHelpers(file))) {
        const owner = this.ownerOf(file, call.line);
        const fit = this.match(call.method, call.path, unit, imports);
        if (!fit.endpoint && owner) {
          const own = this.ownRoute(call.method, call.path, unit);
          if (own) {
            const c: Call = { unit, file, line: call.line, method: call.method, path: call.path, owner: owner.id, endpoint: own };
            this.ownCallsOf.set(owner.id, [...(this.ownCallsOf.get(owner.id) ?? []), c]);
            this.ownCallsInFile.set(file, [...(this.ownCallsInFile.get(file) ?? []), c]);
          }
        }
        if (!fit.endpoint && !fit.possible) continue;
        const item: Call = { unit, file, line: call.line, method: call.method, path: call.path, ...(owner ? { owner: owner.id } : {}), ...fit };
        this.calls.push(item);
        if (owner) this.callsOf.set(owner.id, [...(this.callsOf.get(owner.id) ?? []), item]);
        this.callsInFile.set(file, [...(this.callsInFile.get(file) ?? []), item]);
      }
    }
  }

  /**
   * The endpoint of another project that fits a client call best. `imports` has a key
   * `<unit>\n<other unit>` for each project that `unit` imports. The rules:
   * - A call never links to a route of its own project: that is a call inside the project. When a
   *   route of its own project fits as well as the best route of the others, the call has no endpoint
   *   (a frontend that calls its own `/api/organisations` route, while another frontend has one too).
   * - If the best fit is in more than one project, the project that `unit` imports wins. If not,
   *   the only project with the same method and the same path wins.
   * - If there is still a tie, the call has no endpoint, only `possible` endpoints.
   * - A catch-all of one segment ("/api/*") is only possible, also in a project that `unit` imports:
   *   it is often a check in the code (`pathname.startsWith('/api/')` in a service worker), not a route.
   * - A call to a proxy route of the frontend (`/api/backend-proxy/v1/jobs`) is a call to `/v1/jobs` of
   *   another project. On a tie, the projects with the word of the proxy (`backend`) in the name win.
   */
  match(method: string, path: string, unit: string, imports: ReadonlySet<string> = new Set()): { endpoint?: Endpoint; possible?: Endpoint[] } {
    const proxy = PROXY.exec(path);
    if (proxy?.[2]) {
      const fit = this.fit(method, proxy[2], unit, imports, proxy[1]!.toLowerCase());
      if (fit.endpoint || fit.possible) return fit;
    }
    const fit = this.fit(method, path, unit, imports);
    const top = fit.endpoint ? this.fitScore(method, path, fit.endpoint) : Math.max(-1, ...(fit.possible ?? []).map((e) => this.fitScore(method, path, e)));
    if (top >= 0 && this.endpoints.some((e) => e.unit === unit && this.fitScore(method, path, e) >= top)) return {};
    return fit;
  }

  /** The Next.js API route of its own project that a call fits best (no catch-all of one segment). */
  ownRoute(method: string, path: string, unit: string): Endpoint | undefined {
    let best: Endpoint | undefined;
    let top = -1;
    for (const e of this.endpoints) {
      if (e.unit !== unit || !isNextApiRoute(e.file) || (e.prefix && e.segs.length <= 1)) continue;
      const s = this.fitScore(method, path, e);
      if (s > top) [best, top] = [e, s];
    }
    return best;
  }

  /**
   * The endpoints of the other projects that a Next.js API route calls: the page calls the route, and
   * the route calls the backend. No value: the route is not a proxy of another project.
   */
  backendOf(ep: Endpoint): Endpoint[] {
    const hit = this.backendCache.get(endpointId(ep));
    if (hit) return hit;
    const out: Endpoint[] = [];
    if (isNextApiRoute(ep.file) && ep.open.startsWith('fn:')) {
      for (const r of reachCalls(ep.open.slice(3), this.reachGraph(ep.unit), REACH_DEPTH, REACH_FANOUT)) {
        const b = r.call.endpoint;
        if (b && b.unit !== ep.unit && !isNextApiRoute(b.file) && !out.includes(b)) out.push(b);
      }
    }
    // `export const POST = withApiHandler(async () => …)`: the calls have no function of the graph. Take
    // the calls of the route file from the line of this route to the line of the next route.
    if (isNextApiRoute(ep.file) && out.length === 0) {
      const next = Math.min(...this.endpoints.filter((e) => e.file === ep.file && e.line > ep.line).map((e) => e.line), Infinity);
      for (const c of this.callsInFile.get(ep.file) ?? []) {
        const b = c.endpoint;
        if (c.owner === undefined && c.line >= ep.line && c.line < next && b && b.unit !== ep.unit && !isNextApiRoute(b.file) && !out.includes(b)) out.push(b);
      }
    }
    this.backendCache.set(endpointId(ep), out);
    return out;
  }

  /** The call graph of the walk from a page: calls and renders in the project and in the libraries. */
  private reachGraph(unit: string) {
    return {
      next: (id: string): string[] => {
        const out = new Set<string>();
        for (const e of this.map.edgesFrom(id)) {
          if (e.kind !== 'calls' && e.kind !== 'renders') continue;
          const u = this.map.unitOf(e.to)?.unit;
          if (u === unit || (u !== undefined && this.projects.get(u)?.kind === 'library')) out.add(e.to);
        }
        return [...out].sort(cmp);
      },
      calls: (id: string): Call[] => [...(this.callsOf.get(id) ?? []), ...(this.ownCallsOf.get(id) ?? [])],
    };
  }

  /**
   * The endpoints that a page reaches through the call graph (the Features mode). A call to a Next.js
   * API route that calls another project becomes a link to the endpoint of that project, `via` the route.
   */
  pageLinks(page: string, unit: string): PageLink[] {
    const file = this.map.code.get(page)?.node.file ?? this.entryById.get(page)?.file;
    const out = new Map<string, PageLink>();
    const add = (endpoint: Endpoint, steps: number, direct: boolean, possible: boolean, via?: Endpoint) => {
      const k = `${endpointId(endpoint)}\n${via ? endpointId(via) : ''}`;
      const have = out.get(k);
      if (!have) out.set(k, { endpoint, steps, direct, possible, ...(via ? { via } : {}) });
      else {
        have.steps = Math.min(have.steps, steps);
        have.direct ||= direct;
        have.possible &&= possible;
      }
    };
    for (const r of reachCalls(page, this.reachGraph(unit), REACH_DEPTH, REACH_FANOUT)) {
      const c = r.call;
      const direct = c.file === file;
      if (c.endpoint) {
        const back = this.projects.get(c.endpoint.unit)?.kind === 'frontend' ? this.backendOf(c.endpoint) : [];
        if (back.length > 0) for (const b of back) add(b, r.steps, direct, false, c.endpoint);
        else add(c.endpoint, r.steps, direct, false);
      } else for (const e of c.possible ?? []) add(e, r.steps, direct, true);
    }
    // A possible link to an endpoint that has a sure link too goes away.
    const sure = new Set([...out.values()].filter((l) => !l.possible).map((l) => endpointId(l.endpoint)));
    return [...out.values()].filter((l) => !l.possible || !sure.has(endpointId(l.endpoint))).sort((a, b) => cmp(endpointId(a.endpoint), endpointId(b.endpoint)));
  }

  private fitScore(method: string, path: string, e: Endpoint): number {
    return routeFit(method, routeSegments(path), { method: e.method, path: e.segs, prefix: e.prefix });
  }

  private fit(method: string, path: string, unit: string, imports: ReadonlySet<string>, word?: string): { endpoint?: Endpoint; possible?: Endpoint[] } {
    const segs = routeSegments(path);
    const fits: Array<[Endpoint, number]> = [];
    for (const e of this.endpoints) {
      if (e.unit === unit) continue;
      const s = routeFit(method, segs, { method: e.method, path: e.segs, prefix: e.prefix });
      if (s >= 0) fits.push([e, s]);
    }
    if (fits.length === 0) return {};
    const top = Math.max(...fits.map(([, s]) => s));
    // The best endpoint of each project.
    const best = new Map<string, Endpoint>();
    for (const [e, s] of fits) if (s === top && !best.has(e.unit)) best.set(e.unit, e);
    const imported = (u: string) => imports.has(`${unit}\n${u}`);
    let units = [...best.keys()];
    if (units.length > 1 && units.filter(imported).length === 1) units = units.filter(imported);
    if (units.length > 1 && word) {
      const named = units.filter((u) => (this.projects.get(u)?.name ?? u).toLowerCase().includes(word));
      if (named.length > 0) units = named;
    }
    if (units.length > 1) {
      const exact = units.filter((u) => {
        const e = best.get(u)!;
        return !e.prefix && e.method === method.toUpperCase();
      });
      if (exact.length === 1) units = exact;
    }
    if (units.length !== 1) return { possible: [...best.values()] };
    const e = best.get(units[0]!)!;
    if (e.prefix && e.segs.length <= 1) return { possible: [e] };
    return { endpoint: e };
  }

  /** The files that the files import, at any depth, in their own project (no tests). */
  importClosure(files: Iterable<string>): Set<string> {
    const out = new Set(files);
    for (const queue = [...out]; queue.length > 0; ) {
      for (const g of this.importsOf.get(queue.shift()!) ?? []) if (!out.has(g)) queue.push(g), out.add(g);
    }
    return out;
  }

  /** The HTTP client calls in a file: to other projects and to the routes of its own project. */
  callsIn(file: string): readonly Call[] {
    return [...(this.callsInFile.get(file) ?? []), ...(this.ownCallsInFile.get(file) ?? [])];
  }

  /** The files that `file` imports in its own project. */
  importsOfFile(file: string): ReadonlySet<string> {
    return this.importsOf.get(file) ?? new Set();
  }

  /** The function `name` of a file, else of a file that it imports. The innermost one near `line` first. */
  functionNamed(file: string, name: string, line = 0): GraphNode | undefined {
    // All the functions of the file, also the local ones (`handleIssue` in a component).
    const pick = (f: string) => (this.index.nodesOfFile.get(f) ?? []).filter((n) => n.name === name && FN_KINDS.has(n.kind)).sort((a, b) => Math.abs(firstLine(a.range) - line) - Math.abs(firstLine(b.range) - line))[0];
    const own = pick(file);
    if (own) return own;
    for (const g of [...(this.importsOf.get(file) ?? [])].sort()) {
      const n = pick(g);
      if (n) return n;
    }
    return undefined;
  }

  /** The feature of a page of a frontend (the Features mode). */
  featureOf(unit: string, entryId: string): { id: string; label: string } | undefined {
    const fe = this.featureData().find((x) => x.unit === unit);
    const f = fe?.features.find((x) => x.pages.some((pg) => pg.entry.id === entryId));
    return f ? { id: `feature:${unit}:${f.slug}`, label: f.label } : undefined;
  }

  /** The innermost function in `file` that holds `line`. */
  ownerOf(file: string, line: number): GraphNode | undefined {
    let best: GraphNode | undefined;
    for (const n of this.fnsOfFile.get(file) ?? []) {
      const a = firstLine(n.range);
      const b = lastLine(n.range);
      if (line < a || line > b) continue;
      if (!best || b - a < lastLine(best.range) - firstLine(best.range)) best = n;
    }
    return best;
  }

  private loadStores(): void {
    for (const f of COMPOSE_FILES) {
      const text = this.read(f);
      if (text !== undefined) this.stores.push(...composeStores(f, text));
    }
    for (const p of [...this.projects.values()]) {
      for (const { kind, dep } of clientStores(p.manifest)) {
        let store = this.stores.find((s) => s.kind === kind) ?? (kind === 'sql' ? this.stores.find((s) => s.kind === 'postgres' || s.kind === 'mysql' || s.kind === 'sqlite') : undefined);
        if (!store) {
          store = { id: `store:${kind}`, name: kind, kind, file: p.manifest!.file };
          this.stores.push(store);
        }
        const links = this.storeLinks.get(p.key) ?? new Map<string, string[]>();
        links.set(store.id, [...(links.get(store.id) ?? []), dep]);
        this.storeLinks.set(p.key, links);
      }
    }
  }

  // ---------------------------------------------------------------- views

  info(): AtlasInfo {
    return { root: this.root, name: this.root.split('/').filter(Boolean).at(-1) ?? this.root, projects: this.projects.size, files: this.map.totals.files };
  }

  /** The view of an ID (see view.ts), or a view with `ok: false`. */
  async view(id: string): Promise<AtlasView> {
    if (id === '' || id === 'system') return this.system();
    const pin = /^(project:[^?]+(?:\?(?:to|from)=[^?]+)?)\?pin=(.+)$/.exec(id);
    if (pin) return this.withPins(await this.view(pin[1]!), id, pin[1]!.slice('project:'.length).replace(/\?.*$/, ''), pin[2]!.split(','));
    const cell = /^project:(.+)\?(to|from)=(.+)$/.exec(id);
    if (cell) return this.cell(cell[1]!, cell[2] as 'to' | 'from', cell[3]!);
    if (id.startsWith('project:')) return this.project(id.slice('project:'.length));
    if (id === 'features') return this.features();
    if (id.startsWith('feature:')) return this.feature(id);
    if (id.startsWith('fapi:')) return this.featureApi(id.slice('fapi:'.length));
    return this.flow(id);
  }

  /**
   * A project view with some functions as boxes too (a picked search hit): `project:<key>?pin=fn:<id>,…`.
   * The functions go in the "code" group of the project. An edge links a box of the view that calls a
   * function (or whose code reaches it) to it, and a function to the boxes of the view that it calls.
   */
  withPins(base: AtlasView, id: string, key: string, pins: string[]): AtlasView {
    const p = this.projects.get(key);
    if (!base.ok || !p) return base;
    const view: AtlasView = { ...base, id, groups: [...base.groups], nodes: [...base.nodes], edges: [...base.edges] };
    const have = new Set(view.nodes.map((n) => n.id));
    const refs = view.nodes.filter((n) => n.ref !== undefined).map((n) => ({ id: n.id, ref: n.ref! }));
    for (const fid of pins) {
      if (have.has(fid) || !fid.startsWith('fn:')) continue;
      const c = this.map.code.get(fid.slice(3));
      if (!c || c.unit !== key || c.node.file === undefined) continue;
      if (!view.groups.some((g) => g.id === 'code')) view.groups.push({ id: 'code', label: `${this.nameOf(key)} · code`, icon: 'library', tone: p.tone, noun: ['function', 'functions'] });
      const n = c.node;
      const line = firstLine(n.range);
      view.nodes.push({ id: fid, shape: 'function', label: n.name, sub: `${n.file}:${line}`, group: 'code', tone: p.tone, open: fid, openProject: key, file: n.file, line, ref: n.id });
      have.add(fid);
      for (const r of refs) {
        if (r.ref === n.id) continue;
        if (this.reach(r.ref, key).has(n.id)) view.edges.push({ id: `${r.id}>${fid}`, from: r.id, to: fid, kind: 'uses' });
        else if (this.map.edgesFrom(n.id).some((e) => e.to === r.ref)) view.edges.push({ id: `${fid}>${r.id}`, from: fid, to: r.id, kind: 'uses' });
      }
    }
    return view;
  }

  /** The config file of the target repo (optional, read only). */
  get config(): AtlasConfig {
    return (this.configCache ??= parseConfig(this.read(CONFIG_FILE)));
  }

  private configCache: AtlasConfig | undefined;

  /** The name of a project on the canvas: its name, or the new name in the config file. */
  nameOf(key: string): string {
    const p = this.projects.get(key);
    if (!p) return key;
    return this.config.projects[p.name]?.rename ?? p.name;
  }

  /** The group of each project in the System view, and the projects that the config hides. */
  private systemGroups(): Map<string, SystemGroup> {
    if (this.groupCache) return this.groupCache;
    const runtime = new Set<string>();
    for (const c of this.calls) {
      for (const e of [...(c.endpoint ? [c.endpoint] : []), ...(c.possible ?? [])]) {
        if (e.unit === c.unit) continue;
        runtime.add(c.unit);
        runtime.add(e.unit);
      }
    }
    for (const k of this.storeLinks.keys()) runtime.add(k);
    const out = new Map<string, SystemGroup>();
    for (const p of this.projects.values()) {
      const c = this.config.projects[p.name];
      if (c?.hide) continue;
      out.set(p.key, groupOf(p.kind, { name: p.name, dir: p.dir, count: this.countOf(p), runtime: runtime.has(p.key) }, c));
    }
    this.groupCache = out;
    return out;
  }

  private groupCache: Map<string, SystemGroup> | undefined;

  system(): AtlasView {
    const groups: ViewGroup[] = [];
    const nodes: ViewNode[] = [];
    const groupOfKey = this.systemGroups();
    const gid = (g: SystemGroup) => (g === 'support' ? 'support' : `kind:${g}`);
    for (const g of GROUP_ORDER) {
      const list = [...this.projects.values()]
        .filter((p) => groupOfKey.get(p.key) === g)
        .sort((a, b) => Number(!!this.config.projects[b.name]?.pin) - Number(!!this.config.projects[a.name]?.pin));
      if (list.length === 0) continue;
      const slot = SLOTS[g];
      groups.push({
        id: gid(g), label: GROUP_TITLE[g], icon: g === 'support' ? 'project' : g, tone: GROUP_ORDER.indexOf(g), noun: GROUP_NOUN[g], ...slot,
        ...((g === 'library' || g === 'support') && list.length > FOLD_MIN ? { fold: true } : {}),
      });
      for (const p of list) {
        nodes.push({
          id: `project:${p.key}`, shape: 'project', label: this.nameOf(p.key), sub: this.countText(p), group: gid(g), tone: p.tone, size: sizeStep(this.countOf(p)),
          open: `project:${p.key}`, openProject: p.key, ...(p.manifest ? { file: p.manifest.file, line: 1 } : {}),
        });
      }
    }
    if (this.stores.length > 0) {
      groups.push({ id: 'stores', label: 'Data stores', icon: 'store', tone: 5, noun: ['store', 'stores'], ...SLOTS.stores });
      for (const s of this.stores) nodes.push({ id: s.id, shape: 'store', label: s.name, sub: s.image ?? s.kind, group: 'stores', file: s.file });
    }
    const shown = (key: string) => groupOfKey.has(key);
    const edges: ViewEdge[] = [];
    const http = new Map<string, { n: number; next: number }>();
    for (const c of this.calls) {
      if (!c.endpoint || c.endpoint.unit === c.unit || !shown(c.unit) || !shown(c.endpoint.unit)) continue;
      const k = `${c.unit}\n${c.endpoint.unit}`;
      const t = http.get(k) ?? { n: 0, next: 0 };
      t.n++;
      if (isNextApiRoute(c.endpoint.file)) t.next++;
      http.set(k, t);
    }
    const totals = new Map<string, number>();
    for (const [k, { n, next }] of [...http].sort(([a], [b]) => cmp(a, b))) {
      const [a, b] = k.split('\n') as [string, string];
      const to = this.nameOf(b);
      const title = next === 0 ? undefined : `${next === n ? (n === 1 ? 'The call goes' : `All ${n} calls go`) : `${next} of the ${n} calls go`} to Next.js API routes of ${to} (route handlers in app/api or pages/api).`;
      edges.push({ id: `http:${a}>${b}`, from: `project:${a}`, to: `project:${b}`, kind: 'http', label: `${n} HTTP call${n === 1 ? '' : 's'}`, ...(title ? { title } : {}) });
      const ga = gid(groupOfKey.get(a)!);
      const gb = gid(groupOfKey.get(b)!);
      totals.set(`${ga}\n${gb}`, (totals.get(`${ga}\n${gb}`) ?? 0) + n);
    }
    const title = new Map(groups.map((g) => [g.id, g.label]));
    for (const [k, n] of totals) {
      const [a, b] = k.split('\n') as [string, string];
      const label = `${title.get(a)} → ${title.get(b)} · ${n} call${n === 1 ? '' : 's'}`;
      edges.push({ id: `total:${a}>${b}`, from: a, to: b, kind: 'http', role: 'total', label, title: `${n} HTTP call${n === 1 ? '' : 's'} from the ${title.get(a)} to the ${title.get(b)}.` });
    }
    // The links to the data stores, by group: "APIs → Data stores · 3 links".
    const storeTotals = new Map<string, number>();
    for (const [p, links] of this.storeLinks) {
      if (!shown(p) || this.stores.length === 0) continue;
      const g = gid(groupOfKey.get(p)!);
      storeTotals.set(g, (storeTotals.get(g) ?? 0) + links.size);
    }
    for (const [g, n] of [...storeTotals].sort(([a], [b]) => cmp(a, b))) {
      const label = `${title.get(g)} → Data stores · ${n} link${n === 1 ? '' : 's'}`;
      edges.push({ id: `total:${g}>stores`, from: g, to: 'stores', kind: 'uses', role: 'total', label, title: `${n} link${n === 1 ? '' : 's'} from the ${title.get(g)} to a data store.` });
    }
    for (const [k, n] of this.importCounts()) {
      const [a, b] = k.split('\n') as [string, string];
      if (!shown(a) || !shown(b)) continue;
      edges.push({ id: `uses:${a}>${b}`, from: `project:${a}`, to: `project:${b}`, kind: 'uses', role: 'import', label: `${n} import${n === 1 ? '' : 's'}` });
    }
    for (const [p, links] of [...this.storeLinks].sort(([a], [b]) => cmp(a, b))) {
      if (!shown(p)) continue;
      for (const [s, deps] of links) edges.push({ id: `store:${p}>${s}`, from: `project:${p}`, to: s, kind: 'uses', label: deps.join(', ') });
    }
    const notes = this.projects.size === 0 ? ['The index has no projects with code.'] : [...this.config.problems];
    return { ok: true, level: 'system', id: 'system', title: 'System', groups, nodes, edges, notes, matrix: this.matrix() };
  }

  // ---------------------------------------------------------------- the Features mode

  /** The features of each frontend, with the endpoints that each page reaches. */
  featureData(): FrontendFeatures[] {
    if (this.featureCache) return this.featureCache;
    const groupOfKey = this.systemGroups();
    const out: FrontendFeatures[] = [];
    for (const p of this.projects.values()) {
      if (p.kind !== 'frontend' || !groupOfKey.has(p.key) || groupOfKey.get(p.key) === 'support') continue;
      const pages = this.pagesOf(p);
      if (pages.length === 0) continue;
      const groups = applyFeatureConfig(featureGroups(pages.map((e) => ({ id: e.id, route: e.name, entry: e }))), this.config.features[p.name]);
      out.push({
        unit: p.key,
        features: groups.map((f) => ({ slug: f.slug, label: f.label, pages: f.pages.map((x) => ({ entry: x.entry, links: this.pageLinks(x.id, p.key) })) })),
      });
    }
    this.featureCache = out;
    return out;
  }

  private featureCache: FrontendFeatures[] | undefined;

  /** The features that reach each endpoint (by endpoint ID): "shared · 3 features". */
  private featuresOfEndpoint(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const fe of this.featureData()) {
      for (const f of fe.features) {
        for (const pg of f.pages) for (const l of pg.links) {
          const k = endpointId(l.endpoint);
          out.set(k, (out.get(k) ?? new Set()).add(`${fe.unit}:${f.slug}`));
        }
      }
    }
    return out;
  }

  /** The links of a feature: one for each endpoint, sure if one page has a sure link. */
  private featureLinks(f: FeatureInfo): PageLink[] {
    const by = new Map<string, PageLink>();
    for (const pg of f.pages) for (const l of pg.links) {
      const k = endpointId(l.endpoint);
      const have = by.get(k);
      if (!have || (have.possible && !l.possible)) by.set(k, l);
    }
    return [...by.values()].sort((a, b) => cmp(endpointId(a.endpoint), endpointId(b.endpoint)));
  }

  features(): AtlasView {
    const view: AtlasView = { ok: true, level: 'features', id: 'features', title: 'Features', groups: [], nodes: [], edges: [], notes: [] };
    const used = new Map<string, Set<string>>();
    /** `<frontend>\n<api>` → the endpoints that the features reach, sure and possible. */
    const sums = new Map<string, { sure: Set<string>; possible: Set<string> }>();
    for (const fe of this.featureData()) {
      const p = this.projects.get(fe.unit)!;
      const gid = `fe:${fe.unit}`;
      view.groups.push({ id: gid, label: this.nameOf(fe.unit), icon: 'frontend', tone: p.tone, lane: 0, noun: ['feature', 'features'], ratio: 2.4 });
      for (const f of fe.features) {
        const links = this.featureLinks(f);
        const id = `feature:${fe.unit}:${f.slug}`;
        const sure = links.filter((l) => !l.possible).length;
        view.nodes.push({
          id, shape: 'feature', label: f.label, group: gid, tone: p.tone, open: id, openProject: fe.unit,
          sub: `${f.pages.length} page${f.pages.length === 1 ? '' : 's'} · ${sure} endpoint${sure === 1 ? '' : 's'}`,
        });
        for (const l of links) {
          const ep = l.endpoint;
          used.set(ep.unit, (used.get(ep.unit) ?? new Set()).add(endpointId(ep)));
          const sum = sums.get(`${fe.unit}\n${ep.unit}`) ?? { sure: new Set(), possible: new Set() };
          sum[l.possible ? 'possible' : 'sure'].add(endpointId(ep));
          sums.set(`${fe.unit}\n${ep.unit}`, sum);
          // The edge of one feature: it shows only when the feature (or the API box) is selected.
          view.edges.push({
            id: `${id}>${endpointId(ep)}`, from: id, to: endpointId(ep), toPath: endpointPath(ep), kind: 'http', role: 'detail',
            label: l.possible ? '1 possible link' : '1 endpoint', ends: [endpointId(ep)], ...(l.possible ? { possible: true } : {}),
          });
        }
      }
    }
    // One edge from each frontend to each API box: the sum of its features.
    for (const [k, { sure, possible }] of [...sums].sort(([a], [b]) => cmp(a, b))) {
      const [fe, api] = k.split('\n') as [string, string];
      for (const p of sure) possible.delete(p);
      const n = sure.size > 0 ? sure.size : possible.size;
      const what = sure.size > 0 ? `endpoint${n === 1 ? '' : 's'}` : `possible link${n === 1 ? '' : 's'}`;
      view.edges.push({
        id: `sum:${fe}>${api}`, from: `fe:${fe}`, to: `project:${api}`, toPath: [`project:${api}`], kind: 'http', role: 'sum', label: `${n} ${what}`, ends: [...(sure.size > 0 ? sure : possible)].sort(),
        title: `The features of ${this.nameOf(fe)} reach ${n} ${what} of ${this.nameOf(api)}${sure.size > 0 && possible.size > 0 ? `, and ${possible.size} more possible link${possible.size === 1 ? '' : 's'}` : ''}. Select a feature to see its own links.`,
        ...(sure.size === 0 ? { possible: true } : {}),
      });
    }
    if (used.size > 0) {
      view.groups.push({ id: 'apis', label: 'APIs', icon: 'api', tone: 1, lane: 1, noun: ['API', 'APIs'], middle: true });
      const byId = new Map(this.endpoints.map((e) => [endpointId(e), e]));
      for (const [unit, eps] of [...used].sort(([a], [b]) => cmp(a, b))) {
        const p = this.projects.get(unit)!;
        const label = p.kind === 'frontend' ? `${this.nameOf(unit)} API routes` : this.nameOf(unit);
        view.nodes.push({ id: `project:${unit}`, shape: 'project', label, sub: `${eps.size} endpoint${eps.size === 1 ? '' : 's'} used · ${methodMix([...eps].map((id) => byId.get(id)?.method))}`, group: 'apis', tone: p.tone, open: `fapi:${unit}`, openProject: unit, size: sizeStep(eps.size) });
      }
    }
    if (view.nodes.length === 0) view.notes.push('No frontend has pages that the index knows.');
    else view.notes.push('A feature is a group of pages by route. Open a feature to see its pages and the endpoints that each page reaches. A dashed light link is only a possible match.');
    return view;
  }

  feature(id: string): AtlasView {
    const [, unit, slug] = /^feature:(.+):([^:]+)$/.exec(id) ?? [];
    const fe = this.featureData().find((x) => x.unit === unit);
    const f = fe?.features.find((x) => x.slug === slug);
    const base = { level: 'project' as const, id, groups: [], nodes: [], edges: [] };
    if (!fe || !f) return { ...base, ok: false, title: id, notes: ['This feature is not in the index.'] };
    const p = this.projects.get(fe.unit)!;
    const view: AtlasView = { ...base, ok: true, title: f.label, kind: 'frontend', project: fe.unit, groups: [], nodes: [], edges: [], notes: [] };
    for (const pg of f.pages) {
      const node = this.entryNode(pg.entry, 'page', 'pages', p);
      view.nodes.push(node);
      for (const l of pg.links) {
        const ep = l.endpoint;
        const label = l.possible ? 'possible' : l.direct ? 'direct' : l.via ? `via ${endpointLabel(l.via)}` : `via ${l.steps} step${l.steps === 1 ? '' : 's'}`;
        const title = l.possible
          ? 'Only a possible match: more than one endpoint fits the call.'
          : l.via
            ? `The page calls the Next.js API route ${endpointLabel(l.via)} of ${this.nameOf(l.via.unit)}, and that route calls this endpoint.`
            : l.direct ? 'The page file holds the HTTP call.' : `The HTTP call is ${l.steps} step${l.steps === 1 ? '' : 's'} from the page: through components, hooks and services.`;
        view.edges.push({ id: `${node.id}>${endpointId(ep)}${l.via ? `<${endpointId(l.via)}` : ''}`, from: node.id, to: endpointId(ep), toPath: endpointPath(ep), kind: 'http', label, title, ends: [endpointId(ep)], ...(l.possible ? { possible: true } : {}) });
      }
    }
    if (view.edges.length === 0) view.notes.push('No page of this feature reaches an endpoint that the index knows.');
    return view;
  }

  featureApi(unit: string): AtlasView {
    const p = this.projects.get(unit);
    const base = { level: 'project' as const, id: `fapi:${unit}`, groups: [], nodes: [], edges: [] };
    if (!p) return { ...base, ok: false, title: unit, notes: ['This project is not in the index.'] };
    const view: AtlasView = { ...base, ok: true, title: this.nameOf(unit), kind: p.kind, project: unit, groups: [], nodes: [], edges: [], notes: [] };
    const of = this.featuresOfEndpoint();
    const eps = this.endpoints.filter((e) => e.unit === unit && of.has(endpointId(e)));
    for (const [g, list] of routeGroups(eps)) {
      const gid = `prefix:${g}`;
      view.groups.push({ id: gid, label: g === OTHER_ROUTES ? 'Other routes' : g, icon: 'api', tone: p.tone, noun: ['endpoint', 'endpoints'] });
      for (const e of list) {
        const n = of.get(endpointId(e))!.size;
        view.nodes.push({ ...this.endpointNode(e, gid), sub: n > 1 ? `shared · ${n} features` : '1 feature' });
      }
    }
    if (view.nodes.length === 0) view.notes.push('No page reaches an endpoint of this project.');
    return view;
  }

  /** The HTTP calls of the frontends to the other projects, as a table (the Matrix view). */
  matrix(): Matrix {
    const groupOfKey = this.systemGroups();
    // The rows: the projects in the Frontends group (not Support).
    const rows = [...this.projects.values()].filter((p) => groupOfKey.get(p.key) === 'frontend').map((p) => ({ key: p.key, label: this.nameOf(p.key) }));
    const calls = this.calls.filter((c) => (!c.endpoint || groupOfKey.has(c.endpoint.unit)));
    return matrixOf(calls, rows, (k) => this.nameOf(k));
  }

  /** The count of the box of a project: its pages, routes, commands or exports. */
  countOf(p: Project): number {
    const entries = this.map.entries(p.key);
    const routes = this.endpoints.filter((e) => e.unit === p.key).length;
    if (p.kind === 'frontend') return this.pagesOf(p, entries).length;
    if (p.kind === 'api' || (p.kind === 'worker' && routes > 0)) return routes;
    const commands = entries.filter((e) => e.kind === 'command').length;
    if (p.kind === 'cli' && commands > 0) return commands;
    return entries.filter((e) => e.kind === 'export').length;
  }

  private countText(p: Project): string {
    const routes = this.endpoints.filter((e) => e.unit === p.key).length;
    const commands = this.map.entries(p.key).filter((e) => e.kind === 'command').length;
    const word =
      p.kind === 'frontend' ? 'page'
      : p.kind === 'api' || (p.kind === 'worker' && routes > 0) ? 'route'
      : p.kind === 'cli' && commands > 0 ? 'command'
      : 'export';
    const k = this.countOf(p);
    return `${p.kind} · ${k} ${word}${k === 1 ? '' : 's'}`;
  }

  /**
   * The import edges between projects, without tests: the number of files of one project that import
   * the other. CodeGraph links an import to each file that defines an imported name, so one file
   * counts one time for each project that it imports.
   */
  private importCounts(): Array<[string, number]> {
    if (this.importCache) return this.importCache;
    const counts = new Map<string, number>();
    for (const [from, tos] of this.index.fileImports) {
      const a = this.fileInfo.get(from);
      if (!a || a.test || !this.projects.has(a.unit)) continue;
      const targets = new Set<string>();
      for (const to of tos) {
        const b = this.fileInfo.get(to);
        if (b && !b.test && a.unit !== b.unit && this.projects.has(b.unit)) targets.add(b.unit);
      }
      for (const u of targets) {
        const k = `${a.unit}\n${u}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    this.importCache = [...counts].sort(([a], [b]) => cmp(a, b));
    return this.importCache;
  }

  private importCache: Array<[string, number]> | undefined;

  project(key: string): AtlasView {
    const p = this.projects.get(key);
    const base = { level: 'project' as const, id: `project:${key}`, groups: [], nodes: [], edges: [] };
    if (!p) return { ...base, ok: false, title: key, notes: ['This project is not in the index.'] };
    const view: AtlasView = { ...base, ok: true, title: p.name, kind: p.kind, project: key, groups: [], nodes: [], edges: [], notes: [] };
    if (p.manifest) Object.assign(view, { file: p.manifest.file, line: 1 });
    const entries = this.map.entries(key);
    const pages = p.kind === 'frontend' ? this.pagesOf(p, entries) : [];
    if (pages.length > 0) this.frontend(p, pages, view);
    else if (p.kind === 'api' || (p.kind === 'worker' && this.endpoints.some((e) => e.unit === key))) this.api(p, view);
    else if (p.kind === 'cli' && entries.some((e) => e.kind === 'command')) this.cli(p, entries, view);
    else this.library(p, view);
    if (view.nodes.length === 0) view.notes.push('This project has no pages, routes, commands or exported functions.');
    return view;
  }

  /**
   * A project of a matrix cell: only the boxes of the HTTP calls from one project to the other.
   * `to`: the calling project (`key`) with the pages and functions that call `other`. `from`: the
   * called project (`key`) with the endpoints that `other` calls.
   */
  cell(key: string, side: 'to' | 'from', other: string): AtlasView {
    const p = this.projects.get(key);
    const id = `project:${key}?${side}=${other}`;
    const base = { level: 'project' as const, id, groups: [], nodes: [], edges: [] };
    if (!p) return { ...base, ok: false, title: key, notes: ['This project is not in the index.'] };
    const view: AtlasView = { ...base, ok: true, title: p.name, kind: p.kind, project: key, groups: [], nodes: [], edges: [], notes: [] };
    if (p.manifest) Object.assign(view, { file: p.manifest.file, line: 1 });
    const [from, to] = side === 'to' ? [key, other] : [other, key];
    const hits = (c: Call) => c.unit === from && (c.endpoint ? c.endpoint.unit === to : (c.possible ?? []).some((e) => e.unit === to));
    const calls = this.calls.filter(hits);
    const ends = (c: Call) => (c.endpoint ? [c.endpoint] : (c.possible ?? []).filter((e) => e.unit === to));
    view.notes.push(`A cell of the Matrix: only the calls from ${this.nameOf(from)} to ${this.nameOf(to)}.`);
    if (side === 'from') {
      const eps = [...new Map(calls.flatMap(ends).map((e) => [endpointId(e), e])).values()];
      for (const [g, list] of routeGroups(eps)) {
        const gid = `prefix:${g}`;
        view.groups.push({ id: gid, label: g === OTHER_ROUTES ? 'Other routes' : g, icon: 'api', tone: p.tone });
        for (const e of list) view.nodes.push({ ...this.endpointNode(e, gid), shape: 'route' as const, sub: `${e.file}:${e.line}` });
      }
      if (view.nodes.length === 0) view.notes.push('No endpoint of this project gets these calls.');
      return view;
    }
    // The pages that reach an endpoint of the other project.
    const pages = p.kind === 'frontend' ? this.pagesOf(p) : [];
    const shown = new Set<string>();
    for (const e of pages) {
      const reach = [...this.pageEndpoints(e.id, key)].filter(([ep]) => ep.unit === to).sort(([a], [b]) => cmp(endpointId(a), endpointId(b)));
      if (reach.length === 0) continue;
      if (!view.groups.some((g) => g.id === 'pages')) view.groups.push({ id: 'pages', label: `Pages of ${p.name}`, icon: 'page', tone: p.tone });
      const node = this.entryNode(e, 'page', 'pages', p);
      view.nodes.push(node);
      shown.add(e.id);
      for (const [ep, n] of reach) {
        const label = n.calls > 0 ? `${n.calls} call${n.calls === 1 ? '' : 's'}` : undefined;
        view.edges.push({ id: `${node.id}>${endpointId(ep)}`, from: node.id, to: endpointId(ep), toPath: endpointPath(ep), kind: 'http', ...(label ? { label } : {}) });
      }
    }
    // The functions that hold the calls, with an edge to each endpoint.
    const byOwner = new Map<string, Call[]>();
    for (const c of calls) if (c.owner && !shown.has(c.owner)) byOwner.set(c.owner, [...(byOwner.get(c.owner) ?? []), c]);
    const owners = [...byOwner.keys()]
      .map((o) => this.map.code.get(o)?.node)
      .filter((n): n is GraphNode => n !== undefined && n.file !== undefined)
      .sort((a, b) => cmp(a.file!, b.file!) || firstLine(a.range) - firstLine(b.range));
    if (owners.length > 0) view.groups.push({ id: 'client', label: `HTTP client of ${p.name}`, icon: 'api', tone: p.tone });
    for (const n of owners) {
      const line = firstLine(n.range);
      const fid = `fn:${n.id}`;
      view.nodes.push({ id: fid, shape: 'function', label: n.name, sub: `${n.file}:${line}`, group: 'client', tone: p.tone, open: fid, openProject: key, file: n.file!, line, ref: n.id });
      const per = new Map<string, { ep: Endpoint; calls: number; possible: boolean }>();
      for (const c of byOwner.get(n.id)!) {
        for (const ep of ends(c)) {
          const k = endpointId(ep);
          const x = per.get(k) ?? { ep, calls: 0, possible: true };
          x.calls++;
          if (c.endpoint) x.possible = false;
          per.set(k, x);
        }
      }
      for (const [k, x] of [...per].sort(([a], [b]) => cmp(a, b))) {
        view.edges.push({
          id: `${fid}>${k}`, from: fid, to: k, toPath: endpointPath(x.ep), kind: 'http',
          label: x.possible ? 'possible' : `${x.calls} call${x.calls === 1 ? '' : 's'}`, ...(x.possible ? { possible: true } : {}),
        });
      }
    }
    if (view.nodes.length === 0) view.notes.push('No page or function of this project makes these calls.');
    return view;
  }

  entryNode(e: Entry, shape: Shape, group: string, p: Project): ViewNode {
    const open = isVirtual(e.id) ? e.id : `fn:${e.id}`;
    return { id: open, shape, label: e.name, sub: `${e.file}:${firstLine(e.range)}`, group, tone: p.tone, open, openProject: p.key, file: e.file, line: firstLine(e.range), ref: e.id };
  }

  endpointNode(ep: Endpoint, group: string): ViewNode {
    const p = this.projects.get(ep.unit)!;
    return { id: endpointId(ep), shape: 'endpoint', label: endpointLabel({ ...ep, method: 'ANY' }), method: ep.method, sub: p.name, group, tone: p.tone, open: ep.open, openProject: ep.unit, file: ep.file, line: ep.line, ref: ep.open.startsWith('fn:') ? ep.open.slice(3) : ep.open, ...(isNextApiRoute(ep.file) ? { detail: [`A Next.js API route: the route handler in ${ep.file}`] } : {}) };
  }

  /** The atoms that `from` reaches in its own project: calls, renders and references. */
  reach(from: string, unit: string): Set<string> {
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length > 0 && seen.size < REACH_LIMIT) {
      const id = queue.shift()!;
      for (const e of this.map.edgesFrom(id)) {
        if (seen.has(e.to) || this.map.unitOf(e.to)?.unit !== unit) continue;
        seen.add(e.to);
        queue.push(e.to);
      }
    }
    return seen;
  }

  /**
   * The endpoints that a page calls. `calls`: the HTTP calls in the code that the page reaches.
   * `imports`: the HTTP calls in the files that this code imports. A React page often gets its API
   * client from a context, so the call graph does not show the call; the import does.
   */
  pageEndpoints(page: string, unit: string): Map<Endpoint, { calls: number; imports: number; methods: Set<string> }> {
    const out = new Map<Endpoint, { calls: number; imports: number; methods: Set<string> }>();
    const add = (c: Call, k: 'calls' | 'imports') => {
      if (!c.endpoint) return;
      const v = out.get(c.endpoint) ?? { calls: 0, imports: 0, methods: new Set<string>() };
      v[k]++;
      v.methods.add(c.method.toUpperCase());
      out.set(c.endpoint, v);
    };
    const files = new Set<string>();
    for (const id of [...this.reach(page, unit)].sort()) {
      for (const c of this.callsOf.get(id) ?? []) add(c, 'calls');
      const f = this.map.code.get(id)?.node.file ?? this.entryById.get(id)?.file;
      if (f) files.add(f);
    }
    const imported = new Set<string>();
    for (const f of files) for (const g of this.importsOf.get(f) ?? []) if (!files.has(g)) imported.add(g);
    for (const f of [...imported].sort()) for (const c of this.callsInFile.get(f) ?? []) add(c, 'imports');
    return out;
  }

  /** The pages of a frontend. The root component of the app (`App` in a .tsx or .jsx file) is a page too: it renders the others. */
  pagesOf(p: Project, entries: Entry[] = this.map.entries(p.key)): Entry[] {
    const pages = entries.filter((e) => e.kind === 'page');
    for (const id of this.map.units.get(p.key)?.ids ?? []) {
      const n = this.map.code.get(id)!.node;
      if (n.name !== 'App' || n.kind !== 'function' || !/\.[jt]sx$/.test(n.file ?? '') || pages.some((e) => e.id === id)) continue;
      pages.unshift({ id, kind: 'page', name: n.name, file: n.file!, range: n.range ?? '0' });
    }
    return pages;
  }

  private frontend(p: Project, pages: Entry[], view: AtlasView): void {
    view.groups.push({ id: 'pages', label: `Pages of ${p.name}`, icon: 'page', tone: p.tone });
    const linked = new Set<string>();
    const pageNodes: ViewNode[] = [];
    let byImport = 0;
    let edges = 0;
    for (const e of pages.slice(0, GROUP_LIMIT * 2)) {
      const node = this.entryNode(e, 'page', 'pages', p);
      view.nodes.push(node);
      pageNodes.push(node);
      // The edge goes to the endpoint in the view of the other project. The page draws it to the box of that project while the box is closed.
      for (const [ep, n] of [...this.pageEndpoints(e.id, p.key)].sort(([a], [b]) => cmp(endpointId(a), endpointId(b)))) {
        // Only a direct call has a label. An arrow with no label: the page imports code that calls the endpoint.
        const label = n.calls > 0 ? `${n.calls} call${n.calls === 1 ? '' : 's'}` : undefined;
        if (!label) byImport++;
        linked.add(node.id);
        edges++;
        const title = isNextApiRoute(ep.file) ? `A Next.js API route of ${this.projects.get(ep.unit)?.name ?? ep.unit}: ${ep.file}` : undefined;
        view.edges.push({ id: `${node.id}>${endpointId(ep)}`, from: node.id, to: endpointId(ep), toPath: endpointPath(ep), kind: 'http', ...(label ? { label } : {}), ...(title ? { title } : {}) });
      }
    }
    if (byImport > 0) view.notes.push('An arrow with no label: the page imports code that calls the endpoint. A label ("1 call") shows a call in the code of the page.');
    // A page with no link of its own: if the root page renders it, the root page gets the data for it.
    // "Renders" is a call or a render that the root reaches, or a file that the code of the root imports, at any depth.
    const root = pageNodes.find((n) => n.label === 'App' && linked.has(n.id));
    if (root) {
      const reach = this.reach(root.ref!, p.key);
      const files = new Set<string>();
      for (const id of reach) {
        const f = this.map.code.get(id)?.node.file;
        if (f) files.add(f);
      }
      for (const queue = [...files]; queue.length > 0; ) {
        for (const g of this.importsOf.get(queue.shift()!) ?? []) if (!files.has(g)) queue.push(g), files.add(g);
      }
      for (const n of pageNodes) {
        if (n === root || linked.has(n.id) || (!reach.has(n.ref!) && !files.has(n.file!))) continue;
        n.note = `This page makes no HTTP call of its own. It gets its data through ${root.label}: ${root.label} uses this page and calls the endpoints.`;
      }
    }
    if (pages.length > GROUP_LIMIT * 2) view.notes.push(`${pages.length - GROUP_LIMIT * 2} more pages are not shown. Use the search.`);
    // The HTTP client: the functions that hold the HTTP calls. Each one opens as a flow chart, with an edge from the call to the endpoint.
    const shown = new Set(view.nodes.map((n) => n.ref));
    const owners = [...new Set(this.calls.filter((c) => c.unit === p.key && c.endpoint && c.owner).map((c) => c.owner!))]
      .map((id) => this.map.code.get(id)?.node)
      .filter((n): n is GraphNode => n !== undefined && !shown.has(n.id) && n.file !== undefined)
      .sort((a, b) => cmp(a.file!, b.file!) || firstLine(a.range) - firstLine(b.range));
    if (owners.length > 0) {
      view.groups.push({ id: 'client', label: `HTTP client of ${p.name}`, icon: 'api', tone: p.tone });
      for (const n of owners.slice(0, GROUP_LIMIT)) {
        const line = firstLine(n.range);
        view.nodes.push({ id: `fn:${n.id}`, shape: 'function', label: n.name, sub: `${n.file}:${line}`, group: 'client', tone: p.tone, open: `fn:${n.id}`, openProject: p.key, file: n.file!, line, ref: n.id });
      }
      if (owners.length > GROUP_LIMIT) view.nodes.push({ id: 'more:client', shape: 'more', label: `+${owners.length - GROUP_LIMIT} more`, group: 'client' });
    }
    if (edges === 0) view.notes.push('No page of this project calls an endpoint that the index knows.');
  }

  private api(p: Project, view: AtlasView): void {
    const mine = this.endpoints.filter((e) => e.unit === p.key);
    for (const [g, list] of routeGroups(mine)) {
      const id = `prefix:${g}`;
      view.groups.push({ id, label: g === OTHER_ROUTES ? 'Other routes' : g, icon: 'api', tone: p.tone });
      for (const e of list.slice(0, GROUP_LIMIT)) {
        view.nodes.push({ ...this.endpointNode(e, id), shape: 'route' as const, sub: `${e.file}:${e.line}` });
      }
      if (list.length > GROUP_LIMIT) view.nodes.push({ id: `more:${g}`, shape: 'more', label: `+${list.length - GROUP_LIMIT} more`, group: id });
    }
  }

  private cli(p: Project, entries: Entry[], view: AtlasView): void {
    view.groups.push({ id: 'commands', label: `Commands of ${p.name}`, icon: 'cli', tone: p.tone });
    const commands = entries.filter((e) => e.kind === 'command');
    for (const e of commands.slice(0, GROUP_LIMIT * 2)) view.nodes.push(this.entryNode(e, 'command', 'commands', p));
    if (commands.length > GROUP_LIMIT * 2) view.nodes.push({ id: 'more:commands', shape: 'more', label: `+${commands.length - GROUP_LIMIT * 2} more`, group: 'commands' });
  }

  private library(p: Project, view: AtlasView): void {
    const shown = new Set<string>();
    for (const f of this.map.features(p.key)) {
      const group = `feature:${f.slug}`;
      view.groups.push({ id: group, label: f.name, icon: 'library', tone: p.tone });
      for (const e of f.entries.slice(0, GROUP_LIMIT)) {
        const node = this.entryNode(e, e.kind === 'page' ? 'page' : e.kind === 'route' ? 'route' : e.kind === 'command' ? 'command' : 'function', group, p);
        if (shown.has(node.id)) continue;
        shown.add(node.id);
        view.nodes.push(node);
      }
      if (f.entries.length > GROUP_LIMIT) view.nodes.push({ id: `more:${f.slug}`, shape: 'more', label: `+${f.entries.length - GROUP_LIMIT} more`, group });
    }
    // The calls between the shown functions.
    for (const n of view.nodes) {
      if (!n.ref) continue;
      for (const e of this.map.edgesFrom(n.ref)) {
        const to = isVirtual(e.to) ? e.to : `fn:${e.to}`;
        if (to !== n.id && shown.has(to) && !view.edges.some((x) => x.id === `${n.id}>${to}`)) view.edges.push({ id: `${n.id}>${to}`, from: n.id, to, kind: 'uses' });
      }
    }
  }

  // ---------------------------------------------------------------- flow

  /** The flow chart of a function, a nested function, a route block or a command block. */
  async flow(id: string): Promise<AtlasView> {
    const fail = (note: string): AtlasView => ({ ok: false, level: 'flow', id, title: id, groups: [], nodes: [], edges: [], notes: [note] });
    let target: string;
    let opts: { at?: number; block?: number; blockName?: string } = {};
    let title: string | undefined;
    if (id.startsWith('fn:')) target = id.slice(3);
    else if (id.startsWith('at:')) {
      const m = /^at:(\d+):(.+)$/.exec(id);
      if (!m) return fail('This ID is not correct.');
      target = m[2]!;
      opts = { at: Number(m[1]) };
    } else if (isVirtual(id)) {
      const e = this.entryById.get(id);
      if (!e?.owner) return fail('This route or command is not in the index.');
      target = e.owner;
      title = e.name;
      const ep = this.endpoints.find((x) => x.open === id);
      opts = { block: firstLine(e.range), blockName: ep ? endpointLabel(ep) : e.name };
      if (ep) title = endpointLabel(ep);
    } else return fail('This ID is not correct.');
    const unit = this.map.unitOf(target)?.unit ?? this.map.code.get(target)?.unit;
    const chart = await codeChart(this.source, this.root, target, { limit: STEP_LIMIT, libraries: true, ...opts });
    if (!chart.ok) return { ...fail(chart.notes[0] ?? 'This code has no flow chart.'), notes: chart.notes.length > 0 ? chart.notes : ['This code has no flow chart.'] };
    const p = unit ? this.projects.get(unit) : undefined;
    const view: AtlasView = {
      ok: true, level: 'flow', id, title: title ?? (opts.at ? `${chart.name} › line ${opts.at}` : chart.name), groups: [], nodes: [], edges: [], notes: [...chart.notes],
      ...(p ? { project: p.key } : {}), ...(chart.file ? { file: chart.file } : {}), line: opts.block ?? opts.at ?? chart.start,
    };
    const owned = new Map<string, Call[]>();
    const possibleOf = new Map<string, string[]>();
    const fileCalls = this.calls.filter((c) => c.file === chart.file && c.endpoint);
    for (const c of fileCalls) {
      // The smallest node that holds the line of the call.
      let best: ChartNode | undefined;
      for (const n of chart.nodes) {
        if (n.kind === 'start' || n.kind === 'end' || c.line < n.start || c.line > n.end) continue;
        if (!best || n.end - n.start < best.end - best.start) best = n;
      }
      if (best) owned.set(best.id, [...(owned.get(best.id) ?? []), c]);
    }
    // A call with no sure endpoint: the panel of its node lists the possible endpoints.
    for (const c of this.calls.filter((x) => x.file === chart.file && !x.endpoint && x.possible)) {
      let best: ChartNode | undefined;
      for (const n of chart.nodes) {
        if (n.kind === 'start' || c.line < n.start || c.line > n.end) continue;
        if (!best || n.end - n.start < best.end - best.start) best = n;
      }
      if (best) possibleOf.set(best.id, [...(possibleOf.get(best.id) ?? []), ...c.possible!.map((e) => `Possible HTTP match at line ${c.line}: ${endpointLabel(e)} · ${this.projects.get(e.unit)?.name ?? e.unit}`)]);
    }
    for (const n of chart.nodes) {
      const node = this.chartNode(n, chart.file, target, p);
      const maybe = possibleOf.get(n.id);
      if (maybe) node.detail = [...new Set([...(node.detail ?? []), ...maybe])];
      view.nodes.push(node);
      // An HTTP call: an edge from the step to the endpoint in the view of the other project.
      const seen = new Set<string>();
      for (const c of owned.get(n.id) ?? []) {
        const ep = c.endpoint!;
        const to = endpointId(ep);
        if (seen.has(to)) continue;
        seen.add(to);
        node.target ??= endpointPath(ep);
        node.detail = [...(node.detail ?? []), `HTTP call at line ${c.line}: ${endpointLabel(ep)} · ${this.projects.get(ep.unit)?.name ?? ep.unit}`];
        view.edges.push({ id: `${n.id}>${to}`, from: n.id, to, toPath: endpointPath(ep), kind: 'http', label: endpointLabel(ep) });
      }
    }
    // The event handlers of a component go into one group, in a grid, with one edge from the render.
    const events = new Set(chart.nodes.filter((n) => n.kind === 'event' || (n.kind === 'more' && n.event === 'more')).map((n) => n.id));
    if (events.size > 0) {
      const total = chart.nodes.filter((n) => events.has(n.id)).reduce((sum, n) => sum + (n.kind === 'more' ? (n.count ?? 0) : 1), 0);
      view.groups.push({ id: 'events', label: `Event handlers (${total})`, icon: 'event', tone: p?.tone ?? 7, layout: 'grid' });
      for (const n of view.nodes) if (events.has(n.id)) n.group = 'events';
    }
    const from = new Set<string>();
    for (const e of chart.edges) {
      if (events.has(e.to)) {
        if (!from.has(e.from)) view.edges.push({ id: `${e.from}>events`, from: e.from, to: 'events', kind: 'branch', label: 'events' });
        from.add(e.from);
        continue;
      }
      const kind: ViewEdge['kind'] = e.kind === 'next' ? 'flow' : e.kind;
      view.edges.push({ id: `${e.from}>${e.to}:${e.label ?? ''}:${e.kind}`, from: e.from, to: e.to, kind, ...(e.label ? { label: e.label } : {}) });
    }
    // The setup of a component: a run of hook calls becomes one node for each kind of hook.
    const text = chart.file ? this.read(chart.file)?.split('\n') : undefined;
    const joined = joinHooks(chart, view, (n) => text?.[n - 1]);
    view.nodes = joined.nodes;
    view.edges = joined.edges;
    return view;
  }

  /**
   * The call that a step opens, of the calls on its line: a call into another project first (it says
   * more than a local helper); else the function that reaches the most code (in
   * `sendJson(res, 200, await lensView(…))`, lensView, not the small helper sendJson).
   */
  private mainCall(calls: readonly ChartCall[], unit: string | undefined): ChartCall | undefined {
    const unitOfFn = (id: string) => this.map.unitOf(id)?.unit ?? this.map.code.get(id)?.unit;
    const cross = calls.find((c) => unitOfFn(c.fn.id) !== unit);
    if (cross || calls.length < 2) return cross ?? calls[0];
    const size = (c: ChartCall) => this.reach(c.fn.id, unitOfFn(c.fn.id) ?? '').size;
    return calls.reduce((best, c) => (size(c) > size(best) ? c : best));
  }

  private chartNode(n: ChartNode, file: string | undefined, target: string, p: Project | undefined): ViewNode {
    const base = { id: n.id, label: n.label, ...(file ? { file, line: n.start } : {}), ...(p ? { tone: p.tone } : {}) };
    const detail: string[] = [];
    if (n.text && n.text !== n.label) detail.push(n.text);
    for (const l of n.libs ?? []) detail.push(`${l.package}: ${l.name} (line ${l.line})`);
    const withDetail = detail.length > 0 ? { detail } : {};
    switch (n.kind) {
      case 'start':
        return { ...base, ...withDetail, shape: 'start' };
      case 'decision':
        return { ...base, ...withDetail, shape: 'decision' };
      case 'loop':
        return { ...base, ...withDetail, shape: 'loop' };
      case 'return': case 'throw': case 'end': case 'break': case 'continue': {
        // `return handle(req)`: the end opens the function that it calls (a route block often ends so).
        const call = this.mainCall((n.calls ?? []).filter((c) => c.fn.id !== target), p?.key);
        for (const c of (n.calls ?? []).filter((x) => x !== call && x.fn.id !== target)) detail.push(`calls ${c.fn.name} (${c.fn.file}:${c.fn.line})`);
        const sub = n.kind === 'end' ? undefined : call ? `${n.kind} · ${call.fn.name}()` : n.kind;
        const open = call ? { open: `fn:${call.fn.id}`, ref: call.fn.id, ...(p ? { openProject: this.map.unitOf(call.fn.id)?.unit ?? p.key } : {}) } : {};
        return { ...base, ...(detail.length > 0 ? { detail } : {}), shape: 'end', ...(sub ? { sub } : {}), ...open };
      }
      case 'more':
        return { ...base, ...withDetail, shape: 'more', sub: n.text };
      case 'event':
      case 'nested': {
        const at = n.nested?.[0]?.at;
        return { ...base, ...withDetail, shape: n.kind === 'event' ? 'event' : 'call', sub: n.hook ?? (n.kind === 'event' ? 'event handler' : 'function'), ...(at ? { open: `at:${at}:${target}`, ...(p ? { openProject: p.key } : {}) } : {}) };
      }
    }
    const others = (n.calls ?? []).filter((c) => c.fn.id !== target);
    const call = this.mainCall(others, p?.key);
    if (call) {
      const unit = this.map.unitOf(call.fn.id)?.unit ?? this.map.code.get(call.fn.id)?.unit;
      const q = unit ? this.projects.get(unit) : undefined;
      for (const c of others.filter((x) => x !== call)) detail.push(`calls ${c.fn.name} (${c.fn.file}:${c.fn.line})`);
      const cross = q !== undefined && q.key !== p?.key;
      return {
        ...base, ...(detail.length > 0 ? { detail } : {}), shape: cross ? 'cross' : 'call', sub: cross ? `${call.fn.name} · ${q.name}` : `${call.fn.name}()`,
        open: `fn:${call.fn.id}`, ...(q ? { openProject: q.key, tone: q.tone } : {}), ref: call.fn.id,
      };
    }
    if (n.renders && n.renders.length > 0) {
      // A render branch opens the first component that the map knows (a `renders` edge of the
      // function to a component of that name: CodeGraph gives no line for a render).
      const edge = n.renders.map((r) => this.map.edgesFrom(target).find((e) => e.kind === 'renders' && this.map.nameOf(e.to) === r)).find((e) => e !== undefined);
      const name = edge ? this.map.nameOf(edge.to) : undefined;
      if (edge) {
        const others = n.renders.filter((r) => r !== name);
        if (others.length > 0) detail.push(`also renders ${others.map((r) => `<${r}>`).join(', ')}`);
      }
      return { ...base, ...(detail.length > 0 ? { detail } : {}), shape: edge ? 'call' : 'step', sub: 'render', ...(edge ? { open: `fn:${edge.to}`, ref: edge.to, ...(p ? { openProject: p.key } : {}) } : {}) };
    }
    if (n.libs && n.libs.length > 0) {
      const l = n.libs[0]!;
      return { ...base, ...withDetail, shape: 'lib', sub: `${l.package} · ${l.name}` };
    }
    return { ...base, ...withDetail, shape: 'step', ...(n.hook ? { sub: n.hook } : n.count && n.count > 1 ? { sub: `${n.count} steps` } : {}) };
  }

  // ---------------------------------------------------------------- search and panel

  /** The functions, pages, routes and commands whose names fit the words. */
  search(words: string, limit = 20): SearchHit[] {
    const q = words.trim().toLowerCase();
    if (q === '') return [];
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    const push = (h: SearchHit) => {
      const k = h.path.at(-1)!;
      if (seen.has(k) || hits.length >= limit) return;
      seen.add(k);
      hits.push(h);
    };
    for (const ep of this.endpoints) {
      if (endpointLabel(ep).toLowerCase().includes(q)) push({ label: endpointLabel(ep), sub: `route · ${this.projects.get(ep.unit)!.name}`, path: endpointPath(ep) });
    }
    for (const e of this.entryById.values()) {
      if (e.name.toLowerCase().includes(q)) {
        const open = isVirtual(e.id) ? e.id : `fn:${e.id}`;
        push({ label: e.name, sub: `${e.kind} · ${this.projects.get(e.unit)!.name}`, path: [`project:${e.unit}`, open] });
      }
    }
    // The functions: a name that starts with the words first, then a name that holds them.
    const fns: CodeInfo[] = [];
    for (const c of this.map.code.values()) {
      if (c.test || !FN_KINDS.has(c.node.kind) || c.node.kind === 'class' || c.node.kind === 'route' || !this.projects.has(c.unit)) continue;
      if (c.node.name.toLowerCase().includes(q)) fns.push(c);
    }
    const rank = (c: CodeInfo) => (c.node.name.toLowerCase().startsWith(q) ? 0 : 1);
    fns.sort((a, b) => rank(a) - rank(b) || a.node.name.length - b.node.name.length || cmp(a.node.id, b.node.id));
    for (const { node: n, unit } of fns.slice(0, limit * 3)) {
      const c = { unit };
      push({ label: n.name, sub: `${n.kind} · ${this.projects.get(c.unit)!.name} · ${n.file}:${firstLine(n.range)}`, path: [`project:${c.unit}`, `fn:${n.id}`] });
    }
    return hits;
  }

  /** The panel of a code node or a virtual entry: where it is, its callers and its callees. */
  node(id: string): NodeInfo {
    const entry = this.entryById.get(id);
    const node = this.map.code.get(id)?.node;
    if (!entry && !node) return { ok: false, id, label: id, callers: [], callees: [] };
    const file = entry?.file ?? node?.file;
    const line = firstLine(entry?.range ?? node?.range);
    const link = (other: string, kind: string): NodeLink => {
      const e = this.entryById.get(other);
      const n = this.map.code.get(other)?.node;
      const outside = this.map.unitOf(other) === undefined;
      const f = e?.file ?? n?.file;
      return {
        id: other, kind, label: e?.name ?? n?.name ?? this.map.nameOf(other),
        ...(f && !outside ? { file: f, line: firstLine(e?.range ?? n?.range) } : {}),
        ...(outside ? {} : { open: isVirtual(other) ? other : `fn:${other}` }),
      };
    };
    const uniq = (list: NodeLink[]) => list.filter((l, i) => list.findIndex((x) => x.id === l.id) === i);
    return {
      ok: true, id, label: entry?.name ?? node!.name, ...(file ? { file, line, path: join(this.root, file) } : {}),
      callers: uniq(this.map.edgesTo(id).map((e) => link(e.from, e.kind))),
      callees: uniq(this.map.edgesFrom(id).map((e) => link(e.to, e.kind))),
    };
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
