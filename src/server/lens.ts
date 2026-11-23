// The search lens (round 8): a query redraws the map with only the parts that fit it. No LLM, no
// embeddings, no network: the words of the query against the names in the CodeGraph index, and the
// links that the atlas already knows (page → endpoint, route → backend, function → page).
//
//   1. parseQuery: the free words (after the aliases of the config) and the chips: project:, kind:,
//      method:, path:, depth:, up:, down:, impact:"…", untested.
//   2. The items: pages, endpoints, Next.js API routes, functions, types, data stores, test cases.
//   3. The rank (facts only): more words ranks higher; a page, endpoint or route ranks above a function,
//      a function above a type; a word in the route path is strong; a verb fits a method (create → POST);
//      a node with many users that fits few words goes down; a test, mock or fixture file goes down
//      (not with kind:test).
//   4. The lift: from each seed, along the links, `depth` steps up (to the callers: function → page) or
//      down (to the callees: page → endpoint → data store). A lifted item gets the score of its seed,
//      less a little for each step.
//   5. The cap: LENS_CAP items; the view says how many more there are.
//
// The view is a System-level view (lanes: Frontends → APIs → Functions → Data stores → Tests). Its
// `lens` field has the chips, the time, the count left out and why each item is there.

import { isVirtual, type Entry } from '../index/entries.js';
import { isTestPath } from '../index/projects.js';
import type { DataStore } from './kinds.js';
import { endpointId, endpointLabel, isNextApiRoute, type Atlas, type Endpoint } from './model.js';
import type { TestModel } from './tests.js';
import { LENS_TYPES, type AtlasView, type LensChip, type ViewEdge, type ViewGroup, type ViewNode } from './view.js';

/** The most items in the view. */
export const LENS_CAP = 60;
/** The steps of the lift when the query has no depth:. */
export const DEFAULT_DEPTH = 2;
export const MAX_DEPTH = 5;
/** The steps of the lift of impact:"…" when the query has no depth:. */
const IMPACT_DEPTH = 3;
/** The seeds that lift: the best ones only. */
const LIFT_SEEDS = 30;
/** The most links that one item lifts to. */
const LIFT_FANOUT = 40;
/** The seeds of a free-word lens with no show: (the best ones, cut where the score drops). */
export const CHAIN_SEEDS = 8;
/** A seed of a free-word lens is at most this much below the best one (a little more than one word). */
const CHAIN_DROP = 14;
/** A free-word lens keeps at least this many seeds, so that it is never one box. */
const CHAIN_MIN = 2;
/** The steps of the chain of a seed, each way. */
const CHAIN_STEPS = 4;
/** The most test cases that a free-word lens brings in through the coverage. */
export const CHAIN_CASES = 5;

export type LensKind = 'page' | 'endpoint' | 'route' | 'function' | 'type' | 'store' | 'test';
export const LENS_KINDS: readonly LensKind[] = ['page', 'endpoint', 'route', 'function', 'type', 'store', 'test'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const KEYS = new Set(['project', 'kind', 'method', 'path', 'depth', 'up', 'down', 'impact', 'show']);
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'for', 'in', 'on', 'and', 'or', 'with', 'by', 'at', 'from', 'is', 'are', 'be', 'it', 'this', 'that', 'my', 'all']);

export interface LensQuery {
  /** The free words, lower case, after the aliases. */
  words: string[];
  chips: LensChip[];
  errors: string[];
  projects: string[];
  kinds: Set<LensKind>;
  methods: Set<string>;
  paths: string[];
  depth: number;
  /** A depth: chip (or a number after up:/down:) is in the query. */
  depthSet: boolean;
  dir: 'both' | 'up' | 'down';
  impact?: string;
  untested: boolean;
  /** show:N: the count of seeds of a free-word lens (the "Show more" buttons). */
  show?: number;
  /** The code names of the query (`parseQuery`, `run_lens`), lower case: an exact match is the top seed. */
  names: string[];
}

// ---------------------------------------------------------------- the parser

/** The bonus of an exact code name: above any score of the words. */
const EXACT_BONUS = 40;

const TOKEN = /([A-Za-z]+):"([^"]*)"?|([A-Za-z]+):(\S*)|"([^"]*)"?|(\S+)/g;

/**
 * Read a query: the free words and the chips. A bad chip (an empty value, an unknown kind or method, a
 * bad depth) gives an error and no chip. An unknown `key:` is a free word. A free word that is a key
 * of `aliases` becomes its value (an exact word swap, before the split).
 */
export function parseQuery(text: string, aliases: Readonly<Record<string, string>> = {}): LensQuery {
  const q: LensQuery = { words: [], chips: [], errors: [], projects: [], kinds: new Set(), methods: new Set(), paths: [], depth: DEFAULT_DEPTH, depthSet: false, dir: 'both', untested: false, names: [] };
  const free = (s: string) => {
    for (const raw of s.split(/\s+/).filter(Boolean)) {
      const w = raw.toLowerCase();
      const alias = aliases[w];
      if (alias !== undefined) q.words.push(...alias.toLowerCase().split(/\s+/).filter(Boolean));
      else if (/[a-z0-9][A-Z]|[A-Za-z0-9]_[A-Za-z0-9]/.test(raw)) {
        // A code name: camelCase or snake_case. Its words, and the name for an exact match.
        q.words.push(...segments(raw));
        q.names.push(w);
      } else q.words.push(w);
    }
  };
  const num = (v: string): number | undefined => (/^\d+$/.test(v) && Number(v) <= MAX_DEPTH ? Number(v) : undefined);
  for (const m of text.matchAll(TOKEN)) {
    const raw = m[0];
    const key = (m[1] ?? m[3])?.toLowerCase();
    if (key !== undefined && !KEYS.has(key)) {
      free(raw.replace(/"/g, ' '));
      continue;
    }
    if (key === undefined) {
      const word = m[5] ?? m[6] ?? '';
      if (m[6] !== undefined && word.toLowerCase() === 'untested') {
        q.untested = true;
        q.chips.push({ key: 'untested', value: '', raw });
      } else free(word);
      continue;
    }
    const value = (m[2] ?? m[4] ?? '').trim();
    const chip = () => q.chips.push({ key, value, raw });
    if (value === '' && key !== 'up' && key !== 'down') {
      q.errors.push(`"${key}:" needs a value.`);
      continue;
    }
    switch (key) {
      case 'project':
        q.projects.push(value.toLowerCase());
        chip();
        break;
      case 'kind': {
        const v = value.toLowerCase().replace(/s$/, '');
        const kind = LENS_KINDS.find((k) => k === v);
        if (!kind) q.errors.push(`kind:${value} is not one of ${LENS_KINDS.join(', ')}.`);
        else {
          q.kinds.add(kind);
          chip();
        }
        break;
      }
      case 'method': {
        const v = value.toUpperCase();
        if (!METHODS.includes(v)) q.errors.push(`method:${value} is not one of ${METHODS.join(', ')}.`);
        else {
          q.methods.add(v);
          chip();
        }
        break;
      }
      case 'path':
        q.paths.push(value);
        chip();
        break;
      case 'depth': {
        const n = num(value);
        if (n === undefined) q.errors.push(`depth:${value} is not a number from 0 to ${MAX_DEPTH}.`);
        else {
          q.depth = n;
          q.depthSet = true;
          chip();
        }
        break;
      }
      case 'up':
      case 'down': {
        const n = value === '' ? undefined : num(value);
        if (value !== '' && n === undefined) {
          q.errors.push(`${key}:${value} is not a number from 0 to ${MAX_DEPTH}.`);
          break;
        }
        q.dir = key;
        if (n !== undefined) {
          q.depth = n;
          q.depthSet = true;
        }
        chip();
        break;
      }
      case 'impact':
        q.impact = value;
        chip();
        break;
      case 'show': {
        const n = /^\d+$/.test(value) ? Number(value) : 0;
        if (n < 1 || n > LENS_CAP) q.errors.push(`show:${value} is not a number from 1 to ${LENS_CAP}.`);
        else {
          q.show = n;
          chip();
        }
        break;
      }
    }
  }
  return q;
}

// ---------------------------------------------------------------- words

/** The words of a name: camelCase, snake_case, kebab-case, paths and dots split; lower case. */
export function segments(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** A simple stem, the same for the query and the names: invoices → invoice, closing → clos, create → creat. */
export function stem(w: string): string {
  let s = w;
  if (s.length > 4 && s.endsWith('ies')) s = `${s.slice(0, -3)}y`;
  else if (s.length > 4 && /(ss|x|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss') && !s.endsWith('us')) s = s.slice(0, -1);
  if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
  if (s.length > 3 && s.endsWith('e')) s = s.slice(0, -1);
  return s;
}

const stems = (...texts: Array<string | undefined>): Set<string> => new Set(texts.flatMap((t) => (t ? segments(t).map(stem) : [])));

/** A verb of the query → the HTTP methods that it fits. */
const VERBS = new Map<string, string[]>(
  ([
    [['create', 'add', 'new'], ['POST']],
    [['delete', 'remove'], ['DELETE']],
    [['update', 'edit'], ['PUT', 'PATCH']],
    [['list', 'get', 'show'], ['GET']],
  ] as Array<[string[], string[]]>).flatMap(([ws, ms]) => ws.map((w) => [stem(w), ms] as [string, string[]])),
);

interface Term {
  word: string;
  stem: string;
  methods?: string[];
}

/** The terms of the free words: split, no stop words, stemmed, once each. */
export function termsOf(words: readonly string[]): Term[] {
  const out: Term[] = [];
  for (const w of words) {
    for (const seg of segments(w)) {
      if (STOP.has(seg)) continue;
      const s = stem(seg);
      if (out.some((t) => t.stem === s)) continue;
      const methods = VERBS.get(s);
      out.push({ word: seg, stem: s, ...(methods ? { methods } : {}) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the items

export interface LensItem {
  /** The node ID in the view. */
  id: string;
  kind: LensKind;
  label: string;
  unit?: string;
  file?: string;
  line?: number;
  /** The stems of the name (and of the handler or component name). */
  name: Set<string>;
  /** The stems of the route path (pages, endpoints, routes). */
  path: Set<string>;
  /** The stems of the folders and the file name. */
  folder: Set<string>;
  /** The first word of the name (a verb: createInvoice → creat). */
  first?: string;
  method?: string;
  /** The route path, for path:. */
  route?: string;
  /** The count of users (callers, references). */
  users: number;
  /** In a test, mock or fixture file. */
  testish: boolean;
  entry?: Entry;
  ep?: Endpoint;
  graphId?: string;
  store?: DataStore;
  caseId?: string;
  /** interface, type_alias, enum, constant or class. */
  typeKind?: string;
  /** The class of a method. */
  owner?: string;
}

const TIER: Record<LensKind, number> = { page: 6, endpoint: 6, route: 6, function: 3, store: 3, type: 0, test: 0 };
const MOCKISH = /(^|[/._-])(mocks?|fixtures?|__mocks__|stubs?|fakes?)([/._-]|$)/i;
const folderOf = (file: string | undefined) => (file ? stems(file.replace(/\.[a-z]+$/i, '')) : new Set<string>());
const lineOf = (range: string | undefined) => Number((range ?? '0').split('-')[0]) || 0;

/** The items of the lens and the links between them, made once for an atlas. */
export class LensIndex {
  readonly items: LensItem[] = [];
  readonly byId = new Map<string, LensItem>();
  private pageLinkCache = new Map<string, Array<{ id: string; via?: string }>>();
  private callersOfEndpoint?: Map<string, string[]>;
  private routesOfBackend?: Map<string, string[]>;
  private pagesReaching?: Map<string, string[]>;
  private endpointsReaching?: Map<string, string[]>;
  private directCallers?: Map<string, string[]>;
  private casesOf?: Map<string, string[]>;
  private touchedBy?: Map<string, string[]>;
  /** node → the cases that touch it, and if they use it (not only a mock or "not run"). */
  touchHow = new Map<string, Array<{ case: string; used: boolean }>>();
  touched = new Set<string>();

  private constructor(readonly atlas: Atlas) {}

  static async build(atlas: Atlas, tests?: TestModel): Promise<LensIndex> {
    const ix = new LensIndex(atlas);
    await ix.load(tests);
    return ix;
  }

  private add(item: LensItem): void {
    if (this.byId.has(item.id)) return;
    this.items.push(item);
    this.byId.set(item.id, item);
  }

  /** The project of a file: the project with the longest folder that holds it. */
  unitOfFile(file: string): string | undefined {
    let best: string | undefined;
    let len = -1;
    for (const p of this.atlas.projects.values()) {
      if ((p.dir === '' || file.startsWith(`${p.dir}/`)) && p.dir.length > len) [best, len] = [p.key, p.dir.length];
    }
    return best;
  }

  private async load(tests?: TestModel): Promise<void> {
    const { atlas } = this;
    const taken = new Set<string>();
    for (const p of atlas.projects.values()) {
      if (p.kind !== 'frontend') continue;
      for (const e of atlas.pagesOf(p)) {
        const comp = atlas.map.code.get(e.id)?.node.name;
        const id = e.id.startsWith('route:') || e.id.startsWith('command:') ? e.id : `fn:${e.id}`;
        taken.add(e.id);
        this.add({
          id, kind: 'page', label: e.name, unit: p.key, file: e.file, line: lineOf(e.range), name: stems(e.name, comp), path: stems(e.name), folder: folderOf(e.file),
          route: e.name, users: 0, testish: isTestPath(e.file), entry: e, graphId: e.id,
        });
      }
    }
    for (const ep of atlas.endpoints) {
      const handler = ep.open.startsWith('fn:') ? ep.open.slice(3) : undefined;
      if (handler) taken.add(handler);
      const hname = handler ? atlas.map.code.get(handler)?.node.name : undefined;
      this.add({
        id: endpointId(ep), kind: isNextApiRoute(ep.file) ? 'route' : 'endpoint', label: endpointLabel(ep), unit: ep.unit, file: ep.file, line: ep.line,
        name: stems(ep.path, hname), path: stems(ep.path), folder: folderOf(ep.file), method: ep.method, route: ep.path, users: 0, testish: isTestPath(ep.file), ep,
        // A dispatch block (a virtual entry) is the graph node of its route too: its calls are the handler's.
        ...(handler ? { graphId: handler } : isVirtual(ep.open) ? { graphId: ep.open } : {}),
      });
    }
    // The classes of each file, for the owner of a method.
    const classes = new Map<string, Array<{ name: string; from: number; to: number }>>();
    for (const c of atlas.map.code.values()) {
      const n = c.node;
      if (n.kind !== 'class' || !n.file || !n.range) continue;
      const [from, to] = n.range.split('-').map(Number);
      classes.set(n.file, [...(classes.get(n.file) ?? []), { name: n.name, from: from ?? 0, to: to ?? from ?? 0 }]);
    }
    for (const c of atlas.map.code.values()) {
      const n = c.node;
      if (taken.has(n.id) || !atlas.projects.has(c.unit) || n.targetOnly || !n.file || n.name === '' || n.name.startsWith('<')) continue;
      if (n.kind !== 'function' && n.kind !== 'method' && n.kind !== 'class') continue;
      const cls = n.kind === 'class';
      const line = lineOf(n.range);
      const owner = n.kind === 'method' ? (classes.get(n.file) ?? []).filter((k) => k.from <= line && line <= k.to).sort((a, b) => b.from - a.from)[0]?.name : undefined;
      this.add({
        id: `fn:${n.id}`, kind: cls ? 'type' : 'function', label: n.name, unit: c.unit, file: n.file, line: lineOf(n.range), name: stems(n.name), path: new Set(), folder: folderOf(n.file),
        first: stem(segments(n.name)[0] ?? ''), users: atlas.map.edgesTo(n.id).length, testish: c.test || isTestPath(n.file) || MOCKISH.test(n.file) || /^test_/.test(n.name), graphId: n.id,
        ...(cls ? { typeKind: 'class' } : {}), ...(owner ? { owner } : {}),
      });
    }
    for (const t of atlas.index.typeNodes()) {
      const unit = this.unitOfFile(t.file);
      if (!unit) continue;
      this.add({
        id: t.id, kind: 'type', label: t.name, unit, file: t.file, line: t.line, name: stems(t.name), path: new Set(), folder: folderOf(t.file),
        users: t.refs, testish: isTestPath(t.file) || MOCKISH.test(t.file), typeKind: t.kind.replace('_', ' '),
      });
    }
    for (const s of atlas.stores) {
      this.add({ id: s.id, kind: 'store', label: s.name, file: s.file, name: stems(s.name, s.kind), path: new Set(), folder: new Set(), users: 0, testish: false, store: s });
    }
    if (tests) {
      for (const [file, list] of await tests.cases()) {
        for (const c of list) {
          const unit = this.unitOfFile(file);
          this.add({
            id: `case:${c.id}`, kind: 'test', label: c.title, ...(unit ? { unit } : {}), file, line: c.line, name: stems(c.title, ...c.path), path: new Set(), folder: folderOf(file),
            users: 0, testish: true, caseId: c.id,
          });
        }
      }
      const cov = await tests.coverage();
      const casesOf = new Map<string, string[]>();
      const touchedBy = new Map<string, string[]>();
      for (const [node, cases] of Object.entries(cov.nodes)) {
        casesOf.set(node, cases.map((c) => `case:${c}`));
        for (const c of cases) touchedBy.set(`case:${c}`, [...(touchedBy.get(`case:${c}`) ?? []), node]);
      }
      this.casesOf = casesOf;
      this.touchedBy = touchedBy;
      this.touched = new Set(Object.keys(cov.touches).filter((k) => (cov.touches[k] ?? []).length > 0));
      for (const [k, list] of Object.entries(cov.touches)) {
        // "not run" only (a backend behind a mock) does not count; a mock counts, less than a real use.
        const live = list.filter((t) => t.how.some((h) => h !== 'notRun'));
        if (live.length > 0) this.touchHow.set(k, live.map((t) => ({ case: `case:${t.case}`, used: t.how.some((h) => h !== 'mocked' && h !== 'notRun') })));
      }
    }
  }

  /** A node that a case touches: the "untested" chip drops it. */
  isTouched(item: LensItem): boolean {
    return this.touched.has(item.id) || (item.graphId !== undefined && (this.touched.has(item.graphId) || this.touched.has(`fn:${item.graphId}`)));
  }

  /** The endpoints that a page or a function calls (a route between them as `via`). */
  callsOf(item: LensItem): Array<{ id: string; via?: string }> {
    const hit = this.pageLinkCache.get(item.id);
    if (hit) return hit;
    const out: Array<{ id: string; via?: string }> = [];
    if (item.graphId && item.unit && (item.kind === 'page' || item.kind === 'function')) {
      for (const l of this.atlas.pageLinks(item.graphId, item.unit)) {
        if (l.possible) continue;
        out.push({ id: endpointId(l.endpoint), ...(l.via ? { via: endpointId(l.via) } : {}) });
      }
    }
    this.pageLinkCache.set(item.id, out);
    return out;
  }

  /** endpoint or route → the pages that call it. */
  private callers(): Map<string, string[]> {
    if (this.callersOfEndpoint) return this.callersOfEndpoint;
    const out = new Map<string, string[]>();
    const push = (k: string, v: string) => {
      const l = out.get(k) ?? [];
      if (!l.includes(v)) l.push(v);
      out.set(k, l);
    };
    for (const it of this.items) {
      if (it.kind !== 'page') continue;
      for (const l of this.callsOf(it)) push(l.via ?? l.id, it.id);
    }
    return (this.callersOfEndpoint = out);
  }

  /** backend endpoint → the Next.js API routes that call it. */
  private routes(): Map<string, string[]> {
    if (this.routesOfBackend) return this.routesOfBackend;
    const out = new Map<string, string[]>();
    for (const it of this.items) {
      if (it.kind !== 'route' || !it.ep) continue;
      for (const b of this.atlas.backendOf(it.ep)) out.set(endpointId(b), [...(out.get(endpointId(b)) ?? []), it.id]);
    }
    return (this.routesOfBackend = out);
  }

  /** graph node → the pages whose code reaches it. */
  private pagesOf(): Map<string, string[]> {
    if (this.pagesReaching) return this.pagesReaching;
    const out = new Map<string, string[]>();
    for (const it of this.items) {
      if (it.kind !== 'page' || !it.graphId || !it.unit) continue;
      for (const id of this.atlas.reach(it.graphId, it.unit)) if (id !== it.graphId) out.set(id, [...(out.get(id) ?? []), it.id]);
    }
    return (this.pagesReaching = out);
  }

  /** graph node → the endpoints whose handler reaches it. */
  private servers(): Map<string, string[]> {
    if (this.endpointsReaching) return this.endpointsReaching;
    const out = new Map<string, string[]>();
    for (const it of this.items) {
      if ((it.kind !== 'endpoint' && it.kind !== 'route') || !it.graphId || !it.unit) continue;
      for (const id of this.atlas.reach(it.graphId, it.unit)) if (id !== it.graphId) out.set(id, [...(out.get(id) ?? []), it.id]);
    }
    return (this.endpointsReaching = out);
  }

  /** graph node → the functions of the lens that call it directly. */
  private callersOf(): Map<string, string[]> {
    if (this.directCallers) return this.directCallers;
    const out = new Map<string, string[]>();
    for (const it of this.items) {
      if (it.kind !== 'function' || !it.graphId) continue;
      for (const e of this.atlas.map.edgesFrom(it.graphId)) if (e.to !== it.graphId) out.set(e.to, [...(out.get(e.to) ?? []), it.id]);
    }
    return (this.directCallers = out);
  }

  /**
   * The links of an item, one step: `up` to the callers (function → page, endpoint → page), `down` to
   * the callees (page → endpoint, endpoint → data store). Tests are up from what they touch, only with
   * `tests`.
   */
  links(item: LensItem, dir: 'up' | 'down', tests: boolean): Array<{ id: string; rel: string }> {
    const out: Array<{ id: string; rel: string }> = [];
    const add = (id: string, rel: string) => {
      if (id !== item.id && this.byId.has(id) && !out.some((o) => o.id === id)) out.push({ id, rel });
    };
    const label = item.kind === 'function' ? `${item.label}()` : item.label;
    if (dir === 'down') {
      if (item.kind === 'page' || item.kind === 'function') {
        for (const l of this.callsOf(item)) {
          if (l.via) add(l.via, `${label} calls it`);
          add(l.id, l.via ? `${label} calls it (through ${this.byId.get(l.via)?.label ?? 'a route'})` : `${label} calls it`);
        }
      }
      if (item.kind === 'route' && item.ep) for (const b of this.atlas.backendOf(item.ep)) add(endpointId(b), `the route ${label} calls it`);
      if (item.kind === 'endpoint' && item.unit) for (const s of this.atlas.storeLinks.get(item.unit)?.keys() ?? []) add(s, `the project of ${label} uses it`);
      if (item.kind === 'test') for (const n of this.touchedBy?.get(item.id) ?? []) add(n, `the case "${label}" touches it`);
    } else {
      if (item.kind === 'function' && item.graphId) {
        for (const p of this.pagesOf().get(item.graphId) ?? []) add(p, `its code reaches ${label}`);
        for (const e of this.servers().get(item.graphId) ?? []) add(e, `its handler reaches ${label}`);
        for (const f of this.callersOf().get(item.graphId) ?? []) add(f, `it calls ${label}`);
      }
      if (item.kind === 'endpoint' || item.kind === 'route') {
        for (const r of this.routes().get(item.id) ?? []) add(r, `it calls ${label}`);
        for (const p of this.callers().get(item.id) ?? []) add(p, `it calls ${label}`);
      }
      if (tests && (item.kind === 'page' || item.kind === 'endpoint' || item.kind === 'route')) for (const c of this.casesOf?.get(item.id) ?? []) add(c, `the case touches ${label}`);
    }
    return out.slice(0, LIFT_FANOUT);
  }
}

// ---------------------------------------------------------------- the rank

export interface LensHit {
  item: LensItem;
  score: number;
  why: string[];
  /** A seed (it fits the words), not a lifted item. */
  seed: boolean;
}

const quote = (ws: string[]) => ws.map((w) => `"${w}"`).join(', ');

/** The score of an item for the terms, with why. No hit: no word fits the name or the path. */
export function scoreItem(item: LensItem, terms: readonly Term[], opts: { tests?: boolean } = {}): LensHit | undefined {
  const inName: string[] = [];
  const inPath: string[] = [];
  const inFolder: string[] = [];
  let fit: Term | undefined;
  let misfit: Term | undefined;
  const has = (set: Set<string>, t: Term) => set.has(t.stem) || (t.stem.length >= 4 && [...set].some((s) => s.startsWith(t.stem)));
  const method = item.method && item.method !== 'ANY' ? item.method : undefined;
  for (const t of terms) {
    if (has(item.path, t)) inPath.push(t.word);
    else if (has(item.name, t)) inName.push(t.word);
    else if (method && t.methods) {
      if (t.methods.includes(method)) fit = t;
      else misfit = t;
    } else if (has(item.folder, t)) inFolder.push(t.word);
  }
  const strong = inName.length + inPath.length + (fit ? 1 : 0);
  if (terms.length > 0 && inName.length + inPath.length === 0) return undefined;
  const matched = strong + inFolder.length;
  const why: string[] = [];
  let score = 10 * matched + 3 * strong + TIER[item.kind];
  if (terms.length > 1 && matched === terms.length) score += 10;
  if (inPath.length > 0) {
    score += 4 * inPath.length;
    why.push(`${quote(inPath)} in the path`);
  }
  if (inName.length > 0) why.push(`${quote(inName)} in the name`);
  if (inFolder.length > 0) why.push(`${quote(inFolder)} in the folder`);
  if (fit) {
    score += 6;
    why.push(`${method} fits "${fit.word}"`);
  } else if (misfit) {
    score -= 6;
    why.push(`${method} does not fit "${misfit.word}"`);
  }
  if (item.kind === 'function' && item.first && terms.some((t) => t.methods && t.stem === item.first)) {
    score += 4;
    why.push(`the name starts with the verb`);
  }
  if (item.users >= 15 && matched * 2 <= terms.length) {
    score -= item.users >= 50 ? 12 : 8;
    why.push(`${item.users} users, but few words fit: lower`);
  }
  if (item.testish && !opts.tests) {
    score -= 15;
    why.push('a test, mock or fixture file: lower');
  }
  return { item, score, why, seed: true };
}

/** A path: glob: `*` is one segment, `**` any. A glob with no `*` fits a path that starts with it. */
export function pathFits(glob: string, path: string | undefined): boolean {
  if (!path) return false;
  if (!glob.includes('*')) return path === glob || path.startsWith(glob.endsWith('/') ? glob : `${glob}/`) || path.startsWith(glob);
  const re = new RegExp(`^${glob.split('**').map((p) => p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}(/.*)?$`);
  return re.test(path);
}

const kindFits = (q: LensQuery, k: LensKind) => q.kinds.size === 0 || q.kinds.has(k) || (k === 'route' && q.kinds.has('endpoint'));
const methodFits = (q: LensQuery, it: LensItem) => q.methods.size === 0 || (it.method !== undefined && q.methods.has(it.method));

// ---------------------------------------------------------------- the lens

export interface LensResult {
  query: LensQuery;
  hits: LensHit[];
  /** The items that fit but are not in the view (more seeds, or over the cap). */
  more: number;
  ms: number;
  /** A wide lens (depth:, up:N, down:N, impact: or no words): the neighbourhood, not the chains. */
  wide: boolean;
  /** The count of seeds in the view. */
  seeds: number;
  /** The types and constants that fit the words, left out (kind:type shows them). */
  types: number;
  /** The main chain: the best seed and its chain. */
  main: string[];
}

const byScore = (a: LensHit, b: LensHit) =>
  b.score - a.score || TIER[b.item.kind] - TIER[a.item.kind] || Number(b.seed) - Number(a.seed) || (a.item.label < b.item.label ? -1 : a.item.label > b.item.label ? 1 : 0);

/**
 * The items of a query, ranked and capped.
 *
 * A free-word lens (the default) shows the best seeds (CHAIN_SEEDS, cut where the score drops, or
 * show:N), the chain of each seed through the real links only (page → API route → endpoint → data
 * store; a function up to its page and down to its endpoints), and the test cases that touch the
 * chain (CHAIN_CASES, by the count of parts that they touch). A wide lens (depth:N, up:N, down:N,
 * impact:"…" or filters only) lifts each seed `depth` steps along all the links.
 */
export function runLens(ix: LensIndex, text: string, aliases: Readonly<Record<string, string>> = {}, cap = LENS_CAP): LensResult {
  const t0 = performance.now();
  const q = parseQuery(text, aliases);
  const terms = termsOf(q.words);
  const tests = q.kinds.has('test');
  const types = q.kinds.has('type');
  const wide = q.depthSet || q.impact !== undefined || terms.length === 0;
  const nameOf = (u: string | undefined) => (u ? ix.atlas.nameOf(u).toLowerCase() : '');
  const seedFits = (it: LensItem) =>
    kindFits(q, it.kind) &&
    (q.methods.size === 0 || methodFits(q, it)) &&
    (q.projects.length === 0 || q.projects.some((p) => nameOf(it.unit) === p || nameOf(it.unit).includes(p))) &&
    (q.paths.length === 0 || q.paths.some((g) => pathFits(g, it.route) || pathFits(g, it.file)));
  const hasFilter = q.kinds.size > 0 || q.methods.size > 0 || q.projects.length > 0 || q.paths.length > 0;
  const best = new Map<string, LensHit>();
  const put = (h: LensHit) => {
    const have = best.get(h.item.id);
    if (!have) best.set(h.item.id, h);
    else if (h.score > have.score) best.set(h.item.id, { ...h, seed: h.seed || have.seed, why: [...h.why, ...have.why.filter((w) => !h.why.includes(w))] });
    else for (const w of h.why) if (!have.why.includes(w)) have.why.push(w);
  };
  // The seeds. The types hide (one "+N types" box) unless kind:type.
  const typeHits: number[] = [];
  const seeds: LensHit[] = [];
  if (terms.length > 0 || hasFilter) {
    for (const it of ix.items) {
      if (!seedFits(it)) continue;
      const h = scoreItem(it, terms, { tests });
      if (!h) continue;
      const exact = q.names.includes(it.label.replace(/\(\)$/, '').toLowerCase());
      if (it.kind === 'type' && !types && !exact) {
        if (!it.testish) typeHits.push(h.score);
        continue;
      }
      // A free-word lens has no test code in its seeds: the cases come through the coverage.
      if (!wide && it.testish && !tests) continue;
      seeds.push(h);
    }
  }
  // An exact code name of the query (`parseQuery`) is the top seed.
  if (q.names.length > 0) {
    for (const h of seeds) {
      const bare = h.item.label.replace(/\(\)$/, '').toLowerCase();
      if (!q.names.includes(bare)) continue;
      h.score += EXACT_BONUS;
      h.why.unshift('the exact name');
    }
  }
  seeds.sort(byScore);
  // The types that a free-word lens leaves out: the ones that fit as well as its seeds.
  const typeCount = wide ? typeHits.length : typeHits.filter((v) => v >= (seeds[0]?.score ?? 0) - CHAIN_DROP).length;
  const ws = new Map<string, number>();
  const wordScore = (it: LensItem) => {
    let v = ws.get(it.id);
    if (v === undefined) ws.set(it.id, (v = scoreItem(it, terms, { tests })?.score ?? -1000));
    return v;
  };
  const dirs: Array<'up' | 'down'> = q.dir === 'both' ? ['up', 'down'] : [q.dir];
  const mainIds = new Set<string>();
  let seedCount: number;
  let left: number;

  if (wide) {
    for (const s of seeds) put(s);
    // The lift: from the best seeds, up or down (not both on one path), `depth` steps.
    const lift = (from: LensHit, depth: number, ds: Array<'up' | 'down'>, drop: number) => {
      for (const dir of ds) {
        let front: Array<{ item: LensItem; score: number }> = [{ item: from.item, score: from.score }];
        const seen = new Set([from.item.id]);
        for (let step = 1; step <= depth && front.length > 0; step++) {
          const next: typeof front = [];
          for (const f of front) {
            for (const l of ix.links(f.item, dir, tests)) {
              if (seen.has(l.id)) continue;
              seen.add(l.id);
              const item = ix.byId.get(l.id)!;
              const score = f.score - drop * step;
              put({ item, score, why: [l.rel], seed: false });
              next.push({ item, score });
            }
          }
          front = next;
        }
      }
    };
    for (const s of seeds.slice(0, LIFT_SEEDS)) lift(s, q.depth, dirs, 3);
    if (q.impact) {
      const it = termsOf([q.impact]);
      const top = ix.items.map((x) => scoreItem(x, it)).filter((h): h is LensHit => h !== undefined).sort((a, b) => b.score - a.score)[0];
      if (top) {
        const h: LensHit = { ...top, score: 1000, why: [`impact: what depends on ${top.item.label}`, ...top.why] };
        put(h);
        lift(h, q.depthSet ? q.depth : IMPACT_DEPTH, ['up'], 3);
      } else q.errors.push(`impact:"${q.impact}" fits no part of the map.`);
    }
    seedCount = seeds.length;
    left = 0;
  } else {
    // The seeds: show:N, or the best CHAIN_SEEDS, cut where the score drops by more than about one word
    // (but at least CHAIN_MIN). A kind: filter already narrows the list: no cut, only CHAIN_SEEDS.
    const top = seeds[0]?.score ?? 0;
    const chosen =
      q.show !== undefined
        ? seeds.slice(0, q.show)
        : seeds.slice(0, CHAIN_SEEDS).filter((h, i) => i < CHAIN_MIN || q.kinds.size > 0 || h.score >= top - CHAIN_DROP);
    seedCount = chosen.length;
    left = seeds.length - chosen.length;
    // The chain of a seed: the real links only, each way, no turn. A page goes down only to the
    // endpoints that fit the words; each step keeps the links that fit the words best.
    const chain = (from: LensHit): string[] => {
      const got: string[] = [];
      for (const dir of dirs) {
        let front: LensItem[] = [from.item];
        const seen = new Set([from.item.id]);
        for (let step = 1; step <= CHAIN_STEPS && front.length > 0; step++) {
          const next: LensItem[] = [];
          for (const f of front) {
            let ls = ix
              .links(f, dir, false)
              .map((l) => ({ ...l, item: ix.byId.get(l.id)! }))
              .filter((l) => !seen.has(l.id) && l.item.kind !== 'test' && l.item.kind !== 'type' && (tests || !l.item.testish));
            if (dir === 'down' && f.kind === 'page') ls = ls.filter((l) => wordScore(l.item) > -1000);
            ls.sort((x, y) => wordScore(y.item) - wordScore(x.item));
            for (const l of ls.slice(0, dir === 'down' ? 4 : 2)) {
              seen.add(l.id);
              put({ item: l.item, score: from.score - 3 * step, why: [l.rel], seed: false });
              got.push(l.id);
              next.push(l.item);
            }
          }
          front = next;
        }
      }
      return got;
    };
    for (const [i, s] of chosen.entries()) {
      put(s);
      const ids = chain(s);
      if (i === 0) for (const id of [s.item.id, ...ids]) mainIds.add(id);
    }
    // The test cases that touch the pages and endpoints of the lens (a mock counts, less than a real use).
    if ((q.kinds.size === 0 || tests) && !q.untested) {
      const parts = [...best.values()].filter((h) => h.item.kind === 'page' || h.item.kind === 'endpoint' || h.item.kind === 'route');
      const count = new Map<string, { w: number; labels: string[] }>();
      for (const h of parts) {
        const keys = [h.item.id, h.item.graphId, h.item.graphId ? `fn:${h.item.graphId}` : undefined].filter((k): k is string => k !== undefined);
        const seen = new Set<string>();
        for (const k of keys) {
          for (const t of ix.touchHow.get(k) ?? []) {
            if (seen.has(t.case)) continue;
            seen.add(t.case);
            const c = count.get(t.case) ?? { w: 0, labels: [] };
            c.w += t.used ? 2 : 1;
            c.labels.push(h.item.label);
            count.set(t.case, c);
          }
        }
      }
      const floor = Math.min(...[...best.values()].map((h) => h.score), top) - 1;
      const ranked = [...count.entries()]
        .map(([id, c]) => ({ item: ix.byId.get(id), ...c }))
        .filter((x): x is { item: LensItem; w: number; labels: string[] } => x.item !== undefined)
        .map((x) => ({ ...x, rank: x.w + Math.max(0, wordScore(x.item)) / 5 }))
        .sort((a, b) => b.rank - a.rank || (a.item.label < b.item.label ? -1 : 1))
        .slice(0, CHAIN_CASES);
      for (const x of ranked) {
        const n = x.labels.length;
        put({ item: x.item, score: floor, seed: false, why: [`it touches ${n} part${n === 1 ? '' : 's'} of the lens: ${x.labels.slice(0, 3).join(', ')}${n > 3 ? ', …' : ''}`] });
      }
    }
  }
  let hits = [...best.values()].filter((h) => kindFits(q, h.item.kind) && (h.item.method === undefined || methodFits(q, h.item)));
  if (wide && !tests) hits = hits.filter((h) => h.item.kind !== 'test' || h.seed);
  if (q.untested) hits = hits.filter((h) => h.item.kind === 'test' || h.item.kind === 'store' || h.item.kind === 'type' || !ix.isTouched(h.item));
  hits.sort(byScore);
  const shown = hits.slice(0, cap);
  const inView = new Set(shown.map((h) => h.item.id));
  return {
    query: q, hits: shown, more: left + hits.length - shown.length, ms: Math.round(performance.now() - t0),
    wide, seeds: Math.min(seedCount, shown.filter((h) => h.seed).length), types: typeCount, main: [...mainIds].filter((id) => inView.has(id)),
  };
}

// ---------------------------------------------------------------- the view

const indexes = new WeakMap<Atlas, Promise<LensIndex>>();

/** The lens index of an atlas, made once (the server warms it at the start). */
export function lensIndex(atlas: Atlas, tests?: TestModel): Promise<LensIndex> {
  let ix = indexes.get(atlas);
  if (!ix) {
    ix = LensIndex.build(atlas, tests);
    indexes.set(atlas, ix);
    ix.catch(() => indexes.delete(atlas));
  }
  return ix;
}

/** The view of a query: `lens:<query>`. */
export async function lensView(atlas: Atlas, tests: TestModel | undefined, text: string): Promise<AtlasView> {
  const t0 = performance.now();
  const ix = await lensIndex(atlas, tests);
  const r = runLens(ix, text, atlas.config.aliases);
  const ms = Math.round(performance.now() - t0);
  const groups = new Map<string, ViewGroup & { best: number }>();
  const nodes: ViewNode[] = [];
  const why: Record<string, string[]> = {};
  const group = (id: string, make: () => ViewGroup, score: number) => {
    const g = groups.get(id);
    if (g) g.best = Math.max(g.best, score);
    else groups.set(id, { ...make(), best: score });
    return id;
  };
  // Two functions with one name: the class (a method) or the file name under the name.
  const fnCount = new Map<string, number>();
  for (const h of r.hits) if (h.item.kind === 'function') fnCount.set(h.item.label, (fnCount.get(h.item.label) ?? 0) + 1);
  const fnLabel = (it: LensItem) => {
    if ((fnCount.get(it.label) ?? 0) < 2) return `${it.label}()`;
    return `${it.label}() · ${it.owner ?? it.file?.split('/').pop() ?? ''}`;
  };
  for (const h of r.hits) {
    const it = h.item;
    const p = it.unit ? atlas.projects.get(it.unit) : undefined;
    const pname = it.unit ? atlas.nameOf(it.unit) : '';
    const tone = p?.tone ?? 0;
    why[it.id] = h.why;
    if (it.kind === 'page' && it.entry && p) {
      const g = group(`fe:${p.key}`, () => ({ id: `fe:${p.key}`, label: pname, icon: 'page', tone, lane: 0, noun: ['page', 'pages'] }), h.score);
      nodes.push(atlas.entryNode(it.entry, 'page', g, p));
    } else if ((it.kind === 'endpoint' || it.kind === 'route') && it.ep && p) {
      const route = it.kind === 'route';
      const gid = `${route ? 'routes' : 'api'}:${p.key}`;
      const g = group(gid, () => ({ id: gid, label: route ? `${pname} (API routes)` : pname, icon: 'api', tone, lane: 1, noun: ['endpoint', 'endpoints'] }), h.score);
      nodes.push(atlas.endpointNode(it.ep, g));
    } else if ((it.kind === 'function' || it.kind === 'type') && p) {
      const g = group(`fns:${p.key}`, () => ({ id: `fns:${p.key}`, label: `${pname} · code`, icon: 'library', tone, lane: 2, noun: ['function', 'functions'] }), h.score);
      const fn = it.kind === 'function';
      nodes.push({
        id: it.id, shape: 'function', label: fn ? fnLabel(it) : it.label, sub: `${fn ? '' : `${it.typeKind ?? 'type'} · `}${it.file}:${it.line}`, group: g, tone,
        ...(fn ? { open: it.id, openProject: p.key } : {}), file: it.file!, line: it.line ?? 0, ...(it.graphId ? { ref: it.graphId } : {}),
      });
    } else if (it.kind === 'store' && it.store) {
      const g = group('stores', () => ({ id: 'stores', label: 'Data stores', icon: 'store', tone: 5, lane: 3, noun: ['store', 'stores'] }), h.score);
      nodes.push({ id: it.id, shape: 'store', label: it.label, sub: it.store.image ?? it.store.kind, group: g, file: it.store.file });
    } else if (it.kind === 'test' && it.caseId) {
      const g = group('tests', () => ({ id: 'tests', label: 'Test cases', icon: 'folder', tone: 6, lane: 4, noun: ['case', 'cases'] }), h.score);
      nodes.push({ id: it.id, shape: 'function', label: it.label, sub: `test case · ${it.file}:${it.line}`, group: g, case: it.caseId, file: it.file!, line: it.line ?? 0 });
    }
  }
  // The types and constants that fit the words: one box (a click adds kind:type).
  if (r.types > 0) {
    groups.set('types', { id: 'types', label: 'Types', icon: 'library', tone: 0, lane: 2, noun: ['type', 'types'], best: -1e9 });
    nodes.push({ id: LENS_TYPES, shape: 'function', label: `+${r.types} type${r.types === 1 ? '' : 's'}`, sub: 'kind:type shows them', group: 'types' });
    why[LENS_TYPES] = [
      r.types === 1
        ? '1 type or constant fits the words. Click to show it (kind:type).'
        : `${r.types} types and constants fit the words. Click to show them (kind:type).`,
    ];
  }
  // The links between the items in the view.
  const shown = new Set(nodes.map((n) => n.id));
  const edges: ViewEdge[] = [];
  const seen = new Set<string>();
  const withTests = r.query.kinds.has('test') || r.hits.some((h) => h.item.kind === 'test');
  for (const h of r.hits) {
    for (const l of ix.links(h.item, 'down', withTests)) {
      if (!shown.has(l.id)) continue;
      const k = `${h.item.id}>${l.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const to = ix.byId.get(l.id)!;
      const http = (to.kind === 'endpoint' || to.kind === 'route') && h.item.kind !== 'test';
      edges.push({ id: `lens:${k}`, from: h.item.id, to: l.id, kind: http ? 'http' : 'uses' });
    }
    for (const l of ix.links(h.item, 'up', false)) {
      if (!shown.has(l.id)) continue;
      const k = `${l.id}>${h.item.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push({ id: `lens:${k}`, from: l.id, to: h.item.id, kind: 'uses' });
    }
  }
  // A "reaches" link that a shown function explains (A → f → B) is not drawn: A → B goes.
  const fnIds = new Set(nodes.filter((n) => ix.byId.get(n.id)?.kind === 'function').map((n) => n.id));
  const has = new Set(edges.map((e) => `${e.from}>${e.to}`));
  const short = edges.filter(
    (e) => ix.byId.get(e.from)?.kind !== 'test' && [...fnIds].some((f) => f !== e.from && f !== e.to && has.has(`${e.from}>${f}`) && has.has(`${f}>${e.to}`)),
  );
  for (const e of short) edges.splice(edges.indexOf(e), 1);
  // A test case that touches a part (a page) whose shown chain reaches another part it touches: only
  // the link to the first part is drawn. The why of the case still names all the parts.
  const next = new Map<string, string[]>();
  for (const e of edges) if (ix.byId.get(e.from)?.kind !== 'test') next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set([from]);
    const todo = [from];
    while (todo.length > 0) {
      for (const n of next.get(todo.pop()!) ?? []) {
        if (n === to) return true;
        if (!seen.has(n)) (seen.add(n), todo.push(n));
      }
    }
    return false;
  };
  const viaChain = edges.filter((e) => ix.byId.get(e.from)?.kind === 'test' && edges.some((o) => o.from === e.from && o.to !== e.to && reaches(o.to, e.to)));
  for (const e of viaChain) edges.splice(edges.indexOf(e), 1);
  const order = [...groups.values()].sort((a, b) => (a.lane ?? 9) - (b.lane ?? 9) || b.best - a.best);
  const notes = [...r.query.errors];
  if (nodes.length === 0) notes.push(text.trim() === '' ? 'Type words to search the map.' : 'No part of the map fits the query.');
  return {
    ok: true, level: 'system', id: `lens:${text}`, title: `Search: ${text}`,
    groups: order.map(({ best: _best, ...g }) => g), nodes, edges, notes,
    lens: { query: text, chips: r.query.chips, errors: r.query.errors, ms, shown: nodes.length - (r.types > 0 ? 1 : 0), more: r.more, why, wide: r.wide, seeds: r.seeds, main: r.main },
  };
}
