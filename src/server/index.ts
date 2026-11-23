// System atlas: a standalone map of a repo that opens each page, route and function as a flow
// chart. It reads a CodeGraph index.

export { Atlas, STEP_LIMIT, GROUP_LIMIT, ROUTE_SPLIT, OTHER_ROUTES, routeGroups, endpointLabel, type Call, type Endpoint, type Project } from './model.js';
export { createHandler, startServer, sameOrigin, DEFAULT_PORT, HOST, type AtlasServerOptions } from './http.js';
export { main, parseArgs, type Io } from './cli.js';
export { manifestOf, projectKind, pythonDeps, composeStores, clientStores, COMPOSE_FILES, WORKER_DIR, type Manifest, type DataStore, type StoreKind } from './kinds.js';
export { CodeGraphIndex, hasIndex, dbPathOf } from '../index/codegraph.js';
export type * from './view.js';
