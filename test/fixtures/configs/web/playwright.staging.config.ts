import { defineConfig } from '@playwright/test'

const SERIAL = new RegExp(`(checkout-flow\\.spec\\.ts)$`)

export default defineConfig({
  testDir: './e2e',
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'serial', testMatch: SERIAL, dependencies: ['setup'] },
    { name: 'parallel', testMatch: /(checkout-flow|live\/.+)\.spec\.ts/, testIgnore: SERIAL, dependencies: ['setup'] },
  ],
})
