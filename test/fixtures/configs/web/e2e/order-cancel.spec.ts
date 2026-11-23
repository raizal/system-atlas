import { test, expect } from '@playwright/test'

test('cancels an open order', async ({ page }) => {
  await page.goto('/orders/42')
  await page.getByRole('button', { name: 'Cancel order' }).click()
  await expect(page.getByText('Cancelled')).toBeVisible()
})
