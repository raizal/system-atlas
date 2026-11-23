// The calls of the page to the atlas server. All are GET; the server reads only.

import type { AtlasInfo, AtlasView, NodeInfo, SearchHit } from '../server/view.js';
import type { CaseInfo, Coverage, TestsInfo } from '../tests/types.js';

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok && body.error) throw new Error(body.error);
  return body;
}

export const api = {
  info: () => get<AtlasInfo & { ok: boolean }>('api/info'),
  view: (id: string) => get<AtlasView>(`api/view?id=${encodeURIComponent(id)}`),
  search: (q: string) => get<{ ok: boolean; hits: SearchHit[] }>(`api/search?q=${encodeURIComponent(q)}`),
  node: (id: string) => get<NodeInfo>(`api/node?id=${encodeURIComponent(id)}`),
  tests: () => get<TestsInfo>('api/tests'),
  case: (id: string) => get<CaseInfo>(`api/case?id=${encodeURIComponent(id)}`),
  coverage: () => get<Coverage>('api/coverage'),
};
