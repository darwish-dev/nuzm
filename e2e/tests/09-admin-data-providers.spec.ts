import { expect, test } from '@playwright/test';
import { Client } from 'pg';
import { T, audit, loc, signIn } from './helpers';

/**
 * Admin data providers screen (UI-M08-15), Arabic and English projects.
 *
 * STATUS: NOT RUN (written without running Playwright: the ports and the local database were in use by another session).
 *
 * Only a dev-reference row (`mock-*`, environment=local, NOT VERIFIED) is created here. Whether the probe and enabling succeed depends on the e2e API
 * having been started with `DATA_LOCAL_REFERENCE=true` (the dev adapters are then registered); both outcomes are asserted: success, or the clear
 * "refused" message with the blockers that explain it. Nothing here touches a real provider.
 */

const ADMIN = 'http://127.0.0.1:3001';
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

/** Test tooling: the staff user enrolled MFA in the admin test; mark this session as recently verified so step-up does not interrupt the flow. */
async function elevate(email: string) {
  await sql(
    `UPDATE identity.sessions SET mfa_level = 'totp', mfa_verified_at = now() WHERE user_id = (SELECT id FROM identity.users WHERE email = $1)`,
    [email],
  );
}

test('admin: data providers: configure a dev-reference row, probe, blockers, enable rules (UI-M08-15)', async ({
  page,
}, info) => {
  const L = loc(info);
  const staff = `staff-${L}@example.test`;
  // the cache dev-reference provider: not used by 08 (which enables the database, object-storage and email ones), so the two specs never share a row
  const code = 'mock-cache';
  await sql(`DELETE FROM data.data_providers WHERE provider_code = $1 AND service = 'cache'`, [
    code,
  ]);

  await signIn(page, info, staff, ADMIN);
  await elevate(staff);

  // --- navigation entry and the page: nothing is selected by default
  await page.goto(`${ADMIN}/${L}/data/providers`);
  await expect(
    page.getByRole('heading', { name: T(info, 'm8.adm.title'), level: 1 }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: T(info, 'nav.primary') })
      .getByRole('link', { name: T(info, 'm8.nav.admin.providers') }),
  ).toBeVisible();
  await expect(page.getByText(T(info, 'm8.adm.noSelection'))).toBeVisible();
  await audit(page, info, 'm8-admin-providers-empty');

  // --- a secret-looking key never leaves the browser: credentials are vault references only
  await page.getByLabel(T(info, 'm8.adm.service')).selectOption('cache');
  await page.getByLabel(T(info, 'm8.adm.family')).fill('self-operated-cache');
  await page.getByLabel(T(info, 'm8.adm.code')).fill(code);
  await page.getByLabel(T(info, 'm8.adm.env')).first().selectOption('local');
  await page.getByLabel(T(info, 'm8.adm.config')).fill('{"apiKey":"not-a-real-secret"}');
  await page.getByRole('button', { name: T(info, 'action.save') }).click();
  await expect(page.getByText(T(info, 'm8.adm.err.secret'))).toBeVisible();

  // --- configure with a vault reference
  await page
    .getByLabel(T(info, 'm8.adm.config'))
    .fill('{"credentialRef":"vault://mock/e2e","defaultRegion":"sa-central"}');
  await page.getByRole('button', { name: T(info, 'action.save') }).click();
  await expect(page.getByText(T(info, 'm8.adm.done.configure'))).toBeVisible();

  // --- the row: marked as a dev reference, not verified; nothing is enabled; the blockers say why
  const row = page.getByRole('row').filter({ hasText: code });
  await expect(row).toBeVisible();
  await expect(row.getByText(T(info, 'm8.adm.devRef'))).toBeVisible();
  await expect(row.getByText(T(info, 'm8.adm.disabled'))).toBeVisible();
  await expect(row.getByText(T(info, 'm8.adm.notProbed'))).toBeVisible();
  await expect(row.getByText(T(info, 'm8.adm.blocker.not_probed'))).toBeVisible();
  await audit(page, info, 'm8-admin-providers-configured');

  // --- probe: the result is data, never an error; the evidence kinds are listed
  await row.getByText(T(info, 'm8.adm.actions')).click();
  await row.getByRole('button', { name: T(info, 'm8.adm.probe'), exact: true }).click();
  const probed = page.getByText(T(info, 'm8.adm.done.probe'));
  const refused = page.getByText(T(info, 'm8.adm.refused'));
  await expect(probed.or(refused)).toBeVisible();

  if (await probed.isVisible()) {
    // dev adapters are registered: the probe never carries LIVE evidence, so enabling outside local would stay blocked; a local row can be enabled
    await expect(row.getByText(T(info, 'm8.adm.evidenceKinds'))).toBeVisible();
    await row.getByText(T(info, 'm8.adm.actions')).click();
    await row.getByLabel(T(info, 'm8.adm.evidenceRef')).fill('LOCAL-REFERENCE-NOT-VERIFIED');
    await row
      .getByLabel(T(info, 'm8.adm.verifiedAt'))
      .fill(new Date(Date.now() - 60_000).toISOString().slice(0, 16));
    await row.getByRole('button', { name: T(info, 'm8.adm.requestEnable') }).click();
    await expect(page.getByText(T(info, 'm8.adm.done.request'))).toBeVisible();
    await row.getByText(T(info, 'm8.adm.actions')).click();
    await row.getByRole('button', { name: T(info, 'm8.adm.enable'), exact: true }).click();
    await expect(page.getByText(T(info, 'm8.adm.done.enable'))).toBeVisible();
    await expect(row.getByText(T(info, 'm8.adm.enabled'), { exact: true })).toBeVisible();
    await audit(page, info, 'm8-admin-providers-enabled');
    // disable again: the row goes back to "not enabled"
    await row.getByText(T(info, 'm8.adm.actions')).click();
    await row.getByRole('button', { name: T(info, 'm8.adm.disable') }).click();
    await expect(page.getByText(T(info, 'm8.adm.done.disable'))).toBeVisible();
    await expect(row.getByText(T(info, 'm8.adm.disabled'))).toBeVisible();
  } else {
    // no dev adapter registered here: the refusal is explained and enabling stays blocked
    await expect(row.getByText(T(info, 'm8.adm.blocker.adapter_not_registered'))).toBeVisible();
    await row.getByText(T(info, 'm8.adm.actions')).click();
    await expect(
      row.getByRole('button', { name: T(info, 'm8.adm.enable'), exact: true }),
    ).toBeDisabled();
    await expect(row.getByText(T(info, 'm8.adm.enableBlocked'))).toBeVisible();
    await audit(page, info, 'm8-admin-providers-blocked');
  }
  await expect(page.getByText(T(info, 'm8.adm.enableRules'))).toBeVisible();

  await sql(`DELETE FROM data.data_providers WHERE provider_code = $1 AND service = 'cache'`, [
    code,
  ]);
});
