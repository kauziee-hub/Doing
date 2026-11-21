import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.e2e\.ts/,
  timeout: 90_000,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: '../../test-results/e2e-results.json' }]],
  outputDir: '../../test-results/e2e',
  use: { trace: 'retain-on-failure' },
});
