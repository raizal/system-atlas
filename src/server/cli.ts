// The `atlas` command:
//   atlas index <repo>                 make the CodeGraph index of the repo, or rebuild it
//   atlas serve <repo> [--port 4890] [--results <dir>]
//                                      serve the page; with no index, make it first. --results: read
//                                      the Playwright JSON report and traces in <dir> (else the last
//                                      run of `atlas test`)
//   atlas test <repo> [<spec>] [-g <name>]
//                                      run the Playwright specs with a trace and the JSON reporter;
//                                      the results go to the cache folder of the atlas, not to the repo
// CodeGraph writes the index to <repo>/.codegraph/. The atlas itself writes nothing in the repo.
// CodeGraph telemetry is off: CODEGRAPH_TELEMETRY=0 and DO_NOT_TRACK=1 (see run.ts).

import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodeGraphIndex, CODEGRAPH_DIR, hasIndex } from '../index/codegraph.js';
import { runCodegraph, telemetryOff } from '../index/run.js';
import { DEFAULT_PORT, startServer } from './http.js';
import { lensIndex } from './lens.js';
import { Atlas } from './model.js';
import { TestModel } from './tests.js';
import { findSpecs } from '../tests/specs.js';
import { planRun, runPlan } from '../tests/run.js';

telemetryOff();

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
}

const USAGE = `Usage:
  atlas index <repo>
  atlas serve <repo> [--port ${DEFAULT_PORT}] [--results <dir>]
  atlas test <repo> [<spec>] [-g <name>]
`;

interface Args {
  verb: 'index' | 'serve' | 'test';
  dir: string;
  port: number;
  results?: string;
  spec?: string;
  grep?: string;
}

export function parseArgs(argv: string[]): Args | string {
  const [verb, ...rest] = argv;
  if (verb !== 'index' && verb !== 'serve' && verb !== 'test') return verb === undefined || verb === '--help' || verb === '-h' ? '' : `Unknown command: ${verb}`;
  let dir: string | undefined;
  let port = DEFAULT_PORT;
  let results: string | undefined;
  let spec: string | undefined;
  let grep: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--port') {
      if (verb !== 'serve') return 'Use --port with serve only.';
      port = Number(rest[++i]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) return 'The port must be a number from 0 to 65535.';
    } else if (a === '--results') {
      if (verb !== 'serve') return 'Use --results with serve only.';
      results = rest[++i];
      if (!results) return 'Give the results folder after --results.';
    } else if (a === '-g' || a === '--grep') {
      if (verb !== 'test') return 'Use -g with test only.';
      grep = rest[++i];
      if (!grep) return 'Give the test name after -g.';
    } else if (a.startsWith('-')) return `Unknown option: ${a}`;
    else if (dir === undefined) dir = a;
    else if (verb === 'test' && spec === undefined) spec = a;
    else return `Too many arguments: ${a}`;
  }
  if (dir === undefined) return 'Give the repo folder.';
  return { verb, dir, port, ...(results ? { results } : {}), ...(spec ? { spec } : {}), ...(grep ? { grep } : {}) };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export async function main(argv: string[], io: Io): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    if (args !== '') io.stderr(`${args}\n`);
    io.stderr(USAGE);
    return args === '' ? 0 : 2;
  }
  const root = resolve(args.dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    io.stderr(`The folder ${root} does not exist.\n`);
    return 2;
  }
  if (args.verb === 'test') return runTests(root, args, io);
  if (args.verb === 'index' || !hasIndex(root)) {
    const what = hasIndex(root) ? 'Rebuild the CodeGraph index' : 'Make the CodeGraph index';
    io.stdout(`${what}. This writes ${join(root, CODEGRAPH_DIR)}/ ...\n`);
    try {
      const run = await runCodegraph(root);
      io.stdout(`Indexed in ${seconds(run.ms)}.\n`);
    } catch (err) {
      io.stderr(`${(err as Error).message}\n`);
      return 1;
    }
    if (args.verb === 'index') return 0;
  } else {
    io.stdout(`Use the CodeGraph index in ${join(root, CODEGRAPH_DIR)}/. Run \`atlas index ${args.dir}\` to rebuild it.\n`);
  }
  const start = performance.now();
  const index = CodeGraphIndex.open(root);
  const atlas = await Atlas.build(index, root);
  const web = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
  if (args.results && !existsSync(resolve(args.results))) {
    io.stderr(`The results folder ${resolve(args.results)} does not exist.\n`);
    return 2;
  }
  const tests = new TestModel(atlas, args.results ? resolve(args.results) : undefined);
  const { url } = await startServer({ atlas, tests, port: args.port, ...(existsSync(join(web, 'index.html')) ? { web } : {}) });
  io.stdout(`Read ${atlas.projects.size} projects in ${seconds(performance.now() - start)}. The atlas is at ${url}\n`);
  if (args.results) io.stdout(`The Tests mode reads the results in ${resolve(args.results)}.\n`);
  // Make the test coverage now, so that the page gets it fast. An error shows on the request.
  setTimeout(() => void tests.coverage().then(() => lensIndex(atlas, tests)).catch(() => undefined), 0);
  return await new Promise<number>(() => undefined);
}

/** `atlas test`: run the Playwright specs; the report and traces go to the cache folder. */
async function runTests(root: string, args: Args, io: Io): Promise<number> {
  const { configs, specs } = findSpecs(root);
  const plan = planRun(root, configs, specs, { ...(args.spec ? { spec: args.spec } : {}), ...(args.grep ? { grep: args.grep } : {}) });
  if (typeof plan === 'string') {
    io.stderr(`${plan}\n`);
    return 2;
  }
  io.stdout(`Run Playwright (${plan.config.file}) with a trace. The results go to ${plan.out}/ (not to the repo).\n`);
  let code: number;
  try {
    code = await runPlan(plan, (t) => io.stdout(t));
  } catch (err) {
    io.stderr(`Playwright did not start: ${(err as Error).message}\n`);
    return 1;
  }
  io.stdout(`Playwright stopped with code ${code}. The report is ${join(plan.out, 'report.json')}. Run \`atlas serve ${args.dir}\` and open the Tests mode.\n`);
  return code;
}
