import { test, expect } from '@playwright/test'

test('lists the orders', async ({ page }) => {
  await page.goto('/orders')
  await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible()
})
