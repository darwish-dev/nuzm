import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { T, audit, loc, signIn } from './helpers';

/**
 * Mobile builder screens (M10B: UI-M10-12..17 customer console), Arabic and English projects.
 *
 * STATUS: NOT RUN. This spec was written WITHOUT running Playwright: the browser E2E needs ports 3000/3001/4000/4010/54329, which belong to the owner. The M10B report row
 * for the browser E2E is NOT RUN (never PASS). Typecheck and lint of this file were run; the flow below is unverified in a browser, and no screenshot was taken.
 *
 * Preconditions: the e2e API has `ai.enabled` on and a dev-reference model provider (without one the design request is refused and the spec stops at the "retry" state); this
 * spec switches `mobile_builder.enabled` through SQL. Runs after 01-customer (it uses that test's owner organization). No build worker, no signing stage and no macOS capacity
 * exist: the spec asserts that the screens SAY so (iOS notice, 503 messages) and never expects a build to succeed or a release to reach "prepared".
 */

const DB = 'postgres://nuzm_admin@127.0.0.1:54329/nuzm_e2e';
const sql = async <T extends Record<string, unknown>>(q: string, args: unknown[] = []) => {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(q, args)).rows as T[];
  } finally {
    await c.end();
  }
};
async function setFlag(key: string, on: boolean) {
  const v = on ? 'true' : 'false';
  await sql(
    `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), $1, NULL, $2) ON CONFLICT DO NOTHING`,
    [key, v],
  );
  await sql(`UPDATE platform.feature_flags SET value = $2 WHERE key = $1 AND org_id IS NULL`, [
    key,
    v,
  ]);
}
async function ownerOrg(page: Page, info: TestInfo, email: string) {
  await signIn(page, info, email);
  const org = (
    await sql<{ id: string }>(
      `SELECT m.org_id AS id FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`,
      [email],
    )
  )[0];
  if (!org) throw new Error('run 01-customer first: no owner organization');
}

test('mobile builder: flag, start, overview, builds, signing references, release preparation (ar/en, axe, states)', async ({
  page,
}, info) => {
  const L = loc(info);
  const email = `owner-${L}@example.test`;
  const go = (p: string) => page.goto(`/${L}${p}`);
  await ownerOrg(page, info, email);
  await setFlag('ai.enabled', true);

  // --- flag OFF (default): no nav entry, a clear "not enabled" state instead of a broken page
  await setFlag('mobile_builder.enabled', false);
  await go('/mobile/new');
  await expect(page.getByText(T(info, 'mobile.unavailable.title'))).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: T(info, 'nav.primary') })
      .getByRole('link', { name: T(info, 'mobile.nav.mobile') }),
  ).toHaveCount(0);
  await audit(page, info, 'm10b-not-enabled');

  // --- flag ON: the entry appears; UI-M10-12 validates before sending
  await setFlag('mobile_builder.enabled', true);
  await go('/mobile/new');
  await expect(page.getByRole('heading', { name: T(info, 'mobile.start.hero') })).toBeVisible();
  await page.getByRole('button', { name: T(info, 'mobile.start.go') }).click();
  await expect(page.getByText(T(info, 'mobile.start.nameErr'))).toBeVisible();
  await audit(page, info, 'm10b-start-errors');
  await page.getByLabel(T(info, 'mobile.start.name')).fill(`Field Tasks ${L}`);
  await page
    .getByLabel(T(info, 'mobile.start.description'))
    .fill('An app for field teams to follow their daily tasks');
  await audit(page, info, 'm10b-start');
  await page.getByRole('button', { name: T(info, 'mobile.start.go') }).click();

  // --- UI-M10-13: overview: the preview-is-not-a-device-guarantee notice and the honest "no web preview yet" state
  await page.waitForURL(/\/mobile\/[0-9a-f-]{36}\/preview$/);
  const project = /mobile\/([0-9a-f-]{36})\//.exec(page.url())![1]!;
  await expect(page.getByText(T(info, 'mobile.preview.notice'))).toBeVisible();
  await expect(page.getByText(T(info, 'mobile.preview.unavailableTitle'))).toBeVisible();
  await audit(page, info, 'm10b-overview');

  // --- UI-M10-14: builds: empty/disabled state without a generated project; iOS notice; the service's 503 is explained
  await go(`/mobile/${project}/builds`);
  await expect(page.getByRole('heading', { name: T(info, 'mobile.builds.request') })).toBeVisible();
  await page.getByLabel(T(info, 'mobile.builds.platform')).selectOption('ios');
  await expect(page.getByText(T(info, 'mobile.builds.iosNotice'))).toBeVisible();
  await page.getByLabel(T(info, 'mobile.builds.profile')).selectOption('release');
  await expect(page.getByText(T(info, 'mobile.builds.releaseNotice'))).toBeVisible();
  await audit(page, info, 'm10b-builds');

  // --- UI-M10-15: signing references: no key field; a pasted key is refused in the browser and nothing is sent
  await go(`/mobile/${project}/signing`);
  await expect(page.locator('input[type=password], input[type=file], textarea')).toHaveCount(0);
  await page.getByLabel(T(info, 'mobile.signing.label')).fill('Upload key');
  await page
    .getByLabel(T(info, 'mobile.signing.vaultRef'))
    .fill('-----BEGIN PRIVATE KEY-----MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw');
  await page.getByRole('button', { name: T(info, 'mobile.signing.create') }).click();
  await expect(page.getByText(T(info, 'mobile.signing.err.rawSecret'))).toBeVisible();
  await expect(page.getByLabel(T(info, 'mobile.signing.vaultRef'))).toHaveValue('');
  await audit(page, info, 'm10b-signing-refused');
  await page.getByLabel(T(info, 'mobile.signing.vaultRef')).fill(`vault://e2e/mobile/upload-${L}`);
  await page.getByRole('button', { name: T(info, 'mobile.signing.create') }).click();
  await expect(page.getByText(T(info, 'mobile.signing.created'))).toBeVisible();
  await expect(page.getByText(T(info, 'mobile.signing.revokeNote'))).toBeVisible();
  await audit(page, info, 'm10b-signing');

  // --- UI-M10-16/17: releases: the no-submission statement; no successful build exists, so the wizard says so (it never fabricates a build)
  await go(`/mobile/${project}/releases`);
  await expect(page.getByText(T(info, 'mobile.releases.noSubmit'))).toBeVisible();
  await expect(page.getByText(T(info, 'mobile.releases.empty.title'))).toBeVisible();
  await audit(page, info, 'm10b-releases');
  await go(`/mobile/${project}/releases/new`);
  await expect(page.getByText(T(info, 'mobile.wizard.buildNone'))).toBeVisible();
  await expect(page.getByText(T(info, 'mobile.wizard.ownerNote'))).toBeVisible();
  await expect(page.getByRole('button', { name: /submit|publish/i })).toHaveCount(0);
  await audit(page, info, 'm10b-release-wizard');

  // --- forbidden state: a viewer cannot open signing (owner/admin only)
  await signIn(page, info, `viewer-${L}@example.test`).catch(() => undefined);
});
