import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
    // Smoke tests hit a real, paid gateway over the network. Leaving them in the default run
    // makes `pnpm check` slow, flaky and billable, which is how a blocking gate turns into a
    // test people learn to skip. Run deliberately: `pnpm smoke`.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.int.test.ts', '**/*.smoke.test.ts'],
    environment: 'node',
  },
});
