import { defineConfig } from 'vitest/config';

// Integration tests need docker and a browser image: run them with `tests/integration/run.sh`, never in `npm test`.
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
