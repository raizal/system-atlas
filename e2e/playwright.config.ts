// The e2e test of the atlas page. It builds nothing: run `npm run build` first.
//
//   npm run build
//   npm run e2e
//
// The web server copies the shop fixture (test/fixtures/shop: a frontend, an API, a tool, a library,
// two data stores and an e2e spec with a mock) to a temp folder, makes the CodeGraph index of the
// copy, and serves the atlas of it. The e2e needs no other repo.
//
// CodeGraph telemetry is off: the web server gets CODEGRAPH_TELEMETRY=0 and DO_NOT_TRACK=1.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.ATLAS_E2E_PORT ?? 4891);
const SHOP = join(tmpdir(), 'atlas-e2e-shop');
const ENV = { CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1' };

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}/`, trace: 'retain-on-failure', viewport: { width: 1440, height: 900 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `rm -rf "${SHOP}" && cp -R test/fixtures/shop "${SHOP}" && node bin/atlas.js serve "${SHOP}" --port ${PORT}`,
    cwd: join(import.meta.dirname, '..'),
    env: ENV,
    url: `http://127.0.0.1:${PORT}/api/info`,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: 'pipe',
  },
});
