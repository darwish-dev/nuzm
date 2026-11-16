import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Next's tsconfig uses jsx: preserve; tests need the JSX transformed (automatic runtime).
  oxc: { jsx: { runtime: 'automatic' } },
  test: { include: ['**/*.spec.{ts,tsx}'], exclude: ['node_modules', '.next'] },
});
