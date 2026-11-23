// The parts of round 7 that have no fixture of their own: HTTP helpers in another file, the FastAPI
// mount of a nested source root, the tags of a case, the text of the checks, and the "how" rule.

import { describe, expect, it } from 'vitest';
import { readClientCalls, readHttpHelpers } from '../src/link/client.js';
import { pythonMounts } from '../src/link/mounts.js';
import { readCases, methodsIn } from '../src/tests/extract.js';
import { checkText, settle } from '../src/server/tests.js';
import type { CaseStep } from '../src/tests/types.js';

describe('HTTP helpers in another file', () => {
  const lib = [
    "const BASE = process.env.API_URL;",
    "export async function callApi<T>(path: string, init: { method?: string } = {}): Promise<T> {",
    "  const res = await fetch(`${BASE}/v1${path}`, { method: init.method ?? 'GET' });",
    "  return res.json() as T;",
    "}",
    "export function postApi(path: string) { return callApi(path, { method: 'POST' }); }",
  ].join('\n');

  it('finds the helpers, their prefix and their default method, also through another helper', async () => {
    const helpers = await readHttpHelpers('lib/api.ts', lib);
    expect(helpers.find((h) => h.name === 'callApi')).toMatchObject({ index: 0, method: 'GET', prefix: '/v1' });
    expect(helpers.map((h) => h.name)).toContain('postApi');
  });

  it('reads the calls of an imported helper: a generic call after await, and the method of the options', async () => {
    const helpers = await readHttpHelpers('lib/api.ts', lib);
    const route = [
      "import { callApi } from '@/lib/api';",
      "export async function GET() { return Response.json(await callApi<string[]>('/invoices')); }",
      "export async function POST() { return Response.json(await callApi('/invoices', { method: 'POST' })); }",
    ].join('\n');
    const calls = await readClientCalls('app/api/invoices/route.ts', route, helpers);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/invoices', 'POST /v1/invoices']);
  });
});

describe('the FastAPI mount of a nested source root', () => {
  it('finds `api.router` next to the importing file, not in another project', () => {
    const texts: Record<string, string> = {
      'svc/src/main.py': 'from api.router import router\napp.include_router(router, prefix="/v1")\n',
      'svc/src/api/router.py': 'from api import invoices\nrouter.include_router(invoices.router)\n',
      'svc/src/api/invoices.py': '@router.post("/invoices")\ndef create(): ...\n',
      'other/api/router.py': 'router = APIRouter()\n',
    };
    const imports = (f: string) => [...(texts[f] ?? '').matchAll(/^from .*$/gm)].map((m, i) => ({ module: m[0].split(' ')[1]!, text: m[0], line: i + 1 }));
    const out = pythonMounts(Object.keys(texts), (f) => texts[f], imports);
    expect(out.get('svc/src/api/router.py')).toBe('/v1');
    expect(out.get('svc/src/api/invoices.py')).toBe('/v1');
    expect(out.has('other/api/router.py')).toBe(false);
  });
});

describe('the tags of a case', () => {
  it('reads @tags from the title and from { tag }, and a describe passes them down', async () => {
    const spec = [
      "import { test } from '@playwright/test';",
      "test.describe('orders @smoke', { tag: '@shop' }, () => {",
      "  test('saves @fast', { tag: ['@p1'] }, async ({ page }) => { await page.goto('/'); });",
      "  test('lists', async ({ page }) => { await page.goto('/'); });",
      "});",
    ].join('\n');
    const cases = await readCases('e2e/orders.spec.ts', spec, () => undefined);
    expect(cases.map((c) => [c.title, c.tags])).toEqual([
      ['saves @fast', ['@smoke', '@shop', '@fast', '@p1']],
      ['lists', ['@smoke', '@shop']],
    ]);
  });
});

describe('the words of a check and of a handler', () => {
  const step = (more: Partial<CaseStep>): CaseStep => ({ id: 's1', kind: 'assert', text: 'expect', file: 'a.spec.ts', line: 1, ...more });
  it('says what an assert checks', () => {
    expect(checkText(step({ matcher: 'toBeVisible', locator: { by: 'role', value: 'button', name: 'Save' } }))).toBe('the button "Save" shows');
    expect(checkText(step({ matcher: 'not toBeVisible', locator: { by: 'text', value: 'Error' } }))).toBe('the text "Error" does not show');
    expect(checkText(step({ matcher: 'toHaveURL', url: '/audit/new' }))).toBe('the URL is /audit/new');
  });
  it('reads the methods of a route handler', () => {
    expect(methodsIn("if (route.request().method() === 'POST') {} else if (route.request().method() === 'GET') {}")).toEqual(['POST', 'GET']);
    expect(methodsIn('route.fulfill({ json: [] })')).toEqual([]);
  });
});

describe('how a case touches an item', () => {
  it('a real touch hides "reached by code only"; code that runs hides "not run"', () => {
    expect(settle(['code', 'clicked'])).toEqual(['clicked']);
    expect(settle(['notRun', 'mocked', 'code'])).toEqual(['mocked', 'notRun']);
    expect(settle(['notRun', 'code'])).toEqual(['code']);
    expect(settle(['notRun', 'seen'])).toEqual(['seen']);
  });
});
