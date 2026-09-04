import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    environment: 'node',
    hookTimeout: 5_000,
    include: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts'],
    mockReset: true,
    restoreMocks: true,
    testTimeout: 5_000,
  },
});
