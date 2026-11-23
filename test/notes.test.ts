// One package with a web page and a server (the `notes` fixture): the atlas splits it into a frontend
// part and a server part, with the HTTP edge between them. Also: the method of a GET-only server, a
// picked function as a box in its project, and a lens query that is the exact name of a function.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { CodeGraphIndex } from '../src/index/codegraph.js';
import { findUnits } from '../src/index/projects.js';
import { serverRoutes } from '../src/link/routes.js';
import { lensView, parseQuery } from '../src/server/lens.js';
import { Atlas } from '../src/server/model.js';
import { fnId, indexedCopy } from './helpers.js';

const NOTES = fileURLToPath(new URL('./fixtures/notes', import.meta.url));

describe('the parts of a package', () => {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'notes', dependencies: { react: '19' }, devDependencies: { vite: '6' } }),
    'vite.config.ts': "export default { root: 'src/web' };",
  };
  const code = new Map([
    ['vite.config.ts', 'typescript'],
    ['src/web/App.tsx', 'tsx'],
    ['src/web/api.ts', 'typescript'],
    ['src/server/http.ts', 'typescript'],
  ]);
  const read = (f: string) => files[f];

  it('a package with a web page and a server has two parts: the web part is a project of its own', () => {
    const { units, unitOf } = findUnits({ files: code, manifests: ['package.json'], read });
    expect(units.map((u) => [u.key, u.dir, u.part])).toEqual([
      ['notes', '', undefined],
      ['notes-web', 'src/web', 'web'],
    ]);
    expect(unitOf('src/web/api.ts').key).toBe('notes-web');
    expect(unitOf('src/server/http.ts').key).toBe('notes');
  });

  it('a package with only a web page stays one project', () => {
    const only = new Map([...code].filter(([f]) => !f.startsWith('src/server/')));
    expect(findUnits({ files: only, manifests: ['package.json'], read }).units.map((u) => u.key)).toEqual(['notes']);
  });
});

describe('the method of a route', () => {
  it('a server that refuses all the methods but GET (405) has GET routes', () => {
    const text = [
      "createServer((req, res) => {",
      "  if (req.method !== 'GET' && req.method !== 'HEAD') {",
      "    return sendJson(res, 405, {});",
      "  }",
      "  if (url.pathname === '/api/notes') return sendJson(res, 200, listNotes());",
      "});",
    ].join('\n');
    expect(serverRoutes(text).map((r) => [r.method, r.path])).toEqual([['GET', '/api/notes']]);
  });

  it('with no method test, the route stays ANY', () => {
    const text = "createServer((req, res) => {\n  if (url.pathname === '/api/notes') return send(res);\n});";
    expect(serverRoutes(text).map((r) => r.method)).toEqual(['ANY']);
  });
});

describe('the notes app on the map', () => {
  let index: CodeGraphIndex;
  let atlas: Atlas;
  beforeAll(async () => {
    const root = await indexedCopy(NOTES, 'notes');
    index = CodeGraphIndex.open(root);
    atlas = await Atlas.build(index, root);
  });
  afterAll(() => index?.close());

  it('the System view shows the web part (frontend) → the server part (api), with an HTTP edge', async () => {
    const v = await atlas.view('system');
    expect(v.nodes.map((n) => [n.id, n.group])).toEqual(expect.arrayContaining([
      ['project:notes-web', 'kind:frontend'],
      ['project:notes', 'kind:api'],
    ]));
    expect(v.edges).toContainEqual(expect.objectContaining({ from: 'project:notes-web', to: 'project:notes', kind: 'http', label: '1 HTTP call' }));
  });

  it('the page links to the GET endpoint of the server part', async () => {
    const web = await atlas.view('project:notes-web');
    const app = web.nodes.find((n) => n.label === 'App')!;
    expect(web.edges.filter((e) => e.from === app.id).map((e) => [e.kind, e.toPath])).toEqual([['http', ['project:notes', 'ep:notes:GET /api/notes']]]);
    const api = await atlas.view('project:notes');
    expect(api.nodes.map((n) => n.id)).toContain('ep:notes:GET /api/notes');
  });

  it('a pinned function is a box in the "code" group of its project, linked to the route that reaches it, and it opens', async () => {
    const fid = `fn:${fnId(atlas, 'src/server/notes.ts/noteTitles().')}`;
    const v = await atlas.view(`project:notes?pin=${fid}`);
    expect(v.id).toBe(`project:notes?pin=${fid}`);
    expect(v.groups.find((g) => g.id === 'code')).toMatchObject({ label: 'notes · code' });
    expect(v.nodes.find((n) => n.id === fid)).toMatchObject({ shape: 'function', label: 'noteTitles', group: 'code', open: fid, openProject: 'notes', sub: 'src/server/notes.ts:3' });
    expect(v.edges).toContainEqual(expect.objectContaining({ from: 'ep:notes:GET /api/notes', to: fid, kind: 'uses' }));
    const flow = await atlas.view(fid);
    expect(flow.ok).toBe(true);
    // A function of another project is not pinned.
    const other = `fn:${fnId(atlas, 'src/web/api.ts/loadNotes().')}`;
    expect((await atlas.view(`project:notes?pin=${other}`)).nodes.some((n) => n.id === other)).toBe(false);
  });

  it('a lens query that is the exact camelCase name of a function finds it first', async () => {
    expect(parseQuery('noteTitles').words).toEqual(expect.arrayContaining(['note', 'titles']));
    const fid = `fn:${fnId(atlas, 'src/server/notes.ts/noteTitles().')}`;
    const v = await lensView(atlas, undefined, 'noteTitles');
    expect(v.nodes[0]!.id).toBe(fid);
    expect(v.lens?.main[0]).toBe(fid);
    const s = await lensView(atlas, undefined, 'note_titles');
    expect(s.nodes[0]!.id).toBe(fid);
  });
});
