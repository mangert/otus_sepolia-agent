import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    environment: 'node',
    hookTimeout: 30_000,
    include: ['tests/llm-integration/**/*.test.ts'],
    mockReset: true,
    restoreMocks: true,
    testTimeout: 120_000,
  },
});
