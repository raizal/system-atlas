// The kind of a project and the data stores, from the manifest files only.

import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/server/cli.js';
import { clientStores, composeStores, manifestOf, projectKind, pythonDeps } from '../src/server/kinds.js';

const files = (map: Record<string, string>) => (f: string) => map[f];

describe('project kinds', () => {
  it('a React app with an index.html is a frontend', () => {
    const m = manifestOf('web/src', files({ 'web/package.json': '{"dependencies":{"react":"1"}}', 'web/index.html': '<div></div>' }));
    expect(m).toMatchObject({ file: 'web/package.json', deps: ['react'], bin: false, html: true });
    expect(projectKind(m, 0)).toBe('frontend');
  });

  it('a React library with no app is not a frontend', () => {
    expect(projectKind({ file: 'package.json', deps: ['react'], bin: false, html: false }, 0)).toBe('library');
    expect(projectKind({ file: 'package.json', deps: ['react', 'vite'], bin: false, html: false }, 0)).toBe('frontend');
  });

  it('a project with routes is an api, else a project with a bin is a cli, else a library', () => {
    expect(projectKind({ file: 'package.json', deps: [], bin: true, html: false }, 3)).toBe('api');
    expect(projectKind({ file: 'package.json', deps: [], bin: true, html: false }, 0)).toBe('cli');
    expect(projectKind(undefined, 0)).toBe('library');
  });

  it('a React app with a bin is a cli (an Ink tool), not a frontend', () => {
    expect(projectKind({ file: 'package.json', deps: ['react', 'vite'], bin: true, html: true }, 0)).toBe('cli');
  });

  it('reads the nearest manifest above the folder, and pyproject.toml', () => {
    const read = files({
      'svc/pyproject.toml': '[project]\nname = "svc"\ndependencies = ["fastapi>=0.1", "psycopg2-binary"]\n[project.scripts]\nsvc = "svc:main"\n',
    });
    expect(manifestOf('svc/app/routes', read)).toMatchObject({ file: 'svc/pyproject.toml', deps: ['fastapi', 'psycopg2-binary'], bin: true });
    expect(manifestOf('other', read)).toBeUndefined();
  });

  it('reads the poetry dependencies', () => {
    expect(pythonDeps('[tool.poetry.dependencies]\npython = "^3.12"\nredis = "^5"\n[tool.other]\nx = 1\n')).toEqual(['redis']);
  });
});

describe('data stores', () => {
  it('a compose service with a known image is a store', () => {
    const text = ['services:', '  db:', '    image: postgis/postgis:16', '  cache:', '    image: "redis:7"', '  api:', '    build: ./api', '    environment:', '      image: no', 'volumes:', '  data:'].join('\n');
    expect(composeStores('docker-compose.yml', text)).toEqual([
      { id: 'store:db', name: 'db', kind: 'postgres', file: 'docker-compose.yml', image: 'postgis/postgis:16' },
      { id: 'store:cache', name: 'cache', kind: 'redis', file: 'docker-compose.yml', image: 'redis:7' },
    ]);
  });

  it('a client dependency names the kind of store', () => {
    expect(clientStores({ file: 'package.json', deps: ['pg', 'zod', 'ioredis'], bin: false, html: false })).toEqual([
      { kind: 'postgres', dep: 'pg' },
      { kind: 'redis', dep: 'ioredis' },
    ]);
  });
});

describe('the atlas command', () => {
  it('reads the verb, the folder, the port and the store', () => {
    expect(parseArgs(['serve', '.', '--port', '4999'])).toMatchObject({ verb: 'serve', dir: '.', port: 4999 });
    expect(parseArgs(['index', 'x'])).toMatchObject({ verb: 'index', dir: 'x', port: 4890 });
    expect(parseArgs(['serve', '.', '--db', 'g.db'])).toBe('Unknown option: --db');
    expect(parseArgs(['index', '.', '--port', '1'])).toBe('Use --port with serve only.');
    expect(parseArgs(['serve'])).toBe('Give the repo folder.');
    expect(parseArgs(['serve', '.', '--port', 'x'])).toMatch(/port/);
    expect(parseArgs(['merge', '.'])).toBe('Unknown command: merge');
  });
});
