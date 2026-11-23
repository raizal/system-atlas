import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The page of the atlas. `base: './'` keeps the asset URLs relative, so the build works behind a proxy too.
export default defineConfig({
  base: './',
  root: 'src/web',
  plugins: [react()],
  // ELK is most of the bundle. The page comes from 127.0.0.1, so one chunk is fine.
  build: { outDir: '../../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 2500 },
  // `npm run dev`: the API calls go to a running `atlas serve` (default port 4890).
  server: { proxy: { '/api': process.env.ATLAS_API ?? 'http://127.0.0.1:4890' } },
  test: { root: '.', include: ['test/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 120_000 },
});
