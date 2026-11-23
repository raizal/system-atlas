import { defineConfig, devices } from '@playwright/test'

// The demo recording runs from playwright.demo.config.ts.
const DEMO_ONLY = ['**/demo-*']

/* The checkout flow and e2e/live/ drive a real API: playwright.staging.config.ts. */
const LIVE_ONLY = ['**/checkout-flow.spec.ts', '**/live/**']

export default defineConfig({
  testDir: './e2e',
  testIgnore: [...DEMO_ONLY, ...LIVE_ONLY],
  use: {
    baseURL: 'http://localhost:3000',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],
})
