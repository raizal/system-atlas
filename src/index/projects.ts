// The projects of a repo: the folders with a manifest.
//   - the package.json files that CodeGraph found (`js_workspace_manifests`), and the nearest
//     package.json above each TypeScript or JavaScript file
//   - the Python roots (pyproject.toml, setup.py, requirements.txt) and the Go roots (go.mod) above
//     the source files
// Each file goes to the project with the deepest folder that holds it. A file with no project goes
// to `dir:<top folder>`. A manifest in a test folder is not a project. The manifest at the repo root
// is not a project when there are others: its files go to `dir:` projects.
// One package with a web page and other code (a server, a CLI) has two parts: the folder of the page
// is a project of its own (`<name>-web`), when the facts show it (see webDirOf).

import { posix } from 'node:path';

/**
 * Test code, not product code: a test file of vitest, jest, Playwright, Cypress or pytest, or a file
 * below a test folder (`test/`, `tests/`, `__tests__/`, `e2e/`, `playwright/`, `cypress/`), fixtures too.
 * Test code is not a project, a page, an entry, an HTTP client or a link source.
 */
export const isTestPath = (path: string): boolean =>
  /(^|\/)(tests?|__tests__|e2e|playwright|cypress)\/|\.(test|spec|cy)\.[cm]?[jt]sx?$|(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$/.test(path);

const PYTHON_ROOTS = ['pyproject.toml', 'setup.py', 'requirements.txt'];
const GO_ROOTS = ['go.mod'];
const JS_ROOTS = ['package.json'];
const JS_LANGS = new Set(['typescript', 'tsx', 'javascript', 'jsx']);
const SKIP = /(^|\/)(node_modules|dist|build|\.venv|venv|site-packages|__pycache__)\//;

export interface Unit {
  key: string;
  name: string;
  /** The folder from the repo root, '' for the root. */
  dir: string;
  /** The web part of a package that holds other code too: a frontend. */
  part?: 'web';
}

export interface UnitInput {
  /** The source files, with the language (typescript, python, go…). */
  files: ReadonlyMap<string, string>;
  /** The package.json files, from the root. */
  manifests: readonly string[];
  /** The text of a repo file, or undefined. */
  read(file: string): string | undefined;
}

const within = (file: string, dir: string) => dir === '' || file.startsWith(`${dir}/`);

/** The name of the project in a folder: from package.json, pyproject.toml or go.mod, else the folder name. */
function nameOf(dir: string, read: UnitInput['read']): string {
  const at = (f: string) => (dir === '' ? f : `${dir}/${f}`);
  const pkg = read(at('package.json'));
  if (pkg !== undefined) {
    try {
      const name = (JSON.parse(pkg) as { name?: unknown }).name;
      if (typeof name === 'string' && name.trim() !== '') return name.trim();
    } catch {
      // A broken package.json: use the folder name.
    }
  }
  const py = read(at('pyproject.toml'));
  const pyName = py ? /^\[(?:project|tool\.poetry)\][^[]*?^name\s*=\s*["']([^"']+)["']/ms.exec(py)?.[1] : undefined;
  if (pyName) return pyName;
  const mod = read(at('go.mod'));
  const goName = mod ? /^module\s+(\S+)/m.exec(mod)?.[1] : undefined;
  if (goName) return goName.split('/').at(-1)!;
  return dir === '' ? '(repo root)' : posix.basename(dir);
}

const UI_DEPS = ['react', 'react-dom', 'vue', 'svelte', 'preact', 'solid-js'];
const UI_FILE = /\.(?:tsx|jsx|vue|svelte)$/;
/** The folders that often hold the page of a package with a server: `src/web`, `client`, … */
const WEB_DIRS = ['src/web', 'src/client', 'src/frontend', 'web', 'client', 'frontend'];

const joinDir = (dir: string, rel: string): string => {
  const p = posix.normalize(dir === '' ? rel : `${dir}/${rel}`).replace(/^\.\/?|\/$/g, '');
  return p === '.' ? '' : p;
};

/**
 * The folder of the web page of a JavaScript package, when the package holds other code too. The facts:
 *   - the package uses a UI library (react, vue, svelte, …);
 *   - the folder of the page: the `root` of the Vite config, the folder of the module script of
 *     `index.html`, or a `src/web`, `src/client`, `web`, `client` or `frontend` folder;
 *   - the folder has UI files (.tsx, .jsx, .vue, .svelte), and the package has code in other
 *     folders (not only config files at its root, not tests).
 * Else undefined: the package is one project.
 */
export function webDirOf(dir: string, code: readonly string[], read: UnitInput['read']): string | undefined {
  const at = (f: string) => (dir === '' ? f : `${dir}/${f}`);
  let deps: string[] = [];
  try {
    const j = JSON.parse(read(at('package.json')) ?? '{}') as Record<string, Record<string, string> | undefined>;
    deps = ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((k) => Object.keys(j[k] ?? {}));
  } catch {
    return undefined;
  }
  if (!deps.some((d) => UI_DEPS.includes(d))) return undefined;
  const scriptDir = (html: string | undefined, base: string): string | undefined => {
    const src = html ? /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']|<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*\btype=["']module["']/i.exec(html) : null;
    const file = src?.[1] ?? src?.[2];
    return file && !/^[a-z]+:/i.test(file) ? posix.dirname(joinDir(base, file.replace(/^\//, ''))) : undefined;
  };
  const candidates: string[] = [];
  for (const name of ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs']) {
    const root = /\broot\s*:\s*['"`]([^'"`]+)['"`]/.exec(read(at(name)) ?? '')?.[1];
    if (root) candidates.push(joinDir(dir, root));
  }
  const fromHtml = scriptDir(read(at('index.html')), dir);
  if (fromHtml !== undefined) candidates.push(fromHtml === '.' ? '' : fromHtml);
  for (const w of WEB_DIRS) candidates.push(joinDir(dir, w));
  const own = code.filter((f) => within(f, dir) && !isTestPath(f));
  for (const web of candidates) {
    if (web === dir || !within(web, dir)) continue;
    if (!own.some((f) => within(f, web) && UI_FILE.test(f))) continue;
    // Other code: a file outside the web folder, in a subfolder of the package (not a config file at its root).
    const rest = own.filter((f) => !within(f, web) && posix.dirname(f) !== (dir === '' ? '.' : dir));
    if (rest.length > 0) return web;
  }
  return undefined;
}

/** The projects of the repo, and the project of each file. */
export function findUnits(input: UnitInput): { units: Unit[]; unitOf: (file: string) => Unit } {
  const dirs = new Set<string>();
  for (const m of input.manifests) {
    if (isTestPath(m) || SKIP.test(m)) continue;
    const d = posix.dirname(m);
    dirs.add(d === '.' ? '' : d);
  }
  // The JavaScript, Python and Go roots: the nearest folder above a source file with a root file.
  const rootOf = new Map<string, string | null>();
  const findRoot = (dir: string, names: string[]): string | null => {
    const key = `${names[0]}:${dir}`;
    if (rootOf.has(key)) return rootOf.get(key)!;
    let found: string | null = null;
    if (names.some((f) => input.read(dir === '' ? f : `${dir}/${f}`) !== undefined)) found = dir;
    else if (dir !== '') found = findRoot(posix.dirname(dir) === '.' ? '' : posix.dirname(dir), names);
    rootOf.set(key, found);
    return found;
  };
  for (const [file, lang] of input.files) {
    if (isTestPath(file) || SKIP.test(file)) continue;
    const names = lang === 'python' ? PYTHON_ROOTS : lang === 'go' ? GO_ROOTS : JS_LANGS.has(lang) ? JS_ROOTS : undefined;
    if (!names) continue;
    const d = posix.dirname(file);
    const root = findRoot(d === '.' ? '' : d, names);
    if (root !== null) dirs.add(root);
  }
  if (dirs.size > 1) dirs.delete('');
  // Only the folders with code.
  const code = [...input.files.keys()].filter((f) => !SKIP.test(f));
  const used = [...dirs].filter((d) => code.some((f) => within(f, d)));
  const named = used.map((dir) => ({ dir, name: nameOf(dir, input.read) }));
  // Two projects with one name: both use the folder as the name.
  const count = new Map<string, number>();
  for (const u of named) count.set(u.name, (count.get(u.name) ?? 0) + 1);
  const units: Unit[] = named.map(({ dir, name }) => {
    const label = (count.get(name) ?? 0) > 1 ? (dir === '' ? name : dir) : name;
    return { key: label, name: label, dir };
  });
  // The web part of a package that holds other code too.
  for (const u of [...units]) {
    if (input.read(u.dir === '' ? 'package.json' : `${u.dir}/package.json`) === undefined) continue;
    const web = webDirOf(u.dir, code, input.read);
    if (web === undefined || units.some((x) => x.dir === web)) continue;
    const key = `${u.name}-${posix.basename(web)}`;
    if (units.some((x) => x.key === key)) continue;
    units.push({ key, name: key, dir: web, part: 'web' });
  }
  const deepest = [...units].sort((a, b) => b.dir.length - a.dir.length);
  const extra = new Map<string, Unit>();
  const cache = new Map<string, Unit>();
  const unitOf = (file: string): Unit => {
    const hit = cache.get(file);
    if (hit) return hit;
    let u = deepest.find((x) => x.dir !== '' && within(file, x.dir)) ?? units.find((x) => x.dir === '');
    if (!u) {
      const top = file.includes('/') ? file.split('/')[0]! : '.';
      const key = `dir:${top}`;
      u = extra.get(key);
      if (!u) extra.set(key, (u = { key, name: top === '.' ? '(repo root)' : `${top}/`, dir: top === '.' ? '' : top }));
    }
    cache.set(file, u);
    return u;
  };
  for (const f of code) unitOf(f);
  return { units: [...units, ...extra.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)), unitOf };
}
