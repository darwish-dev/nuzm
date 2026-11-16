import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// NestJS needs decorator metadata, which esbuild does not emit; SWC does.
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    exclude: ['src/**/*.int.spec.ts'],
    // the 10,000-run property tests take ~2 s alone but several times that while the whole pipeline runs in parallel
    testTimeout: 60_000,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
