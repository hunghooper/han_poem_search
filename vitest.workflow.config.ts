import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/worker/src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: 'forks',
  },
});
