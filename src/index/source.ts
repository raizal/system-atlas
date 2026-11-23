// What the flow chart reads from a CodeGraph index (the ChartSource of chart.ts):
//   callSites   the resolved calls of a function (and of the functions nested in it) to repo functions
//   libSites    the calls that CodeGraph did not resolve, bound to an outside package by the import
//               lines of the file: `import { useState } from 'react'` makes `useState()` a react call
// A call into the Python standard library, a relative import or a module of the repo is not an
// outside package. A Node.js builtin (`node:fs`, `path`) is the package `node`.

import { builtinModules } from 'node:module';
import type { CallSite, ChartLib, ChartSource } from '../flow/chart.js';
import type { CodeGraphIndex, ImportLine } from './codegraph.js';
import type { GraphNode } from './types.js';

const FN_KINDS = new Set(['function', 'method', 'class', 'route']);
const NODE_BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '').split('/')[0]!));

/** The Python standard library modules that code calls most. A call into one of them is not drawn. */
const PYTHON_STDLIB = new Set([
  'abc', 'argparse', 'ast', 'asyncio', 'base64', 'bisect', 'builtins', 'calendar', 'collections', 'concurrent', 'contextlib', 'copy', 'csv',
  'dataclasses', 'datetime', 'decimal', 'difflib', 'enum', 'errno', 'fnmatch', 'functools', 'gc', 'glob', 'gzip', 'hashlib', 'heapq', 'hmac',
  'html', 'http', 'importlib', 'inspect', 'io', 'ipaddress', 'itertools', 'json', 'logging', 'math', 'mimetypes', 'multiprocessing', 'operator',
  'os', 'pathlib', 'pickle', 'platform', 'pprint', 'queue', 'random', 're', 'secrets', 'select', 'shlex', 'shutil', 'signal', 'socket',
  'sqlite3', 'ssl', 'stat', 'statistics', 'string', 'struct', 'subprocess', 'sys', 'tempfile', 'textwrap', 'threading', 'time', 'timeit',
  'traceback', 'types', 'typing', 'unittest', 'urllib', 'uuid', 'warnings', 'weakref', 'xml', 'zipfile', 'zlib', 'zoneinfo',
]);

/** The local names that the import lines of a file bind, each to its module. */
export function importBindings(lines: readonly ImportLine[], language: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const { module, text } of lines) {
    const t = text.replace(/\s+/g, ' ').trim();
    if (language === 'python') {
      const from = /^from\s+(\S+)\s+import\s+\(?(.+?)\)?$/.exec(t);
      if (from) {
        for (const part of from[2]!.split(',')) {
          const m = /^\s*([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
          if (m) out.set(m[2] ?? m[1]!, from[1]!);
        }
        continue;
      }
      const imp = /^import\s+(.+)$/.exec(t);
      if (imp) {
        for (const part of imp[1]!.split(',')) {
          const m = /^\s*([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
          if (m) out.set(m[2] ?? m[1]!.split('.')[0]!, m[1]!);
        }
      }
      continue;
    }
    // TypeScript: `import X, { a as b, c } from 'm'`, `import * as ns from 'm'`, `import X = require('m')`.
    if (/^import\s+type\s/.test(t)) continue;
    const head = /^import\s+(.+?)\s+from\s+['"]/.exec(t)?.[1] ?? /^import\s+(\w+)\s*=\s*require\(/.exec(t)?.[1];
    if (!head) continue;
    const ns = /\*\s+as\s+([\w$]+)/.exec(head)?.[1];
    if (ns) out.set(ns, module);
    const def = /^([\w$]+)\s*(?:,|$)/.exec(head)?.[1];
    if (def) out.set(def, module);
    const named = /\{([^}]*)\}/.exec(head)?.[1];
    for (const part of named?.split(',') ?? []) {
      const m = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
      if (m && !/^\s*type\s/.test(part)) out.set(m[2] ?? m[1]!, module);
    }
  }
  return out;
}

/** The outside package of a module, or undefined for a module of the repo or of the language. */
export function packageOf(module: string, language: string, isRepoModule: (top: string) => boolean): string | undefined {
  if (language === 'python') {
    if (module.startsWith('.')) return undefined;
    const top = module.split('.')[0]!;
    if (PYTHON_STDLIB.has(top) || isRepoModule(top)) return undefined;
    return top;
  }
  if (module.startsWith('.') || module.startsWith('/') || module.startsWith('@/') || module.startsWith('~/')) return undefined;
  if (module.startsWith('node:') || NODE_BUILTINS.has(module.split('/')[0]!)) return 'node';
  const parts = module.split('/');
  return module.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export class IndexChartSource implements ChartSource {
  private readonly bindings = new Map<string, Map<string, string>>();
  private readonly pyModules = new Set<string>();

  constructor(private readonly index: CodeGraphIndex) {
    // The top Python modules of the repo: a file `x.py` or a folder `x/` with Python files.
    for (const [file, lang] of index.files) {
      if (lang !== 'python') continue;
      for (const part of file.replace(/\.py$/, '').split('/')) this.pyModules.add(part);
    }
  }

  node(id: string): GraphNode | undefined {
    return this.index.nodes.get(id);
  }

  callSites(id: string): CallSite[] {
    const out: CallSite[] = [];
    const seen = new Set<string>();
    for (const from of [id, ...this.index.inside(id)]) {
      for (const e of this.index.edgesFrom(from)) {
        if (e.kind !== 'calls' || e.line === undefined || e.trust === 'unresolved') continue;
        const to = this.index.nodes.get(e.to);
        if (!to?.file || !FN_KINDS.has(to.kind) || to.kind === 'route') continue;
        const key = `${e.line}\n${e.to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ line: e.line, trust: e.trust, fn: { id: to.id, name: to.name, kind: to.kind, file: to.file, line: Number(to.range?.split('-')[0] ?? 0), ...(to.range ? { range: to.range } : {}) } });
      }
    }
    return out.sort((a, b) => a.line - b.line || (a.fn.id < b.fn.id ? -1 : 1));
  }

  libSites(id: string): ChartLib[] {
    const n = this.index.nodes.get(id);
    if (!n?.file) return [];
    const language = n.language ?? 'typescript';
    let binds = this.bindings.get(n.file);
    if (!binds) this.bindings.set(n.file, (binds = importBindings(this.index.imports(n.file), language)));
    const out: ChartLib[] = [];
    const seen = new Set<string>();
    for (const c of this.index.openCalls([id, ...this.index.inside(id)])) {
      // `os.path.join` → os; `expect().toBe` → expect; `new Foo` → Foo.
      const parts = c.name.replace(/^new\s+/, '').split('.');
      const root = parts[0]!.replace(/\(\)$/, '');
      const module = binds.get(root);
      if (module === undefined) continue;
      const pkg = packageOf(module, language, (top) => this.pyModules.has(top));
      if (!pkg) continue;
      const name = parts.at(-1)!.replace(/\(\)$/, '');
      const key = `${c.line}\n${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ line: c.line, name, package: pkg });
    }
    return out.sort((a, b) => a.line - b.line || (a.name < b.name ? -1 : 1));
  }
}
