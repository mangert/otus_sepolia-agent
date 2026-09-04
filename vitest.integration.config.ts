import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    environment: 'node',
    hookTimeout: 30_000,
    include: ['tests/integration/**/*.test.ts'],
    mockReset: true,
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
