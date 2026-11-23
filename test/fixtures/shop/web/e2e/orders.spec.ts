import { test, expect, type Page } from '@playwright/test';

const HOME = '/';

async function openForm(page: Page) {
  await page.goto(HOME);
  await page.getByRole('button', { name: 'New order' }).click();
}

test.describe('orders', () => {
  test('saves a new order', async ({ page }) => {
    await page.route('**/api/orders', (route) => route.fulfill({ json: ['a', 'b'] }));
    await test.step('open the form', async () => {
      await openForm(page);
    });
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('2 orders')).toBeVisible();
  });

  test('resets the list', async ({ page }) => {
    await page.goto(HOME);
    await page.getByRole('button', { name: 'Reset' }).click();
    await expect(page.getByText('No orders')).toBeVisible();
  });
});
