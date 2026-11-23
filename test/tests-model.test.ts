// The Tests mode, part 2: the steps of the fixture specs on the map (pages, elements, endpoints), the
// case views, the coverage, and the results of a run (a JSON report and a trace.zip made by hand).

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodeGraphIndex } from '../src/index/codegraph.js';
import { Atlas } from '../src/server/model.js';
import { TestModel } from '../src/server/tests.js';
import { cacheDir, readReport } from '../src/tests/results.js';
import { readZip, traceRequests } from '../src/tests/trace.js';
import { indexedCopy } from './helpers.js';

const open = async (name: string) => {
  const root = await indexedCopy(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), name);
  const index = CodeGraphIndex.open(root);
  return { root, index, atlas: await Atlas.build(index, root) };
};

/** A zip with the files: the first one stored, the others deflated. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  Object.entries(files).forEach(([name, text], i) => {
    const raw = Buffer.from(text);
    const data = i === 0 ? raw : deflateRawSync(raw);
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(i === 0 ? 0 : 8, 8);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(i === 0 ? 0 : 8, 10);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data);
    central.push(ch, n);
    offset += 30 + n.length + data.length;
  });
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n');

describe('the trace reader', () => {
  it('reads a stored and a deflated file of a zip', () => {
    const files = readZip(zip({ 'a.txt': 'one', 'b.txt': 'two two two' }));
    expect([...files].map(([k, v]) => [k, v.toString()])).toEqual([['a.txt', 'one'], ['b.txt', 'two two two']]);
  });

  it('gives each request the spec line of the action that runs at its time', () => {
    const spec = '/repo/web/e2e/orders.spec.ts';
    const files = readZip(zip({
      'trace.trace': jsonl([
        { type: 'before', callId: 'c1', startTime: 100, stack: [{ file: spec, line: 12 }] },
        { type: 'after', callId: 'c1', endTime: 200 },
        { type: 'before', callId: 'c2', startTime: 210 },
        { type: 'after', callId: 'c2', endTime: 400 },
      ]),
      'trace.stacks': JSON.stringify({ files: ['/x/node_modules/pw/lib.js', spec], stacks: [['c2', [[0, 5, 1, 'x'], [1, 14, 3, '']]]] }),
      'trace.network': jsonl([
        { type: 'resource-snapshot', snapshot: { request: { method: 'get', url: 'http://localhost:5173/api/orders' }, response: { status: 200 }, _monotonicTime: 150 } },
        { type: 'resource-snapshot', snapshot: { request: { method: 'POST', url: 'http://localhost:5173/api/orders' }, response: { status: 201 }, _monotonicTime: 300 } },
      ]),
    }));
    expect(traceRequests(files)).toEqual([
      { method: 'GET', url: 'http://localhost:5173/api/orders', status: 200, file: spec, line: 12, at: 50 },
      { method: 'POST', url: 'http://localhost:5173/api/orders', status: 201, file: spec, line: 14, at: 200 },
    ]);
  });
});

describe('the JSON report', () => {
  it('reads the last result of each case, with the error line', () => {
    const report = { config: { rootDir: '/repo/web/e2e' }, suites: [{ file: 'orders.spec.ts', specs: [], suites: [{ specs: [{ title: 'saves', file: 'orders.spec.ts', line: 11, tests: [{ status: 'unexpected', results: [{ status: 'failed', duration: 5 }, { status: 'failed', duration: 9, error: { message: '\u001b[31mExpected\u001b[39m', location: { file: '/repo/web/e2e/orders.spec.ts', line: 17 } } }] }] }] }] }] };
    expect(readReport(JSON.stringify(report))).toEqual([{ file: 'orders.spec.ts', path: '/repo/web/e2e/orders.spec.ts', line: 11, title: 'saves', result: { status: 'failed', duration: 9, error: { message: 'Expected', file: '/repo/web/e2e/orders.spec.ts', line: 17 } } }]);
  });

  it('keeps the cache out of the repo', () => {
    expect(cacheDir('/work/shop', { ATLAS_CACHE_DIR: '/c' })).toMatch(/^\/c\/shop-[0-9a-f]{12}$/);
    expect(cacheDir('/work/shop', { XDG_CACHE_HOME: '/x' })).toMatch(/^\/x\/system-atlas\/shop-/);
  });
});

describe('the cases of the fleet on the map', () => {
  let fleet: Awaited<ReturnType<typeof open>>;
  let tests: TestModel;
  beforeAll(async () => {
    fleet = await open('fleet');
    tests = new TestModel(fleet.atlas, join(tmpdir(), 'atlas-no-results'));
  });
  afterAll(() => fleet?.index.close());

  it('goes from a path to the page with its route', () => {
    expect(tests.pageOf('fleet-web', '/audit/list')?.entry.name).toBe('/audit/list');
    expect(tests.pageOf('fleet-web', '/orders/:id')).toBeUndefined();
  });

  it('matches the fixture mock and the proxy mock to the endpoints', async () => {
    const c = await tests.caseInfo('web/e2e/audits.spec.ts:18');
    const byId = new Map(c.steps.map((s) => [s.id, s]));
    // The route answers from the mock: the backend endpoint behind it does not run.
    expect(byId.get('s1.1.1')!.targets).toEqual([
      { node: 'ep:fleet-web:GET /api/audits', kind: 'endpoint', label: 'GET /api/audits', mock: true },
      { node: 'ep:core-api:GET /v1/orders', kind: 'endpoint', label: 'GET /v1/orders', possible: true, notRun: true },
    ]);
    expect(byId.get('s1.1.1')!.notes).toContain('from the fixture');
    expect(byId.get('s2.1')!.targets.map((t) => t.node)).toEqual(['ep:fleet-web:GET /api/core-proxy/*', 'ep:core-api:GET /v1/orders']);
    expect(byId.get('s3.1.1')!.targets).toMatchObject([{ kind: 'page', label: '/audit/list' }]);
    expect(byId.get('s4')!.notes).toContain('no element found in the code of the page');
  });

  it('draws the case with its flow chart, the page, the endpoints by project and the stores', async () => {
    const v = await tests.caseView('web/e2e/audits.spec.ts:18');
    expect(v.groups.map((g) => [g.id, g.lane])).toEqual([['case', 0], ['fe:fleet-web', 1], ['api:core-api', 2], ['api:fleet-web', 2], ['stores', 3]]);
    expect(v.nodes[0]).toMatchObject({ id: 'flow:web/e2e/audits.spec.ts:18', open: 'caseflow:web/e2e/audits.spec.ts:18' });
    expect(v.edges.find((e) => e.to === 'ep:fleet-web:GET /api/audits')).toMatchObject({ kind: 'http', label: 'GET /api/audits' });
    const flow = await tests.flowView('web/e2e/audits.spec.ts:18');
    expect(flow.nodes.map((n) => n.id)).toEqual(['start', 'step:s1.1.1', 'step:s2.1', 'step:s3.1.1', 'step:s3.1.2', 'step:s4', 'step:s5', 'end']);
    expect(flow.groups.map((g) => g.label)).toEqual(['setup: fixture page (1 mock used)', 'beforeEach', 'open the list › openList']);
    // The setup of the fixture is one group that starts collapsed.
    expect(flow.groups.map((g) => !!g.fold)).toEqual([true, false, false]);
    const other = await tests.flowView('web/e2e/audits.spec.ts:26');
    expect(other.groups[0]).toMatchObject({ label: 'setup: fixture page (0 mocks used, 1 more)', fold: true });
  });

  it('lists the areas of a case: the proxy mock leaves the backend, its code and its store "not run"', async () => {
    const c = await tests.caseInfo('web/e2e/audits.spec.ts:18');
    expect(c.areas!.map((a) => [a.layer, a.label, a.how])).toEqual([
      ['feature', '/audit', ['visited', 'asserted']],
      ['page', '/audit/list', ['visited']],
      ['page', '/audit/new', ['asserted']],
      ['route', 'GET /api/audits', ['mocked']],
      ['route', 'GET /api/core-proxy/*', ['mocked']],
      ['endpoint', 'GET /v1/orders', ['mocked', 'notRun']],
      ['backend', 'read_orders', ['notRun']],
      ['backend', 'postgres', ['notRun']],
    ]);
    expect(c.areas!.find((a) => a.label === 'read_orders')).toMatchObject({ file: 'core/src/api/orders.py', node: 'ep:core-api:GET /v1/orders' });
    expect(c.checks).toEqual(['the list shows', 'the URL is /audit/new']);
  });

  it('keeps a fixture mock that the page does not call out of the areas', async () => {
    // :26 goes to no known page and sends request.get('/api/audits'): an API request does not go
    // through page.route, so the mock of the fixture is registered but not used.
    const c = await tests.caseInfo('web/e2e/audits.spec.ts:26');
    expect(c.fixtureExtra).toEqual([{ fixture: 'page', routes: ['/api/audits'] }]);
    const mock = c.steps.find((s) => s.kind === 'mock' && s.unused);
    expect(mock?.targets).toEqual([]);
    expect(mock?.notes).toContain('the page does not call this route');
    expect(c.areas!.find((a) => a.label === 'GET /api/audits')?.how).toEqual(['code']);
    // :18 visits /audit/list, whose code calls GET /api/audits: the same mock is used there.
    const d = await tests.caseInfo('web/e2e/audits.spec.ts:18');
    expect(d.fixtureExtra).toBeUndefined();
    expect(d.steps.some((s) => s.unused)).toBe(false);
  });

  it('counts the cases of each page and endpoint, and finds a case by its title', async () => {
    const cov = await tests.coverage();
    expect(cov.nodes['ep:fleet-web:GET /api/audits']).toEqual(['web/e2e/audits.spec.ts:18', 'web/e2e/audits.spec.ts:26']);
    // Area → cases: each box keeps the cases that touch it, with how; a row per feature counts them.
    expect(cov.touches['ep:core-api:GET /v1/orders']).toEqual([
      { case: 'web/e2e/audits.spec.ts:18', how: ['mocked', 'notRun'] },
      { case: 'web/e2e/audits.spec.ts:26', how: ['mocked', 'notRun'] },
    ]);
    expect(cov.where['web/e2e/audits.spec.ts:18']).toEqual({ file: 'web/e2e/audits.spec.ts', path: ['audits'] });
    expect(cov.areas[0]).toEqual({ id: 'feature:fleet-web:audit', label: '/audit', project: 'fleet-web', cases: ['web/e2e/audits.spec.ts:18'], pages: { tested: 2, all: 2 }, endpoints: { real: 1, mocked: 1, none: 0 } });
    expect(cov.caseAreas['web/e2e/audits.spec.ts:18']).toEqual(['feature:fleet-web:audit']);
    expect(cov.summaries['web/e2e/audits.spec.ts:18']).toBe('1 feature · 2 pages · 3 endpoints');
    expect(await tests.search('list of audits')).toEqual([{ label: 'opens the list of audits', sub: 'test case · web/e2e/audits.spec.ts:18', path: [], case: 'web/e2e/audits.spec.ts:18' }]);
  });
});

describe('the cases of the shop on the map, with a run', () => {
  let shop: Awaited<ReturnType<typeof open>>;
  let tests: TestModel;
  beforeAll(async () => {
    shop = await open('shop');
    // The results of a run: the first case failed at the text assert; its trace saw a POST at the Save click.
    const dir = mkdtempSync(join(tmpdir(), 'atlas-run-'));
    const spec = join(shop.root, 'web/e2e/orders.spec.ts');
    mkdirSync(join(dir, 'test-results', 'saves'), { recursive: true });
    const trace = join(dir, 'test-results', 'saves', 'trace.zip');
    writeFileSync(trace, zip({
      'trace.trace': jsonl([{ type: 'before', callId: 'c1', startTime: 10, stack: [{ file: spec, line: 16 }] }, { type: 'after', callId: 'c1', endTime: 50 }]),
      'trace.network': jsonl([{ type: 'resource-snapshot', snapshot: { request: { method: 'POST', url: 'http://localhost:5173/api/orders' }, _monotonicTime: 20 } }]),
    }));
    const report = { config: { rootDir: join(shop.root, 'web/e2e') }, suites: [{ file: 'orders.spec.ts', specs: [], suites: [{ specs: [
      { title: 'saves a new order', file: 'orders.spec.ts', line: 11, tests: [{ results: [{ status: 'failed', duration: 900, error: { message: 'not visible', location: { file: spec, line: 17 } }, attachments: [{ name: 'trace', path: trace }] }] }] },
      { title: 'resets the list', file: 'orders.spec.ts', line: 20, tests: [{ results: [{ status: 'passed', duration: 300 }] }] },
    ] }] }] };
    writeFileSync(join(dir, 'report.json'), JSON.stringify(report));
    tests = new TestModel(shop.atlas, dir);
  });
  afterAll(() => shop?.index.close());

  it('goes to the app page of the SPA (possible) and to the elements in the JSX with their handlers', async () => {
    const c = await tests.caseInfo('web/e2e/orders.spec.ts:20');
    expect(c.steps.map((s) => s.targets.map((t) => [t.kind, t.label, !!t.possible]))).toEqual([
      // No mock: the real server answers, so the reads of the page code are possible areas.
      [['page', 'App', true], ['endpoint', 'GET /api/orders', true]],
      [['element', 'button "Reset" · App · reset()', true]],
      [['element', 'text "No orders" · Empty', true]],
    ]);
    expect(c.result).toMatchObject({ status: 'passed' });
    expect(c.steps.every((s) => s.passed)).toBe(true);
  });

  it('marks the failed assert, and the request that the run saw at the Save click', async () => {
    const c = await tests.caseInfo('web/e2e/orders.spec.ts:11');
    const save = c.steps.find((s) => s.text === 'click button "Save"')!;
    expect(save.targets).toContainEqual({ node: 'ep:shop-api:POST /api/orders', kind: 'endpoint', label: 'POST /api/orders', seen: true });
    expect(save.notes).toContain('seen in the run');
    expect(save.passed).toBe(true);
    expect(c.steps.find((s) => s.kind === 'assert')).toMatchObject({ failed: true, line: 17 });
    expect(c.steps[0]).toMatchObject({ kind: 'mock', passed: true, targets: [{ node: 'ep:shop-api:GET /api/orders', mock: true }] });
    const info = await tests.info();
    expect(info.specs[0]!.cases.map((x) => x.result?.status)).toEqual(['failed', 'passed']);
  });

  it('lists the areas of a case: the mocked endpoint does not run, the run saw the real one', async () => {
    const c = await tests.caseInfo('web/e2e/orders.spec.ts:11');
    expect(c.areas!.map((a) => [a.layer, a.label, a.how])).toEqual([
      ['feature', 'Other pages', ['visited']],
      ['page', 'App', ['visited']],
      ['component', 'App', ['clicked']],
      ['component', 'OrderForm', ['clicked']],
      ['handler', 'saveOrder()', ['clicked']],
      ['handler', 'onSave()', ['clicked']],
      ['endpoint', 'GET /api/orders', ['mocked', 'notRun']],
      ['endpoint', 'POST /api/orders', ['seen']],
      // The run saw the POST; the code behind it is reached by code only.
      ['backend', 'db', ['code']],
      ['backend', 'createOrder', ['code']],
    ]);
    const cov = await tests.coverage();
    expect(cov.touches['ep:shop-api:GET /api/orders']).toEqual([{ case: 'web/e2e/orders.spec.ts:11', how: ['mocked', 'notRun'] }, { case: 'web/e2e/orders.spec.ts:20', how: ['code'] }]);
    // A component and a handler get their cases by the ID of their code too.
    const handler = c.areas!.find((a) => a.label === 'reset()') ?? (await tests.caseInfo('web/e2e/orders.spec.ts:20')).areas!.find((a) => a.label === 'reset()')!;
    expect(cov.touches[handler.refs[0]!]).toEqual([{ case: 'web/e2e/orders.spec.ts:20', how: ['clicked'] }]);
    expect(cov.status['web/e2e/orders.spec.ts:11']).toBe('failed');
  });
});
