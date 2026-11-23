// The kind of a project and the data stores of a workspace. The atlas reads only the manifest
// files: package.json, pyproject.toml and docker-compose. It does not guess more than they show.
//
// The kind of a project, in this order:
//   frontend  a React, Vue, Svelte, Next or Vite app
//   api       the project has routes
//   worker    the folder name ends in function, worker or lambda (`image-resize-function`)
//   cli       the manifest has a bin (package.json `bin`, pyproject `[project.scripts]`)
//   library   all other projects

import type { ProjectKind } from './view.js';

/** The text of a file below the root, or undefined. */
export type ReadFile = (file: string) => string | undefined;

export interface Manifest {
  /** The file of the manifest, from the root. */
  file: string;
  /** The names of all the dependencies. */
  deps: string[];
  bin: boolean;
  /** The project has an HTML page (index.html) next to the manifest. */
  html: boolean;
}

const UI_DEPS = ['react', 'react-dom', 'vue', 'svelte', 'next', 'nuxt', '@angular/core', 'solid-js', 'preact'];
const APP_DEPS = ['next', 'nuxt', 'vite', '@sveltejs/kit', 'react-scripts', '@angular/cli'];

/** The nearest manifest at or above `dir` (a folder from the root, '' for the root). */
export function manifestOf(dir: string, read: ReadFile): Manifest | undefined {
  const parts = dir === '' ? [] : dir.split('/');
  for (let n = parts.length; n >= 0; n--) {
    const at = parts.slice(0, n).join('/');
    const join = (f: string) => (at === '' ? f : `${at}/${f}`);
    const pkg = read(join('package.json'));
    if (pkg !== undefined) {
      try {
        const j = JSON.parse(pkg) as Record<string, unknown>;
        const deps = ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((k) => Object.keys((j[k] as Record<string, string> | undefined) ?? {}));
        return { file: join('package.json'), deps, bin: j.bin !== undefined, html: read(join('index.html')) !== undefined };
      } catch {
        // A broken package.json: look above it.
      }
    }
    const py = read(join('pyproject.toml'));
    if (py !== undefined) return { file: join('pyproject.toml'), deps: pythonDeps(py), bin: /^\[(?:project\.scripts|tool\.poetry\.scripts)\]/m.test(py), html: false };
  }
  return undefined;
}

/** The dependency names of a pyproject.toml: the `dependencies` list and the poetry tables. */
export function pythonDeps(text: string): string[] {
  const out = new Set<string>();
  const list = /^dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(text)?.[1] ?? '';
  for (const m of list.matchAll(/['"]\s*([A-Za-z0-9_.-]+)/g)) out.add(m[1]!.toLowerCase());
  let inPoetry = false;
  for (const line of text.split('\n')) {
    if (/^\[/.test(line)) inPoetry = /^\[tool\.poetry\.(?:dev-)?dependencies\]/.test(line);
    else if (inPoetry) {
      const name = /^([A-Za-z0-9_.-]+)\s*=/.exec(line)?.[1];
      if (name && name !== 'python') out.add(name.toLowerCase());
    }
  }
  return [...out];
}

/** A folder of a serverless function or a worker: `csv-validation-function`, `thumbnail_fix_function`, `workers`. */
export const WORKER_DIR = /(?:^|[-_/])(?:functions?|workers?|lambdas?)$/i;

/** The kind of a project, from its manifest, its routes and its folder. */
export function projectKind(m: Manifest | undefined, routes: number, dir = ''): ProjectKind {
  if (m) {
    const ui = m.deps.some((d) => UI_DEPS.includes(d));
    const app = m.html || m.deps.some((d) => APP_DEPS.includes(d));
    if (ui && app && !m.bin) return 'frontend';
  }
  if (dir !== '' && WORKER_DIR.test(dir)) return 'worker';
  if (routes > 0) return 'api';
  if (m?.bin) return 'cli';
  return 'library';
}

// ---------------------------------------------------------------- data stores

export type StoreKind = 'postgres' | 'mysql' | 'mongodb' | 'redis' | 'sqlite' | 'elasticsearch' | 'queue' | 'storage' | 'sql';

export interface DataStore {
  /** `store:<name>`. */
  id: string;
  name: string;
  kind: StoreKind;
  /** The file that shows the store: the compose file, or the manifest of the first client. */
  file: string;
  /** The image of a compose service. */
  image?: string;
}

/** A client dependency → the kind of store it talks to. */
const CLIENT_DEPS: Record<string, StoreKind> = {
  pg: 'postgres', postgres: 'postgres', 'pg-promise': 'postgres', psycopg2: 'postgres', 'psycopg2-binary': 'postgres', psycopg: 'postgres', asyncpg: 'postgres',
  mysql: 'mysql', mysql2: 'mysql', pymysql: 'mysql', mysqlclient: 'mysql',
  mongodb: 'mongodb', mongoose: 'mongodb', pymongo: 'mongodb', motor: 'mongodb',
  redis: 'redis', ioredis: 'redis', 'redis-py': 'redis', aioredis: 'redis',
  'better-sqlite3': 'sqlite', sqlite3: 'sqlite', aiosqlite: 'sqlite',
  '@elastic/elasticsearch': 'elasticsearch', elasticsearch: 'elasticsearch', '@opensearch-project/opensearch': 'elasticsearch', 'opensearch-py': 'elasticsearch',
  amqplib: 'queue', pika: 'queue', kafkajs: 'queue', 'kafka-python': 'queue', 'aiokafka': 'queue', bullmq: 'queue', celery: 'queue',
  boto3: 'storage', '@aws-sdk/client-s3': 'storage', minio: 'storage',
  prisma: 'sql', '@prisma/client': 'sql', typeorm: 'sql', sequelize: 'sql', knex: 'sql', 'drizzle-orm': 'sql', sqlalchemy: 'sql', sqlmodel: 'sql', 'django': 'sql', 'tortoise-orm': 'sql',
};

const IMAGE_KINDS: Array<[RegExp, StoreKind]> = [
  [/postgres|postgis|timescale/, 'postgres'],
  [/mysql|mariadb/, 'mysql'],
  [/mongo/, 'mongodb'],
  [/redis|valkey|keydb/, 'redis'],
  [/elasticsearch|opensearch/, 'elasticsearch'],
  [/rabbitmq|kafka|nats|redpanda/, 'queue'],
  [/minio|localstack/, 'storage'],
];

export const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/** The data-store services of a compose file: a service whose image is a known store. */
export function composeStores(file: string, text: string): DataStore[] {
  const out: DataStore[] = [];
  let inServices = false;
  let service: string | undefined;
  let indent = -1;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (line.trim() === '') continue;
    const lead = line.length - line.trimStart().length;
    if (lead === 0) {
      inServices = /^services\s*:/.test(line);
      service = undefined;
      indent = -1;
      continue;
    }
    if (!inServices) continue;
    const key = /^\s*([\w.-]+)\s*:\s*$/.exec(line)?.[1];
    if (key && (indent < 0 || lead <= indent)) {
      indent = lead;
      service = key;
      continue;
    }
    const image = /^\s*image\s*:\s*['"]?([^'"\s]+)/.exec(line)?.[1];
    if (service && image) {
      const kind = IMAGE_KINDS.find(([re]) => re.test(image.toLowerCase()))?.[1];
      if (kind) out.push({ id: `store:${service}`, name: service, kind, file, image });
    }
  }
  return out;
}

/** The kinds of store that a manifest's dependencies talk to, with the dependency names. */
export function clientStores(m: Manifest | undefined): Array<{ kind: StoreKind; dep: string }> {
  if (!m) return [];
  return m.deps.filter((d) => CLIENT_DEPS[d.toLowerCase()] !== undefined).map((d) => ({ kind: CLIENT_DEPS[d.toLowerCase()]!, dep: d }));
}
