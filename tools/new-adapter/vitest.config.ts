import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['*.test.mjs'], environment: 'node', testTimeout: 10_000, hookTimeout: 10_000 },
});
