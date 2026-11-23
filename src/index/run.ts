// Make or rebuild the CodeGraph index of a repo with the CodeGraph CLI of the package
// (`@colbymchenry/codegraph`). CodeGraph writes only `<repo>/.codegraph/`.
//
// CodeGraph has anonymous telemetry. The atlas always turns it off: each CodeGraph process gets
// CODEGRAPH_TELEMETRY=0 and DO_NOT_TRACK=1 in its env.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { hasIndex } from './codegraph.js';

/** The env that turns off the CodeGraph telemetry. */
export const NO_TELEMETRY = { CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1' } as const;

/** Set the telemetry env in this process, before it loads CodeGraph code. */
export function telemetryOff(): void {
  Object.assign(process.env, NO_TELEMETRY);
}

/** The file of the CodeGraph CLI in node_modules. */
export function codegraphCli(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('@colbymchenry/codegraph/package.json')), 'npm-shim.js');
}

export interface IndexRun {
  ms: number;
  /** `init` for a first index, `index` for a full rebuild. */
  verb: 'init' | 'index';
}

/**
 * Index the repo. With no index it runs `codegraph init -y`, else `codegraph index` (a full rebuild).
 * `log` gets the output lines of CodeGraph.
 */
export function runCodegraph(repo: string, opts: { log?: (line: string) => void } = {}): Promise<IndexRun> {
  const verb = hasIndex(repo) ? 'index' : 'init';
  const args = verb === 'init' ? ['init', '-y', repo] : ['index', repo];
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [codegraphCli(), ...args], {
      cwd: repo,
      env: { ...process.env, ...NO_TELEMETRY },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines = (chunk: Buffer) => {
      for (const l of chunk.toString('utf8').split(/\r?\n|\r/)) if (l.trim() !== '') opts.log?.(l);
    };
    child.stdout.on('data', lines);
    child.stderr.on('data', lines);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && hasIndex(repo)) resolve({ ms: performance.now() - start, verb });
      else reject(new Error(`CodeGraph ${verb} stopped with code ${code}.`));
    });
  });
}
