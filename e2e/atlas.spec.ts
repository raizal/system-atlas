// The atlas e2e: a box opens in place. The other boxes stay on the canvas, and the open box holds its
// inner process. The URL hash keeps the open boxes. The test reads only: the atlas API has no write.
// The atlas is of the shop fixture (see playwright.config.ts).

import { expect, test, type Locator, type Page } from '@playwright/test';

const SEP = '§';
const UI = 'project:shop-web';
const SERVER = 'project:shop-api';
const TOOL = 'project:shop-tool';
const CORE = 'project:shop-core';
const GET_ORDERS = 'ep:shop-api:GET /api/orders';

const canvas = (page: Page) => page.getByTestId('canvas');
/** A closed box or a leaf, by its full ID. */
const node = (page: Page, fid: string) => page.locator(`[data-testid="node"][data-id="${fid}"]`);
/** An open box, by its full ID. */
const container = (page: Page, fid: string) => page.locator(`[data-testid="container"][data-id="${fid}"]`);

async function ready(page: Page): Promise<void> {
  await expect(canvas(page)).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
}

/** Open a closed box with its + button, and wait for the layout. */
async function open(page: Page, box: Locator): Promise<void> {
  await box.first().getByTestId('open').click();
  await ready(page);
}

async function inside(inner: Locator, outer: Locator): Promise<void> {
  const a = (await inner.boundingBox())!;
  const b = (await outer.boundingBox())!;
  expect(a.x).toBeGreaterThanOrEqual(b.x - 1);
  expect(a.y).toBeGreaterThanOrEqual(b.y - 1);
  expect(a.x + a.width).toBeLessThanOrEqual(b.x + b.width + 1);
  expect(a.y + a.height).toBeLessThanOrEqual(b.y + b.height + 1);
}

test('a box opens in place, the other boxes stay, and a reload keeps the open boxes', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  // 1. The system level: the projects in groups by kind.
  await expect(node(page, UI)).toBeVisible();
  await expect(node(page, SERVER)).toBeVisible();
  await expect(page.getByTestId('group').filter({ hasText: 'Frontends' })).toBeVisible();
  await expect(page.getByTestId('legend')).toBeVisible();

  // 2. Open shop-web: it becomes a container with its pages, and the shop-api box stays.
  await open(page, node(page, UI));
  const ui = container(page, UI);
  await expect(ui).toBeVisible();
  await expect(node(page, SERVER)).toBeVisible();
  await expect(page).toHaveURL(/#\/\?open=/);
  const app = page.locator(`[data-testid="node"][data-shape="page"][data-id^="${UI}${SEP}"][data-label="App"]`);
  await expect(app).toBeVisible();
  await inside(app, ui);
  const appFid = (await app.getAttribute('data-id'))!;

  // 3. Open App inside shop-web: the diamonds of App are inside the App box, and shop-api is still there.
  await open(page, app);
  const appBox = container(page, appFid);
  await expect(appBox).toBeVisible();
  await expect(ui).toBeVisible();
  await expect(node(page, SERVER)).toBeVisible();
  const diamond = page.locator(`[data-shape="decision"][data-id^="${appFid}${SEP}"]`).first();
  await expect(diamond).toBeVisible();
  await inside(diamond, appBox);

  // A click selects a node: the strip shows the path of open boxes, and the panel shows the file.
  await page.locator(`[data-shape="start"][data-id^="${appFid}${SEP}"]`).first().click();
  await expect(page.getByTestId('panel')).toBeVisible();
  await expect(page.getByTestId('where')).toContainText('web/src/App.tsx:');
  await expect(page.getByTestId('strip-path')).toContainText('App');

  // 4. Open a call step in App: the chart of the callee is inside the call box.
  const call = page.locator(`[data-testid="node"][data-shape="call"][data-id^="${appFid}${SEP}"]`).filter({ has: page.getByTestId('open') }).first();
  const callFid = (await call.getAttribute('data-id'))!;
  await open(page, call);
  const callBox = container(page, callFid);
  await expect(callBox).toBeVisible();
  const inner = page.locator(`[data-testid="node"][data-id^="${callFid}${SEP}"]`).first();
  await expect(inner).toBeVisible();
  await inside(inner, callBox);

  // 5. The camera shows the call box: its "−" closes it, and its inner nodes go away.
  await callBox.getByTestId('collapse').first().click();
  await ready(page);
  await expect(node(page, callFid)).toBeVisible();
  await expect(page.locator(`[data-id^="${callFid}${SEP}"]`)).toHaveCount(0);

  // 6. Escape closes the deepest open box that holds the selection (a step in App): App closes,
  // and shop-web stays open. App is the selection now.
  await page.keyboard.press('Escape');
  await ready(page);
  await expect(node(page, appFid)).toBeVisible();
  await expect(page.locator(`[data-id^="${appFid}${SEP}"]`)).toHaveCount(0);
  await expect(ui).toBeVisible();

  // 7. The panel opens App again, and the camera shows App.
  await page.getByTestId('panel-toggle').click();
  await ready(page);
  await expect(container(page, appFid)).toBeVisible();

  // 8. The head of App can be out of view: the × of App in the strip path closes App.
  await page.locator(`[data-shape="start"][data-id^="${appFid}${SEP}"]`).first().click();
  await expect(page.locator(`[data-testid="strip-part"][data-id="${appFid}"]`)).toBeVisible();
  await page.locator(`[data-testid="strip-close"][data-id="${appFid}"]`).click();
  await ready(page);
  await expect(node(page, appFid)).toBeVisible();
  await expect(page.locator(`[data-id^="${appFid}${SEP}"]`)).toHaveCount(0);
  await expect(ui).toBeVisible();

  // 9. Open App again. A part of the strip path selects that box: shop-web.
  await page.getByTestId('panel-toggle').click();
  await ready(page);
  await expect(container(page, appFid)).toBeVisible();
  await page.locator(`[data-testid="strip-part"][data-id="${UI}"]`).click();
  await expect(page.getByTestId('strip-where')).toContainText('project');

  // 10. A reload keeps the open boxes.
  await page.reload();
  await ready(page);
  await expect(container(page, UI)).toBeVisible();
  await expect(container(page, appFid)).toBeVisible();
  await expect(page.locator(`[data-shape="decision"][data-id^="${appFid}${SEP}"]`).first()).toBeVisible();
});

test('a search hit opens the path to it, and selects it', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.getByTestId('search').fill('loadOrders');
  await expect(page.getByTestId('hits')).toBeVisible();
  // Enter shows the lens (lens.spec.ts); a click on a hit jumps to it.
  await page.getByTestId('hits').locator('button').filter({ has: page.locator('.hit-label', { hasText: /^loadOrders$/ }) }).first().click();
  await ready(page);
  await expect(container(page, UI)).toBeVisible();
  const hit = page.locator(`[data-testid="node"][data-id^="${UI}${SEP}"][data-label="loadOrders"]`);
  await expect(hit).toBeVisible();
  await expect(page.getByTestId('panel')).toBeVisible();
  await expect(page.getByTestId('strip-path')).toContainText('loadOrders');
});

const LIBS = 'group:kind:library';
/** The wrapper of a box on the canvas: it has the class "dim" when the box is out of the focus. */
const wrapper = (page: Page, fid: string) => page.locator('.react-flow__node').filter({ has: page.locator(`[data-id="${fid}"]`) }).last();

test('the mode is in the hash: a reload keeps it; a matrix cell opens both projects in System mode', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await expect(page.getByTestId('mode-system')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('mode-features').click();
  await expect(page).toHaveURL(/mode=features/);
  await ready(page);
  await expect(page.locator('[data-testid="node"][data-shape="feature"]').first()).toBeVisible();
  await page.reload();
  await ready(page);
  await expect(page.getByTestId('mode-features')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-testid="node"][data-shape="feature"]').first()).toBeVisible();

  await page.getByTestId('mode-matrix').click();
  await expect(page.getByTestId('matrix')).toBeVisible();
  const cell = page.locator(`[data-testid="matrix-cell"][data-row="shop-web"][data-col="shop-api"]`);
  await expect(cell).toContainText('direct');
  await cell.click();
  await ready(page);
  await expect(page.getByTestId('mode-system')).toHaveAttribute('aria-pressed', 'true');
  await expect(container(page, UI)).toBeVisible();
  await expect(container(page, SERVER)).toBeVisible();
  // The cell filters both projects: the strip shows a chip that clears the filter.
  await expect(page.getByTestId('filter-chip')).toBeVisible();
  await expect(page.getByTestId('filter-chip')).toContainText('→');
  // An automatic fit never goes below zoom 0.4.
  await expect
    .poll(async () => {
      const t = await page.locator('.react-flow__viewport').evaluate((el) => getComputedStyle(el).transform);
      const m = /matrix\(([-\d.e]+)/.exec(t);
      return m ? Number(m[1]) : 0;
    })
    .toBeGreaterThanOrEqual(0.4);
  // The view fits both projects: each box is in the canvas, left of the side panel.
  await expect
    .poll(async () => {
      const canvas = await page.locator('.react-flow').boundingBox();
      const panel = await page.getByTestId('panel').boundingBox();
      if (!canvas) return 'no canvas';
      const right = panel ? Math.min(canvas.x + canvas.width, panel.x) : canvas.x + canvas.width;
      const out: string[] = [];
      for (const fid of [UI, SERVER]) {
        const b = await container(page, fid).boundingBox();
        if (!b || b.x < canvas.x - 1 || b.y < canvas.y - 1 || b.x + b.width > right + 1 || b.y + b.height > canvas.y + canvas.height + 1) out.push(fid);
      }
      return out.join(',') || 'in view';
    })
    .toBe('in view');
  // The × of the chip clears the filter.
  await page.getByTestId('filter-clear').click();
  await expect(page.getByTestId('filter-chip')).toHaveCount(0);
  await expect(page).not.toHaveURL(/filter=/);
});

test('System mode: collapse and expand Libraries, compact names, imports hidden by default, focus fades the others', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  // Collapse Libraries: one row with the count. A reload keeps it.
  const libs = page.locator(`[data-testid="group"][data-id="${LIBS}"]`);
  await expect(libs).toBeVisible();
  await libs.getByTestId('fold').click();
  await ready(page);
  const row = node(page, LIBS);
  await expect(row).toBeVisible();
  await expect(row).toContainText('1 library');
  await expect(node(page, CORE)).toHaveCount(0);
  await expect(page).toHaveURL(/fold=/);
  await page.reload();
  await ready(page);
  await expect(node(page, LIBS)).toBeVisible();
  await node(page, LIBS).getByTestId('unfold').click();
  await ready(page);
  await expect(libs).toBeVisible();
  await expect(node(page, CORE)).toBeVisible();

  // Compact: the libraries show their names only.
  await libs.getByTestId('compact').click();
  await ready(page);
  await expect(node(page, CORE)).toHaveClass(/size-chip/);
  await libs.getByTestId('compact').click();
  await ready(page);
  await expect(node(page, CORE)).not.toHaveClass(/size-chip/);

  // The import edges are hidden; "Show imports" shows them.
  const imp = page.getByTestId('rf__edge-uses:shop-tool>shop-core');
  await expect(imp).toHaveCount(0);
  await page.getByTestId('imports').check();
  await expect(imp).toHaveCount(1);
  await page.getByTestId('imports').uncheck();
  await expect(imp).toHaveCount(0);

  // Focus: select shop-web. Its neighbours stay clear, the others fade. Escape clears the focus.
  await node(page, UI).click();
  await expect(wrapper(page, UI)).not.toHaveClass(/dim/);
  await expect(wrapper(page, SERVER)).not.toHaveClass(/dim/);
  await expect(wrapper(page, TOOL)).toHaveClass(/dim/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.react-flow__node.dim')).toHaveCount(0);
});

test('Features mode: open a feature, see the endpoint links of its pages, select an endpoint, open its flow chart', async ({ page }) => {
  await page.goto('/#/?mode=features');
  await ready(page);
  const feature = page.locator('[data-testid="node"][data-shape="feature"]').first();
  const fid = (await feature.getAttribute('data-id'))!;
  await open(page, feature);
  const box = container(page, fid);
  await expect(box).toBeVisible();
  const app = page.locator(`[data-testid="node"][data-shape="page"][data-id^="${fid}${SEP}"][data-label="App"]`);
  await expect(app).toBeVisible();
  await inside(app, box);
  // The API box is closed: the links of App go into it as one link with the count; its title says how far.
  const merged = page.getByTestId('edge-label').filter({ hasText: /^2 endpoints$/ });
  await expect(merged).toBeVisible();
  await expect(merged).toHaveAttribute('title', /1 step from the page/);

  // The endpoints sit in the API box: open it. Each page link now says how the page reaches its
  // endpoint. When two labels would overlap, a label shows on hover only: then it is the <title> of the edge.
  await open(page, node(page, SERVER));
  const ep = page.locator(`[data-testid="node"][data-shape="endpoint"][data-id^="${SERVER}${SEP}"][data-id$="${GET_ORDERS}"]`);
  await expect(ep).toBeVisible();
  await expect(page.locator('[data-testid="edge-label"], .react-flow__edge title').filter({ hasText: /via \d+ steps?|direct/ })).not.toHaveCount(0);
  await expect(ep).toContainText('1 feature');

  // Select the endpoint: the page that reaches it stays clear; the other pages fade.
  await ep.click();
  const epFid = (await ep.getAttribute('data-id'))!;
  await expect(wrapper(page, (await app.getAttribute('data-id'))!)).not.toHaveClass(/dim/);
  const other = page.locator(`[data-testid="node"][data-shape="page"][data-id^="${fid}${SEP}"][data-label="StatusView"]`);
  await expect(wrapper(page, (await other.getAttribute('data-id'))!)).toHaveClass(/dim/);

  // Open the endpoint: its handler flow chart is inside it.
  await open(page, ep);
  const epBox = container(page, epFid);
  await expect(epBox).toBeVisible();
  const step = page.locator(`[data-testid="node"][data-id^="${epFid}${SEP}"]`).first();
  await expect(step).toBeVisible();
  await inside(step, epBox);
});

test('Features mode: the side panel never covers the selected endpoint; its + button opens it', async ({ page }) => {
  await page.goto('/#/?mode=features');
  await ready(page);
  await open(page, node(page, SERVER));
  const ep = page.locator(`[data-testid="node"][data-shape="endpoint"][data-id^="${SERVER}${SEP}"]`).first();
  await expect(ep).toBeVisible();
  const epFid = (await ep.getAttribute('data-id'))!;
  await ep.click();
  await expect(page.getByTestId('panel')).toBeVisible();
  // The camera moves the endpoint (if it must) into the part of the canvas left of the panel.
  await expect
    .poll(async () => {
      const b = await ep.boundingBox();
      const p = await page.getByTestId('panel').boundingBox();
      const c = await page.locator('.react-flow').boundingBox();
      if (!b || !p || !c) return 'no box';
      return b.x >= c.x && b.y >= c.y && b.x + b.width <= p.x && b.y + b.height <= c.y + c.height ? 'clear' : `at ${Math.round(b.x)}..${Math.round(b.x + b.width)}, panel at ${Math.round(p.x)}`;
    })
    .toBe('clear');
  await open(page, ep);
  await expect(container(page, epFid)).toBeVisible();
});

test('the API refuses a write', async ({ request }) => {
  const res = await request.post('api/view?id=system');
  expect(res.status()).toBe(405);
});
