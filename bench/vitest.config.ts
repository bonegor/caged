import { defineConfig } from 'vitest/config';

// Balance harness, kept out of `npm test`: npx vitest run --config bench/vitest.config.ts
export default defineConfig({
  test: {
    include: ['bench/**/*.test.ts'],
    testTimeout: 900000,
  },
});
