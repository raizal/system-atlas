// The features of a project. A feature is a named group of entries.
// The features come from 2 sources, in this order:
//   rule    - route prefixes and command names, then the folder below the source root.
//   cluster - label propagation over the entries that are left, and over a rule group with more
//             than CLUSTER_ABOVE entries. The order is fixed and there is no random seed.

import { folderBelow, wordsOf, type Entry } from './entries.js';

export type FeatureSource = 'rule' | 'cluster';

export interface Feature {
  /** Unique in its project. */
  slug: string;
  name: string;
  source: FeatureSource;
  entries: Entry[];
}

/** A rule group with more entries than this goes to the clusters. */
export const CLUSTER_ABOVE = 12;
const MAX_ROUNDS = 20;
/** A node that more entries than this reach is common code: it does not link entries. */
const HUB_SHARE = 0.5;
const SKIP_WORDS = new Set(['src', 'lib', 'index', 'ts', 'tsx', 'js', 'py', 'packages', 'main', 'the', 'and', 'of', 'to', 'api', 'test']);

export interface FeatureInput {
  /** The folder of the project in the repo, '' for the root. */
  dir: string;
  entries: Entry[];
  /** The code that an entry reaches in the project (an atom ID set). */
  reach(entry: Entry): ReadonlySet<string>;
}

/** The features of one project: rule, then cluster. Each entry is in one feature. */
export function findFeatures(input: FeatureInput): Feature[] {
  const out: Feature[] = [];
  const used = new Set<string>();
  const slugs = new Set<string>();
  const add = (name: string, source: FeatureSource, entries: Entry[]) => {
    if (entries.length === 0) return;
    let slug = slugOf(name);
    for (let n = 2; slugs.has(slug); n++) slug = `${slugOf(name)}-${n}`;
    slugs.add(slug);
    for (const e of entries) used.add(e.id);
    out.push({ slug, name, source, entries });
  };

  // C: the file.
  // A: the rules.
  const left = input.entries.filter((e) => !used.has(e.id));
  const groups = ruleGroups(left, input.dir);
  const toCluster: Entry[] = [];
  for (const g of groups) {
    if (g.entries.length > CLUSTER_ABOVE) toCluster.push(...g.entries);
    else add(g.name, 'rule', g.entries);
  }

  // B: the clusters.
  if (toCluster.length > 0) {
    // A word of most entries (the file `http` of all routes) does not tell one cluster from the next.
    const common = new Set([...wordCounts(toCluster, input.dir)].filter(([, n]) => n > toCluster.length / 2).map(([w]) => w));
    for (const c of labelClusters(toCluster, input.reach)) add(clusterName(c, input.dir, new Set(out.map((f) => f.name)), common), 'cluster', c);
  }
  return out;
}

interface Group {
  name: string;
  entries: Entry[];
}

/** The rule groups: routes by the first path word, commands by the first name word, the rest by folder. */
function ruleGroups(entries: Entry[], dir: string): Group[] {
  const routeKey = (e: Entry) => {
    const parts = (e.paths?.[0] ?? e.name).split('/').filter((p) => p !== '' && !p.startsWith(':') && !p.startsWith('{'));
    return (parts[0] === 'api' ? parts[1] : parts[0]) ?? 'routes';
  };
  const commandKey = (e: Entry) => e.name.split(/[-\s]/)[0]!;
  const keyed = (list: Entry[], key: (e: Entry) => string, rest: string): Group[] => {
    const by = new Map<string, Entry[]>();
    for (const e of list) {
      const k = key(e);
      by.set(k, [...(by.get(k) ?? []), e]);
    }
    const out: Group[] = [];
    const single: Entry[] = [];
    for (const [k, list2] of by) (list2.length >= 2 ? out.push({ name: k, entries: list2 }) : single.push(...list2));
    if (single.length > 0) out.push({ name: rest, entries: single });
    return out;
  };
  const routes = keyed(entries.filter((e) => e.kind === 'route'), routeKey, 'routes');
  const commands = keyed(entries.filter((e) => e.kind === 'command'), commandKey, 'commands');
  const src = dir === '' ? 'src' : `${dir}/src`;
  const folder = new Map<string, Entry[]>();
  for (const e of entries) {
    if (e.kind === 'route' || e.kind === 'command') continue;
    const root = e.file.startsWith(`${src}/`) ? src : dir;
    const k = folderBelow(e.file, root) || '(top level)';
    folder.set(k, [...(folder.get(k) ?? []), e]);
  }
  const folders = [...folder].sort(([a], [b]) => (a === '(top level)' ? 1 : b === '(top level)' ? -1 : a < b ? -1 : 1)).map(([name, list]) => ({ name, entries: list }));
  return [...routes, ...commands, ...folders];
}

/**
 * Label propagation over entries. Two entries link when they reach the same code or one reaches the
 * other. Labels start as the entry positions. Each round visits the entries in order; an entry takes
 * the label with the largest link weight, and a tie goes to the smallest label. Entries with no link
 * go into one last cluster.
 */
export function labelClusters(entries: Entry[], reach: (e: Entry) => ReadonlySet<string>): Entry[][] {
  const n = entries.length;
  const reaches = entries.map((e) => reach(e));
  const at = new Map(entries.map((e, i) => [e.id, i]));
  // Who reaches each node, without the hubs.
  const by = new Map<string, number[]>();
  reaches.forEach((set, i) => {
    for (const id of set) by.set(id, [...(by.get(id) ?? []), i]);
  });
  // In a small set, no node is a hub.
  const hub = n < 20 ? n : Math.floor(n * HUB_SHARE);
  const weights: Array<Map<number, number>> = entries.map(() => new Map());
  const link = (a: number, b: number, w: number) => {
    if (a === b) return;
    weights[a]!.set(b, (weights[a]!.get(b) ?? 0) + w);
    weights[b]!.set(a, (weights[b]!.get(a) ?? 0) + w);
  };
  for (const [id, list] of [...by].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const self = at.get(id);
    if (self !== undefined) for (const i of list) link(i, self, 3);
    if (list.length < 2 || list.length > hub) continue;
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) link(list[x]!, list[y]!, 1);
  }
  const label = entries.map((_, i) => i);
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      const score = new Map<number, number>();
      for (const [j, w] of weights[i]!) score.set(label[j]!, (score.get(label[j]!) ?? 0) + w);
      if (score.size === 0) continue;
      let best = label[i]!;
      let top = -1;
      for (const [l, w] of [...score].sort(([a], [b]) => a - b)) {
        if (w > top) {
          best = l;
          top = w;
        }
      }
      if (best !== label[i]) {
        label[i] = best;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const clusters = new Map<number, Entry[]>();
  const alone: Entry[] = [];
  entries.forEach((e, i) => {
    if (weights[i]!.size === 0) alone.push(e);
    else clusters.set(label[i]!, [...(clusters.get(label[i]!) ?? []), e]);
  });
  // The clusters in the order of their first entry.
  const out = [...clusters.values()].sort((a, b) => at.get(a[0]!.id)! - at.get(b[0]!.id)!);
  if (alone.length > 0) out.push(alone);
  return out;
}

/** How many entries have each word in their file or name. */
function wordCounts(entries: Entry[], dir: string): Map<string, number> {
  const count = new Map<string, number>();
  for (const e of entries) {
    const rel = dir !== '' && e.file.startsWith(`${dir}/`) ? e.file.slice(dir.length + 1) : e.file;
    for (const w of new Set([...wordsOf(rel), ...wordsOf(e.kind === 'route' || e.kind === 'command' ? e.name : '')])) {
      if (!SKIP_WORDS.has(w)) count.set(w, (count.get(w) ?? 0) + 1);
    }
  }
  return count;
}

/**
 * The name of a cluster: the most common words of its files and names. A word in `common` comes last.
 * A tie goes to the first word in alphabetical order. A name in `taken` gets one more word.
 */
export function clusterName(entries: Entry[], dir: string, taken: ReadonlySet<string> = new Set(), common: ReadonlySet<string> = new Set()): string {
  const ranked = [...wordCounts(entries, dir)]
    .sort(([a, x], [b, y]) => Number(common.has(a)) - Number(common.has(b)) || y - x || (a < b ? -1 : 1))
    .map(([w]) => w);
  for (const name of [ranked[0], ranked.slice(0, 2).join(' '), ranked.slice(0, 3).join(' ')]) {
    if (name && !taken.has(name)) return name;
  }
  for (let n = 2; ranked[0]; n++) if (!taken.has(`${ranked[0]} ${n}`)) return `${ranked[0]} ${n}`;
  return 'other';
}

export function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'feature';
}
