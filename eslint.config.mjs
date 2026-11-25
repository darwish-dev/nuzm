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
      '.local/**', // git-ignored local scratch (run logs, dev logins, backups)
      'apps/api/.gen-tmp/**', // git-ignored: generated apps written by tests and live previews
      'packages/sdk/src/schema.ts',
      '.claude/worktrees/**',
      'apps/desktop/release/**', // packaged desktop installers (git-ignored)
      'apps/api/templates/webapp-runtime/public/**', // M10A: browser code shipped inside generated apps
      'apps/mobile/**', // Flutter app: Dart, checked by `flutter analyze`; its build output is generated JS
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } },
  },
  {
    // Design render/export scripts: Node drivers whose page.evaluate callbacks run in the browser (carried from main's config, which the hosting line's design/ scripts need).
    files: ['design/**/*.mjs'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        performance: 'readonly',
        setTimeout: 'readonly',
        Blob: 'readonly',
        btoa: 'readonly',
        Buffer: 'readonly',
        MediaRecorder: 'readonly',
        createImageBitmap: 'readonly',
      },
    },
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
    // D-46, SCR-K-10 §4 (AC-AG-07): the read-only agent tool executors are pure. No node builtin, no process, no network, no dynamic code. (`separation.spec.ts` checks the same from the
    // source text.) The shared module-boundary patterns are repeated because a rule set here replaces the general one for these files.
    files: ['packages/domain/src/ai/agent-tools/**/*.ts'],
    ignores: ['**/*.spec.ts'],
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
              group: ['../**/internal', '../**/internal/**', '@/**/internal/**'],
              message: 'Module internals are private; import the module public index only.',
            },
            {
              group: ['**/apps/*', '../../apps/*', '../../../apps/*'],
              message: 'Apps must not import from other apps.',
            },
            {
              group: [
                'node:*',
                'child_process',
                'fs',
                'fs/*',
                'net',
                'http',
                'https',
                'dns',
                'tls',
                'vm',
                'worker_threads',
                'os',
                'path',
                'url',
                'cluster',
                'dgram',
              ],
              message:
                'The read-only agent tools must not reach the system: no process, filesystem, network or code-execution module.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        'process',
        'require',
        'fetch',
        'eval',
        'setTimeout',
        'setInterval',
        'XMLHttpRequest',
        'WebSocket',
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: 'No dynamic import in the read-only agent tools.',
        },
        { selector: "NewExpression[callee.name='Function']", message: 'No dynamic code.' },
      ],
      'no-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    files: ['**/*.mjs', '**/*.js', 'scripts/**'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Operator tool (P3-S08): a read-only checker that reuses the QA evidence verifier of apps/api; it is not application code and nothing imports it.
    files: ['docs/phase3/validate/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
