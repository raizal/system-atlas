import type { Page } from '@playwright/test';
import { test, expect, AUDIT_ID } from './fixtures';

const AUDIT = '/audit';
const LIST_PATH = `${AUDIT}/list`;
const ORDERS = `**/api/core-proxy/v1/orders`;

async function openList(page: Page) {
  await page.goto(LIST_PATH);
  await expect(page.getByRole('list')).toBeVisible();
}

test.describe('audits', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(ORDERS, (route) => route.fulfill({ json: [] }));
  });

  test('opens the list of audits', async ({ page }) => {
    await test.step('open the list', async () => {
      await openList(page);
    });
    await page.getByRole('button', { name: 'New audit' }).click();
    await expect(page).toHaveURL('/audit/new');
  });

  test.skip('opens one order', async ({ page, request }) => {
    await page.goto(`${process.env.BASE_URL}/orders/${AUDIT_ID}`);
    await page.getByTestId('order-row').first().click();
    await request.get('/api/audits');
  });
});
