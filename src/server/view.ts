// The JSON of the atlas API. The server makes one view for each box; the page draws it.
// The page has one canvas. To open a box is to draw the view of that box inside the box: the
// other boxes stay on the canvas, and the layout moves them aside.
//
// The view IDs:
//   system                     the projects and the data stores
//   project:<key>              the pages, routes, commands or features of one project
//   fn:<graph node id>         the flow chart of a function
//   at:<line>:<graph node id>  the flow chart of a nested function or callback at that line
//   route:<file>#<path>        the flow chart of one route block in a dispatch function
//   command:<file>#<name>      the flow chart of one command block
//   features                   the Features mode: the features of each frontend, and the APIs that they reach
//   feature:<unit>:<slug>      the pages of one feature, with an edge to each endpoint that a page reaches
//   fapi:<unit>                the endpoints of one project that the pages reach, by route group
//   lens:<query>               the search lens: only the parts of the map that fit the query (lens.ts)

export type ProjectKind = 'frontend' | 'api' | 'cli' | 'worker' | 'library';

export type ViewLevel = 'system' | 'features' | 'project' | 'flow';

export type Shape =
  // the system level
  | 'project' | 'store' | 'feature'
  // a collapsed group (the page makes it, not the server)
  | 'fold'
  // the project level
  | 'page' | 'endpoint' | 'route' | 'command' | 'function'
  // the flow level
  | 'start' | 'step' | 'decision' | 'loop' | 'call' | 'cross' | 'lib' | 'end' | 'event' | 'more';

export interface ViewGroup {
  id: string;
  label: string;
  /** An icon name: project, page, api, cli, library, store, folder. */
  icon: string;
  /** A tone (0 to 7) for the pastel colour. */
  tone: number;
  /** grid: the children have no edges between them and sit in rows of GRID_COLUMNS (the event handlers of a page). */
  layout?: 'grid';
  /** The column of the group in the top view, left to right (Frontends 0, APIs 1, ...). */
  lane?: number;
  /** A row along the bottom of the top view, not a lane (Libraries, Support). */
  shelf?: boolean;
  /** The group starts collapsed (a large group of libraries). */
  fold?: boolean;
  /** The noun of the members, singular and plural: a collapsed group shows "25 libraries". */
  noun?: [string, string];
  /** The aspect (width / height) of the rows of boxes in a lane group. No value: a narrow column. */
  ratio?: number;
  /** The group sits at the vertical middle of the tallest lane (the APIs of the Features mode). */
  middle?: boolean;
}

/** One line of a joined step (the hooks of a component), for the panel. */
export interface ViewItem {
  label: string;
  line?: number;
  /** The view that opens the item, if there is one. */
  open?: string;
}

export interface ViewNode {
  id: string;
  shape: Shape;
  label: string;
  /** A second line in small type: a project name, a method, a count. */
  sub?: string;
  group?: string;
  /** The tone of the project of the node (a cross-project call has the colour of its project). */
  tone?: number;
  /** The view that the page draws inside the node when the reader opens it. No value: a leaf. */
  open?: string;
  /** The project of the view that opens. */
  openProject?: string;
  /**
   * The target of an HTTP call in the node: the node IDs from the system level to the endpoint,
   * for example `['project:shop-api', 'ep:shop-api:GET /api/orders']`. The page can open each box
   * on this path and select the endpoint.
   */
  target?: string[];
  file?: string;
  line?: number;
  /** The graph node ID: the panel reads its callers and callees. */
  ref?: string;
  /** More text for the panel: the code line, the calls into outside packages. */
  detail?: string[];
  /** The HTTP method of an endpoint: the page shows it as a pill before the path. */
  method?: string;
  /** A sentence for the panel, for example how a page gets its data. */
  note?: string;
  /** The lines of a joined step: the panel shows the list. */
  items?: ViewItem[];
  /** The size of a project box, by its count of pages, routes or exports. A chip shows the name only. */
  size?: 'chip' | 's' | 'm' | 'l';
  /** A test case (the search lens): the panel opens it in the Tests mode. */
  case?: string;
}

export interface ViewEdge {
  id: string;
  from: string;
  /** A node ID, or a group ID: one edge to a group (the event handlers) replaces an edge to each child. */
  to: string;
  /**
   * An edge to a box in another view (an HTTP call to an endpoint): the node IDs from the system
   * level to the end. The page draws the edge to the deepest box on this path that is on the canvas.
   */
  toPath?: string[];
  label?: string;
  /** The endpoint IDs that the edge stands for (Features mode): a bundle of edges counts them once. */
  ends?: string[];
  /** The text on hover of the label: what the edge stands for ("19 calls go to Next.js API routes of shop-web"). */
  title?: string;
  /** flow: the order of execution; back: a loop goes back; http: an HTTP call; uses: imports and calls. */
  kind: 'flow' | 'branch' | 'back' | 'error' | 'http' | 'uses';
  /**
   * import: an import edge between projects (hidden until the reader asks for it).
   * total: the sum of the HTTP calls from one group to another (shown when the zoom is small).
   * sum: the endpoints of all the features of a frontend in one API box (the Features mode).
   * detail: the endpoints of one feature in one API box: shown only when the feature (or the API
   * box) is selected. Then the sum edges of that frontend go away.
   */
  role?: 'import' | 'total' | 'sum' | 'detail';
  /** Only a possible match: the page draws it dashed and lighter. */
  possible?: boolean;
}

export interface AtlasView {
  ok: boolean;
  level: ViewLevel;
  id: string;
  title: string;
  /** The kind of the project at the project level. */
  kind?: ProjectKind;
  /** The project of the view (not at the system level). */
  project?: string;
  file?: string;
  line?: number;
  groups: ViewGroup[];
  nodes: ViewNode[];
  edges: ViewEdge[];
  notes: string[];
  /** The System view: the HTTP calls of the frontends to the APIs, as a table. */
  matrix?: Matrix;
  /** The search lens (`lens:<query>`): the chips, the time and why each item is there. */
  lens?: LensInfo;
}

/** A filter of a lens query, with its text in the query (the × of the chip removes that text). */
export interface LensChip {
  key: string;
  value: string;
  raw: string;
}

export interface LensInfo {
  query: string;
  chips: LensChip[];
  errors: string[];
  /** The time of the query on the server, in ms. */
  ms: number;
  shown: number;
  /** The items that fit but are not in the view (more seeds, or the cap). */
  more: number;
  /** node ID → why it is in the view. */
  why: Record<string, string[]>;
  /** A wide lens (depth:, up:N, down:N, impact: or filters only): no "Show more" buttons. */
  wide: boolean;
  /** The count of seeds in the view (the "Show more" buttons add to it). */
  seeds: number;
  /** The node IDs of the main chain: the page lights them. */
  main: string[];
}

/** The node of the types that a free-word lens leaves out: a click adds kind:type. */
export const LENS_TYPES = 'lens:types';

export interface MatrixCell {
  direct: number;
  possible: number;
}

export interface Matrix {
  rows: Array<{ key: string; label: string }>;
  cols: Array<{ key: string; label: string }>;
  /** `<row key>\n<col key>` → the counts. */
  cells: Record<string, MatrixCell>;
}

export interface SearchHit {
  label: string;
  sub: string;
  /** The node IDs from the system level to the hit. The page opens each box on the path, then selects the hit. */
  path: string[];
  /** A test case: the page opens it in the Tests mode (the path is empty). */
  case?: string;
}

export interface NodeLink {
  id: string;
  label: string;
  file?: string;
  line?: number;
  kind: string;
  /** The view that opens the code, if there is one. */
  open?: string;
}

export interface NodeInfo {
  ok: boolean;
  id: string;
  label: string;
  file?: string;
  line?: number;
  /** The absolute path of the file, for the editor link. */
  path?: string;
  callers: NodeLink[];
  callees: NodeLink[];
}

export interface AtlasInfo {
  root: string;
  name: string;
  projects: number;
  files: number;
}
