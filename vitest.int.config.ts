import { defineConfig } from 'vitest/config';

/**
 * Integration tests — CONTRIBUTING.md: "*.int.test.ts ... we do not mock Postgres or Qdrant,
 * the query behaviour IS what is under test." Kept out of the default run because they need
 * a live database; run with `pnpm test:int`.
 */
export default defineConfig({
  test: {
    include: ['{packages,apps}/**/src/**/*.int.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
