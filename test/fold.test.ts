// Round 3: collapsed and compact groups, the page state in the hash, the import filter, the focus.

import { describe, expect, it } from 'vitest';
import type { AtlasView, ViewEdge, ViewNode } from '../src/server/view.js';
import { buildTree, defaultFold, focusSet, hashOfState, openOfHash, SEP, stateOfHash, toggleIn, visibleEdges } from '../src/web/tree.js';

const node = (id: string, group?: string, open?: string): ViewNode => ({ id, shape: 'project', label: id, ...(group ? { group } : {}), ...(open ? { open } : {}) });
const system: AtlasView = {
  ok: true, level: 'system', id: 'system', title: 'System', notes: [],
  groups: [
    { id: 'kind:frontend', label: 'Frontends', icon: 'frontend', tone: 0, lane: 0, noun: ['frontend', 'frontends'] },
    { id: 'kind:api', label: 'APIs', icon: 'api', tone: 1, lane: 1, noun: ['API', 'APIs'] },
    { id: 'kind:library', label: 'Libraries', icon: 'library', tone: 4, shelf: true, fold: true, noun: ['library', 'libraries'] },
  ],
  nodes: [node('project:ui', 'kind:frontend', 'v:ui'), node('project:srv', 'kind:api'), node('project:a', 'kind:library'), node('project:b', 'kind:library')],
  edges: [
    { id: 'http:ui>srv', from: 'project:ui', to: 'project:srv', kind: 'http', label: '2 HTTP calls' },
    { id: 'uses:ui>a', from: 'project:ui', to: 'project:a', kind: 'uses', role: 'import', label: '3 imports' },
    { id: 'uses:srv>b', from: 'project:srv', to: 'project:b', kind: 'uses', role: 'import', label: '1 import' },
    { id: 'uses:ui>b', from: 'project:ui', to: 'project:b', kind: 'uses', role: 'import', label: '2 imports' },
    { id: 'total:fe>api', from: 'kind:frontend', to: 'kind:api', kind: 'http', role: 'total', label: 'Frontends → APIs · 2 calls' },
  ] satisfies ViewEdge[],
};
const ui: AtlasView = {
  ok: true, level: 'project', id: 'v:ui', title: 'ui', groups: [], notes: [],
  nodes: [{ id: 'page', shape: 'page', label: '/home' }],
  edges: [{ id: 'page>a', from: 'page', to: 'a', toPath: ['project:a'], kind: 'uses', role: 'import' }],
};
const get = (id: string) => (id === 'v:ui' ? ui : undefined);
const LIB = 'group:kind:library';

describe('a collapsed group', () => {
  it('is one node with the count; the edges to its members go to it, as one edge', () => {
    const t = buildTree(system, get, new Set(), { fold: new Set([LIB]) });
    expect(t.groups.map((g) => g.fid)).toEqual(['group:kind:frontend', 'group:kind:api']);
    const f = t.nodes.find((n) => n.fid === LIB)!;
    expect(f).toMatchObject({ node: { shape: 'fold', label: 'Libraries', sub: '2 libraries' }, state: 'leaf' });
    expect(t.nodes.some((n) => n.fid === 'project:a')).toBe(false);
    const toFold = t.edges.filter((e) => e.to === LIB);
    expect(toFold.map((e) => [e.from, e.label])).toEqual([['project:ui', '5 imports'], ['project:srv', '1 import']]);
    // The total of the groups stays, apart from the other edges.
    expect(t.edges.find((e) => e.role === 'total')).toMatchObject({ from: 'group:kind:frontend', to: 'group:kind:api' });
  });

  it('an edge from inside an open box to a member goes to the collapsed group', () => {
    const t = buildTree(system, get, new Set(['project:ui']), { fold: new Set([LIB]) });
    expect(t.edges.some((e) => e.from === `project:ui${SEP}page` && e.to === LIB)).toBe(true);
  });

  it('the groups with `fold` start collapsed; a toggle expands one', () => {
    const d = defaultFold(system);
    expect([...d]).toEqual([LIB]);
    expect([...toggleIn(d, LIB)]).toEqual([]);
    expect([...toggleIn(new Set(), LIB)]).toEqual([LIB]);
  });

  it('a compact group shows its members as chips; an open member keeps its size', () => {
    const t = buildTree(system, get, new Set(['project:ui']), { compact: new Set(['group:kind:frontend', 'group:kind:api']) });
    expect(t.groups.find((g) => g.fid === 'group:kind:api')!.compact).toBe(true);
    expect(t.nodes.find((n) => n.fid === 'project:srv')!.node.size).toBe('chip');
    expect(t.nodes.find((n) => n.fid === 'project:ui')!.node.size).toBeUndefined();
  });
});

describe('the page state in the hash', () => {
  it('keeps the mode, the open boxes, the collapsed and compact groups, and the imports', () => {
    const s = { mode: 'features' as const, open: new Set(['feature:web:audit', `a${SEP}b`]), fold: new Set<string>(), compact: new Set([LIB]), imports: true };
    const h = hashOfState(s);
    expect(stateOfHash(h)).toEqual(s);
    // No fold in the hash: the defaults of the view. An empty fold: all groups are expanded.
    expect(stateOfHash('#/?mode=system').fold).toBeUndefined();
    expect(stateOfHash('#/?fold=').fold).toEqual(new Set());
    expect(stateOfHash('#/?mode=nonsense').mode).toBe('system');
    expect(hashOfState({ mode: 'system', open: new Set(), compact: new Set(), imports: false })).toBe('#/');
    // The old hash still works.
    expect(openOfHash('#/?open=project%3Aui')).toEqual(new Set(['project:ui']));
  });

  it('keeps the test case, the step of the player, and the coverage toggle', () => {
    const s = { mode: 'tests' as const, open: new Set(['flow:web/e2e/a.spec.ts:11']), compact: new Set<string>(), imports: false, case: 'web/e2e/a.spec.ts:11', step: 2 };
    const h = hashOfState(s);
    expect(h).toContain('step=2');
    expect(stateOfHash(h)).toEqual(s);
    expect(stateOfHash('#/?mode=system&tests=1').tests).toBe(true);
    // No case: no step.
    expect(hashOfState({ mode: 'tests', open: new Set(), compact: new Set(), imports: false, step: 3 })).toBe('#/?mode=tests');
  });
});

describe('the edges on the page', () => {
  const t = buildTree(system, get, new Set());
  it('the imports are hidden; "Show imports" shows them; the selected box shows its own imports', () => {
    expect(visibleEdges(t.edges, { imports: false }).map((e) => e.id)).toEqual(['http:ui>srv', 'total:fe>api']);
    expect(visibleEdges(t.edges, { imports: true })).toHaveLength(t.edges.length);
    expect(visibleEdges(t.edges, { imports: false, selected: 'project:srv' }).map((e) => e.id)).toEqual(['http:ui>srv', 'uses:srv>b', 'total:fe>api']);
  });

  it('the focus: the selection, its neighbours, the boxes that hold them', () => {
    const parentOf = new Map<string, string | undefined>([
      ['group:kind:frontend', undefined], ['group:kind:api', undefined], [LIB, undefined],
      ['project:ui', 'group:kind:frontend'], ['project:srv', 'group:kind:api'], ['project:a', LIB], ['project:b', LIB],
    ]);
    const edges = visibleEdges(t.edges, { imports: false, selected: 'project:srv' });
    expect([...focusSet(edges, 'project:srv', parentOf)].sort()).toEqual(['group:kind:api', 'group:kind:frontend', LIB, 'project:b', 'project:srv', 'project:ui'].sort());
  });
});
