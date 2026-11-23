// The tree-sitter grammars: TypeScript, TSX and Python, as .wasm files for web-tree-sitter.
// The atlas parses a file only to draw a flow chart or to read HTTP client calls. CodeGraph makes
// the index; this is not a second index.

import { createRequire } from 'node:module';
import { Language, Parser, type Node } from 'web-tree-sitter';

export interface Grammars {
  typescript: Language;
  tsx: Language;
  python: Language;
}

let grammars: Promise<Grammars> | undefined;

export function loadGrammars(): Promise<Grammars> {
  grammars ??= (async () => {
    const require = createRequire(import.meta.url);
    await Parser.init();
    const [typescript, tsx, python] = await Promise.all([
      Language.load(require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm')),
      Language.load(require.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm')),
      Language.load(require.resolve('tree-sitter-python/tree-sitter-python.wasm')),
    ]);
    return { typescript, tsx, python };
  })();
  return grammars;
}

/** The value of a plain string literal, or undefined when it has an interpolation or an escape. */
export function stringValue(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'string') {
    const parts = node.namedChildren.filter((c) => c !== null);
    if (parts.some((c) => c.type === 'interpolation' || c.type === 'escape_sequence')) return undefined;
    return parts.filter((c) => c.type === 'string_fragment' || c.type === 'string_content').map((c) => c.text).join('');
  }
  if (node.type === 'template_string') {
    if (node.namedChildren.some((c) => c?.type === 'template_substitution')) return undefined;
    return node.text.slice(1, -1);
  }
  return undefined;
}

/** The node of the tree that spans exactly the rows `start` to `end` (0-based): a function or a class. */
export function spanning(n: Node, start: number, end: number): Node | undefined {
  const same = (c: Node) => c.startPosition.row === start && c.endPosition.row === end;
  let found: Node | undefined;
  const walk = (c: Node): void => {
    if (found) return;
    if (c.type !== 'program' && c.type !== 'module' && same(c)) {
      found = c;
      return;
    }
    if (c.startPosition.row <= start && c.endPosition.row >= end) for (const k of c.namedChildren) walk(k);
  };
  walk(n);
  while (found && !found.childForFieldName('name')) {
    const inner = found.namedChildren.find(same);
    if (!inner) break;
    found = inner;
  }
  return found;
}
