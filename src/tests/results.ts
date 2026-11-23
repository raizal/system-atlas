// The results of an e2e run: a Playwright JSON report and the trace.zip files that it points to.
// `atlas test` writes them to the cache folder of the atlas (not to the repo). `atlas serve --results
// <dir>` reads a report and traces that the person made.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { readTrace } from './trace.js';
import type { CaseResult, RunStatus } from './types.js';

/** The cache folder of the atlas for one repo: `$ATLAS_CACHE_DIR`, or `$XDG_CACHE_HOME/system-atlas`, or `~/.cache/system-atlas`. */
export function cacheDir(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.ATLAS_CACHE_DIR || join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'system-atlas');
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 12);
  return join(base, `${basename(root).replace(/[^\w.-]/g, '_')}-${hash}`);
}

/** The folder of the runs of a repo. */
export const runsDir = (root: string, env?: NodeJS.ProcessEnv) => join(cacheDir(root, env), 'runs');

/** The newest run folder with a report, if there is one. */
export function lastRun(root: string, env?: NodeJS.ProcessEnv): string | undefined {
  const dir = runsDir(root, env);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const n of names.sort().reverse()) if (existsSync(join(dir, n, 'report.json'))) return join(dir, n);
  return undefined;
}

/** A result of one case, with the spec file as it is in the report. */
export interface ReportCase {
  /** The spec file from the rootDir of the report (the testDir of the config). */
  file: string;
  /** The spec file as an absolute path, if the report has its rootDir. */
  path?: string;
  line: number;
  title: string;
  result: CaseResult;
}

interface JsonResult {
  status?: string;
  duration?: number;
  startTime?: string;
  error?: { message?: string; location?: { file?: string; line?: number } };
  errors?: Array<{ message?: string; location?: { file?: string; line?: number } }>;
  attachments?: Array<{ name?: string; path?: string; contentType?: string }>;
}
interface JsonSpec {
  title?: string;
  file?: string;
  line?: number;
  tests?: Array<{ status?: string; results?: JsonResult[] }>;
}
interface JsonSuite {
  file?: string;
  specs?: JsonSpec[];
  suites?: JsonSuite[];
}

const STATUS: Record<string, RunStatus> = { passed: 'passed', failed: 'failed', skipped: 'skipped', timedOut: 'timedOut', interrupted: 'interrupted' };
// ANSI colour codes in the error text of the report.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** The cases of a Playwright JSON report. `dir` is the folder of the report: a trace path that is not there is looked for in it. */
export function readReport(text: string, dir?: string): ReportCase[] {
  const json = JSON.parse(text) as { config?: { rootDir?: string }; suites?: JsonSuite[] };
  const rootDir = json.config?.rootDir;
  const out: ReportCase[] = [];
  const traces = dir ? traceFiles(dir) : [];
  const walk = (s: JsonSuite) => {
    for (const spec of s.specs ?? []) {
      const file = spec.file ?? s.file;
      if (!file || spec.line === undefined) continue;
      const test = spec.tests?.[0];
      const r = test?.results?.at(-1);
      if (!test || !r) continue;
      let status: RunStatus = STATUS[r.status ?? ''] ?? 'failed';
      if (test.status === 'flaky') status = 'flaky';
      const err = r.error ?? r.errors?.[0];
      let trace = r.attachments?.find((a) => a.name === 'trace' && a.path)?.path;
      if (trace && !existsSync(trace) && dir) {
        // A report from another folder or machine: the trace with the same test folder name in `dir`.
        const want = trace.split(/[\\/]/).slice(-2).join('/');
        trace = traces.find((t) => t.split(sep).slice(-2).join('/') === want);
      }
      out.push({
        file,
        ...(rootDir ? { path: join(rootDir, file) } : {}),
        line: spec.line,
        title: spec.title ?? '',
        result: {
          status,
          duration: r.duration ?? 0,
          ...(r.startTime ? { startTime: r.startTime } : {}),
          ...(err?.message ? { error: { message: err.message.replace(ANSI, '').slice(0, 2000), ...(err.location?.file ? { file: err.location.file } : {}), ...(err.location?.line ? { line: err.location.line } : {}) } } : {}),
          ...(trace ? { trace } : {}),
        },
      });
    }
    for (const c of s.suites ?? []) walk(c);
  };
  for (const s of json.suites ?? []) walk(s);
  return out;
}

/** The trace.zip files in a folder, at any depth (not in node_modules). */
function traceFiles(dir: string, depth = 0): string[] {
  if (depth > 6) return [];
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (n === 'node_modules' || n.startsWith('.')) continue;
    const p = join(dir, n);
    try {
      if (statSync(p).isDirectory()) out.push(...traceFiles(p, depth + 1));
      else if (n.endsWith('.zip')) out.push(p);
    } catch {
      // Not readable: leave it out.
    }
  }
  return out;
}

/** The report in a results folder: `report.json`, or the first JSON file with `suites`. */
export function findReport(dir: string): string | undefined {
  if (existsSync(join(dir, 'report.json'))) return join(dir, 'report.json');
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return undefined;
  }
  for (const n of names) {
    try {
      const head = readFileSync(join(dir, n), 'utf8');
      if (/"suites"\s*:/.test(head)) return join(dir, n);
    } catch {
      // Not readable: try the next one.
    }
  }
  return undefined;
}

export interface Results {
  /** The folder of the results, for the page. */
  from: string;
  /** case ID (`<spec file from the repo root>:<line>`) → its result. */
  byCase: Map<string, CaseResult>;
}

/**
 * The results of a folder, by case ID. `specs` are the spec files of the repo (from its root): a
 * report case goes to the spec whose path ends with the file of the report.
 */
export function loadResults(dir: string, root: string, specs: readonly string[]): Results | undefined {
  const report = findReport(dir);
  if (!report) return undefined;
  let cases: ReportCase[];
  try {
    cases = readReport(readFileSync(report, 'utf8'), dir);
  } catch {
    return undefined;
  }
  const byCase = new Map<string, CaseResult>();
  for (const c of cases) {
    let file: string | undefined;
    if (c.path && isAbsolute(c.path)) {
      const rel = relative(root, c.path).split(sep).join('/');
      if (!rel.startsWith('..') && specs.includes(rel)) file = rel;
    }
    file ??= specs.find((s) => s === c.file || s.endsWith(`/${c.file}`));
    if (!file) continue;
    const result = c.result;
    if (result.trace) {
      const requests = readTrace(result.trace).map((r) => {
        if (!r.file) return r;
        const rel = isAbsolute(r.file) ? relative(root, r.file).split(sep).join('/') : r.file;
        // A trace from another folder: the spec or helper path from the end.
        const own = rel.startsWith('..') ? (specs.find((s) => r.file!.endsWith(`/${s}`)) ?? r.file) : rel;
        return { ...r, file: own };
      });
      if (requests.length > 0) result.requests = requests;
    }
    byCase.set(`${file}:${c.line}`, result);
  }
  return { from: dir, byCase };
}
