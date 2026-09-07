import { defineConfig } from 'vitest/config';

/**
 * Workflow tests spin up a real Temporal test server, so they are slower than unit tests and
 * kept out of the default run. `pnpm test:wf`.
 */
export default defineConfig({
  test: {
    include: ['apps/worker/src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: 'forks',
  },
});
