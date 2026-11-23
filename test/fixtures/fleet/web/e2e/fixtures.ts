import { test as base, type Page } from '@playwright/test';

export { expect } from '@playwright/test';

export const AUDIT_ID = 'a-1';
export const AUDITS = '**/api/audits';

export async function mockAudits(page: Page) {
  await page.route(AUDITS, (route) => route.fulfill({ json: ['a-1'] }));
}

export const test = base.extend({
  page: async ({ page }, use) => {
    await mockAudits(page);
    await use(page);
  },
});
