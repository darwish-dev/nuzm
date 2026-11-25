import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // preflight: a mandatory, leased, loopback, non-protected database (scripts/testenv); there is no default database
    globalSetup: ['../../scripts/testenv/guard.mjs'],
    include: ['src/**/*.int.spec.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
    // R5 (P3-S02): the builder's git-store runs git on the test host; the guard needs the explicit local-development opt-in (never set in production; specs that test the refusal delete it)
    env: { NUZM_LOCAL_DEV_EXEC: '1' },
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
