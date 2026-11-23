// The node and edge types of the atlas. They come from the CodeGraph index (see codegraph.ts).

export type NodeKind = 'file' | 'function' | 'method' | 'class' | 'route' | 'test';
export type Trust = 'exact' | 'name-match' | 'unresolved';

export interface GraphNode {
  /** The CodeGraph node ID, for example `function:3f2a…`. */
  id: string;
  kind: NodeKind;
  name: string;
  /** The repo path, with `/`. */
  file?: string;
  /** First and last line, as `12-20`. */
  range?: string;
  /** typescript or python. TSX and JavaScript files are typescript. */
  language?: string;
  /** A route node: `POST /orders/{id}`, or a page path `/orders/:id`. */
  route?: string;
  /** Not a part of the repo (always false: CodeGraph keeps no outside nodes). */
  targetOnly?: boolean;
  /** `export` in TypeScript (CodeGraph is_exported). */
  exported?: boolean;
  /** No function or class holds it. */
  topLevel?: boolean;
}

/** A call site: the function that holds it, the line, and the target if CodeGraph resolved it. */
export interface StoredRef {
  from: string;
  name: string;
  line: number;
  kind: 'calls';
  resolvedTo?: string;
  resolvedTrust?: Trust;
}
