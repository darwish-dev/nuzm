import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    // preflight: a mandatory, leased, loopback, non-protected database (scripts/testenv); there is no default database
    globalSetup: ['../../scripts/testenv/guard.mjs'],
    include: ['src/**/*.int.spec.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
