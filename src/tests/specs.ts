// The e2e spec files of a repo: the specs of each Playwright config (its testDir, testMatch and
// testIgnore, or the defaults), and the Cypress specs (`*.cy.ts`). The atlas reads the config as
// text: it does not run it.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { SpecFile } from './types.js';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', '.codegraph', '.venv', 'venv', '__pycache__', 'playwright-report', 'test-results', '.turbo', '.cache']);
const CONFIG = /^playwright(?:\.[\w-]+)?\.config\.[cm]?[jt]s$/;
/** The default testMatch of Playwright. */
const DEFAULT_MATCH = /(^|\/)[^/]*\.(test|spec)\.[cm]?[jt]sx?$/;
const CYPRESS = /\.cy\.[cm]?[jt]sx?$/;
const MAX_FILES = 200_000;

export interface PlaywrightProject {
  name?: string;
  /** The test folder of the project from the repo root. */
  testDir: string;
  match: RegExp[];
  ignore: RegExp[];
  /** A setup or teardown project: another project depends on it, or its name says so. */
  setup?: boolean;
}

export interface PlaywrightConfig {
  /** The config file from the repo root. */
  file: string;
  /** The folder of the config from the repo root ('' for the root). */
  dir: string;
  /** The test folder from the repo root. */
  testDir: string;
  match: RegExp[];
  ignore: RegExp[];
  /** The baseURL of `use`, if it is a plain string. */
  baseURL?: string;
  /** The projects of the config. No projects: the top-level settings only. */
  projects: PlaywrightProject[];
  /** The middle word of `playwright.<tag>.config.ts` ("demo", "staging"). No tag: the main config. */
  tag?: string;
  /** The config drives a live stack (a real API, database or mail): the atlas does not run it. */
  live?: boolean;
}

/** The names of a config file that say "a live stack, not mocks". */
const LIVE_TAG = /golden|live|staging|prod/i;

/** A glob of Playwright (`**\/*.e2e.ts`, `*.spec.ts`) as a regex on the path from the test folder. */
export function globRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += glob[i + 2] === '/' ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) re += '\\{';
      else {
        re += `(?:${glob.slice(i + 1, end).split(',').map((p) => p.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  // A glob with no folder part fits the file name in each folder.
  return new RegExp(glob.includes('/') ? `^${re}$` : `(^|/)${re}$`);
}

// ---------------------------------------------------------------- a small reader of config text

/** The text with the comments replaced by spaces (strings and regexes stay). */
function noComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      const j = skipString(text, i);
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && regexStart(text, i)) {
      const j = skipRegex(text, i);
      out += text.slice(i, j + 1);
      i = j;
    } else out += c;
  }
  return out;
}

/** The index of the closing quote of the string at `i`. */
function skipString(text: string, i: number): number {
  const q = text[i];
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === q) return j;
  }
  return text.length - 1;
}

/** A `/` at `i` starts a regex (not a division): the code before it is an operator or a bracket. */
function regexStart(text: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0 && /\s/.test(text[k]!)) k--;
  return k < 0 || /[(,=:[!&|?{};]/.test(text[k]!);
}

function skipRegex(text: string, i: number): number {
  let cls = false;
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j]!;
    if (c === '\\') j++;
    else if (c === '[') cls = true;
    else if (c === ']') cls = false;
    else if (c === '/' && !cls) {
      while (/[a-z]/.test(text[j + 1] ?? '')) j++;
      return j;
    } else if (c === '\n') return j;
  }
  return text.length - 1;
}

/** The index of the bracket that closes the one at `i` (`{`, `[` or `(`). */
function closeOf(text: string, i: number): number {
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j]!;
    if (c === "'" || c === '"' || c === '`') j = skipString(text, j);
    else if (c === '/' && regexStart(text, j)) j = skipRegex(text, j);
    else if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return text.length - 1;
}

/** The end of the value that starts at `i`: the next `,` or the end of the text, at bracket depth 0. */
function valueEnd(text: string, i: number): number {
  for (let j = i; j < text.length; j++) {
    const c = text[j]!;
    if (c === "'" || c === '"' || c === '`') j = skipString(text, j);
    else if (c === '/' && regexStart(text, j)) j = skipRegex(text, j);
    else if (c === '{' || c === '[' || c === '(') j = closeOf(text, j);
    else if (c === ',' || c === '}' || c === ']' || c === ')') return j;
  }
  return text.length;
}

/** The keys of an object body (the text between `{` and `}`), at its own depth only. */
function keysOf(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    const m = /^\s*(?:\.\.\.[\w$.]+|['"]?([\w$]+)['"]?\s*:\s*)/.exec(body.slice(i));
    if (!m) {
      const end = valueEnd(body, i);
      i = end + 1;
      continue;
    }
    const start = i + m[0].length;
    const end = valueEnd(body, start);
    if (m[1] && !out.has(m[1])) out.set(m[1], body.slice(start, end).trim());
    i = end + 1;
  }
  return out;
}

/** The items of an array text (`[a, 'b', ...C]`). */
function itemsOf(arr: string): string[] {
  const body = arr.trim().replace(/^\[/, '').replace(/\]$/, '');
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    const end = valueEnd(body, i);
    const item = body.slice(i, end).trim();
    if (item) out.push(item);
    i = end + 1;
  }
  return out;
}

/** The `const NAME = value` lines of a file. */
function constsOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*/g)) {
    const start = m.index + m[0].length;
    out.set(m[1]!, text.slice(start, valueEnd(text, start)).trim());
  }
  return out;
}

/** The patterns of a value: a string, a regex, a const, or an array of them. Unknown parts give no pattern. */
function patternsOf(value: string, consts: Map<string, string>, depth = 0): RegExp[] {
  const v = value.trim();
  if (depth > 5) return [];
  if (v.startsWith('[')) return itemsOf(v).flatMap((x) => patternsOf(x.replace(/^\.\.\./, ''), consts, depth + 1));
  const str = /^(['"`])([^]*)\1$/.exec(v);
  if (str) return str[1] === '`' && str[2]!.includes('${') ? [] : [globRegex(str[2]!)];
  const re = /^\/((?:\\.|[^/\\])+)\/([a-z]*)$/.exec(v);
  if (re) {
    try {
      return [new RegExp(re[1]!, re[2]!.replace(/[gy]/g, ''))];
    } catch {
      // A regex that JavaScript cannot read: no pattern.
      return [];
    }
  }
  if (/^[\w$]+$/.test(v) && consts.has(v)) return patternsOf(consts.get(v)!, consts, depth + 1);
  return [];
}

function stringOf(value: string | undefined): string | undefined {
  return value ? /^(['"`])([^'"`$]+)\1$/.exec(value.trim())?.[2] : undefined;
}

/** The body of the config object: `defineConfig({...})`, `export default {...}` or `module.exports = {...}`. */
function configBody(text: string): string {
  const m = /\bdefineConfig\s*\(\s*\{|export\s+default\s+\{|module\.exports\s*=\s*\{/.exec(text);
  if (!m) return text;
  const open = m.index + m[0].length - 1;
  return text.slice(open + 1, closeOf(text, open));
}

/** The test settings of one Playwright config file, read as text: the top level and each project. */
export function readConfig(file: string, raw: string): PlaywrightConfig {
  const text = noComments(raw);
  const dir = posix.dirname(file) === '.' ? '' : posix.dirname(file);
  const consts = constsOf(text);
  const top = keysOf(configBody(text));
  const folder = (td: string | undefined, from: string) => posix.normalize(posix.join(from, td ?? '.')).replace(/^\.$/, '').replace(/\/$/, '');
  const testDir = folder(stringOf(top.get('testDir')), dir);
  const match = top.has('testMatch') ? patternsOf(top.get('testMatch')!, consts) : [DEFAULT_MATCH];
  const ignore = top.has('testIgnore') ? patternsOf(top.get('testIgnore')!, consts) : [];
  const use = top.get('use');
  const base = use?.startsWith('{') ? stringOf(keysOf(use.slice(1, -1)).get('baseURL')) : undefined;
  const projects: PlaywrightProject[] = [];
  const list = top.get('projects');
  const needed = new Set<string>();
  if (list?.startsWith('[')) {
    for (const item of itemsOf(list)) {
      if (!item.startsWith('{')) continue;
      const k = keysOf(item.slice(1, -1));
      for (const key of ['dependencies', 'teardown']) {
        const v = k.get(key);
        if (v) for (const d of v.startsWith('[') ? itemsOf(v) : [v]) if (stringOf(d)) needed.add(stringOf(d)!);
      }
      const name = stringOf(k.get('name'));
      const td = stringOf(k.get('testDir'));
      projects.push({
        ...(name ? { name } : {}),
        testDir: td ? folder(td, dir) : testDir,
        match: k.has('testMatch') ? patternsOf(k.get('testMatch')!, consts) : match,
        ignore: k.has('testIgnore') ? patternsOf(k.get('testIgnore')!, consts) : ignore,
      });
    }
    for (const p of projects) if (p.name && (needed.has(p.name) || /setup|teardown/i.test(p.name))) p.setup = true;
  }
  const tag = /^playwright\.([\w-]+)\.config\./.exec(posix.basename(file))?.[1];
  return { file, dir, testDir, match, ignore, ...(base ? { baseURL: base } : {}), projects, ...(tag ? { tag } : {}), ...(tag && LIVE_TAG.test(tag) ? { live: true } : {}) };
}

/** Does the config run the file? `setup`: only its setup projects run it. */
export function configRuns(c: PlaywrightConfig, f: string): { setup: boolean } | undefined {
  const runs = (p: Pick<PlaywrightProject, 'testDir' | 'match' | 'ignore'>) => {
    if (p.testDir !== '' && !f.startsWith(`${p.testDir}/`)) return false;
    const rel = p.testDir === '' ? f : f.slice(p.testDir.length + 1);
    return p.match.some((r) => r.test(rel)) && !p.ignore.some((r) => r.test(rel));
  };
  const projects = c.projects.length > 0 ? c.projects : [c];
  const hits = projects.filter(runs);
  if (hits.length === 0) return undefined;
  return { setup: hits.every((p) => 'setup' in p && p.setup === true) };
}

/** All the files of the repo, from the root, with no build or package folders. */
export function repoFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    let names: string[];
    try {
      names = readdirSync(join(root, rel));
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (out.length >= MAX_FILES) return;
      if (SKIP.has(name)) continue;
      const r = rel ? `${rel}/${name}` : name;
      let dir = false;
      try {
        dir = statSync(join(root, r)).isDirectory();
      } catch {
        continue;
      }
      if (dir) walk(r);
      else out.push(r);
    }
  };
  walk('');
  return out;
}

/** The Playwright configs and the spec files of a repo. A spec that several configs run has all of them. */
export function findSpecs(root: string, files: readonly string[] = repoFiles(root)): { configs: PlaywrightConfig[]; specs: SpecFile[] } {
  const configs: PlaywrightConfig[] = [];
  for (const f of files) {
    if (!CONFIG.test(posix.basename(f))) continue;
    try {
      configs.push(readConfig(f, readFileSync(join(root, f), 'utf8')));
    } catch {
      // A config that the atlas cannot read: no specs from it.
    }
  }
  const specs: SpecFile[] = [];
  for (const f of files) {
    if (CYPRESS.test(f)) {
      specs.push({ file: f, runner: 'cypress' });
      continue;
    }
    if (!/\.[cm]?[jt]sx?$/.test(f)) continue;
    const hits = configs.map((c) => ({ c, r: configRuns(c, f) })).filter((h): h is { c: PlaywrightConfig; r: { setup: boolean } } => h.r !== undefined);
    if (hits.length === 0) continue;
    // The nearest configs only: a spec goes to the configs of the deepest folder.
    const deep = Math.max(...hits.map((h) => h.c.dir.length));
    const near = hits.filter((h) => h.c.dir.length === deep);
    // The main config first (no tag), then a config that is not a live stack.
    const main = near.find((h) => !h.c.tag) ?? near.find((h) => !h.c.live) ?? near[0]!;
    specs.push({
      file: f,
      runner: 'playwright',
      config: main.c.file,
      ...(near.length > 1 ? { configs: near.map((h) => h.c.file) } : {}),
      ...(main.c.tag ? { tag: main.c.live ? `${main.c.tag} (live stack)` : main.c.tag } : {}),
      ...(near.every((h) => h.r.setup) ? { setup: true } : {}),
    });
  }
  return { configs, specs };
}

/** A loader of the relative imports of a spec (`./fixtures`, `../helpers/login`), from the repo root. */
export function fileLoader(root: string): (from: string, spec: string) => { file: string; text: string } | undefined {
  const cache = new Map<string, { file: string; text: string } | undefined>();
  return (from, spec) => {
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    if (base.startsWith('..')) return undefined;
    if (cache.has(base)) return cache.get(base);
    let hit: { file: string; text: string } | undefined;
    for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js']) {
      const f = base + ext;
      try {
        if (!statSync(join(root, f)).isFile()) continue;
        hit = { file: f, text: readFileSync(join(root, f), 'utf8') };
        break;
      } catch {
        // Not this name: try the next one.
      }
    }
    cache.set(base, hit);
    return hit;
  };
}
