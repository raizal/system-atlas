// The Tests mode e2e: the atlas of the shop fixture (an e2e spec with a mock). It opens the Tests
// mode, opens a case, steps three times, and sees the page and the endpoint lit on the map. It also
// opens a case from the coverage badge of a page, and from the search. The atlas only reads.

import { expect, test, type Page } from '@playwright/test';

const CASE = 'web/e2e/orders.spec.ts:11';
const ENDPOINT = 'ep:shop-api:GET /api/orders';

const canvas = (page: Page) => page.getByTestId('canvas');
const node = (page: Page, fid: string) => page.locator(`[data-testid="node"][data-id="${fid}"]`);
const step = (page: Page, id: string) => node(page, `flow:${CASE}§step:${id}`);

async function ready(page: Page): Promise<void> {
  await expect(canvas(page)).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
}

test('the Tests mode plays a case on the map', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  // 1. The list of the cases: by project, then by describe.
  await page.getByTestId('mode-tests').click();
  await ready(page);
  await expect(page.getByTestId('tests-list')).toBeVisible();
  await expect(page.getByTestId('tests-project')).toContainText('shop-web');
  await expect(page.getByTestId('case-row')).toHaveCount(2);
  await expect(page.getByTestId('tests-list')).toContainText('orders');

  // 2. Open a case: its flow chart (left) and the parts of the map that it touches (right).
  await page.locator(`[data-testid="case-row"][data-case="${CASE}"]`).click();
  await ready(page);
  await expect(page.getByTestId('player')).toBeVisible();
  await expect(step(page, 's1')).toBeVisible();
  await expect(node(page, ENDPOINT)).toBeVisible();
  await expect(node(page, ENDPOINT).getByTestId('badge-mock')).toBeVisible();
  const pageNode = page.locator('[data-testid="node"][data-shape="page"]').first();
  await expect(pageNode).toBeVisible();
  await expect(page.getByTestId('step-count')).toHaveText('0 / 5');

  // 3. Step three times: the mock, the goto, the click on "New order".
  for (let i = 0; i < 3; i++) await page.getByTestId('step-next').click();
  await expect(canvas(page)).toHaveAttribute('data-step', '2');
  expect(page.url()).toContain('step=2');
  await expect(page.getByTestId('step-text')).toContainText('New order');
  await expect(step(page, 's2.1.2')).toHaveAttribute('data-play', 'lit');
  await expect(node(page, 'el:web/src/App.tsx:31')).toHaveAttribute('data-play', 'lit');
  // The page of the goto stays lit until the next goto; the steps to come fade.
  await expect(pageNode).toHaveAttribute('data-play', 'lit');
  await expect(node(page, ENDPOINT)).toHaveAttribute('data-play', /lit|played/);
  await expect(step(page, 's4')).toHaveAttribute('data-play', 'dim');

  // 4. Back one step: the goto is lit, and so is its page.
  await page.getByTestId('step-back').click();
  await expect(canvas(page)).toHaveAttribute('data-step', '1');
  await expect(pageNode).toHaveAttribute('data-play', 'lit');

  // 5. A reload keeps the case and the step.
  await page.reload();
  await ready(page);
  await expect(canvas(page)).toHaveAttribute('data-step', '1');
  await expect(page.getByTestId('step-count')).toHaveText('2 / 5');
});

test('a coverage badge and the search open a case', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.getByTestId('coverage').check();
  await node(page, 'project:shop-web').getByTestId('open').click();
  await ready(page);
  const badge = page.locator('[data-testid="node"][data-shape="page"] [data-testid="badge-cover"]').first();
  await expect(badge).toBeVisible();
  await badge.click();
  await expect(page.getByTestId('cases')).toBeVisible();
  await page.locator(`[data-testid="case-link"][data-case="${CASE}"]`).click();
  await ready(page);
  await expect(canvas(page)).toHaveAttribute('data-mode', 'tests');
  await expect(page.getByTestId('player')).toBeVisible();

  await page.getByTestId('mode-system').click();
  await ready(page);
  await page.getByTestId('search').fill('resets');
  await page.getByTestId('hits').getByText('resets the list').click();
  await ready(page);
  await expect(canvas(page)).toHaveAttribute('data-mode', 'tests');
  expect(decodeURIComponent(page.url())).toContain('case=web/e2e/orders.spec.ts:20');
});

test('a case lists its areas and checks; an endpoint lists its cases; the list filters', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.getByTestId('mode-tests').click();
  await ready(page);

  // 1. The list: "Coverage by area" on top, a filter box, and the areas of each case in its row.
  await expect(page.getByTestId('coverage-area')).toHaveCount(1);
  await expect(page.locator(`[data-testid="case-row"][data-case="${CASE}"] [data-testid="case-areas"]`)).toContainText('endpoints');
  await page.getByTestId('tests-filter').fill('resets');
  await expect(page.getByTestId('case-row')).toHaveCount(1);
  await page.getByTestId('tests-filter').fill('');
  await page.getByTestId('coverage-area').first().click();
  await expect(page.getByTestId('area-filter')).toBeVisible();
  await expect(page.getByTestId('case-row')).toHaveCount(2);

  // 2. Open a case: the panel shows a page, and the GET endpoint as mocked (it does not run).
  await page.locator(`[data-testid="case-row"][data-case="${CASE}"]`).click();
  await ready(page);
  const panel = page.getByTestId('case-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-testid="area-item"][data-layer="page"]')).toHaveCount(1);
  const endpoint = panel.locator(`[data-testid="area-item"][data-node="${ENDPOINT}"]`);
  await expect(endpoint).toHaveAttribute('data-how', /mocked/);
  await expect(endpoint).toHaveAttribute('data-how', /notRun/);
  await expect(panel.getByTestId('checks')).toContainText('the text "2 orders" shows');
  // A click on an item selects its box on the map.
  await endpoint.click();
  await expect(page.getByTestId('panel')).toContainText('GET /api/orders');

  // 3. In System, the endpoint lists the case, with how and the last result.
  await page.getByTestId('mode-system').click();
  await ready(page);
  await node(page, 'project:shop-api').getByTestId('open').click();
  await ready(page);
  // In an open box, the ID of a box is "<container>§<id>".
  await page.locator(`[data-testid="node"][data-id$="§${ENDPOINT}"]`).click();
  const cases = page.getByTestId('cases');
  await expect(cases).toBeVisible();
  await expect(cases.locator(`[data-testid="case-link"][data-case="${CASE}"]`)).toBeVisible();
  await expect(cases).toContainText('mocked');
});
