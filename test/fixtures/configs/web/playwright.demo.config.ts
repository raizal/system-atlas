import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: /(demo-walkthrough\.spec|auth\.setup)\.ts/,
  use: { baseURL: process.env.DEMO_BASE_URL ?? 'http://localhost:3100' },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'chromium', testMatch: /demo-walkthrough\.spec\.ts/, dependencies: ['setup'] },
  ],
})
