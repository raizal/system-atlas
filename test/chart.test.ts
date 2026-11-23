// The flow chart drops the statements that do nothing: a Python docstring, a JS directive, a comment.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeChart, type ChartSource } from '../src/flow/chart.js';
import type { GraphNode } from '../src/index/types.js';

const chartOf = async (file: string, text: string, language: string) => {
  const root = mkdtempSync(join(tmpdir(), 'atlas-chart-'));
  writeFileSync(join(root, file), text);
  const node: GraphNode = { id: 'function:1', kind: 'function', name: 'upload', file, range: `1-${text.trimEnd().split('\n').length}`, language };
  const store: ChartSource = { node: (id) => (id === node.id ? node : undefined), callSites: () => [], libSites: () => [] };
  return codeChart(store, root, node.id);
};

describe('the steps of a flow chart', () => {
  it('drops a Python docstring', async () => {
    const c = await chartOf('up.py', 'def upload(f):\n    """Upload a file to org storage.\n\n    More text.\n    """\n    size = len(f)\n    return size\n', 'python');
    expect(c.ok).toBe(true);
    const text = c.nodes.map((n) => `${n.label} ${n.text ?? ''}`).join('\n');
    expect(text).not.toContain('"""');
    expect(text).not.toContain('Upload a file');
    expect(text).toContain('size = len(f)');
  });

  it('drops a JS directive and the leading comments', async () => {
    const c = await chartOf('up.ts', "function upload(f: string) {\n  'use strict';\n  // Upload the file.\n  /* more */\n  const size = f.length;\n  return size;\n}\n", 'typescript');
    expect(c.ok).toBe(true);
    const text = c.nodes.map((n) => `${n.label} ${n.text ?? ''}`).join('\n');
    expect(text).not.toContain('use strict');
    expect(text).not.toContain('Upload the file');
    expect(text).toContain('const size = f.length');
  });
});
