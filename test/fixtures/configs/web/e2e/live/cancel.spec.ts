import { test, expect } from '@playwright/test'

test('a cancel reaches the real API', async ({ page }) => {
  await page.goto('/orders/42')
  await page.getByRole('button', { name: 'Cancel order' }).click()
  await expect(page.getByText('Cancelled')).toBeVisible()
})
