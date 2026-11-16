import { defineConfig } from '@playwright/test';

/**
 * Browser E2E for the customer and admin consoles, in Arabic (RTL) and English (LTR) projects.
 * Runs against a throwaway database (`nuzm_e2e`), the real API, the dev identity provider and the BUILT Next.js apps.
 * `channel: 'chrome'` uses the installed Chrome (Playwright's bundled Chromium does not support macOS 13).
 */
const E2E_DB = 'nuzm_e2e';
export const USERS = [
  { sub: 'e2e-owner-ar', email: 'owner-ar@example.test', name: 'Layla Owner' },
  { sub: 'e2e-owner-en', email: 'owner-en@example.test', name: 'Layla Owner' },
  { sub: 'e2e-staff-ar', email: 'staff-ar@example.test', name: 'Sara Staff' },
  { sub: 'e2e-staff-en', email: 'staff-en@example.test', name: 'Sara Staff' },
];

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  use: {
    channel: 'chrome',
    baseURL: 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 900 },
  },
  projects: [
    { name: 'ar', use: { locale: 'ar-SA' } },
    { name: 'en', use: { locale: 'en-GB' } },
  ],
  webServer: [
    {
      command: 'pnpm --filter @nuzm/api run dev:stack',
      url: 'http://127.0.0.1:4000/healthz',
      timeout: 180_000,
      reuseExistingServer: false,
      env: {
        DATABASE_URL: `postgres://nuzm_app:nuzm_dev_only@127.0.0.1:54329/${E2E_DB}`,
        DEV_IDP_USERS: JSON.stringify(USERS),
      },
    },
    {
      command: 'pnpm --filter @nuzm/web exec next start -p 3000 -H 127.0.0.1',
      url: 'http://127.0.0.1:3000/ar/login',
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @nuzm/admin exec next start -p 3001 -H 127.0.0.1',
      url: 'http://127.0.0.1:3001/ar/login',
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
