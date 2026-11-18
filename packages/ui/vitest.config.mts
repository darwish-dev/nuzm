import { defineConfig } from 'vitest/config';

// axe-core runs a full accessibility audit per test; under a busy parallel `turbo run test` the default 5 s is too tight.
export default defineConfig({ test: { testTimeout: 30_000 } });
