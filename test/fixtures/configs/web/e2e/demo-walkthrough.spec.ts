import { test, expect } from '@playwright/test'

test('a short tour of the shop', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Orders' }).click()
  await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible()
})
