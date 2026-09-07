import { defineConfig } from 'vitest/config';

/** Opt-in only: these hit a real gateway and cost money. See docs/adr/002-llm-gateway.md. */
export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.smoke.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
});
