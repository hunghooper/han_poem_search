import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.int.test.ts',
      '**/*.smoke.test.ts',
      'apps/worker/**',
    ],
    environment: 'node',
  },
});
