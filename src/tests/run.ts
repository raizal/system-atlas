// `atlas test`: run the Playwright specs of a repo with a trace and the JSON reporter. The report and
// the traces go to the cache folder of the atlas (see results.ts), not to the repo. The command uses
// the Playwright of the repo (`npx --no-install playwright`). It does not run:
//   - a spec with no Playwright config (Cypress, or no config),
//   - a test automation project (`qa-tests`, `acceptance-tests`: it often needs the secrets of a shared stage),
//   - a config whose baseURL is not on this computer,
//   - a config of a live stack (playwright.staging.config.ts: a real API, database and mail),
//   - a setup file alone (Playwright runs it before the specs that need it).

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runsDir } from './results.js';
import type { PlaywrightConfig } from './specs.js';
import type { SpecFile } from './types.js';

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i;

export interface TestPlan {
  config: PlaywrightConfig;
  /** The spec files to run, from the repo root. No value: all the specs of the config. */
  specs: string[];
  cwd: string;
  args: string[];
  env: Record<string, string>;
  /** The folder of this run in the cache. */
  out: string;
}

/** The plan of a run, or the reason that the atlas does not run it. */
export function planRun(root: string, configs: PlaywrightConfig[], specs: SpecFile[], opts: { spec?: string; grep?: string; now?: Date; env?: NodeJS.ProcessEnv }): TestPlan | string {
  let config: PlaywrightConfig | undefined;
  let chosen: string[] = [];
  if (opts.spec) {
    const want = opts.spec.replace(/^\.\//, '');
    const hits = specs.filter((s) => s.file === want || s.file.endsWith(`/${want}`));
    if (hits.length === 0) return `No spec file ${opts.spec} in the repo.`;
    if (hits.length > 1) return `More than one spec file fits ${opts.spec}: ${hits.map((h) => h.file).join(', ')}.`;
    const spec = hits[0]!;
    if (spec.runner !== 'playwright' || !spec.config) return `${spec.file} has no Playwright config. The atlas runs Playwright specs only.`;
    if (spec.setup) return `${spec.file} is a setup file. Playwright runs it before the specs that need it: give a spec.`;
    config = configs.find((c) => c.file === spec.config);
    chosen = [spec.file];
  } else {
    const withSpecs = configs.filter((c) => specs.some((s) => s.config === c.file && !s.setup));
    if (withSpecs.length === 0) return 'The repo has no Playwright config with specs.';
    // Without a spec, the main configs only (no tag such as "demo" or "staging").
    const main = withSpecs.filter((c) => !c.tag);
    if (main.length === 1) config = main[0];
    else if (withSpecs.length > 1) return `The repo has more than one Playwright config (${withSpecs.map((c) => c.file).join(', ')}). Give a spec file.`;
    else config = withSpecs[0];
  }
  if (!config) return 'The atlas did not find the Playwright config of the spec.';
  if (/(^|\/)[\w-]*(automation|qa|acceptance)[-_]?tests?\//i.test(config.file)) return `The atlas does not run ${config.file}: a test automation project often needs the secrets of a shared stage. Run it yourself.`;
  if (config.live) return `The atlas does not run ${config.file}: it drives a live stack (a real API, database and mail). Run it yourself.`;
  if (config.baseURL && !LOCAL.test(config.baseURL)) return `The baseURL of ${config.file} is ${config.baseURL}, not on this computer. The atlas runs local tests only.`;
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const out = join(runsDir(root, opts.env), stamp);
  const cwd = join(root, config.dir);
  const args = ['--no-install', 'playwright', 'test', '-c', join(root, config.file), ...chosen.map((s) => relative(cwd, join(root, s))), ...(opts.grep ? ['-g', opts.grep] : []), '--trace', 'on', '--reporter', 'json', '--output', join(out, 'test-results')];
  return { config, specs: chosen, cwd, args, env: { PLAYWRIGHT_JSON_OUTPUT_NAME: join(out, 'report.json'), CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1' }, out };
}

/** Run the plan. The output of Playwright goes to `log`. The exit code of Playwright. */
export function runPlan(plan: TestPlan, log: (text: string) => void): Promise<number> {
  mkdirSync(plan.out, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', plan.args, { cwd: plan.cwd, env: { ...process.env, ...plan.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (b: Buffer) => log(b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => log(b.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}
