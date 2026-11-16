import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      '.dev-vault/**',
      'packages/sdk/src/schema.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { process: 'readonly' } },
  },
  {
    // Module boundaries (docs/02 §3, ADR-001): import only a module's public index and
    // a package's public entry, never internals. Violations must fail lint (bootstrap B6).
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nuzm/*/src/*', '@nuzm/*/dist/*'],
              message: 'Import a package only through its public entry point.',
            },
            {
              // Reaching into another module's internals via a parent-relative path is forbidden;
              // a module's own files use './internal/...' from the module root.
              group: ['../**/internal', '../**/internal/**', '@/**/internal/**'],
              message: 'Module internals are private; import the module public index only.',
            },
            {
              group: ['**/apps/*', '../../apps/*', '../../../apps/*'],
              message: 'Apps must not import from other apps.',
            },
          ],
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { varsIgnorePattern: '^_', argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['**/*.mjs', '**/*.js', 'scripts/**'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
