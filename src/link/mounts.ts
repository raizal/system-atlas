// The mount prefix of the FastAPI routes of a project.
//
// CodeGraph names a FastAPI route with the prefix of its APIRouter (`POST /api-keys`), but not with
// the prefix of the app: `app.include_router(router, prefix="/v1")` or
// `prefix=settings.api_v1_str` (with `api_v1_str: str = "/v1"` in a settings class). The client
// calls `/v1/api-keys`. This file finds that prefix for each route file:
//   1. the `include_router` calls on `app` (the app level), with a literal or a settings prefix
//   2. the module of the router, from the import lines of the file (`from src.api.router import router`)
//   3. the routers that this router includes (`router.include_router(jobs_router)`), at any depth
// A route file that the app does not reach gets no prefix.

import { posix } from 'node:path';
import type { ImportLine } from '../index/codegraph.js';
import { importBindings } from '../index/source.js';

const INCLUDE_RE = /^\s*(\w+)\.include_router\(\s*([\w.]+)\s*(?:,([^)]*))?\)/gm;
const PREFIX_RE = /\bprefix\s*=\s*(?:(['"])([^'"]*)\1|([\w.]+))/;

interface Include {
  on: string;
  router: string;
  prefix?: string;
}

/** `prefix=settings.NAME`: the value of `NAME: str = "..."` (or `NAME = "..."`) in a Python file of the project. */
function settingValue(name: string, texts: ReadonlyMap<string, string>): string | undefined {
  const re = new RegExp(`^\\s*${name}\\s*(?::\\s*[\\w\\[\\], |]+)?=\\s*(['"])([^'"]*)\\1`, 'm');
  for (const text of texts.values()) {
    const m = re.exec(text);
    if (m) return m[2];
  }
  return undefined;
}

/** The file of a Python module, from the files of the project: `src.api.router` → `shop-api/src/api/router.py`. */
function moduleFile(module: string, from: string, files: readonly string[]): string | undefined {
  let path = module;
  if (module.startsWith('.')) {
    const dots = /^\.+/.exec(module)![0].length;
    let dir = posix.dirname(from);
    for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
    path = `${dir}/${module.slice(dots).replace(/\./g, '/')}`;
    return files.find((f) => f === `${path}.py` || f === `${path}/__init__.py`);
  }
  const tail = path.replace(/\./g, '/');
  // A source root above the importing file: `src/main.py` imports `api.router` → `src/api/router.py`.
  for (let dir = posix.dirname(from); ; dir = posix.dirname(dir)) {
    const base = dir === '.' ? '' : `${dir}/`;
    const hit = files.find((f) => f === `${base}${tail}.py` || f === `${base}${tail}/__init__.py`);
    if (hit) return hit;
    if (dir === '.' || dir === '/' || dir === '') break;
  }
  const hits = files.filter((f) => f.endsWith(`/${tail}.py`) || f === `${tail}.py` || f.endsWith(`/${tail}/__init__.py`));
  // Else the nearest one to the importing file, by whole folders.
  return hits.sort((a, b) => common(b, from) - common(a, from) || a.length - b.length)[0];
}

/** The count of the folders that two paths share at the start. */
const common = (a: string, b: string): number => {
  const x = a.split('/');
  const y = b.split('/');
  let i = 0;
  while (i < x.length - 1 && i < y.length - 1 && x[i] === y[i]) i++;
  return i;
};

/** The prefix of each route file of a project: file → prefix (e.g. `/v1`). */
export function pythonMounts(files: readonly string[], read: (file: string) => string | undefined, imports: (file: string) => ImportLine[]): Map<string, string> {
  const texts = new Map<string, string>();
  for (const f of files) {
    const t = read(f);
    if (t !== undefined && t.includes('include_router')) texts.set(f, t);
  }
  const out = new Map<string, string>();
  if (texts.size === 0) return out;
  const allTexts = new Map<string, string>();
  const includes = new Map<string, Include[]>();
  for (const [f, t] of texts) {
    const list: Include[] = [];
    for (const m of t.matchAll(INCLUDE_RE)) {
      const p = m[3] ? PREFIX_RE.exec(m[3]) : null;
      let prefix: string | undefined;
      if (p?.[2] !== undefined) prefix = p[2];
      else if (p?.[3]) {
        if (allTexts.size === 0) for (const g of files) { const x = read(g); if (x !== undefined) allTexts.set(g, x); }
        prefix = settingValue(p[3].split('.').at(-1)!, allTexts);
      }
      list.push({ on: m[1]!, router: m[2]!, ...(prefix ? { prefix } : {}) });
    }
    includes.set(f, list);
  }
  /** The file of the router object `name` used in `file`. */
  const routerFile = (name: string, file: string): string | undefined => {
    const root = name.split('.')[0]!;
    const binds = importBindings(imports(file), 'python');
    const module = binds.get(root);
    if (module === undefined) return undefined;
    // `from src.api import jobs` + `jobs.router`: the module is `src.api.jobs`.
    if (name.includes('.')) return moduleFile(`${module}.${root}`, file, files) ?? moduleFile(module, file, files);
    return moduleFile(module, file, files) ?? moduleFile(`${module}.${root}`, file, files);
  };
  const visit = (file: string, prefix: string, seen: Set<string>) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (!out.has(file)) out.set(file, prefix);
    for (const inc of includes.get(file) ?? []) {
      if (inc.on === 'app') continue;
      const g = routerFile(inc.router, file);
      if (g) visit(g, prefix + (inc.prefix ?? ''), seen);
    }
  };
  for (const [f, list] of includes) {
    for (const inc of list) {
      if (inc.on !== 'app') continue;
      const g = routerFile(inc.router, f);
      if (g) visit(g, inc.prefix ?? '', new Set());
    }
  }
  for (const [f, p] of out) if (p === '') out.delete(f);
  return out;
}
