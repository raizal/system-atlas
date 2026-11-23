// The types of the Tests mode: the e2e specs of a repo, their cases and steps, and the results of
// the last run. The server makes them; the page draws them. All of it is static (tree-sitter) but the
// results, which come from a Playwright JSON report and its trace files.

/** goto: the page opens a URL. action: a click, a fill … on an element. assert: an `expect`.
 * mock: `page.route` (the test answers the request). request: an API call of the test, or a wait for a response.
 * group: a helper function, a `test.step`, a hook or a fixture, with its own steps. other: another call of the page. */
export type StepKind = 'goto' | 'action' | 'assert' | 'mock' | 'request' | 'group' | 'other';

export interface Locator {
  /** role, text, testid, label, placeholder, title, alt, css. */
  by: string;
  value: string;
  /** The accessible name of a role locator. */
  name?: string;
}

export interface CaseStep {
  /** The ID of the step in its case: `s3`, `s3.1` (a step in a group). */
  id: string;
  kind: StepKind;
  /** A short text: `click button "Close invoice"`, `goto /audit/invoices/:id`. */
  text: string;
  file: string;
  line: number;
  /** goto, mock, request: the path with each part that is not known as `:name`. */
  url?: string;
  /** action: click, fill, check … */
  action?: string;
  locator?: Locator;
  /** mock, request: the HTTP method, or `*` if the step does not say. */
  method?: string;
  /** mock: the glob or the URL of `page.route`. */
  glob?: string;
  /** mock: all the methods that the handler answers, if there is more than one (`GET`, `POST`). */
  methods?: string[];
  /** assert: the matcher (`toBeVisible`, `not toHaveCount`) and its value, if the source gives it. */
  matcher?: string;
  value?: string;
  /** assert on a record of a fixture mock (`expect(invoiceApi.created())`): the request that fills it. */
  api?: { method: string; url: string; glob?: string };
  /** The step comes from a fixture (`test.extend`) of the spec. */
  fromFixture?: boolean;
  /** group: helper, step (`test.step`), hook (`beforeEach`), fixture. */
  group?: 'helper' | 'step' | 'hook' | 'fixture';
  steps?: CaseStep[];
}

export interface TestCase {
  /** `<spec file>:<line>`. */
  id: string;
  title: string;
  /** The names of the `describe` blocks, outside first. */
  path: string[];
  file: string;
  line: number;
  /** `test.skip` or `test.fixme`. */
  skip?: boolean;
  /** The Playwright tags of the case and its describes: `@smoke`. */
  tags?: string[];
  steps: CaseStep[];
}

export interface SpecFile {
  /** The path from the repo root. */
  file: string;
  runner: 'playwright' | 'cypress';
  /** The Playwright config of the spec, from the repo root: the main config if it runs the spec. */
  config?: string;
  /** All the configs that run the spec, if there is more than one. */
  configs?: string[];
  /** The tag of the config of the spec, if it is not the main config: "demo", "staging (live stack)". */
  tag?: string;
  /** A setup file (auth.setup.ts): only the setup projects run it. */
  setup?: boolean;
}

export type RunStatus = 'passed' | 'failed' | 'skipped' | 'timedOut' | 'interrupted' | 'flaky';

/** An HTTP request that the page sent in a run (from the trace). */
export interface SeenRequest {
  method: string;
  url: string;
  status?: number;
  /** The spec or helper line of the action that was running when the request went out. */
  file?: string;
  line?: number;
  /** The time from the start of the test, in ms. */
  at: number;
}

export interface CaseResult {
  status: RunStatus;
  /** The time of the run of the case, in ms. */
  duration: number;
  /** The start of the run, ISO time. */
  startTime?: string;
  error?: { message: string; file?: string; line?: number };
  /** The trace file of the run. */
  trace?: string;
  /** The requests from the trace. */
  requests?: SeenRequest[];
}

// ---------------------------------------------------------------- the API of the page

/** The target of a step on the map: a node of the case view. */
export interface StepTarget {
  /** The node ID in the case view. */
  node: string;
  kind: 'page' | 'element' | 'endpoint';
  label: string;
  possible?: boolean;
  /** The step mocks this endpoint. */
  mock?: boolean;
  /** A request of the run went to this endpoint at this step. */
  seen?: boolean;
  /** The endpoint is behind a mocked route: the case does not run it. */
  notRun?: boolean;
}

/** The layers of the areas of a case, in the order of the list. */
export type AreaLayer = 'feature' | 'page' | 'component' | 'handler' | 'route' | 'endpoint' | 'backend';
/** How a case touches an area. `code`: the atlas found it in the code only (no step, no run). */
export type AreaHow = 'visited' | 'clicked' | 'filled' | 'asserted' | 'mocked' | 'seen' | 'code' | 'notRun';

/** One part of the project that a case touches. */
export interface AreaItem {
  layer: AreaLayer;
  /** Unique in the list. */
  key: string;
  label: string;
  sub?: string;
  file?: string;
  line?: number;
  how: AreaHow[];
  /** The node of the case view that shows the item, if there is one. */
  node?: string;
  /** The node IDs of the System and Features views (the area → cases index). */
  refs: string[];
  project?: string;
}

/** A case that touches a part of the map (the "Test cases" section of the panel). */
export interface CaseTouch {
  case: string;
  how: AreaHow[];
}

/** One row of "Coverage by area": a feature of a frontend. */
export interface AreaRow {
  /** The feature node ID of the Features view. */
  id: string;
  label: string;
  project: string;
  cases: string[];
  pages: { tested: number; all: number };
  endpoints: { real: number; mocked: number; none: number };
}

/** One step of the player: a leaf step of the case, in source order. */
export interface PlayStep {
  /** The step ID (`s3.1`): the node ID of the step in the case flow chart is `step:<id>`. */
  id: string;
  kind: StepKind;
  text: string;
  file: string;
  line: number;
  /** The names of the groups that hold the step, outside first. */
  groups: string[];
  targets: StepTarget[];
  /** The edge of the case view that animates at this step (from the page to the endpoint). */
  edges: string[];
  /** A short note for the panel: "no page found", "from the fixture", "seen in the run". */
  notes: string[];
  /** assert: the last run failed at this step. Others: the run failed here. */
  failed?: boolean;
  /** The last run passed this step. */
  passed?: boolean;
  /** A mock of a fixture that the code of the page does not call: the case does not use it. */
  unused?: boolean;
}

/** The mocks of a fixture that the case does not use: the page does not call these routes. */
export interface FixtureExtra {
  fixture: string;
  routes: string[];
}

export interface CaseInfo {
  ok: boolean;
  id: string;
  title: string;
  path: string[];
  file: string;
  line: number;
  project?: string;
  projectName?: string;
  steps: PlayStep[];
  result?: CaseResult;
  notes: string[];
  /** The parts of the project that the case touches, by layer. */
  areas?: AreaItem[];
  /** What the case checks: its asserts in short words, in order. */
  checks?: string[];
  /** The mocks of each fixture that the page does not call. */
  fixtureExtra?: FixtureExtra[];
}

export interface CaseSummary {
  id: string;
  title: string;
  path: string[];
  line: number;
  skip?: boolean;
  tags?: string[];
  steps: number;
  result?: { status: RunStatus; duration: number };
}

export interface SpecSummary {
  file: string;
  runner: 'playwright' | 'cypress';
  project?: string;
  projectName?: string;
  /** The tag of the config of the spec: "demo", "staging (live stack)". */
  tag?: string;
  cases: CaseSummary[];
}

export interface TestsInfo {
  ok: boolean;
  specs: SpecSummary[];
  /** Where the results come from, if there are any. */
  results?: string;
  notes: string[];
}

/** The cases that touch each page and endpoint (node IDs of the System and Features views). */
export interface Coverage {
  ok: boolean;
  /** node ID → case IDs. */
  nodes: Record<string, string[]>;
  /** node ID → the cases that touch it, and how (pages, endpoints, components, handlers). */
  touches: Record<string, CaseTouch[]>;
  /** case ID → a short line: "1 feature · 2 pages · 5 components · 3 endpoints". */
  summaries: Record<string, string>;
  /** case ID → its feature node IDs (the list filter of "Coverage by area"). */
  caseAreas: Record<string, string[]>;
  /** case ID → the status of its last run. */
  status: Record<string, RunStatus>;
  /** case ID → its spec file and describe path. */
  where: Record<string, { file: string; path: string[] }>;
  /** "Coverage by area": one row per feature. */
  areas: AreaRow[];
  /** case ID → its title, for the list. */
  titles: Record<string, string>;
}
