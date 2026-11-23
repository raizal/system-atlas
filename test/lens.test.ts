// The search lens (round 8): the parser, the words, the rank, the lift, the cap and the view.

import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { CodeGraphIndex } from '../src/index/codegraph.js';
import { LENS_CAP, LensIndex, lensView, parseQuery, pathFits, runLens, scoreItem, segments, stem, termsOf, type LensItem } from '../src/server/lens.js';
import { Atlas } from '../src/server/model.js';
import { TestModel } from '../src/server/tests.js';
import { indexedCopy } from './helpers.js';

const open = async (name: string) => {
  const root = await indexedCopy(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), name);
  const atlas = await Atlas.build(CodeGraphIndex.open(root), root);
  const tests = new TestModel(atlas);
  return { atlas, tests, ix: await LensIndex.build(atlas, tests) };
};

const item = (o: Partial<LensItem> & { label: string }): LensItem => ({
  id: o.label,
  kind: 'function',
  name: new Set(segments(o.label).map(stem)),
  path: new Set(),
  folder: new Set(),
  users: 0,
  testish: false,
  ...o,
});

describe('the parser', () => {
  it('reads the free words and the chips', () => {
    const q = parseQuery('close Invoice project:shop-api kind:endpoints method:post path:/v1/* depth:3');
    expect(q.words).toEqual(['close', 'invoice']);
    expect(q.projects).toEqual(['shop-api']);
    expect([...q.kinds]).toEqual(['endpoint']);
    expect([...q.methods]).toEqual(['POST']);
    expect(q.paths).toEqual(['/v1/*']);
    expect(q.depth).toBe(3);
    expect(q.depthSet).toBe(true);
    expect(q.chips.map((c) => c.key)).toEqual(['project', 'kind', 'method', 'path', 'depth']);
    expect(q.errors).toEqual([]);
  });
  it('a quoted value and a quoted phrase', () => {
    const q = parseQuery('impact:"save order" "store pickup"');
    expect(q.impact).toBe('save order');
    expect(q.chips[0]).toEqual({ key: 'impact', value: 'save order', raw: 'impact:"save order"' });
    expect(q.words).toEqual(['store', 'pickup']);
    // An open quote runs to the end.
    expect(parseQuery('impact:"save ord').impact).toBe('save ord');
  });
  it('bad input gives an error and no chip', () => {
    const q = parseQuery('kind:robot method:fetch depth:9 depth:x project: orders');
    expect(q.chips).toEqual([]);
    expect(q.errors).toHaveLength(5);
    expect(q.errors[0]).toMatch(/kind:robot is not one of/);
    expect(q.errors[1]).toMatch(/method:fetch/);
    expect(q.errors[2]).toMatch(/depth:9 is not a number from 0 to 5/);
    expect(q.errors[4]).toMatch(/"project:" needs a value/);
    expect(q.words).toEqual(['orders']);
    expect(parseQuery('').words).toEqual([]);
    expect(parseQuery('   ').chips).toEqual([]);
  });
  it('an unknown key is a free word; untested is a chip', () => {
    const q = parseQuery('http://x untested');
    expect(q.words).toEqual(['http://x']);
    expect(q.untested).toBe(true);
    expect(q.chips).toEqual([{ key: 'untested', value: '', raw: 'untested' }]);
  });
  it('up: and down: take a number or none', () => {
    expect(parseQuery('a up:').dir).toBe('up');
    expect(parseQuery('a up:').depthSet).toBe(false);
    const q = parseQuery('a down:1');
    expect([q.dir, q.depth, q.depthSet]).toEqual(['down', 1, true]);
    expect(parseQuery('a up:7').errors[0]).toMatch(/up:7/);
  });
  it('an alias swaps one exact word', () => {
    const aliases = { po: 'purchase order', sku: 'stock item' };
    expect(parseQuery('PO list skus', aliases).words).toEqual(['purchase', 'order', 'list', 'skus']);
  });
});

describe('the words', () => {
  it('split a name into words', () => {
    expect(segments('createInvoice')).toEqual(['create', 'invoice']);
    expect(segments('HTTPServer_start-now')).toEqual(['http', 'server', 'start', 'now']);
    expect(segments('/api/invoices/{id}/close')).toEqual(['api', 'invoices', 'id', 'close']);
  });
  it('a stem is the same for the query and the names', () => {
    expect(stem('invoices')).toBe(stem('invoice'));
    expect(stem('policies')).toBe(stem('policy'));
    expect(stem('closing')).toBe(stem('close'));
    expect(stem('created')).toBe(stem('create'));
    expect(stem('status')).toBe('status');
  });
  it('no stop words, once each, a verb has its methods', () => {
    const t = termsOf(['create', 'the', 'orders', 'order']);
    expect(t.map((x) => x.word)).toEqual(['create', 'orders']);
    expect(t[0]!.methods).toEqual(['POST']);
    expect(t[1]!.methods).toBeUndefined();
  });
});

describe('path:', () => {
  it('a glob or a start', () => {
    expect(pathFits('/api/orders', '/api/orders/{id}')).toBe(true);
    expect(pathFits('/api/*/close', '/api/invoices/close')).toBe(true);
    expect(pathFits('/api/*/close', '/api/a/b/close')).toBe(false);
    expect(pathFits('/api/**/close', '/api/a/b/close')).toBe(true);
    expect(pathFits('/v1', '/api/v1')).toBe(false);
    expect(pathFits('/v1', undefined)).toBe(false);
  });
});

describe('the rank', () => {
  const terms = termsOf(['create', 'order']);
  const ep = (method: string) => item({ label: `${method} /api/orders`, kind: 'endpoint', method, name: new Set(), path: new Set(['api', 'order']) });
  it('a verb that fits the method goes up, a misfit goes down', () => {
    const post = scoreItem(ep('POST'), terms)!;
    const get = scoreItem(ep('GET'), terms)!;
    expect(post.score).toBeGreaterThan(get.score);
    expect(post.why).toContain('POST fits "create"');
    expect(get.why).toContain('GET does not fit "create"');
  });
  it('a word in the path is strong; a page or endpoint ranks above a function', () => {
    const f = scoreItem(item({ label: 'loadOrders' }), termsOf(['order']))!;
    const e = scoreItem(ep('GET'), termsOf(['order']))!;
    expect(e.score).toBeGreaterThan(f.score);
    expect(e.why[0]).toMatch(/in the path/);
  });
  it('more words rank higher; the name starts with the verb', () => {
    const both = scoreItem(item({ label: 'createOrder', first: stem('create') }), terms)!;
    const one = scoreItem(item({ label: 'listOrders', first: stem('list') }), terms)!;
    expect(both.score).toBeGreaterThan(one.score);
    expect(both.why).toContain('the name starts with the verb');
  });
  it('a big type that fits few words goes down', () => {
    const t3 = termsOf(['order', 'close', 'invoice']);
    const small = scoreItem(item({ label: 'Order', kind: 'type', users: 2 }), t3)!;
    const big = scoreItem(item({ label: 'Order', kind: 'type', users: 60 }), t3)!;
    expect(small.score - big.score).toBe(12);
    expect(big.why.at(-1)).toMatch(/60 users/);
  });
  it('a test file goes down, but not with kind:test', () => {
    const it0 = item({ label: 'saveOrder', testish: true });
    expect(scoreItem(it0, terms)!.score).toBe(scoreItem({ ...it0, testish: false }, terms)!.score - 15);
    expect(scoreItem(it0, terms, { tests: true })!.score).toBe(scoreItem({ ...it0, testish: false }, terms)!.score);
  });
  it('no hit without a word in the name or the path', () => {
    expect(scoreItem(item({ label: 'reset', folder: new Set(['order']) }), termsOf(['order']))).toBeUndefined();
  });
});

describe('the types in a lens', () => {
  it('a free-word lens hides the types (one "+N types" box); kind:type shows them', async () => {
    const fleet = await open('fleet');
    const r = runLens(fleet.ix, 'settings');
    expect(r.types).toBe(1);
    expect(r.hits.some((h) => h.item.kind === 'type')).toBe(false);
    expect(runLens(fleet.ix, 'settings kind:type').hits.map((h) => h.item.label)).toEqual(['Settings']);
    const v = await lensView(fleet.atlas, fleet.tests, 'settings');
    expect(v.nodes.map((n) => n.label)).toContain('+1 type');
    expect(v.lens?.why['lens:types']?.[0]).toMatch(/kind:type/);
  }, 60000);
});

describe('the lens on the shop', () => {
  let shop: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => {
    shop = await open('shop');
  }, 60000);
  const labels = (q: string, cap?: number) => runLens(shop.ix, q, {}, cap).hits.map((h) => `${h.item.kind} ${h.item.label}`);

  it('the best hit first: create order → POST /api/orders', () => {
    const r = runLens(shop.ix, 'create order');
    expect(`${r.hits[0]!.item.kind} ${r.hits[0]!.item.label}`).toBe('endpoint POST /api/orders');
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(r.wide).toBe(false);
  });
  it('a free-word lens: the best seeds, cut where the score drops by more than one word', () => {
    const r = runLens(shop.ix, 'create order');
    // POST /api/orders (52) and createOrder (43); the next seeds fit one word only (about 16).
    expect(r.seeds).toBe(2);
    expect(r.hits.filter((h) => h.seed).map((h) => h.item.label)).toEqual(['POST /api/orders', 'createOrder']);
    expect(r.more).toBe(6);
  });
  it('the chain of a seed through the real links: the page above, the data store below; the main chain', () => {
    const r = runLens(shop.ix, 'create order');
    const kinds = r.hits.map((h) => `${h.item.kind} ${h.item.label}`);
    expect(kinds).toContain('page App');
    expect(kinds).toContain('store db');
    expect(kinds).not.toContain('endpoint GET /api/orders');
    const label = (id: string) => shop.ix.byId.get(id)!.label;
    expect(r.main.map(label)).toEqual(['POST /api/orders', 'App', 'db']);
  });
  it('the test cases come through the coverage, not the words of the title', () => {
    const r = runLens(shop.ix, 'create order');
    const cases = r.hits.filter((h) => h.item.kind === 'test');
    expect(cases.map((h) => h.item.label).sort()).toEqual(['resets the list', 'saves a new order']);
    expect(cases[0]!.why[0]).toMatch(/^it touches \d+ parts? of the lens: /);
    // They come after the chain.
    expect(r.hits.at(-1)!.item.kind).toBe('test');
  });
  it('the wide lens (depth:N) has more parts than the chains', () => {
    expect(runLens(shop.ix, 'orders depth:2').wide).toBe(true);
    expect(labels('orders depth:2')).toContain('endpoint POST /api/orders');
    expect(runLens(shop.ix, 'create order depth:2').hits.length).toBeGreaterThan(runLens(shop.ix, 'create order').hits.length);
  });
  it('show:N sets the count of seeds (the "Show more" buttons)', () => {
    const r = runLens(shop.ix, 'orders show:2');
    expect(r.seeds).toBe(2);
    expect(r.more).toBe(6);
    expect(r.query.chips.map((c) => c.raw)).toEqual(['show:2']);
    expect(parseQuery('orders show:0').errors[0]).toMatch(/show:0 is not a number from 1 to 60/);
  });
  it('a function lifts to its page and its data store', () => {
    const r = runLens(shop.ix, 'create order');
    const page = r.hits.find((h) => h.item.kind === 'page' && h.item.label === 'App')!;
    const store = r.hits.find((h) => h.item.kind === 'store' && h.item.label === 'db')!;
    expect(page.seed).toBe(false);
    expect(store.seed).toBe(false);
    expect(page.why.join(' ')).toMatch(/./);
  });
  it('depth:0 does not lift; up: lifts to the callers only', () => {
    expect(labels('orders depth:0')).not.toContain('page App');
    expect(labels('orders depth:0')).not.toContain('store db');
    expect(labels('orders up:1')).toContain('page App');
    expect(labels('orders up:1')).not.toContain('store db');
  });
  it('kind: keeps one kind; a test case shows with kind:test', () => {
    // The best one first; a lens keeps at least two seeds.
    expect(labels('kind:endpoint create order')).toEqual(['endpoint POST /api/orders', 'endpoint GET /api/orders']);
    expect(labels('kind:test orders')).toEqual(['test resets the list', 'test saves a new order']);
    expect(labels('kind:endpoint orders').every((l) => l.startsWith('endpoint '))).toBe(true);
    expect(labels('method:GET orders').filter((l) => l.startsWith('endpoint '))).toEqual(['endpoint GET /api/orders']);
  });
  it('the test files go down to the end', () => {
    const l = labels('orders depth:2');
    expect(l.slice(-2).every((x) => x.startsWith('test '))).toBe(true);
  });
  it('untested drops the parts that a case touches', async () => {
    await shop.tests.coverage();
    const l = labels('orders untested');
    expect(l).not.toContain('endpoint POST /api/orders');
    expect(l).not.toContain('function createOrder');
  });
  it('an alias swaps a word', () => {
    expect(runLens(shop.ix, 'mk order', { mk: 'create' }).hits[0]!.item.label).toBe('POST /api/orders');
  });
  it('the cap: the best N, and how many more', () => {
    const all = runLens(shop.ix, 'orders');
    const r = runLens(shop.ix, 'orders', {}, 3);
    expect(r.hits).toHaveLength(3);
    expect(r.more).toBe(all.hits.length - 3);
    expect(r.hits.map((h) => h.item.id)).toEqual(all.hits.slice(0, 3).map((h) => h.item.id));
    expect(LENS_CAP).toBe(60);
  });
  it('a test case links to the page it visits; the endpoints that the page reaches on the map get no second link', async () => {
    const v = await lensView(shop.atlas, shop.tests, 'orders');
    const tests = new Set(v.nodes.filter((n) => n.group === 'tests').map((n) => n.id));
    expect(tests.size).toBeGreaterThan(0);
    const fromTests = v.edges.filter((e) => tests.has(e.from)).map((e) => v.nodes.find((n) => n.id === e.to)?.label);
    expect(fromTests.length).toBeGreaterThan(0);
    expect(fromTests.every((l) => l === 'App')).toBe(true);
  });
  it('no words, no hits', () => {
    expect(runLens(shop.ix, 'zzqx').hits).toEqual([]);
    expect(runLens(shop.ix, '').hits).toEqual([]);
  });
  it('the view: lanes, chips, why, the time', async () => {
    const v = await lensView(shop.atlas, shop.tests, 'create order kind:endpoint depth:1');
    expect(v.lens?.query).toBe('create order kind:endpoint depth:1');
    expect(v.lens?.chips.map((c) => c.raw)).toEqual(['kind:endpoint', 'depth:1']);
    expect(v.lens?.shown).toBe(v.nodes.length);
    expect(v.nodes.length).toBeGreaterThan(0);
    expect(v.nodes[0]!.id).toBe('ep:shop-api:POST /api/orders');
    expect(v.lens?.why['ep:shop-api:POST /api/orders']?.[0]).toMatch(/in the path/);
    expect(v.lens?.ms).toBeGreaterThanOrEqual(0);
    // depth:1: a wide lens, no main chain.
    expect(v.lens?.wide).toBe(true);
    expect(v.lens?.main).toEqual([]);
    const c = await lensView(shop.atlas, shop.tests, 'create order');
    expect(c.lens?.wide).toBe(false);
    expect(c.lens?.main).toHaveLength(3);
    expect(c.lens?.seeds).toBe(2);
    expect(c.groups.map((g) => g.id)).toContain('tests');
  });
});
