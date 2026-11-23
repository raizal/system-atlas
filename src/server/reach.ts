// The pages of a frontend in features, and the endpoints that a page reaches (the Features mode).
//
// A feature is a group of pages by the first static segment of the route after the common prefix of
// the project: /audit/[id] and /audit/list go to "/audit". A very large group splits by the next
// static segment ("/s/:subdomain/shipments"). A group of one page goes to "Other pages".
//
// A page reaches an endpoint if the call graph goes from the page component down to an HTTP client
// call: through components (renders), hooks and services (calls). The walk stops at REACH_DEPTH
// steps, and follows at most REACH_FANOUT edges out of one function.

/** The most steps from the page component to the function that holds the HTTP call. */
export const REACH_DEPTH = 6;
/** The most edges that the walk follows out of one function. */
export const REACH_FANOUT = 40;
/** The most functions that one walk visits. */
export const REACH_NODES = 3000;
/** The key of the group of the pages that are alone in their group. */
export const OTHER_PAGES = 'other';

export interface PageRoute {
  id: string;
  /** The route of the page ("/audit/[id]"), or the name of the component if it has no route. */
  route: string;
}

export interface Feature<T extends PageRoute = PageRoute> {
  /** The slug, unique in the project: the first segment, or OTHER_PAGES. */
  slug: string;
  /** "/audit", or "Other pages". */
  label: string;
  pages: T[];
}

const segsOf = (route: string): string[] =>
  route.startsWith('/') ? route.split('/').filter((s) => s !== '' && !/^\(.*\)$/.test(s)) : [];
const dynamic = (seg: string): boolean => seg.startsWith(':') || seg.startsWith('[');

/** A group with more pages than this splits by the next static segment. */
const splitAt = (total: number): number => Math.max(8, Math.ceil(total * 0.4));

/**
 * The key of a page: the segments after `skip` up to and with the `level`-th static segment
 * ("s/:subdomain/shipments" at level 2). Dynamic segments come along, but do not count.
 */
function keyOf(segs: readonly string[], skip: number, level: number): string {
  const out: string[] = [];
  let n = 0;
  for (const s of segs.slice(skip)) {
    if (n === level) break;
    out.push(s);
    if (!dynamic(s)) n++;
  }
  while (out.length > 0 && dynamic(out[out.length - 1]!)) out.pop();
  return out.join('/');
}

/** The features of the pages of one frontend, by label. "Other pages" is last. */
export function featureGroups<T extends PageRoute>(pages: readonly T[]): Feature<T>[] {
  const routed = pages.filter((p) => p.route.startsWith('/'));
  // The common prefix of the routes, as segments.
  let common: string[] | undefined;
  for (const p of routed) {
    const s = segsOf(p.route);
    if (!common) common = s.slice(0, -1);
    else {
      let i = 0;
      while (i < common.length && i < s.length - 1 && common[i] === s[i]) i++;
      common = common.slice(0, i);
    }
  }
  const skip = routed.length > 1 ? (common?.length ?? 0) : 0;
  const head = (common ?? []).slice(0, skip);
  const limit = splitAt(routed.length);
  const groups: Array<[string, T[]]> = [];
  const other: T[] = pages.filter((p) => !p.route.startsWith('/'));
  // Group by the first static segment; a group that is too large splits by the next one (3 levels at most).
  const split = (list: readonly T[], level: number) => {
    const by = new Map<string, T[]>();
    for (const p of list) {
      const k = keyOf(segsOf(p.route), skip, level);
      by.set(k, [...(by.get(k) ?? []), p]);
    }
    for (const [k, sub] of by) {
      if (sub.length > limit && level < 3 && new Set(sub.map((p) => keyOf(segsOf(p.route), skip, level + 1))).size > 1) split(sub, level + 1);
      else groups.push([k, sub]);
    }
  };
  split(routed, 1);
  const out: Feature<T>[] = [];
  for (const [k, list] of groups.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (list.length === 1) other.push(list[0]!);
    else out.push({ slug: k === '' ? 'home' : k.replace(/[^\w-]+/g, '-'), label: `/${[...head, k].filter(Boolean).join('/')}`, pages: list });
  }
  if (other.length > 0) out.push({ slug: OTHER_PAGES, label: 'Other pages', pages: other });
  return out;
}

export interface ReachGraph<C> {
  /** The functions that a function calls or renders, in a fixed order. */
  next(id: string): readonly string[];
  /** The HTTP calls in a function. */
  calls(id: string): readonly C[];
}

export interface Reached<C> {
  call: C;
  /** The steps from the page component to the function that holds the call (0: the page itself). */
  steps: number;
  /** The function that holds the call. */
  fn: string;
}

/**
 * The HTTP calls that a page component reaches, each one with the least number of steps.
 * A breadth-first walk: at most `depth` steps, `fanout` edges out of one function.
 */
export function reachCalls<C>(start: string, g: ReachGraph<C>, depth = REACH_DEPTH, fanout = REACH_FANOUT): Reached<C>[] {
  const out: Reached<C>[] = [];
  const seen = new Set([start]);
  let level = [start];
  for (let steps = 0; level.length > 0 && steps <= depth; steps++) {
    const next: string[] = [];
    for (const id of level) {
      for (const call of g.calls(id)) out.push({ call, steps, fn: id });
      if (steps === depth) continue;
      for (const to of g.next(id).slice(0, fanout)) {
        if (seen.has(to) || seen.size >= REACH_NODES) continue;
        seen.add(to);
        next.push(to);
      }
    }
    level = next;
  }
  return out;
}
