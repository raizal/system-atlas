// The parts of the System view that need no index: the lanes, the Support group, the size steps,
// the config file of the target repo, and the matrix of the HTTP calls.
//
// The System view has fixed lanes, left to right: Frontends → APIs → Functions and workers (and
// command-line tools) → Data stores. Libraries and Support are shelves along the bottom.

import type { Matrix, MatrixCell, ProjectKind } from './view.js';

export type { Matrix, MatrixCell };

/** The group of a project in the System view: its kind, or the Support group. */
export type SystemGroup = ProjectKind | 'support';

export interface Slot {
  /** The column, left to right. */
  lane?: number;
  /** A row along the bottom, not a lane. */
  shelf?: boolean;
}

/** The place of each group of the System view. */
export const SLOTS: Record<SystemGroup | 'stores', Slot> = {
  frontend: { lane: 0 },
  api: { lane: 1 },
  worker: { lane: 2 },
  cli: { lane: 2 },
  stores: { lane: 3 },
  library: { shelf: true },
  support: { shelf: true },
};

/** The order of the groups in the view: the lanes left to right, then the shelves. */
export const GROUP_ORDER: Array<SystemGroup> = ['frontend', 'api', 'worker', 'cli', 'library', 'support'];

export const GROUP_TITLE: Record<SystemGroup, string> = {
  frontend: 'Frontends', api: 'APIs', cli: 'Command-line tools', worker: 'Functions and workers', library: 'Libraries', support: 'Support',
};

/** The noun of the members of a group, for a collapsed group: "25 libraries". */
export const GROUP_NOUN: Record<SystemGroup, [string, string]> = {
  frontend: ['frontend', 'frontends'], api: ['API', 'APIs'], cli: ['tool', 'tools'], worker: ['function', 'functions'], library: ['library', 'libraries'], support: ['project', 'projects'],
};

/** A group with more members than this starts collapsed (Libraries and Support only). */
export const FOLD_MIN = 12;

/** The names and folders of the projects that support the product: infra, templates, playgrounds, docs, test automation, scripts. */
const SUPPORT = [/(^|[/-])infra$/i, /(^|\/)template/i, /playground/i, /(^|\/)docs?$/i, /(^|\/)[\w-]*(automation|qa|acceptance)[-_]?tests?$/i, /(^|\/)scripts$/i];

export interface SupportInput {
  name: string;
  dir: string;
  /** Pages, routes, commands or exports. */
  count: number;
  /** An HTTP call in or out, or a data store. */
  runtime: boolean;
}

/** True if a project goes to the Support group: by its name or folder, or with nothing to show and no runtime edge. */
export function isSupport(p: SupportInput): boolean {
  if (SUPPORT.some((re) => re.test(p.name) || re.test(p.dir))) return true;
  return p.count === 0 && !p.runtime;
}

/** The size of a project box: by its count of pages, routes or exports. A few steps, not a scale. */
export type SizeStep = 'chip' | 's' | 'm' | 'l';

export function sizeStep(count: number): SizeStep {
  if (count <= 2) return 'chip';
  if (count <= 15) return 's';
  if (count <= 60) return 'm';
  return 'l';
}

// ---------------------------------------------------------------- the config file

/** The optional config file in the root of the target repo. The atlas only reads it. */
export const CONFIG_FILE = 'atlas.config.json';

export interface ProjectConfig {
  /** Never in Support, and first in its group. */
  pin?: boolean;
  /** Not on the canvas. */
  hide?: boolean;
  rename?: string;
  /** Move the project to this group. */
  group?: SystemGroup;
}

export interface FeatureConfig {
  /** A feature slug → its new label. */
  rename?: Record<string, string>;
  /** A feature slug → the slugs of the features that join it. */
  merge?: Record<string, string[]>;
}

export interface AtlasConfig {
  /** By project name. */
  projects: Record<string, ProjectConfig>;
  /** By frontend name. */
  features: Record<string, FeatureConfig>;
  /** The search lens: a word of the query → the words of the code (`"po": "purchase order"`). An exact word swap. */
  aliases: Record<string, string>;
  /** The problems of the file, for the notes of the view. */
  problems: string[];
}

const GROUPS = new Set<string>(GROUP_ORDER);
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Read the config file. A bad file or a bad item gives a problem, not an error. */
export function parseConfig(text: string | undefined): AtlasConfig {
  const out: AtlasConfig = { projects: {}, features: {}, aliases: {}, problems: [] };
  if (text === undefined) return out;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    out.problems.push(`${CONFIG_FILE} is not valid JSON. The atlas does not use it.`);
    return out;
  }
  if (!isRecord(raw)) {
    out.problems.push(`${CONFIG_FILE} must hold an object.`);
    return out;
  }
  if (isRecord(raw.projects)) {
    for (const [name, v] of Object.entries(raw.projects)) {
      if (!isRecord(v)) continue;
      const c: ProjectConfig = {};
      if (v.pin === true) c.pin = true;
      if (v.hide === true) c.hide = true;
      if (typeof v.rename === 'string' && v.rename.trim() !== '') c.rename = v.rename.trim();
      if (typeof v.group === 'string') {
        if (GROUPS.has(v.group)) c.group = v.group as SystemGroup;
        else out.problems.push(`${CONFIG_FILE}: the group "${v.group}" of ${name} is not one of ${GROUP_ORDER.join(', ')}.`);
      }
      out.projects[name] = c;
    }
  }
  if (isRecord(raw.features)) {
    for (const [name, v] of Object.entries(raw.features)) {
      if (!isRecord(v)) continue;
      const c: FeatureConfig = {};
      if (isRecord(v.rename)) c.rename = Object.fromEntries(Object.entries(v.rename).filter((e): e is [string, string] => typeof e[1] === 'string'));
      if (isRecord(v.merge)) c.merge = Object.fromEntries(Object.entries(v.merge).filter((e): e is [string, string[]] => Array.isArray(e[1])).map(([k, l]) => [k, l.filter((s) => typeof s === 'string')]));
      out.features[name] = c;
    }
  }
  if (raw.aliases !== undefined) {
    if (!isRecord(raw.aliases)) out.problems.push(`${CONFIG_FILE}: "aliases" must be an object of words.`);
    else {
      for (const [k, v] of Object.entries(raw.aliases)) {
        const key = k.trim().toLowerCase();
        if (typeof v !== 'string' || v.trim() === '' || key === '' || /\s/.test(key)) out.problems.push(`${CONFIG_FILE}: the alias "${k}" must be one word with a text value.`);
        else out.aliases[key] = v.trim();
      }
    }
  }
  return out;
}

/** The group of a project, with the config. */
export function groupOf(kind: ProjectKind, support: SupportInput, c: ProjectConfig | undefined): SystemGroup {
  if (c?.group) return c.group;
  if (!c?.pin && isSupport(support)) return 'support';
  return kind;
}

/** Rename and merge the features of a frontend. The merged features keep the slug of the target. */
export function applyFeatureConfig<F extends { slug: string; label: string; pages: unknown[] }>(features: F[], c: FeatureConfig | undefined): F[] {
  if (!c) return features;
  let out = features.map((f) => ({ ...f, pages: [...f.pages] }));
  for (const [target, sources] of Object.entries(c.merge ?? {})) {
    const into = out.find((f) => f.slug === target);
    if (!into) continue;
    for (const s of sources) {
      const from = out.find((f) => f.slug === s && f !== into);
      if (!from) continue;
      into.pages.push(...from.pages);
      out = out.filter((f) => f !== from);
    }
  }
  for (const f of out) if (c.rename?.[f.slug]) f.label = c.rename[f.slug]!;
  return out;
}

// ---------------------------------------------------------------- the matrix

export interface MatrixCall {
  unit: string;
  endpoint?: { unit: string };
  possible?: Array<{ unit: string }>;
}

/**
 * The HTTP calls of the frontends to the other projects: the rows are the frontends, the columns the
 * projects that they call. A call with only possible endpoints counts one time in each column of them.
 */
export function matrixOf(calls: readonly MatrixCall[], rows: Matrix['rows'], label: (key: string) => string): Matrix {
  const rowKeys = new Set(rows.map((r) => r.key));
  const cells: Record<string, MatrixCell> = {};
  const cols = new Set<string>();
  const bump = (row: string, col: string, k: keyof MatrixCell) => {
    if (row === col) return;
    const cell = (cells[`${row}\n${col}`] ??= { direct: 0, possible: 0 });
    cell[k]++;
    cols.add(col);
  };
  for (const c of calls) {
    if (!rowKeys.has(c.unit)) continue;
    if (c.endpoint) bump(c.unit, c.endpoint.unit, 'direct');
    else for (const u of new Set((c.possible ?? []).map((e) => e.unit))) bump(c.unit, u, 'possible');
  }
  return { rows, cols: [...cols].sort().map((key) => ({ key, label: label(key) })), cells };
}
