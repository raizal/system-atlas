// The Tests mode of the atlas: the e2e cases of the repo on the map.
//   case:<case id>      the touched parts of the map in the System lanes: the case (its flow chart opens
//                       in place), the pages and elements of the frontend, the endpoints by API project,
//                       and the data stores of those APIs
//   caseflow:<case id>  the flow chart of one case: its steps in order, a box for each helper, test.step,
//                       hook and fixture
// The steps come from the spec source (tree-sitter, see src/tests/extract.ts). The targets of a step are
// a guess from the source: a goto goes to the page whose route fits the URL, a mock or a request to the
// endpoint that fits its path, an action to the element with its text, label or test ID in the JSX.
// The requests of the last run (from its trace) win over the guess: "seen in the run".

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Entry } from '../index/entries.js';
import { isTestPath } from '../index/projects.js';
import { routeFit, routeSegments } from '../link/routes.js';
import { readCases } from '../tests/extract.js';
import { lastRun, loadResults, type Results } from '../tests/results.js';
import { fileLoader, findSpecs, type PlaywrightConfig } from '../tests/specs.js';
import type { AreaHow, AreaItem, AreaLayer, AreaRow, CaseInfo, CaseResult, CaseStep, CaseTouch, Coverage, FixtureExtra, PlayStep, SpecFile, StepTarget, TestCase, TestsInfo } from '../tests/types.js';
import { endpointId, endpointLabel, isNextApiRoute, type Atlas, type Endpoint, type Project } from './model.js';
import type { AtlasView, SearchHit, ViewEdge, ViewGroup, ViewNode } from './view.js';

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const firstLine = (range: string | undefined): number => Number((range ?? '0').split('-')[0]) || 0;
/** The most elements of one locator that the atlas shows. */
const ELEMENT_HITS = 3;
/** The lines before a JSX text where the atlas looks for the tag and its handler. */
const TAG_LOOKBACK = 4;

/** An element in the JSX of a frontend that a locator fits. */
interface ElementHit {
  file: string;
  line: number;
  /** The function (component) that holds the element. */
  owner?: { id: string; name: string };
  /** The handler of the element: `onClick={reset}` → reset. */
  handler?: string;
  /** A test ID or an exact label: a sure match. */
  exact: boolean;
}

/** The plan of one case: each leaf step with its targets on the map. */
interface Plan {
  test: TestCase;
  spec: SpecFile;
  unit?: string;
  steps: PlayStep[];
  /** The nodes of the case view: pages and elements by frontend, endpoints by project. */
  pages: Map<string, ViewNode>;
  elements: Map<string, ViewNode>;
  endpoints: Map<string, Endpoint>;
  edges: Map<string, ViewEdge>;
  result?: CaseResult;
  /** The endpoints behind a mocked route: the case does not run them. */
  notRun: Set<string>;
  areas: AreaItem[];
  checks: string[];
  /** The mocks of each fixture that the page does not call. */
  fixtureExtra: FixtureExtra[];
}

/** The scope of the element search: the files that the page reaches, and the files of the last hits (most recent first). */
interface ElementScope {
  files: ReadonlySet<string>;
  recent: string[];
}

const CLICKS = new Set(['click', 'dblclick', 'tap', 'check', 'uncheck', 'setChecked', 'selectOption', 'hover', 'dragTo', 'dispatchEvent']);
/** The most endpoints that one goto adds (the calls of the page code), when the case has no mock. */
const PAGE_CALLS = 12;
const FILLS = new Set(['fill', 'type', 'press', 'pressSequentially', 'clear', 'setInputFiles', 'selectText']);
/** The most backend functions that the areas list shows behind one endpoint. */
const BACKEND_FNS = 5;
/** The files of error answers (`errors.py`, `exceptions.ts`): not the work behind an endpoint. */
const ERROR_FILE = /(^|\/)(errors?|exceptions?)\.\w+$/;
const LAYER_ORDER: AreaLayer[] = ['feature', 'page', 'component', 'handler', 'route', 'endpoint', 'backend'];
/** The verbs of the function names that an HTTP method calls first: GET → listOrders before createOrder. */
const VERBS: Record<string, string[]> = { GET: ['list', 'get', 'read', 'find', 'fetch', 'load', 'search'], POST: ['create', 'add', 'insert', 'save', 'new', 'issue', 'post'], PUT: ['update', 'set', 'save', 'replace', 'put'], PATCH: ['update', 'patch', 'set', 'edit'], DELETE: ['delete', 'remove', 'destroy', 'close'] };
const HOW_ORDER: AreaHow[] = ['visited', 'clicked', 'filled', 'asserted', 'mocked', 'seen', 'notRun', 'code'];

/** The route of a Next.js page as segments: `/audit/[id]` → `audit/{}`; a catch-all is a prefix. */
function pageRoute(name: string): { segs: string[]; prefix: boolean } | undefined {
  if (!name.startsWith('/')) return undefined;
  const parts = name.split('/').filter((s) => s !== '' && !/^\(.*\)$/.test(s));
  const prefix = parts.length > 0 && /^\[\[?\.\.\./.test(parts.at(-1)!);
  const segs = (prefix ? parts.slice(0, -1) : parts).map((s) => (/^\[.*\]$|^:\w+$|^\{.*\}$/.test(s) ? '{}' : s));
  return { segs, prefix };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class TestModel {
  private specCache: { configs: PlaywrightConfig[]; specs: SpecFile[] } | undefined;
  private caseCache: Map<string, TestCase[]> | undefined;
  private readonly plans = new Map<string, Plan>();
  private readonly jsx = new Map<string, Array<{ file: string; lines: string[]; low: string }>>();
  private results: Results | undefined;
  private resultsLoaded = false;

  constructor(
    readonly atlas: Atlas,
    /** The results folder (`--results`). No value: the last run of `atlas test`. */
    private readonly resultsDir?: string,
  ) {}

  get specs(): { configs: PlaywrightConfig[]; specs: SpecFile[] } {
    return (this.specCache ??= findSpecs(this.atlas.root));
  }

  /** The cases of each spec file (parsed once). */
  async cases(): Promise<Map<string, TestCase[]>> {
    if (this.caseCache) return this.caseCache;
    const out = new Map<string, TestCase[]>();
    const load = fileLoader(this.atlas.root);
    for (const s of this.specs.specs) {
      let text: string;
      try {
        text = readFileSync(join(this.atlas.root, s.file), 'utf8');
      } catch {
        continue;
      }
      try {
        out.set(s.file, await readCases(s.file, text, load));
      } catch {
        out.set(s.file, []);
      }
    }
    this.caseCache = out;
    return out;
  }

  /** The results of the last run, read once. */
  private lastResults(): Results | undefined {
    if (!this.resultsLoaded) {
      this.resultsLoaded = true;
      const dir = this.resultsDir ?? lastRun(this.atlas.root);
      if (dir) this.results = loadResults(dir, this.atlas.root, this.specs.specs.map((s) => s.file));
    }
    return this.results;
  }

  /** The frontend that a spec tests: the project whose folder holds its config, else the one frontend. */
  private unitOf(spec: SpecFile): string | undefined {
    const fronts = [...this.atlas.projects.values()].filter((p) => p.kind === 'frontend');
    const dir = spec.config ? spec.config.split('/').slice(0, -1).join('/') : spec.file.split('/').slice(0, -1).join('/');
    const holds = (p: Project) => p.dir === '' || dir === p.dir || dir.startsWith(`${p.dir}/`);
    const own = [...this.atlas.projects.values()].filter(holds).sort((a, b) => b.dir.length - a.dir.length)[0];
    if (own && own.kind === 'frontend') return own.key;
    const near = fronts.filter(holds).sort((a, b) => b.dir.length - a.dir.length)[0];
    if (near) return near.key;
    return fronts.length === 1 ? fronts[0]!.key : undefined;
  }

  // ---------------------------------------------------------------- the matchers

  /** The page of a frontend that a URL path opens. A single-page app: its root component, possible. */
  pageOf(unit: string, url: string): { entry: Entry; possible: boolean } | undefined {
    const p = this.atlas.projects.get(unit);
    if (!p) return undefined;
    const pages = this.atlas.pagesOf(p);
    const segs = routeSegments(url.replace(/[?#].*$/, ''));
    let best: Entry | undefined;
    let top = -1;
    let routed = false;
    for (const e of pages) {
      const r = pageRoute(e.name);
      if (!r) continue;
      routed = true;
      const s = routeFit('*', segs, { method: 'ANY', path: r.segs, prefix: r.prefix });
      if (s > top) [best, top] = [e, s];
    }
    if (best) return { entry: best, possible: false };
    if (routed) return undefined;
    const app = pages.find((e) => e.name === 'App') ?? (pages.length === 1 ? pages[0] : undefined);
    return app ? { entry: app, possible: true } : undefined;
  }

  /**
   * The endpoints that a request path of a frontend goes to: its own Next.js API route first, then the
   * endpoint of another project. A Next.js route that calls another project adds that endpoint.
   */
  endpointsOf(unit: string, method: string, url: string): Array<{ endpoint: Endpoint; possible: boolean; via?: Endpoint }> {
    const path = url.replace(/[?#].*$/, '');
    if (path === '' || path === '/' || /^\*+$/.test(path)) return [];
    const out: Array<{ endpoint: Endpoint; possible: boolean; via?: Endpoint }> = [];
    const add = (e: Endpoint, possible: boolean, via?: Endpoint) => {
      if (!out.some((o) => o.endpoint === e)) out.push({ endpoint: e, possible, ...(via ? { via } : {}) });
    };
    const own = this.atlas.ownRoute(method, path, unit);
    if (own) add(own, false);
    const far = this.atlas.match(method, path, unit);
    if (far.endpoint) add(far.endpoint, false);
    else if (!own) for (const e of far.possible ?? []) add(e, true);
    if (own && !far.endpoint) for (const b of this.atlas.backendOf(own)) add(b, true, own);
    return out;
  }

  /** The .tsx and .jsx files of a frontend, as lines. */
  private jsxOf(unit: string): Array<{ file: string; lines: string[]; low: string }> {
    const hit = this.jsx.get(unit);
    if (hit) return hit;
    const p = this.atlas.projects.get(unit);
    const out: Array<{ file: string; lines: string[]; low: string }> = [];
    if (p) {
      for (const f of [...this.atlas.index.files.keys()].sort()) {
        if (!/\.[jt]sx$/.test(f) || isTestPath(f) || (p.dir !== '' && !f.startsWith(`${p.dir}/`))) continue;
        try {
          const text = readFileSync(join(this.atlas.root, f), 'utf8');
          out.push({ file: f, lines: text.split('\n'), low: text.toLowerCase() });
        } catch {
          // Not readable: leave it out.
        }
      }
    }
    this.jsx.set(unit, out);
    return out;
  }

  /**
   * The elements of a frontend that a locator fits. With a scope: only the files that the page reaches
   * (its imports at any depth), and the hits near the last hits first (the dialog that the last click
   * opened). The text fits with no regard to case, as `getByRole` does.
   */
  elementsOf(unit: string, loc: NonNullable<CaseStep['locator']>, scope?: ElementScope): ElementHit[] {
    const text = loc.name ?? (loc.by === 'role' ? undefined : loc.value);
    if (!text || text.length > 120) return [];
    const t = escape(text.trim());
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*\\{?\\s*["'\`]${t}["'\`]`, 'i');
    let res: Array<{ re: RegExp; exact: boolean }>;
    switch (loc.by) {
      case 'testid':
        res = [{ re: new RegExp(`\\bdata-(?:testid|test-id|test|cy|qa)\\s*=\\s*\\{?\\s*["'\`]${t}["'\`]`, 'i'), exact: true }];
        break;
      case 'label':
        res = [{ re: attr('aria-label'), exact: true }, { re: new RegExp(`<label\\b[^>]*>\\s*${t}\\s*<`, 'i'), exact: false }, { re: new RegExp(`^\\s*${t}\\s*$`, 'i'), exact: false }];
        break;
      case 'placeholder':
      case 'title':
      case 'alt':
        res = [{ re: attr(loc.by), exact: true }];
        break;
      case 'css': {
        const id = /^#([\w-]+)$/.exec(loc.value)?.[1];
        const test = /^\[data-(?:testid|test-id|cy|qa)=["']?([\w-]+)["']?\]$/.exec(loc.value)?.[1];
        if (id) res = [{ re: new RegExp(`\\bid\\s*=\\s*["'\`]${escape(id)}["'\`]`, 'i'), exact: true }];
        else if (test) res = [{ re: new RegExp(`\\bdata-(?:testid|test-id|cy|qa)\\s*=\\s*["'\`]${escape(test)}["'\`]`, 'i'), exact: true }];
        else return [];
        break;
      }
      default:
        // role (with a name), text: the JSX text, or an aria-label, title or value with the text.
        res = [{ re: attr('aria-label'), exact: true }, { re: new RegExp(`>\\s*${t}\\s*<`, 'i'), exact: false }, { re: new RegExp(`^\\s*${t}\\s*$`, 'i'), exact: false }, { re: attr('(?:title|value|label)'), exact: false }];
    }
    // Each pattern holds the text: a file and a line without it are not read (a fast check).
    const needle = (loc.by === 'css' ? (/^#([\w-]+)$/.exec(loc.value)?.[1] ?? /([\w-]+)["']?\]$/.exec(loc.value)?.[1] ?? '') : text.trim()).toLowerCase();
    const hits: ElementHit[] = [];
    const files = (scope ? this.jsxOf(unit).filter((f) => scope.files.has(f.file)) : this.jsxOf(unit)).filter((f) => f.low.includes(needle));
    for (const { file, lines } of files) {
      for (let i = 0; i < lines.length && hits.length < ELEMENT_HITS * 2; i++) {
        if (!lines[i]!.toLowerCase().includes(needle)) continue;
        const r = res.find((x) => x.re.test(lines[i]!));
        if (!r) continue;
        // A role locator: the tag must fit the role (a button, a link …) if the line shows a tag.
        const back = lines.slice(Math.max(0, i - TAG_LOOKBACK), i + 1).join('\n');
        if (loc.by === 'role' && !roleFits(loc.value, back)) continue;
        const owner = this.atlas.ownerOf(file, i + 1);
        const handler = /\bon[A-Z]\w*\s*=\s*\{\s*([A-Za-z_$][\w$.]*)\s*\}/.exec(back)?.[1] ?? /\bon[A-Z]\w*\s*=\s*\{\s*\([^)]*\)\s*=>\s*(?:void\s+)?([A-Za-z_$][\w$.]*)\s*\(/.exec(back)?.[1];
        hits.push({ file, line: i + 1, exact: r.exact, ...(owner ? { owner: { id: owner.id, name: owner.name } } : {}), ...(handler ? { handler } : {}) });
      }
    }
    // Near the last hits first: a file that the last hit file imports (a dialog that it opens), the same
    // file, a file that imports it. Only the hits of the best rank stay.
    const rank = (f: string): number => {
      let best = 1000;
      (scope?.recent ?? []).forEach((r, k) => {
        const d = this.atlas.importsOfFile(r).has(f) ? 0 : f === r ? 1 : this.atlas.importsOfFile(f).has(r) ? 2 : -1;
        if (d >= 0) best = Math.min(best, k * 3 + d);
      });
      return best;
    };
    const ranked = hits.map((h) => ({ h, r: rank(h.file) }));
    const top = Math.min(...ranked.map((x) => x.r));
    return ranked.filter((x) => x.r === top).map((x) => x.h).sort((a, b) => Number(b.exact) - Number(a.exact)).slice(0, ELEMENT_HITS);
  }

  private readonly closures = new Map<string, Set<string>>();
  /** The files that a page reaches: its file, the code that it calls and renders, and their imports at any depth. */
  private closureOf(entry: Entry, unit: string): Set<string> {
    const hit = this.closures.get(entry.id);
    if (hit) return hit;
    const files = new Set<string>([entry.file]);
    for (const a of this.atlas.reach(entry.id, unit)) {
      const f = this.atlas.map.code.get(a)?.node.file;
      if (f) files.add(f);
    }
    const out = this.atlas.importClosure(files);
    this.closures.set(entry.id, out);
    return out;
  }

  // ---------------------------------------------------------------- the plan of a case

  private async find(id: string): Promise<{ test: TestCase; spec: SpecFile } | undefined> {
    const file = id.slice(0, id.lastIndexOf(':'));
    const spec = this.specs.specs.find((s) => s.file === file);
    if (!spec) return undefined;
    const test = (await this.cases()).get(file)?.find((c) => c.id === id);
    return test ? { test, spec } : undefined;
  }

  async plan(id: string): Promise<Plan | undefined> {
    const hit = this.plans.get(id);
    if (hit) return hit;
    const found = await this.find(id);
    if (!found) return undefined;
    const { test, spec } = found;
    const unit = this.unitOf(spec);
    const result = this.lastResults()?.byCase.get(id);
    const plan: Plan = { test, spec, ...(unit ? { unit } : {}), steps: [], pages: new Map(), elements: new Map(), endpoints: new Map(), edges: new Map(), notRun: new Set(), areas: [], checks: [], fixtureExtra: [], ...(result ? { result } : {}) };
    const project = unit ? this.atlas.projects.get(unit) : undefined;
    // The leaf steps in order, with their groups.
    const leaves: Array<{ step: CaseStep; groups: string[] }> = [];
    const walk = (steps: CaseStep[], groups: string[]) => {
      for (const s of steps) {
        if (s.kind === 'group') walk(s.steps ?? [], [...groups, s.text]);
        else leaves.push({ step: s, groups });
      }
    };
    walk(test.steps, []);
    const areas = new Areas();
    const methodsOf = (s: { method?: string; methods?: string[] }) => s.methods ?? [s.method ?? '*'];
    // The endpoints that the case mocks (any step): a request to them does not reach the real code.
    const mocked = new Set<string>();
    if (unit) {
      for (const { step } of leaves) {
        if (step.kind !== 'mock' || !step.url) continue;
        for (const m of methodsOf(step)) for (const { endpoint, via } of this.endpointsOf(unit, m, step.url)) if (!via) mocked.add(endpointId(endpoint));
      }
    }
    // The endpoints that the case uses: the client calls of the functions that the visited pages
    // reach (a call outside a function counts if its file is in the import closure), and the mocks
    // that an assert names. A fixture can mock many routes; a mock that the page does not call is
    // "registered, not used" and is not an area of the case.
    const used = new Set<string>();
    if (unit) {
      const files = new Set<string>();
      const reached = new Set<string>();
      for (const { step } of leaves) {
        if ((step.kind === 'goto' || (step.kind === 'assert' && step.url)) && step.url) {
          const m = this.pageOf(unit, step.url);
          if (m) {
            for (const f of this.closureOf(m.entry, unit)) files.add(f);
            for (const x of this.atlas.reach(m.entry.id, unit)) reached.add(x);
          }
        }
        if (step.kind === 'assert' && step.api) for (const { endpoint, via } of this.endpointsOf(unit, step.api.method, step.api.url)) if (!via) used.add(endpointId(endpoint));
      }
      for (const f of files) {
        for (const c of this.atlas.callsIn(f)) {
          if (c.owner ? !reached.has(c.owner) : false) continue;
          if (c.endpoint) used.add(endpointId(c.endpoint));
          for (const e of c.possible ?? []) used.add(endpointId(e));
        }
      }
    }
    const extra = new Map<string, string[]>();
    // The first page of the case: a mock before the first goto is on this page.
    let page: { node: ViewNode; entry: Entry; possible: boolean } | undefined;
    const pageNode = (url: string) => {
      if (!unit || !project) return undefined;
      const m = this.pageOf(unit, url);
      if (!m) return undefined;
      const node = { ...this.atlas.entryNode(m.entry, 'page', `fe:${unit}`, project), sub: m.entry.name === 'App' ? 'the app (one page)' : m.entry.file };
      plan.pages.set(node.id, node);
      return { node, entry: m.entry, possible: m.possible };
    };
    const mocks = leaves.some((l) => l.step.kind === 'mock');
    const firstGoto = leaves.find((l) => l.step.kind === 'goto' && l.step.url);
    const first = firstGoto ? pageNode(firstGoto.step.url!) : undefined;
    const scopeOf = (entry: Entry | undefined): ElementScope | undefined => (entry && unit ? { files: this.closureOf(entry, unit), recent: [] } : undefined);
    let scope = scopeOf(first?.entry);
    // The requests of the run, by the line of the action that sent them.
    const seen = result?.requests ?? [];
    let failedAt = -1;
    if (result?.error?.line !== undefined) {
      const errFile = result.error.file;
      failedAt = leaves.findIndex((l) => l.step.line === result.error!.line && (!errFile || errFile.endsWith(l.step.file)));
    }
    leaves.forEach(({ step, groups }, i) => {
      const targets: StepTarget[] = [];
      const edges: string[] = [];
      const notes: string[] = [];
      if (step.fromFixture) notes.push('from the fixture');
      const how: AreaHow = step.kind === 'assert' ? 'asserted' : step.action && FILLS.has(step.action) ? 'filled' : 'clicked';
      const addEndpoint = (e: Endpoint, opts: { possible?: boolean; mock?: boolean; seen?: boolean; via?: Endpoint; notRun?: boolean; from?: string; method?: string }) => {
        plan.endpoints.set(endpointId(e), e);
        if (opts.notRun) plan.notRun.add(endpointId(e));
        const kind: AreaHow = opts.seen ? 'seen' : opts.mock ? 'mocked' : opts.notRun ? 'notRun' : 'code';
        areas.endpoint(this.atlas, e, kind, endpointId(e));
        if (targets.some((t) => t.node === endpointId(e))) return;
        targets.push({ node: endpointId(e), kind: 'endpoint', label: endpointLabel(e), ...(opts.possible ? { possible: true } : {}), ...(opts.mock ? { mock: true } : {}), ...(opts.seen ? { seen: true } : {}), ...(opts.notRun ? { notRun: true } : {}) });
        // The Next.js API route calls the endpoint of the backend: the edge goes from the route (see caseView).
        if (opts.via) {
          edges.push(`case:${endpointId(opts.via)}>${endpointId(e)}`);
          return;
        }
        const fromId = opts.from ?? (page ?? first)?.node.id;
        if (!fromId) return;
        const eid = `case:${fromId}>${endpointId(e)}`;
        const sm = opts.method ?? step.method;
        const m = sm && sm !== '*' ? sm : e.method === 'ANY' ? '' : e.method;
        const label = `${m ? `${m} ` : ''}${endpointLabel({ ...e, method: 'ANY' })}`;
        const have = plan.edges.get(eid);
        if (!have) plan.edges.set(eid, { id: eid, from: fromId, to: endpointId(e), kind: 'http', label, ...(opts.possible ? { possible: true } : {}) });
        else if (!opts.possible) delete have.possible;
        edges.push(eid);
      };
      /** A request to the endpoints of a path: a mocked route answers it, so the backend behind it does not run. */
      const addRequest = (method: string, url: string, opts: { mock?: boolean; possible?: boolean; from?: string; keep?: (e: Endpoint, via?: Endpoint) => boolean }): number => {
        if (!unit) return 0;
        const list = this.endpointsOf(unit, method, url).filter(({ endpoint, via }) => !opts.keep || opts.keep(endpoint, via));
        for (const { endpoint, possible, via } of list) {
          const isMock = opts.mock ?? mocked.has(endpointId(endpoint));
          if (via) {
            const routeMocked = opts.mock ?? mocked.has(endpointId(via));
            addEndpoint(endpoint, { possible: true, via, ...(routeMocked ? { notRun: true } : {}) });
          } else addEndpoint(endpoint, { possible: possible || opts.possible === true, ...(isMock ? { mock: true } : {}), ...(opts.from ? { from: opts.from } : {}), ...(method !== '*' ? { method } : {}) });
        }
        return list.length;
      };
      if ((step.kind === 'goto' || (step.kind === 'assert' && step.url)) && step.url) {
        const p = pageNode(step.url);
        if (p) {
          if (step.kind === 'goto' || p.entry.id !== page?.entry.id) scope = scopeOf(p.entry);
          page = p;
          targets.push({ node: p.node.id, kind: 'page', label: p.entry.name, ...(p.possible ? { possible: true } : {}) });
          areas.page(this.atlas, unit!, p.entry, p.node, step.kind === 'goto' ? 'visited' : 'asserted');
          // No mock in the case: the real server answers the page. The reads (GET) that the code of the
          // page calls are areas of the case (possible: the case may not use each one). The writes come
          // from the clicks (see the handlers below).
          if (step.kind === 'goto' && !mocks) for (const l of this.atlas.pageLinks(p.entry.id, unit!).filter((x) => !x.possible && !x.via && (x.endpoint.method === 'GET' || x.endpoint.method === 'ANY')).slice(0, PAGE_CALLS)) addEndpoint(l.endpoint, { possible: true, from: p.node.id });
        } else notes.push('no page found');
      }
      if (step.locator && unit && project) {
        const hits = this.elementsOf(unit, step.locator, scope);
        for (const h of hits) {
          const id = `el:${h.file}:${h.line}`;
          const what = step.locator.by === 'role' ? `${step.locator.value} "${step.locator.name ?? ''}"` : `${step.locator.by} "${step.locator.value}"`;
          const sub = [h.owner?.name, h.handler ? `${h.handler}()` : undefined].filter(Boolean).join(' · ');
          const possible = !h.exact || hits.length > 1;
          if (!plan.elements.has(id)) {
            plan.elements.set(id, {
              id, shape: 'function', label: what, sub: sub || `${h.file}:${h.line}`, group: `fe:${unit}`, tone: project.tone, file: h.file, line: h.line,
              ...(h.owner ? { open: `fn:${h.owner.id}`, openProject: unit, ref: h.owner.id } : {}),
              note: `The element in the JSX of ${h.owner?.name ?? h.file}${h.handler ? `, with the handler ${h.handler}` : ''}.${possible ? ' A possible match: the atlas found it by its text.' : ''}`,
            });
            const host = page ?? first;
            if (host) plan.edges.set(`case:${host.node.id}>${id}`, { id: `case:${host.node.id}>${id}`, from: host.node.id, to: id, kind: 'uses' });
          }
          targets.push({ node: id, kind: 'element', label: sub ? `${what} · ${sub}` : what, ...(possible ? { possible: true } : {}) });
          if (h.owner) {
            const o = this.atlas.map.code.get(h.owner.id)?.node;
            areas.add('component', h.owner.id, h.owner.name, how, { sub: h.file, file: h.file, ...(o?.range ? { line: firstLine(o.range) } : {}), node: id, refs: [`fn:${h.owner.id}`, h.owner.id], project: unit });
          }
        }
        if (hits.length > 0 && scope) scope = { ...scope, recent: [...new Set([hits[0]!.file, ...scope.recent])].slice(0, 6) };
        if (hits.length === 0 && step.kind === 'action') notes.push(scope ? 'no element found in the code of the page' : 'no element found');
        // The handler of the element: the endpoints that its code calls (page → element → endpoint).
        const h = hits.find((x) => x.handler);
        if (h && step.kind === 'action' && step.action && CLICKS.has(step.action)) {
          const name = h.handler!.split('.').at(-1)!;
          const fn = this.atlas.functionNamed(h.file, name, h.line);
          const el = `el:${h.file}:${h.line}`;
          areas.add('handler', fn?.id ?? `handler:${h.file}:${name}`, `${name}()`, 'clicked', {
            sub: fn ? `${fn.file}` : `${h.file} (no function: a state setter or a prop)`, file: fn?.file ?? h.file, line: fn?.range ? firstLine(fn.range) : h.line, node: el,
            refs: fn ? [`fn:${fn.id}`, fn.id] : [], project: unit,
          });
          if (fn) {
            for (const l of this.atlas.pageLinks(fn.id, unit).slice(0, 6)) {
              if (l.via) {
                const routeMocked = mocked.has(endpointId(l.via));
                addEndpoint(l.via, { from: el, ...(routeMocked ? { mock: true } : { possible: true }) });
                addEndpoint(l.endpoint, { possible: true, via: l.via, ...(routeMocked ? { notRun: true } : {}) });
              } else addEndpoint(l.endpoint, { from: el, ...(mocked.has(endpointId(l.endpoint)) ? { mock: true } : { possible: true }) });
            }
          }
        }
      }
      let unused = false;
      if ((step.kind === 'mock' || step.kind === 'request') && step.url && unit) {
        // A fixture mock: keep the routes that the page calls; the others go to one "also mocks" line.
        const keep = step.kind === 'mock' && step.fromFixture
          ? (e: Endpoint, via?: Endpoint) => used.has(endpointId(via ?? e))
          : undefined;
        if (keep) {
          const all = methodsOf(step).flatMap((m) => this.endpointsOf(unit, m, step.url!));
          if (!all.some(({ endpoint, via }) => keep(endpoint, via))) {
            unused = true;
            const fixture = groups.findLast((g) => g.startsWith('fixture '))?.slice('fixture '.length) ?? 'fixture';
            const list = extra.get(fixture) ?? [];
            const m = methodsOf(step).filter((x) => x !== '*').join('|');
            const route = `${m ? `${m} ` : ''}${step.url}`;
            if (!list.includes(route)) list.push(route);
            extra.set(fixture, list);
            notes.push('the page does not call this route');
          }
        }
        if (!unused) {
          let n = 0;
          for (const m of methodsOf(step)) n += addRequest(m, step.url, { mock: step.kind === 'mock', ...(keep ? { keep } : {}) });
          if (n === 0) notes.push('no endpoint found');
        }
      }
      // expect(invoiceApi.created()): the record of a fixture mock. It checks the requests to that mock.
      if (step.kind === 'assert' && step.api && unit) {
        if (addRequest(step.api.method, step.api.url, { mock: true }) > 0) notes.push(`checks the requests to the mock ${step.api.method === '*' ? '' : `${step.api.method} `}${step.api.url}`);
      }
      // The run wins over the guess: the requests that the actions of this line sent.
      const mine = seen.filter((r) => r.line === step.line && r.file !== undefined && (r.file === step.file || r.file.endsWith(`/${step.file}`)));
      if (mine.length > 0 && unit) {
        const hitEps: Endpoint[] = [];
        for (const r of mine) {
          let path: string;
          try {
            path = new URL(r.url).pathname;
          } catch {
            continue;
          }
          for (const { endpoint, via } of this.endpointsOf(unit, r.method, path)) if (!via && !hitEps.includes(endpoint)) hitEps.push(endpoint);
        }
        if (hitEps.length > 0) {
          if (step.kind === 'request') {
            for (let k = targets.length - 1; k >= 0; k--) if (targets[k]!.kind === 'endpoint' && !hitEps.some((e) => endpointId(e) === targets[k]!.node)) targets.splice(k, 1);
          }
          for (const e of hitEps) {
            const t = targets.find((x) => x.node === endpointId(e));
            areas.endpoint(this.atlas, e, 'seen', endpointId(e));
            if (t) {
              t.seen = true;
              delete t.possible;
            } else addEndpoint(e, { seen: true });
          }
          notes.push('seen in the run');
        }
      }
      if (step.kind === 'assert') plan.checks.push(checkText(step));
      const ps: PlayStep = { id: step.id, kind: step.kind, text: step.text, file: step.file, line: step.line, groups, targets, edges: [...new Set(edges)], notes, ...(unused ? { unused: true } : {}) };
      if (result) {
        if (result.status === 'passed' || result.status === 'flaky') ps.passed = true;
        else if (failedAt >= 0) {
          if (i < failedAt) ps.passed = true;
          else if (i === failedAt) ps.failed = true;
        }
      }
      plan.steps.push(ps);
    });
    // The code behind each backend endpoint, from the static reach: not run if the endpoint is mocked.
    for (const e of plan.endpoints.values()) {
      if (this.atlas.projects.get(e.unit)?.kind === 'frontend') continue;
      // The handler of the route: its function, else the function around the route line (a `handle(method, path)` switch).
      const around = (this.atlas.index.nodesOfFile.get(e.file) ?? []).filter((n) => (n.kind === 'function' || n.kind === 'method') && n.range && firstLine(n.range) <= e.line && Number(n.range.split('-')[1]) >= e.line)
        .sort((a, b) => Number(a.range!.split('-')[1]) - firstLine(a.range) - (Number(b.range!.split('-')[1]) - firstLine(b.range)))[0];
      const root = e.open.startsWith('fn:') ? e.open.slice(3) : around?.id;
      if (!root) continue;
      const item = areas.get(endpointId(e));
      const hows = item ? settle(item.how) : ['code'];
      const behind: AreaHow = hows.some((h) => h === 'seen' || h === 'code') ? 'code' : 'notRun';
      // The words of the path (`invoice` of /v1/invoices/{}) rank a function first, then the code
      // in another file than the router (services, stores), then the order of the reach.
      const words = e.segs.filter((x) => x !== '{}' && !/^v\d+$/.test(x)).flatMap((x) => x.toLowerCase().split(/[-_]/)).map((x) => x.replace(/s$/, '')).filter((x) => x.length > 2);
      const verbs = VERBS[e.method] ?? [];
      const score = (n: { name: string; file?: string }) => (words.some((w) => n.name.toLowerCase().includes(w)) ? 0 : 4) + (verbs.some((v) => n.name.toLowerCase().startsWith(v)) ? 0 : 2) + (n.file === e.file ? 1 : 0);
      const fns = [...this.atlas.reach(root, e.unit)].filter((x) => x !== root).map((x) => this.atlas.map.code.get(x)?.node).filter((n): n is NonNullable<typeof n> => !!n && (n.kind === 'function' || n.kind === 'method') && !ERROR_FILE.test(n.file ?? ''))
        .map((n, i) => ({ n, i })).sort((a, b) => score(a.n) - score(b.n) || a.i - b.i).map((x) => x.n)
        // One function serves all the methods (a switch): keep the functions with the verb of this method.
        .filter((n) => e.open.startsWith('fn:') || verbs.some((v) => n.name.toLowerCase().startsWith(v)))
        .slice(0, BACKEND_FNS);
      for (const n of fns) areas.add('backend', n.id, n.name, behind, { sub: `${this.atlas.nameOf(e.unit)} · behind ${endpointLabel(e)}`, ...(n.file ? { file: n.file } : {}), ...(n.range ? { line: firstLine(n.range) } : {}), node: endpointId(e), refs: [`fn:${n.id}`, n.id], project: e.unit });
      for (const sid of this.atlas.storeLinks.get(e.unit)?.keys() ?? []) {
        const st = this.atlas.stores.find((x) => x.id === sid);
        if (st) areas.add('backend', sid, st.name, behind, { sub: `data store · ${this.atlas.nameOf(e.unit)}`, ...(st.file ? { file: st.file } : {}), node: sid, refs: [sid], project: e.unit });
      }
    }
    plan.areas = areas.list();
    plan.fixtureExtra = [...extra].map(([fixture, routes]) => ({ fixture, routes }));
    this.plans.set(id, plan);
    return plan;
  }

  // ---------------------------------------------------------------- the API

  async info(): Promise<TestsInfo> {
    const all = await this.cases();
    const results = this.lastResults();
    // A setup file with no cases (auth.setup.ts) is not a spec of the list.
    const setups = this.specs.specs.filter((s) => s.setup && (all.get(s.file) ?? []).length === 0);
    const specs = this.specs.specs.filter((s) => !setups.includes(s)).map((s) => {
      const unit = this.unitOf(s);
      return {
        file: s.file, runner: s.runner, ...(unit ? { project: unit, projectName: this.atlas.nameOf(unit) } : {}), ...(s.tag ? { tag: s.tag } : {}),
        cases: (all.get(s.file) ?? []).map((c) => {
          const r = results?.byCase.get(c.id);
          return { id: c.id, title: c.title, path: c.path, line: c.line, ...(c.skip ? { skip: true } : {}), ...(c.tags ? { tags: c.tags } : {}), steps: countLeaves(c.steps), ...(r ? { result: { status: r.status, duration: r.duration } } : {}) };
        }),
      };
    });
    const notes: string[] = [];
    if (specs.length === 0) notes.push('The repo has no e2e spec files (no Playwright config with specs, and no Cypress specs).');
    if (setups.length > 0) notes.push(`${setups.length} setup file${setups.length === 1 ? ' is' : 's are'} not in the list (${setups.map((s) => s.file.split('/').pop()).filter((v, i, a) => a.indexOf(v) === i).join(', ')}): Playwright runs ${setups.length === 1 ? 'it' : 'them'} before the specs.`);
    return { ok: true, specs, ...(results ? { results: results.from } : {}), notes };
  }

  async caseInfo(id: string): Promise<CaseInfo> {
    const plan = await this.plan(id);
    if (!plan) return { ok: false, id, title: id, path: [], file: '', line: 0, steps: [], notes: [`No case ${id}.`] };
    const notes: string[] = [];
    if (!plan.unit) notes.push('The atlas found no frontend for this spec: the steps have no pages or elements.');
    if (plan.test.skip) notes.push('The case is skipped (test.skip or test.fixme).');
    return {
      ok: true, id, title: plan.test.title, path: plan.test.path, file: plan.test.file, line: plan.test.line,
      ...(plan.unit ? { project: plan.unit, projectName: this.atlas.nameOf(plan.unit) } : {}),
      steps: plan.steps, ...(plan.result ? { result: plan.result } : {}), notes, areas: plan.areas, checks: plan.checks, ...(plan.fixtureExtra.length > 0 ? { fixtureExtra: plan.fixtureExtra } : {}),
    };
  }

  /** The case view: the case and the touched parts of the map, in the System lanes. */
  async caseView(id: string): Promise<AtlasView> {
    const plan = await this.plan(id);
    if (!plan) return { ok: false, level: 'system', id: `case:${id}`, title: id, groups: [], nodes: [], edges: [], notes: [`No case ${id}.`] };
    const groups: ViewGroup[] = [{ id: 'case', label: 'Test case', icon: 'test', tone: 6, lane: 0 }];
    const nodes: ViewNode[] = [{
      id: `flow:${id}`, shape: 'feature', label: plan.test.title, sub: `${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'} · ${plan.test.file}:${plan.test.line}`,
      group: 'case', tone: 6, open: `caseflow:${id}`, file: plan.test.file, line: plan.test.line,
    }];
    if (plan.unit && (plan.pages.size > 0 || plan.elements.size > 0)) {
      const p = this.atlas.projects.get(plan.unit)!;
      groups.push({ id: `fe:${plan.unit}`, label: `${this.atlas.nameOf(plan.unit)}`, icon: 'page', tone: p.tone, lane: 1, noun: ['part', 'parts'] });
      nodes.push(...plan.pages.values(), ...plan.elements.values());
    }
    const byUnit = new Map<string, Endpoint[]>();
    for (const e of plan.endpoints.values()) byUnit.set(e.unit, [...(byUnit.get(e.unit) ?? []), e]);
    const stores = new Set<string>();
    for (const [u, list] of [...byUnit].sort(([a], [b]) => cmp(a, b))) {
      const p = this.atlas.projects.get(u)!;
      // The own Next.js API routes of the frontend sit in the APIs lane too: a request goes to them.
      groups.push({ id: `api:${u}`, label: `${this.atlas.nameOf(u)}${p.kind === 'frontend' ? ' (API routes)' : ''}`, icon: 'api', tone: p.tone, lane: 2, noun: ['endpoint', 'endpoints'] });
      for (const e of list.sort((a, b) => cmp(a.key, b.key))) nodes.push({ ...this.atlas.endpointNode(e, `api:${u}`), sub: isNextApiRoute(e.file) ? 'Next.js API route' : this.atlas.nameOf(u) });
      for (const s of this.atlas.storeLinks.get(u)?.keys() ?? []) stores.add(s);
    }
    const edges = [...plan.edges.values()];
    // A Next.js API route that calls another project: an edge to the endpoint of that project.
    for (const e of plan.endpoints.values()) {
      if (!isNextApiRoute(e.file)) continue;
      for (const b of this.atlas.backendOf(e)) {
        if (plan.endpoints.has(endpointId(b))) edges.push({ id: `case:${endpointId(e)}>${endpointId(b)}`, from: endpointId(e), to: endpointId(b), kind: 'http', ...(plan.notRun.has(endpointId(b)) ? { possible: true, label: 'not run: mocked', title: 'The case mocks the route, so this endpoint does not run.' } : {}) });
      }
    }
    if (stores.size > 0) {
      groups.push({ id: 'stores', label: 'Data stores', icon: 'store', tone: 5, lane: 3, noun: ['store', 'stores'] });
      for (const s of this.atlas.stores.filter((x) => stores.has(x.id))) {
        nodes.push({ id: s.id, shape: 'store', label: s.name, sub: s.image ?? s.kind, group: 'stores', file: s.file });
        for (const u of byUnit.keys()) {
          const deps = this.atlas.storeLinks.get(u)?.get(s.id);
          const firstEp = byUnit.get(u)![0]!;
          if (deps) edges.push({ id: `case:store:${u}>${s.id}`, from: endpointId(firstEp), to: s.id, kind: 'uses', label: deps.join(', '), title: `${this.atlas.nameOf(u)} uses ${s.name}.` });
        }
      }
    }
    const notes: string[] = [];
    if (!plan.unit) notes.push('The atlas found no frontend for this spec.');
    return { ok: true, level: 'system', id: `case:${id}`, title: plan.test.title, file: plan.test.file, line: plan.test.line, groups, nodes, edges, notes };
  }

  /** The flow chart of a case: start, each leaf step, end; a box for each group of steps. */
  async flowView(id: string): Promise<AtlasView> {
    const plan = await this.plan(id);
    if (!plan) return { ok: false, level: 'flow', id: `caseflow:${id}`, title: id, groups: [], nodes: [], edges: [], notes: [`No case ${id}.`] };
    const groups: ViewGroup[] = [];
    const nodes: ViewNode[] = [{ id: 'start', shape: 'start', label: plan.test.title, sub: plan.test.path.join(' › ') || undefined }];
    const groupIds = new Map<string, string>();
    // The setup of a fixture is one group that starts collapsed: "setup: fixture invoiceApi (3 mocks used, 9 more)".
    const fixtureOf = (s: PlayStep) => (s.groups[0]?.startsWith('fixture ') ? s.id.split('.')[0]! : undefined);
    for (const s of plan.steps) {
      let group: string | undefined;
      if (s.groups.length > 0) {
        const fx = fixtureOf(s);
        const key = fx ?? `${s.id.split('.').slice(0, s.groups.length).join('.')}`;
        group = groupIds.get(key);
        if (!group) {
          group = `grp:${key}`;
          groupIds.set(key, group);
          if (fx) {
            const mine = plan.steps.filter((x) => fixtureOf(x) === fx);
            const mocks = mine.filter((x) => x.kind === 'mock');
            const usedN = mocks.filter((x) => !x.unused).length;
            const more = mocks.length - usedN;
            const count = mocks.length === 0 ? '' : ` (${usedN} mock${usedN === 1 ? '' : 's'} used${more > 0 ? `, ${more} more` : ''})`;
            groups.push({ id: group, label: `setup: ${s.groups[0]}${count}`, icon: 'folder', tone: 6, fold: true, noun: ['step', 'steps'] });
          } else groups.push({ id: group, label: s.groups.join(' › '), icon: 'folder', tone: 6 });
        }
      }
      const shape = s.kind === 'goto' ? 'call' : s.kind === 'assert' ? 'decision' : s.kind === 'mock' || s.kind === 'request' ? 'cross' : 'step';
      const target = s.targets.find((t) => t.kind === 'endpoint');
      const m = s.kind === 'mock' || s.kind === 'request' ? findStep(plan.test.steps, s.id)?.method : undefined;
      const method = m && m !== '*' ? m : undefined;
      nodes.push({
        id: `step:${s.id}`, shape, label: s.text, sub: `${s.kind} · ${s.file}:${s.line}`, file: s.file, line: s.line,
        ...(group ? { group } : {}),
        ...(method ? { method } : {}),
        ...(target ? { target: [`api:${plan.endpoints.get(target.node)?.unit ?? ''}`, target.node] } : {}),
        ...(s.notes.length > 0 ? { note: s.notes.join(' · ') } : {}),
        ...(s.unused ? { sub: `not used · ${s.file}:${s.line}` } : {}),
        detail: s.targets.map((t) => `→ ${t.kind} ${t.label}${t.possible ? ' (possible)' : ''}${t.mock ? ' (mock)' : ''}${t.seen ? ' (seen in the run)' : ''}`),
      });
    }
    nodes.push({ id: 'end', shape: 'end', label: plan.result ? plan.result.status : 'end' });
    const ids = nodes.map((n) => n.id);
    const edges: ViewEdge[] = ids.slice(1).map((to, i) => ({ id: `f:${ids[i]}>${to}`, from: ids[i]!, to, kind: 'flow' as const }));
    return { ok: true, level: 'flow', id: `caseflow:${id}`, title: plan.test.title, file: plan.test.file, line: plan.test.line, groups, nodes, edges, notes: [] };
  }

  private coverageCache: Promise<Coverage> | undefined;

  /**
   * The cases that touch each part of the map (pages, endpoints, components, handlers), by the node IDs
   * of the System and Features views, with how; a short line for each case; and "Coverage by area".
   */
  coverage(): Promise<Coverage> {
    // One computation: the server starts it at once, and a request while it runs waits for it.
    return (this.coverageCache ??= this.makeCoverage().catch((err: unknown) => {
      this.coverageCache = undefined;
      throw err;
    }));
  }

  private async makeCoverage(): Promise<Coverage> {
    const nodes: Record<string, string[]> = {};
    const touches: Record<string, CaseTouch[]> = {};
    const titles: Record<string, string> = {};
    const summaries: Record<string, string> = {};
    const caseAreas: Record<string, string[]> = {};
    const status: Coverage['status'] = {};
    const where: Coverage['where'] = {};
    for (const [file, list] of await this.cases()) {
      for (const c of list) {
        titles[c.id] = c.title;
        where[c.id] = { file, path: c.path };
        const plan = await this.plan(c.id);
        if (!plan) continue;
        if (plan.result) status[c.id] = plan.result.status;
        for (const a of plan.areas) {
          for (const r of a.refs) {
            const l = (touches[r] ??= []);
            const have = l.find((t) => t.case === c.id);
            if (have) for (const h of a.how) !have.how.includes(h) && have.how.push(h);
            else l.push({ case: c.id, how: [...a.how] });
            if (a.layer === 'page' || a.layer === 'route' || a.layer === 'endpoint') {
              const n = (nodes[r] ??= []);
              if (!n.includes(c.id)) n.push(c.id);
            }
          }
        }
        summaries[c.id] = summaryOf(plan.areas);
        caseAreas[c.id] = plan.areas.filter((a) => a.layer === 'feature').map((a) => a.key);
      }
    }
    const areas: AreaRow[] = [];
    for (const fe of this.atlas.featureData()) {
      for (const f of fe.features) {
        const id = `feature:${fe.unit}:${f.slug}`;
        const cases = Object.keys(caseAreas).filter((k) => caseAreas[k]!.includes(id));
        const tested = f.pages.filter((pg) => (touches[`fn:${pg.entry.id}`] ?? touches[pg.entry.id] ?? []).length > 0).length;
        const eps = new Set<string>();
        for (const pg of f.pages) for (const l of pg.links) {
          eps.add(endpointId(l.endpoint));
          if (l.via) eps.add(endpointId(l.via));
        }
        const ep = { real: 0, mocked: 0, none: 0 };
        for (const e of eps) {
          const t = touches[e] ?? [];
          if (t.length === 0) ep.none++;
          else if (t.some((x) => x.how.some((h) => h !== 'mocked' && h !== 'notRun'))) ep.real++;
          else ep.mocked++;
        }
        areas.push({ id, label: f.label, project: this.atlas.nameOf(fe.unit), cases, pages: { tested, all: f.pages.length }, endpoints: ep });
      }
    }
    areas.sort((a, b) => b.cases.length - a.cases.length || cmp(a.label, b.label));
    return { ok: true, nodes, touches, titles, summaries, caseAreas, status, where, areas };
  }

  /** The cases whose title or describe fits the words. */
  async search(words: string, limit = 10): Promise<SearchHit[]> {
    const q = words.trim().toLowerCase();
    if (q === '') return [];
    const hits: SearchHit[] = [];
    for (const [file, list] of await this.cases()) {
      for (const c of list) {
        if (hits.length >= limit) return hits;
        if (![c.title, ...c.path].some((t) => t.toLowerCase().includes(q))) continue;
        hits.push({ label: c.title, sub: `test case · ${file}:${c.line}`, path: [], case: c.id });
      }
    }
    return hits;
  }

  /** The view of a Tests ID, or undefined for another ID. */
  async view(id: string): Promise<AtlasView | undefined> {
    if (id.startsWith('case:')) return this.caseView(id.slice('case:'.length));
    if (id.startsWith('caseflow:')) return this.flowView(id.slice('caseflow:'.length));
    return undefined;
  }
}

function countLeaves(steps: CaseStep[]): number {
  return steps.reduce((n, s) => n + (s.kind === 'group' ? countLeaves(s.steps ?? []) : 1), 0);
}

function findStep(steps: CaseStep[], id: string): CaseStep | undefined {
  for (const s of steps) {
    if (s.id === id) return s;
    const hit = findStep(s.steps ?? [], id);
    if (hit) return hit;
  }
  return undefined;
}

/** Does the tag before a text fit an ARIA role? A line with no tag fits. */
function roleFits(role: string, back: string): boolean {
  const tag = [...back.matchAll(/<([A-Za-z][\w.]*)/g)].at(-1)?.[1];
  if (!tag) return true;
  const roleAttr = /\brole\s*=\s*["']([\w-]+)["']/.exec(back)?.[1];
  if (roleAttr) return roleAttr === role;
  const t = tag.toLowerCase();
  switch (role) {
    case 'button':
      return t === 'button' || /button|btn/.test(t) || (t === 'input' && /type\s*=\s*["'](?:submit|button|reset)/.test(back));
    case 'link':
      return t === 'a' || /link/.test(t);
    case 'heading':
      return /^h[1-6]$/.test(t) || /heading|title/.test(t);
    case 'textbox':
      return t === 'input' || t === 'textarea' || /input|field|text/.test(t);
    case 'checkbox':
    case 'radio':
      return t === 'input' || t.includes(role);
    case 'list':
      return t === 'ul' || t === 'ol';
    case 'listitem':
      return t === 'li';
    case 'option':
      return t === 'option' || t.includes('option');
    case 'tab':
      return t.includes('tab');
    case 'cell':
    case 'row':
      return t === 'td' || t === 'tr' || t.includes(role);
    default:
      return true;
  }
}

export const isTestsView = (id: string) => id.startsWith('case:') || id.startsWith('caseflow:');

/**
 * The ways that stay on an item: a real touch (a step, a mock, the run) hides "reached by code only";
 * the run, or code that runs for real (another endpoint), hides "not run".
 */
export function settle(how: readonly AreaHow[]): AreaHow[] {
  let out = [...new Set(how)];
  if (out.some((h) => h !== 'code' && h !== 'notRun')) out = out.filter((h) => h !== 'code');
  if (out.includes('seen') || out.includes('code')) out = out.filter((h) => h !== 'notRun');
  return out.sort((a, b) => HOW_ORDER.indexOf(a) - HOW_ORDER.indexOf(b));
}

/** The areas of one case, by key: each item keeps all the ways the case touches it. */
class Areas {
  private readonly items = new Map<string, AreaItem>();

  get(key: string): AreaItem | undefined {
    return this.items.get(key);
  }

  add(layer: AreaLayer, key: string, label: string, how: AreaHow, more: Partial<AreaItem> & { refs: string[] }): void {
    const have = this.items.get(key);
    if (have) {
      if (!have.how.includes(how)) have.how.push(how);
      return;
    }
    this.items.set(key, { layer, key, label, how: [how], ...more });
  }

  page(atlas: Atlas, unit: string, entry: Entry, node: ViewNode, how: AreaHow): void {
    const f = atlas.featureOf(unit, entry.id);
    if (f) this.add('feature', f.id, f.label, how, { sub: atlas.nameOf(unit), node: node.id, refs: [f.id], project: unit });
    this.add('page', node.id, entry.name, how, { sub: entry.file, file: entry.file, line: firstLine(entry.range), node: node.id, refs: [node.id], project: unit });
  }

  endpoint(atlas: Atlas, e: Endpoint, how: AreaHow, node: string): void {
    const route = atlas.projects.get(e.unit)?.kind === 'frontend';
    this.add(route ? 'route' : 'endpoint', node, endpointLabel(e), how, { sub: `${atlas.nameOf(e.unit)}${route ? ` · ${e.file}` : ''}`, file: e.file, line: e.line, node, refs: [node], project: e.unit });
    // A mocked backend endpoint does not run: the mock answers in its place.
    if (!route && how === 'mocked') this.add('endpoint', node, endpointLabel(e), 'notRun', { refs: [node] });
  }

  list(): AreaItem[] {
    const out = [...this.items.values()];
    for (const it of out) {
      it.how = settle(it.how);
    }
    return out.sort((a, b) => LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer));
  }
}

/** The text of the subject of an assert: the locator, else the source. */
function subjectOf(s: CaseStep): string {
  const l = s.locator;
  if (l) {
    if (l.by === 'role') return l.name !== undefined ? `the ${l.value} "${l.name}"` : `the ${l.value}`;
    if (l.by === 'text') return `the text "${l.value}"`;
    if (l.by === 'css') return `"${l.value}"`;
    return `the element with ${l.by} "${l.value}"`;
  }
  const m = /^expect (.+?) (?:not )?\w+(?: ".*")?$/.exec(s.text);
  return m?.[1] ?? 'the value';
}

/** An assert in short words, from its matcher and its locator: no guess. */
export function checkText(s: CaseStep): string {
  if (!s.matcher) {
    if (s.url !== undefined) return `the URL becomes ${s.url}`;
    return s.text;
  }
  const not = s.matcher.startsWith('not ');
  const m = not ? s.matcher.slice(4) : s.matcher;
  const who = subjectOf(s);
  const v = s.value;
  const q = v !== undefined ? `"${v}"` : '';
  const api = s.api ? ` (the ${s.api.method === '*' ? '' : `${s.api.method} `}${s.api.url} mock)` : '';
  switch (m) {
    case 'toBeVisible':
      return `${who} ${not ? 'does not show' : 'shows'}`;
    case 'toBeHidden':
      return `${who} ${not ? 'shows' : 'is hidden'}`;
    case 'toHaveURL':
      return `the URL ${not ? 'is not' : 'is'} ${s.url ?? v ?? '…'}`;
    case 'toHaveTitle':
      return `the page title ${not ? 'is not' : 'is'} ${q}`;
    case 'toContainText':
      return `${who} ${not ? 'does not contain' : 'contains'} ${q}`;
    case 'toHaveText':
      return `${who} ${not ? 'does not have' : 'has'} the text ${q}`;
    case 'toHaveValue':
      return `${who} ${not ? 'does not have' : 'has'} the value ${q}`;
    case 'toHaveCount':
      return `there ${not ? 'are not' : 'are'} ${v ?? 'N'} of ${who}`;
    case 'toHaveLength':
      return `${who} ${not ? 'does not have' : 'has'} length ${v ?? 'N'}${api}`;
    case 'toBeEnabled':
    case 'toBeDisabled':
    case 'toBeChecked':
    case 'toBeEditable':
    case 'toBeFocused':
    case 'toBeEmpty':
    case 'toBeAttached':
      return `${who} is ${not ? 'not ' : ''}${m.slice(4).toLowerCase()}`;
    case 'toBe':
    case 'toEqual':
    case 'toStrictEqual':
      return `${who} ${not ? 'is not' : 'is'} ${v !== undefined ? q : 'the expected value'}${api}`;
    case 'ok':
      return `${who} is true${api}`;
    default:
      return `${who} ${not ? 'not ' : ''}${m}${v !== undefined ? ` ${q}` : ''}${api}`;
  }
}

/** A short line of the areas of a case: "1 feature · 2 pages · 5 components · 3 endpoints". */
export function summaryOf(areas: AreaItem[]): string {
  const n = (f: (a: AreaItem) => boolean) => areas.filter(f).length;
  const part = (k: number, one: string, many: string) => (k > 0 ? `${k} ${k === 1 ? one : many}` : undefined);
  return [
    part(n((a) => a.layer === 'feature'), 'feature', 'features'),
    part(n((a) => a.layer === 'page'), 'page', 'pages'),
    part(n((a) => a.layer === 'component'), 'component', 'components'),
    part(n((a) => a.layer === 'route' || a.layer === 'endpoint'), 'endpoint', 'endpoints'),
  ].filter(Boolean).join(' · ') || 'no area found';
}
