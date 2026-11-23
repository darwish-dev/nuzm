import { createHash } from 'node:crypto';
import { defineConfig } from '@playwright/test';
import {
  ADMIN,
  ADMIN_PORT,
  API,
  API_PORT,
  E2E_DB,
  IDP_PORT,
  PG_PORT,
  STORE_DIR,
  WEB,
  WEB_PORT,
} from './tests/env';

/**
 * Browser E2E for the customer and admin consoles, in Arabic (RTL) and English (LTR) projects.
 * Runs against a throwaway database (`nuzm_e2e`), the real API, the dev identity provider and the BUILT Next.js apps.
 * `channel: 'chrome'` uses the installed Chrome (Playwright's bundled Chromium does not support macOS 13).
 */
/** Service key of the synthetic metering producer the billing E2E posts usage with (test-only value). */
export const PRODUCER_KEY = 'e2e-producer-key';
export const USERS = [
  { sub: 'e2e-owner-ar', email: 'owner-ar@example.test', name: 'Layla Owner' },
  { sub: 'e2e-owner-en', email: 'owner-en@example.test', name: 'Layla Owner' },
  { sub: 'e2e-billing-ar', email: 'billing-ar@example.test', name: 'Omar Billing' },
  { sub: 'e2e-billing-en', email: 'billing-en@example.test', name: 'Omar Billing' },
  { sub: 'e2e-staff-ar', email: 'staff-ar@example.test', name: 'Sara Staff' },
  { sub: 'e2e-staff-en', email: 'staff-en@example.test', name: 'Sara Staff' },
  // S-K2a: the two other people a third-party package needs before it can be activated (the uploader cannot be one of them)
  { sub: 'e2e-approver1-ar', email: 'approver1-ar@example.test', name: 'Huda Security' },
  { sub: 'e2e-approver1-en', email: 'approver1-en@example.test', name: 'Huda Security' },
  { sub: 'e2e-approver2-ar', email: 'approver2-ar@example.test', name: 'Faisal Admin' },
  { sub: 'e2e-approver2-en', email: 'approver2-en@example.test', name: 'Faisal Admin' },
];

/** How long a server may take to come up. Defaults are for an idle machine; `E2E_SERVER_TIMEOUT_MS` raises them when other work shares the machine (it never lowers them). */
const SERVER_START_MS = (dflt: number) =>
  Math.max(dflt, Number(process.env.E2E_SERVER_TIMEOUT_MS) || 0);

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
    baseURL: WEB,
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
      url: `${API}/healthz`,
      timeout: SERVER_START_MS(180_000),
      reuseExistingServer: false,
      env: {
        PORT: String(API_PORT),
        KNOWLEDGE_STORE_DIR: STORE_DIR,
        DEV_IDP_PORT: String(IDP_PORT),
        WEB_ORIGIN: WEB,
        ADMIN_ORIGIN: `http://127.0.0.1:${ADMIN_PORT}`,
        DATABASE_URL: `postgres://nuzm_app:nuzm_dev_only@127.0.0.1:${PG_PORT}/${E2E_DB}`,
        DEV_IDP_USERS: JSON.stringify(USERS),
        DATA_LOCAL_REFERENCE: 'true', // M08: in-memory dev-reference adapters (mock-*, NOT VERIFIED) so the managed-data screens can be exercised; never production
        // M07: local MOCK registrars (Openprovider/ResellerClub shaped from their docs: NOT VERIFIED vendor behaviour) behind the real adapters, dev only
        DOMAINS_DEV_MOCKS: 'true',
        DOMAINS_ENABLED: 'true',
        DOMAINS_ALLOW_NON_LIVE_REGISTRARS: 'true',
        DOMAINS_FX_JSON: JSON.stringify({ SAR: '1', USD: '3.75', EUR: '4.10' }),
        ZATCA_MODE: 'simulation', // e-invoicing admin screens; nothing is generated until ZATCA_GENERATE_FROM is set
        METERING_SOURCE_KEYS: JSON.stringify([
          {
            source: 'e2e@M99',
            sha256: createHash('sha256').update(PRODUCER_KEY).digest('hex'),
          },
        ]),
      },
    },
    {
      command: `pnpm --filter @nuzm/web exec next start -p ${WEB_PORT} -H 127.0.0.1`,
      url: `${WEB}/ar/login`,
      timeout: SERVER_START_MS(120_000),
      reuseExistingServer: false,
      env: { PSP_SANDBOX_UI: 'true', API_ORIGIN: API, WEB_ORIGIN: WEB, ADMIN_ORIGIN: ADMIN }, // the e2e API runs the sandbox PSP, so the sandbox card picker is shown
    },
    {
      command: `pnpm --filter @nuzm/admin exec next start -p ${ADMIN_PORT} -H 127.0.0.1`,
      url: `http://127.0.0.1:${ADMIN_PORT}/ar/login`,
      timeout: SERVER_START_MS(120_000),
      reuseExistingServer: false,
      // the consoles read these at run time (sign-in return address, API for server-side rendering)
      env: { API_ORIGIN: API, WEB_ORIGIN: WEB, ADMIN_ORIGIN: ADMIN },
    },
  ],
});
