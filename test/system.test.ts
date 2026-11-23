// Round 3: the System view without an index: the lanes, Support, the size steps, the config file, the matrix.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyFeatureConfig, FOLD_MIN, GROUP_ORDER, groupOf, isSupport, matrixOf, parseConfig, sizeStep, SLOTS,
} from '../src/server/system.js';
import { shop, type Shop } from './helpers.js';

describe('the lanes', () => {
  it('Frontends → APIs → Functions and workers → Data stores, left to right; Libraries and Support are shelves', () => {
    expect([SLOTS.frontend.lane, SLOTS.api.lane, SLOTS.worker.lane, SLOTS.stores.lane]).toEqual([0, 1, 2, 3]);
    expect(SLOTS.cli.lane).toBe(SLOTS.worker.lane);
    expect([SLOTS.library.shelf, SLOTS.support.shelf]).toEqual([true, true]);
    expect(GROUP_ORDER.slice(-2)).toEqual(['library', 'support']);
  });
});

describe('the Support group', () => {
  const p = (name: string, dir = name, count = 5, runtime = false) => ({ name, dir, count, runtime });
  it('infra, templates, playgrounds, docs, test automation and scripts go to Support', () => {
    for (const name of ['shop-infra', 'apps/api/infra', 'template-node-service', 'ui-playground', 'docs', 'acceptance-tests', 'ui-automation_tests', 'qa-test', 'scripts']) expect(isSupport(p(name)), name).toBe(true);
    for (const name of ['shop-api', 'infrastructure-tools', 'web', 'tests-api']) expect(isSupport(p(name)), name).toBe(false);
  });
  it('a project with nothing to show and no runtime edge goes to Support', () => {
    expect(isSupport(p('tools', 'tools', 0, false))).toBe(true);
    expect(isSupport(p('tools', 'tools', 0, true))).toBe(false);
  });
  it('the config can pin a project out of Support, or move it to a group', () => {
    const c = parseConfig(JSON.stringify({ projects: { docs: { pin: true }, web: { group: 'library' } } }));
    expect(groupOf('frontend', p('docs'), c.projects.docs)).toBe('frontend');
    expect(groupOf('frontend', p('web'), c.projects.web)).toBe('library');
    expect(groupOf('api', p('shop-infra'), undefined)).toBe('support');
  });
});

describe('the config file', () => {
  it('reads pin, hide, rename, group, and the features', () => {
    const c = parseConfig(JSON.stringify({
      projects: { a: { pin: true, hide: true, rename: ' Alpha ', group: 'worker' } },
      features: { web: { rename: { audit: 'Audits' }, merge: { audit: ['kiosk', 7] } } },
    }));
    expect(c.projects.a).toEqual({ pin: true, hide: true, rename: 'Alpha', group: 'worker' });
    expect(c.features.web).toEqual({ rename: { audit: 'Audits' }, merge: { audit: ['kiosk'] } });
    expect(c.problems).toEqual([]);
  });
  it('a bad file or a bad group gives a problem, not an error', () => {
    expect(parseConfig(undefined).problems).toEqual([]);
    expect(parseConfig('{nope').problems[0]).toMatch(/not valid JSON/);
    expect(parseConfig('[]').problems[0]).toMatch(/must hold an object/);
    expect(parseConfig(JSON.stringify({ projects: { a: { group: 'x' } } })).problems[0]).toMatch(/group "x"/);
  });
  it('reads the aliases of the search: one word to a text', () => {
    const c = parseConfig(JSON.stringify({ aliases: { ' PO ': 'purchase order', 'two words': 'x', dd: 3, ee: '' } }));
    expect(c.aliases).toEqual({ po: 'purchase order' });
    expect(c.problems).toHaveLength(3);
    expect(parseConfig(JSON.stringify({ aliases: [] })).problems[0]).toMatch(/"aliases" must be an object/);
  });
  it('renames and merges features', () => {
    const fs = [{ slug: 'audit', label: '/audit', pages: [1, 2] }, { slug: 'kiosk', label: '/kiosk', pages: [3] }, { slug: 'other', label: 'Other pages', pages: [4] }];
    const out = applyFeatureConfig(fs, { rename: { audit: 'Audits' }, merge: { audit: ['kiosk', 'missing'] } });
    expect(out).toEqual([{ slug: 'audit', label: 'Audits', pages: [1, 2, 3] }, { slug: 'other', label: 'Other pages', pages: [4] }]);
    // The input does not change.
    expect(fs[0]!.pages).toEqual([1, 2]);
  });
});

describe('the size steps and the matrix', () => {
  it('a few steps, not a scale', () => {
    expect([0, 2, 3, 15, 16, 60, 61, 500].map(sizeStep)).toEqual(['chip', 'chip', 's', 's', 'm', 'm', 'l', 'l']);
    expect(FOLD_MIN).toBe(12);
  });
  it('counts the direct and the possible calls of each frontend to each project', () => {
    const m = matrixOf(
      [
        { unit: 'web', endpoint: { unit: 'api' } },
        { unit: 'web', endpoint: { unit: 'api' } },
        { unit: 'web', possible: [{ unit: 'api' }, { unit: 'api' }, { unit: 'auth' }] },
        { unit: 'web', endpoint: { unit: 'web' } },
        { unit: 'api', endpoint: { unit: 'auth' } },
      ],
      [{ key: 'web', label: 'web' }],
      (k) => k.toUpperCase(),
    );
    expect(m.cols).toEqual([{ key: 'api', label: 'API' }, { key: 'auth', label: 'AUTH' }]);
    expect(m.cells).toEqual({ 'web\napi': { direct: 2, possible: 1 }, 'web\nauth': { direct: 0, possible: 1 } });
  });
});

describe('the System view of the shop', () => {
  let s: Shop;
  beforeAll(async () => {
    s = await shop();
  });
  afterAll(() => s?.index.close());
  it('the groups in lane order; an HTTP edge, a total of the groups, a matrix', async () => {
    const v = await s.atlas.view('system');
    expect(v.groups.map((g) => [g.id, g.lane])).toEqual([['kind:frontend', 0], ['kind:api', 1], ['kind:cli', 2], ['kind:library', undefined], ['stores', 3]]);
    // The library is a shelf; the tool imports it: an import edge, hidden until the reader asks.
    expect(v.groups.find((g) => g.id === 'kind:library')).toMatchObject({ shelf: true });
    expect(v.edges.find((e) => e.role === 'import')).toMatchObject({ from: 'project:shop-tool', to: 'project:shop-core' });
    expect(v.edges.find((e) => e.role === 'total')).toMatchObject({ from: 'kind:frontend', to: 'kind:api', label: 'Frontends → APIs · 2 calls' });
    expect(v.edges.filter((e) => e.kind === 'http' && e.role !== 'total').map((e) => e.id)).toEqual(['http:shop-web>shop-api']);
    expect(v.matrix?.cells).toEqual({ 'shop-web\nshop-api': { direct: 2, possible: 0 } });
  });
});
