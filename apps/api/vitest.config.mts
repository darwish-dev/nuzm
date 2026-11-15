import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// NestJS needs decorator metadata, which esbuild does not emit; SWC does.
export default defineConfig({
  test: { include: ['src/**/*.spec.ts'] },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
