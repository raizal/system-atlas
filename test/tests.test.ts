// The Tests mode, part 1: the steps of the e2e cases (tree-sitter) and the spec files of a repo.
// The specs are in the fixtures: fleet/web/e2e (a fixture mock, a hook, a helper in a test.step, a
// const and template goto) and shop/web/e2e (an inline mock, role clicks, text asserts).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { cleanPath, readCases } from '../src/tests/extract.js';
import { fileLoader, findSpecs, globRegex, readConfig } from '../src/tests/specs.js';
import type { CaseStep, TestCase } from '../src/tests/types.js';
import { planRun } from '../src/tests/run.js';
import { parseArgs } from '../src/server/cli.js';

const ROOT = fileURLToPath(new URL('./fixtures', import.meta.url));
const load = fileLoader(ROOT);
const cases = (file: string) => readCases(file, readFileSync(join(ROOT, file), 'utf8'), load);

/** All the steps of a case, groups first, in source order. */
function flat(steps: CaseStep[]): CaseStep[] {
  return steps.flatMap((s) => [s, ...flat(s.steps ?? [])]);
}

describe('the steps of the fleet spec', () => {
  let list: TestCase[];
  beforeAll(async () => {
    list = await cases('fleet/web/e2e/audits.spec.ts');
  });

  it('finds the two cases with their describe and the skip', () => {
    expect(list.map((c) => [c.id, c.title, c.path, !!c.skip])).toEqual([
      ['fleet/web/e2e/audits.spec.ts:18', 'opens the list of audits', ['audits'], false],
      ['fleet/web/e2e/audits.spec.ts:26', 'opens one order', ['audits'], true],
    ]);
  });

  it('puts the fixture mock first, from the fixture file', () => {
    const [fx] = list[0]!.steps;
    expect(fx).toMatchObject({ kind: 'group', group: 'fixture', fromFixture: true });
    const mock = flat([fx!]).find((s) => s.kind === 'mock')!;
    expect(mock).toMatchObject({ url: '/api/audits', glob: '**/api/audits', file: 'fleet/web/e2e/fixtures.ts', fromFixture: true });
  });

  it('reads the beforeEach mock with the const glob', () => {
    const hook = list[0]!.steps[1]!;
    expect(hook).toMatchObject({ kind: 'group', group: 'hook' });
    expect(hook.steps![0]).toMatchObject({ kind: 'mock', url: '/api/core-proxy/v1/orders' });
  });

  it('inlines the helper in the test.step, with the const and template goto', () => {
    const step = list[0]!.steps[2]!;
    expect(step).toMatchObject({ kind: 'group', group: 'step', text: 'open the list' });
    const helper = step.steps![0]!;
    expect(helper).toMatchObject({ kind: 'group', group: 'helper' });
    expect(helper.steps!.map((s) => [s.kind, s.url ?? s.text, s.line])).toEqual([
      ['goto', '/audit/list', 9],
      ['assert', expect.stringContaining('toBeVisible'), 10],
    ]);
  });

  it('reads a role click and the URL assert', () => {
    const [, , , click, assert] = list[0]!.steps;
    expect(click).toMatchObject({ kind: 'action', action: 'click', locator: { by: 'role', value: 'button', name: 'New audit' } });
    expect(click!.text).toBe('click button "New audit"');
    expect(assert).toMatchObject({ kind: 'assert', url: '/audit/new' });
  });

  it('drops the base URL, names the const part, and reads a test request', () => {
    const steps = list[1]!.steps;
    expect(steps.find((s) => s.kind === 'goto')).toMatchObject({ url: '/orders/:id' });
    expect(steps.find((s) => s.kind === 'action')).toMatchObject({ locator: { by: 'testid', value: 'order-row' } });
    expect(steps.find((s) => s.kind === 'request')).toMatchObject({ method: 'GET', url: '/api/audits' });
  });

  it('numbers the steps by their group', () => {
    expect(flat(list[0]!.steps).map((s) => s.id)).toEqual(['s1', 's1.1', 's1.1.1', 's2', 's2.1', 's3', 's3.1', 's3.1.1', 's3.1.2', 's4', 's5']);
  });
});

describe('the steps of the shop spec', () => {
  it('reads the inline mock, the helper, the clicks and the text assert', async () => {
    const [save, reset] = await cases('shop/web/e2e/orders.spec.ts');
    expect(save!.steps.map((s) => s.kind)).toEqual(['mock', 'group', 'action', 'assert']);
    expect(save!.steps[0]).toMatchObject({ url: '/api/orders' });
    expect(save!.steps[0]!.fromFixture).toBeUndefined();
    expect(flat(save!.steps[1]!.steps!).map((s) => s.text)).toEqual(['openForm', 'goto /', 'click button "New order"']);
    expect(save!.steps[3]!.locator).toEqual({ by: 'text', value: '2 orders' });
    expect(reset!.steps.map((s) => s.text)).toEqual(['goto /', 'click button "Reset"', expect.stringMatching(/^expect text "No orders"/)]);
  });
});

describe('paths', () => {
  it('cleans a glob and a full URL to a path', () => {
    expect(cleanPath('**/api/orders*', true)).toBe('/api/orders');
    expect(cleanPath('http://localhost:3000/audit/list?x=1')).toBe('/audit/list');
  });
});

describe('the spec files of a repo', () => {
  it('reads testDir, testMatch and baseURL from a config as text', () => {
    const c = readConfig('web/playwright.config.ts', "export default { testDir: './e2e', testMatch: ['**/*.e2e.ts', /flow\\.ts$/], use: { baseURL: 'http://localhost:3000' } }");
    expect(c.testDir).toBe('web/e2e');
    expect(c.baseURL).toBe('http://localhost:3000');
    expect(c.match.map((r) => r.test('a/b.e2e.ts'))).toEqual([true, false]);
    expect(c.match[1]!.test('x/flow.ts')).toBe(true);
  });

  it('turns a glob to a regex', () => {
    expect(globRegex('*.spec.ts').test('deep/a.spec.ts')).toBe(true);
    expect(globRegex('**/*.{spec,test}.ts').test('a.test.ts')).toBe(true);
    expect(globRegex('e2e/*.ts').test('e2e/x/a.ts')).toBe(false);
  });

  it('finds the specs of each config, and not the fixtures file', () => {
    const { configs, specs } = findSpecs(join(ROOT, 'fleet'));
    expect(configs.map((c) => c.testDir)).toEqual(['web/e2e']);
    expect(specs).toEqual([{ file: 'web/e2e/audits.spec.ts', runner: 'playwright', config: 'web/playwright.config.ts' }]);
  });
});

describe('a project with three Playwright configs', () => {
  const root = join(ROOT, 'configs');
  const { configs, specs } = findSpecs(root);
  const of = (name: string) => specs.find((s) => s.file === `web/e2e/${name}`);

  it('reads the top-level keys, the consts and the projects, not a testMatch of a project as the top one', () => {
    const main = configs.find((c) => c.file === 'web/playwright.config.ts')!;
    expect(main.match.map(String)).toEqual([String(/(^|\/)[^/]*\.(test|spec)\.[cm]?[jt]sx?$/)]);
    expect(main.ignore).toHaveLength(3);
    expect(main.baseURL).toBe('http://localhost:3000');
    expect(main.projects.map((p) => [p.name, p.setup ?? false])).toEqual([['setup', true], ['chromium', false]]);
    const staging = configs.find((c) => c.tag === 'staging')!;
    expect(staging.live).toBe(true);
    expect(configs.find((c) => c.tag === 'demo')!.live).toBeUndefined();
  });

  it('gives each spec all the configs that run it, with the tag of a config that is not the main one', () => {
    expect(of('orders-list.spec.ts')).toEqual({ file: 'web/e2e/orders-list.spec.ts', runner: 'playwright', config: 'web/playwright.config.ts' });
    expect(of('order-cancel.spec.ts')?.config).toBe('web/playwright.config.ts');
    expect(of('demo-walkthrough.spec.ts')).toMatchObject({ config: 'web/playwright.demo.config.ts', tag: 'demo' });
    expect(of('checkout-flow.spec.ts')).toMatchObject({ config: 'web/playwright.staging.config.ts', tag: 'staging (live stack)' });
    expect(of('live/cancel.spec.ts')).toMatchObject({ tag: 'staging (live stack)' });
    expect(of('live/live-stack.ts')).toBeUndefined();
    expect(of('auth.setup.ts')).toMatchObject({ setup: true, config: 'web/playwright.config.ts' });
    expect(of('auth.setup.ts')?.configs).toHaveLength(3);
  });

  it('runs a spec with its own config, and refuses a live stack and a setup file', () => {
    const env = { ATLAS_CACHE_DIR: '/cache' };
    const demo = planRun(root, configs, specs, { spec: 'demo-walkthrough.spec.ts', env });
    if (typeof demo === 'string') throw new Error(demo);
    expect(demo.config.file).toBe('web/playwright.demo.config.ts');
    expect(planRun(root, configs, specs, { spec: 'checkout-flow.spec.ts', env })).toMatch(/live stack/);
    expect(planRun(root, configs, specs, { spec: 'auth.setup.ts', env })).toMatch(/setup file/);
    const all = planRun(root, configs, specs, { env });
    if (typeof all === 'string') throw new Error(all);
    expect(all.config.file).toBe('web/playwright.config.ts');
  });
});

describe('atlas test', () => {
  const root = join(ROOT, 'shop');
  const { configs, specs } = findSpecs(root);

  it('reads the test command and its options', () => {
    expect(parseArgs(['test', '.', 'e2e/orders.spec.ts', '-g', 'saves'])).toMatchObject({ verb: 'test', dir: '.', spec: 'e2e/orders.spec.ts', grep: 'saves' });
    expect(parseArgs(['serve', '.', '--results', 'out'])).toMatchObject({ verb: 'serve', results: 'out' });
    expect(parseArgs(['index', '.', '-g', 'x'])).toBe('Use -g with test only.');
  });

  it('runs Playwright with a trace and the JSON report in the cache folder, not in the repo', () => {
    const plan = planRun(root, configs, specs, { spec: 'orders.spec.ts', grep: 'saves', now: new Date('2026-11-23T10:00:00Z'), env: { ATLAS_CACHE_DIR: '/cache' } });
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.cwd).toBe(join(root, 'web'));
    expect(plan.out).toMatch(/^\/cache\/shop-[0-9a-f]{12}\/runs\/2026-11-23T10-00-00-000Z$/);
    expect(plan.args).toEqual(['--no-install', 'playwright', 'test', '-c', join(root, 'web/playwright.config.ts'), 'e2e/orders.spec.ts', '-g', 'saves', '--trace', 'on', '--reporter', 'json', '--output', `${plan.out}/test-results`]);
    expect(plan.env).toMatchObject({ PLAYWRIGHT_JSON_OUTPUT_NAME: `${plan.out}/report.json`, CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1' });
  });

  it('does not run a test automation project, a remote baseURL, or a spec with no config', () => {
    const remote = { ...configs[0]!, baseURL: 'https://staging.example.com' };
    expect(planRun(root, [remote], specs, {})).toMatch(/not on this computer/);
    const auto = { ...configs[0]!, file: 'qa-tests/playwright.config.ts' };
    expect(planRun(root, [auto], specs.map((s) => ({ ...s, config: auto.file })), {})).toMatch(/test automation project/);
    expect(planRun(root, configs, [{ file: 'web/a.cy.ts', runner: 'cypress' }], { spec: 'a.cy.ts' })).toMatch(/no Playwright config/);
  });
});
