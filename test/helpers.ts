// The test helpers of the atlas: a copy of the `shop` fixture in a temporary folder, indexed with
// the CodeGraph CLI (telemetry off). The fixture has a frontend (web), an api and a command-line
// tool (tool). The index is made once for each test file.

import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodeGraphIndex } from '../src/index/codegraph.js';
import { runCodegraph } from '../src/index/run.js';
import { Atlas } from '../src/server/model.js';

export const FIXTURE = fileURLToPath(new URL('./fixtures/shop', import.meta.url));

export interface Shop {
  root: string;
  index: CodeGraphIndex;
  atlas: Atlas;
}

/** Copy a fixture to a temporary folder and make its CodeGraph index there. */
export async function indexedCopy(fixture: string, name: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-test-'));
  const root = join(dir, name);
  cpSync(fixture, root, { recursive: true });
  await runCodegraph(root);
  return root;
}

/** Index a copy of the shop fixture and make the atlas of it. */
export async function shop(): Promise<Shop> {
  const root = await indexedCopy(FIXTURE, 'shop');
  const index = CodeGraphIndex.open(root);
  const atlas = await Atlas.build(index, root);
  return { root, index, atlas };
}

/**
 * The ID of a code node from a path and a name: `web/src/App.tsx/App().` is the function `App` in
 * the file `web/src/App.tsx`.
 */
export function fnId(atlas: Atlas, end: string): string {
  const m = /^(.+\.[a-z]+)\/([\w$#.]+?)\(?\)?\.?$/.exec(end);
  if (!m) throw new Error(`Not a path and a name: ${end}`);
  const [, file, name] = m as unknown as [string, string, string];
  const short = name.split(/[#.]/).at(-1)!;
  const hit = [...atlas.map.code.values()].find((c) => c.node.file === file && c.node.name === short && c.node.kind !== 'file');
  if (!hit) throw new Error(`No code node ${short} in ${file}`);
  return hit.node.id;
}
