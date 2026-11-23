import { test, expect } from '@playwright/test'

test('buys one item from cart to receipt', async ({ page }) => {
  await page.goto('/cart')
  await page.getByRole('button', { name: 'Check out' }).click()
  await expect(page.getByText('Thank you')).toBeVisible()
})
