// The pure parts of the Features mode: the feature groups of the pages, and the walk from a page to its HTTP calls.

import { describe, expect, it } from 'vitest';
import { featureGroups, reachCalls, type ReachGraph } from '../src/server/reach.js';

const pages = (...routes: string[]) => routes.map((route, i) => ({ id: `p${i}`, route }));
const summary = (routes: string[]) => featureGroups(pages(...routes)).map((f) => [f.label, f.pages.map((p) => p.route)]);

describe('feature groups', () => {
  it('groups the pages by the first segment; a group of one goes to "Other pages", last', () => {
    expect(summary(['/audit', '/audit/[id]', '/returns/list', '/returns/[id]', '/login', 'Home'])).toEqual([
      ['/audit', ['/audit', '/audit/[id]']],
      ['/returns', ['/returns/list', '/returns/[id]']],
      ['Other pages', ['Home', '/login']],
    ]);
  });

  it('skips the common prefix, and splits a large group by the next static segment', () => {
    const routes = ['/s/:sub/a', '/s/:sub/a/:id', '/s/:sub/b', '/s/:sub/b/new', '/s/:sub/c', '/s/:sub/d', '/s/:sub/e', '/s/:sub/f', '/s/:sub/g', '/s/:sub/h', '/x/1', '/x/2'];
    expect(summary(routes)).toEqual([
      ['/s/:sub/a', ['/s/:sub/a', '/s/:sub/a/:id']],
      ['/s/:sub/b', ['/s/:sub/b', '/s/:sub/b/new']],
      ['/x', ['/x/1', '/x/2']],
      ['Other pages', ['/s/:sub/c', '/s/:sub/d', '/s/:sub/e', '/s/:sub/f', '/s/:sub/g', '/s/:sub/h']],
    ]);
  });

  it('gives each feature a unique slug', () => {
    const slugs = featureGroups(pages('/s/:sub/a', '/s/:sub/a/1', '/', '/home', '/b/1', '/b/2')).map((f) => f.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

/** A chain page → hook → service → client, with a fetch in the client. */
const chain = (extra: Record<string, string[]> = {}): ReachGraph<string> => {
  const next: Record<string, string[]> = { page: ['hook'], hook: ['service'], service: ['client'], ...extra };
  const calls: Record<string, string[]> = { client: ['GET /x'], page: ['GET /own'] };
  return { next: (id) => next[id] ?? [], calls: (id) => calls[id] ?? [] };
};

describe('the walk from a page to its calls', () => {
  it('finds each call with the least steps (0: in the page itself)', () => {
    expect(reachCalls('page', chain()).map((r) => [r.call, r.steps, r.fn])).toEqual([['GET /own', 0, 'page'], ['GET /x', 3, 'client']]);
  });

  it('stops at the depth limit', () => {
    expect(reachCalls('page', chain(), 2).map((r) => r.call)).toEqual(['GET /own']);
    expect(reachCalls('page', chain(), 3).map((r) => r.call)).toEqual(['GET /own', 'GET /x']);
  });

  it('follows at most `fanout` edges out of one function, and visits a function once', () => {
    const g = chain({ page: ['a', 'b', 'hook'], a: ['page'], b: ['hook'] });
    // Fan-out 2: the page does not go to the hook, but b does (one step more).
    expect(reachCalls('page', g, 6, 2).map((r) => [r.call, r.steps])).toEqual([['GET /own', 0], ['GET /x', 4]]);
    expect(reachCalls('page', g, 6, 1).map((r) => r.call)).toEqual(['GET /own']);
    expect(reachCalls('page', g, 6, 3).map((r) => [r.call, r.steps])).toEqual([['GET /own', 0], ['GET /x', 3]]);
  });
});
