import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'tests/integration/**/*.test.ts', 'apps/desktop/electron/**/*.test.ts', 'apps/cloud/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    pool: 'forks',
    reporters: ['default'],
  },
});
