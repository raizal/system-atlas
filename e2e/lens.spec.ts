// The search lens e2e, on the shop fixture: Enter redraws the map with only the parts that fit the
// query; the × of a chip redraws it; the Show button adds seeds; the "+N types" box adds kind:type;
// a reload keeps the query (#/?q=); "Whole map" goes back.

import { expect, test, type Page } from '@playwright/test';

const POST = 'ep:shop-api:POST /api/orders';
const QUERY = 'create order kind:endpoint';
const TYPES = 'lens:types';

const canvas = (page: Page) => page.getByTestId('canvas');
const node = (page: Page, fid: string) => page.locator(`[data-testid="node"][data-id="${fid}"]`);
const nodes = (page: Page) => page.locator('[data-testid="node"]');

async function ready(page: Page): Promise<void> {
  await expect(canvas(page)).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
}

test('the lens: Enter redraws, a chip × redraws, Show all adds seeds, a reload keeps it, Whole map goes back', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await expect(node(page, 'project:shop-web')).toBeVisible();

  // 1. Enter: only the parts that fit. kind:endpoint keeps the endpoints.
  await page.getByTestId('search').fill(QUERY);
  await page.getByTestId('search').press('Enter');
  await expect(page.getByTestId('lens-bar')).toBeVisible();
  await ready(page);
  await expect(page).toHaveURL(/#\/\?q=create%20order%20kind%3Aendpoint/);
  await expect(page.getByTestId('lens-chip')).toHaveCount(1);
  await expect(page.getByTestId('lens-chip')).toHaveAttribute('data-key', 'kind');
  await expect(page.getByTestId('lens-time')).toHaveText(/^\d+ ms$/);
  await expect(page.getByTestId('lens-error')).toHaveCount(0);
  await expect(node(page, POST)).toBeVisible();
  await expect(node(page, 'project:shop-web')).toHaveCount(0);
  const few = await nodes(page).count();
  expect(few).toBeGreaterThan(0);
  expect(await page.locator('[data-testid="node"][data-id^="fn:"]').count()).toBe(0);

  // 2. The panel says why an item is there.
  await node(page, POST).click();
  await expect(page.getByTestId('why')).toContainText('in the path');

  // 3. The × of the chip: the lens of the words only: the best seeds, their chains (the page and
  //    the data store), the main chain lit, and the test cases that touch the lens.
  await page.getByTestId('lens-chip-remove').click();
  await ready(page);
  await expect(page.getByTestId('lens-chip')).toHaveCount(0);
  await expect(page.getByTestId('lens-query')).toHaveText('create order');
  await expect(page).toHaveURL(/#\/\?q=create%20order$/);
  await expect(node(page, POST)).toBeVisible();
  await expect.poll(() => nodes(page).count()).toBeGreaterThan(few);
  await expect(page.getByTestId('lens-more')).toContainText('more fit');
  await expect(page.getByTestId('search')).toHaveValue('create order');
  await expect(page.locator('.react-flow__node.lens-main')).not.toHaveCount(0);
  await expect(page.locator('[data-testid="node"][data-id^="case:"]').filter({ hasText: 'saves a new order' })).toBeVisible();
  const chain = await nodes(page).count();

  // 3b. "Show all": show:N in the query, a chip, more parts. The × of that chip goes back.
  await page.getByTestId('lens-show-all').click();
  await ready(page);
  await expect(page).toHaveURL(/show%3A\d+/);
  await expect(page.getByTestId('lens-chip')).toHaveCount(1);
  await expect(page.getByTestId('lens-chip')).toHaveAttribute('data-key', 'show');
  await expect.poll(() => nodes(page).count()).toBeGreaterThan(chain);
  await page.getByTestId('lens-chip-remove').click();
  await ready(page);
  await expect(page).toHaveURL(/#\/\?q=create%20order$/);

  // 4. A reload keeps the lens.
  await page.reload();
  await ready(page);
  await expect(page.getByTestId('lens-bar')).toBeVisible();
  await expect(page.getByTestId('lens-query')).toHaveText('create order');
  await expect(node(page, POST)).toBeVisible();

  // 5. Whole map: back to the System view.
  await page.getByTestId('lens-clear').click();
  await ready(page);
  await expect(page.getByTestId('lens-bar')).toHaveCount(0);
  await expect(node(page, 'project:shop-web')).toBeVisible();
  await expect(page).not.toHaveURL(/q=/);
});

test('the "+N types" box of a lens: a click adds kind:type and shows the types', async ({ page }) => {
  await page.goto('/#/?q=order%20status');
  await ready(page);
  await expect(node(page, TYPES)).toBeVisible();
  await expect(node(page, TYPES)).toContainText('+1 type');
  await node(page, TYPES).click();
  await ready(page);
  await expect(page.getByTestId('lens-query')).toHaveText('order status kind:type');
  await expect(page.getByTestId('lens-chip')).toHaveAttribute('data-key', 'kind');
  await expect(node(page, TYPES)).toHaveCount(0);
  await expect(page.locator('[data-testid="node"][data-label="OrderStatus"]')).toBeVisible();
});

test('a bad chip shows an error, not a blank map', async ({ page }) => {
  await page.goto('/#/?q=create%20order%20kind%3Arobot');
  await ready(page);
  await expect(page.getByTestId('lens-error')).toContainText('kind:robot is not one of');
  await expect(node(page, POST)).toBeVisible();
});

test('the first view of a lens shows its top left boxes in full, at zoom 0.6 or more', async ({ page }) => {
  await page.goto('/#/?q=order');
  await ready(page);
  const c = (await canvas(page).boundingBox())!;
  const boxes = page.locator('[data-testid="node"], [data-testid="group"]');
  await expect.poll(async () => boxes.count()).toBeGreaterThan(0);
  const all = await boxes.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y })));
  expect(Math.min(...all.map((b) => b.y))).toBeGreaterThanOrEqual(c.y - 1);
  expect(Math.min(...all.map((b) => b.x))).toBeGreaterThanOrEqual(c.x - 1);
  const t = await page.locator('.react-flow__viewport').evaluate((el) => getComputedStyle(el).transform);
  expect(Number(/matrix\(([-\d.e]+)/.exec(t)?.[1] ?? 0)).toBeGreaterThanOrEqual(0.6);
});

test('a picked function hit shows the function as a box in its project, and its + opens its flow chart', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.getByTestId('search').fill('createOrder');
  await page.getByTestId('hits').getByRole('button', { name: /createOrder/ }).first().click();
  await ready(page);
  const fn = page.locator('[data-testid="node"][data-id^="project:shop-api§fn:"]').filter({ hasText: 'createOrder' });
  await expect(fn).toHaveCount(1);
  await expect(page).toHaveURL(/[?&]pin=/);
  await expect(page.locator('[data-testid="group"][data-group="code"]')).toHaveCount(1);
  // The ID before the click: an open box is a group, and its start step has the same name.
  const id = await fn.getAttribute('data-id');
  await fn.getByTestId('open').click();
  await ready(page);
  await expect(page.locator(`[data-testid="node"][data-id^="${id}§"]`).first()).toBeVisible();
  // A reload keeps the pinned box, open.
  await page.reload();
  await ready(page);
  await expect(page.locator(`[data-testid="node"][data-id^="${id}§"]`).first()).toBeVisible();
});
