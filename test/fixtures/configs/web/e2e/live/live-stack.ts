import { test as base } from '@playwright/test'

// A helper of the live specs: the base URL of the real API.
export const test = base.extend<{ apiUrl: string }>({
  apiUrl: async ({}, use) => use(process.env.API_URL ?? 'http://localhost:8000'),
})
