/**
 * STATUS: NOT RUN. Written in the M05 admin-UI stream, where the S17 API (routing rules, cross-org resources, reconciliations), the
 * provider-costs endpoint and the live-verification endpoint are not all present in one tree, so this spec could not be executed and no
 * screenshot was produced. Run it (with the full API from the merged M05 branch, `pnpm test:e2e`) before treating AC-M05-14 as PASS.
 *
 * Admin screens UI-M05-08..15 in Arabic and English with axe: provider registry and health, accounts (vault references only, verification
 * job), account detail (capability matrix, regions with evidence kind, plans), routing rules and the dry-run simulator, cross-org resources
 * (audited read, force reconcile), operations monitor, provider costs with RC-04 and margin, and live verification (read-only).
 * Runs after 02-admin (the staff user exists, MFA enrolled) and 01-customer / 06 (this locale's owner organization exists).
 */
import { expect, test } from '@playwright/test';
import { Client } from 'pg';
import { T, audit, loc, signIn } from './helpers';

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
/** Test tooling (as in 05 and 07): the staff session counts as recently MFA-verified so step-up never interrupts a flow. */
async function elevate(email: string) {
  await sql(
    `UPDATE identity.sessions SET mfa_level = 'totp', mfa_verified_at = now() WHERE user_id = (SELECT id FROM identity.users WHERE email = $1)`,
    [email],
  );
}
const grant = (userId: string, role: string) =>
  sql(
    `INSERT INTO tenancy.platform_roles (user_id, role) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM tenancy.platform_roles WHERE user_id = $1 AND role = $2)`,
    [userId, role],
  );
const revoke = (userId: string, role: string) =>
  sql(`DELETE FROM tenancy.platform_roles WHERE user_id = $1 AND role = $2`, [userId, role]);

test('admin providers and cloud: registry, accounts, detail, routing, resources, operations, costs, live verification', async ({
  page,
}, info) => {
  const L = loc(info);
  const staff = `staff-${L}@example.test`;
  const go = (path: string) => page.goto(`${ADMIN}/${L}${path}`);
  const h1 = (key: Parameters<typeof T>[1]) =>
    expect(page.getByRole('heading', { level: 1, name: T(info, key) })).toBeVisible();
  const form = (key: Parameters<typeof T>[1]) => page.getByRole('form', { name: T(info, key) });
  const table = (key: Parameters<typeof T>[1]) => page.getByRole('table', { name: T(info, key) });

  const org = (
    await sql<{ id: string }>(
      `SELECT m.org_id AS id FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`,
      [`owner-${L}@example.test`],
    )
  )[0];
  if (!org) throw new Error('run 01-customer first: no owner organization');
  const staffUser = (
    await sql<{ id: string }>(`SELECT id FROM identity.users WHERE email = $1`, [staff])
  )[0]!;
  await grant(staffUser.id, 'platform_admin');
  await signIn(page, info, staff, ADMIN);
  await elevate(staff);
  try {
    // --- UI-M05-08: registry and health. The mock provider is registered by the seed; nothing real is "verified".
    await go('/providers');
    await h1('m05.adm.reg.title');
    await expect(page.getByText(T(info, 'm05.adm.notVerified'))).toBeVisible();
    await expect(table('m05.adm.reg.title')).toBeVisible();
    await expect(table('m05.adm.reg.health')).toBeVisible();
    await expect(page.getByRole('navigation', { name: T(info, 'm05.adm.nav') })).toBeVisible();
    await audit(page, info, 'provider-registry');

    // --- UI-M05-09: accounts. A secret typed into the credential field is refused on the screen; a vault reference is accepted.
    await go('/providers/accounts');
    await h1('m05.adm.acc.title');
    const add = form('m05.adm.acc.add');
    await add.getByLabel(T(info, 'field.name'), { exact: true }).fill(`E2E ${L}`);
    await add
      .getByLabel(T(info, 'm05.adm.col.credentialRef'), { exact: true })
      .fill(['AKIA', 'IOSFODNN7EXAMPLE-not-a-reference'].join(''));
    await add.getByRole('button', { name: T(info, 'm05.adm.acc.addSubmit') }).click();
    await expect(page.getByText(T(info, 'm05.adm.acc.err.vaultRef'))).toBeVisible();
    await expect(page.locator('main')).not.toContainText(['AKIA', 'IOSFODNN7EXAMPLE'].join(''));
    await add
      .getByLabel(T(info, 'm05.adm.col.provider'), { exact: true })
      .selectOption({ label: 'mock' });
    await add
      .getByLabel(T(info, 'm05.adm.col.credentialRef'), { exact: true })
      .fill(`vault://e2e/${L}/mock`);
    await add.getByRole('button', { name: T(info, 'm05.adm.acc.addSubmit') }).click();
    await expect(page.getByText(T(info, 'm05.adm.acc.created'))).toBeVisible();
    const row = page.getByRole('row', { name: new RegExp(`E2E ${L}`) });
    await expect(row).toBeVisible();
    await expect(row.getByText(`vault://e2e/${L}/mock`)).toBeVisible();
    await audit(page, info, 'provider-accounts');

    // verification: 202 job, followed to a terminal state (the dev vault decides whether it succeeds; both are honest outcomes)
    await row.getByRole('button', { name: new RegExp(T(info, 'm05.adm.acc.verify')) }).click();
    await expect(
      page
        .getByRole('status')
        .filter({
          hasText: new RegExp(
            `${T(info, 'm05.adm.job.state.succeeded')}|${T(info, 'm05.adm.job.state.failed')}`,
          ),
        })
        .first(),
    ).toBeVisible({ timeout: 30_000 });

    // --- UI-M05-10: account detail
    await row.getByRole('link', { name: `E2E ${L}` }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: T(info, 'm05.adm.acc.detail') }),
    ).toBeVisible();
    await expect(table('m05.adm.cap.title')).toBeVisible();
    // unknown is shown as unsupported: the matrix has only the supported / unsupported words
    await expect(table('m05.adm.cap.title').getByText(/^(unknown|غير معروف)$/i)).toHaveCount(0);
    // mock evidence is never green and never "verified"
    const regions = page.getByRole('table', { name: T(info, 'm05.adm.reg2.title') });
    if (await regions.count()) {
      await expect(regions.getByText(T(info, 'm05.adm.reg2.v.verified_live'))).toHaveCount(0);
      await expect(regions.locator('.nz-badge[data-tone="success"]')).toHaveCount(0);
    }
    await audit(page, info, 'provider-account-detail');
    await page.getByRole('button', { name: T(info, 'm05.adm.acc.sync') }).click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: T(info, 'm05.adm.job.kind.catalog_sync') })
        .first(),
    ).toBeVisible({ timeout: 30_000 });

    // --- UI-M05-11: routing rules and the dry-run simulator
    await go('/providers/routing');
    await h1('m05.adm.rt.title');
    const rule = form('m05.adm.rt.newRule');
    await rule.getByRole('button', { name: T(info, 'action.save') }).click();
    await expect(rule.getByRole('alert').first()).toBeVisible();
    await rule.getByLabel(T(info, 'm05.adm.rt.ruleKey'), { exact: true }).fill(`e2e.${L}.prefer`);
    await rule.getByLabel(T(info, 'm05.adm.rt.countries'), { exact: true }).fill('SA');
    await rule.getByLabel(T(info, 'm05.adm.rt.providerKey'), { exact: true }).fill('mock');
    await rule.getByRole('button', { name: T(info, 'action.save') }).click();
    await expect(page.getByText(T(info, 'm05.adm.rt.saved'))).toBeVisible();
    await expect(table('m05.adm.rt.rules').getByText(`e2e.${L}.prefer`)).toBeVisible();
    const sim = form('m05.adm.rt.sim');
    await expect(page.getByText(T(info, 'm05.adm.rt.sim.readOnly'))).toBeVisible();
    await sim.getByLabel(T(info, 'm05.adm.rt.sim.org'), { exact: true }).fill(org.id);
    await sim.getByLabel(T(info, 'field.country'), { exact: true }).fill('SA');
    await sim.getByRole('button', { name: T(info, 'm05.adm.rt.sim.run') }).click();
    await expect(
      page.getByRole('region', { name: T(info, 'm05.adm.rt.sim.result') }),
    ).toBeVisible();
    await audit(page, info, 'provider-routing');

    // --- UI-M05-12: cross-org inventory: the audited-read notice, drift filter, force reconcile for a manager
    await go('/cloud/resources');
    await h1('m05.adm.res.title');
    await expect(page.getByText(T(info, 'm05.adm.res.audited'))).toBeVisible();
    await page
      .getByLabel(T(info, 'm05.adm.res.col.drift'), { exact: true })
      .selectOption('orphan_suspected');
    await page.getByRole('button', { name: T(info, 'action.search') }).click();
    await expect(
      page
        .getByRole('table', { name: T(info, 'm05.adm.res.title') })
        .or(page.getByText(T(info, 'm05.adm.res.empty.title'))),
    ).toBeVisible();
    await audit(page, info, 'cloud-resources');

    // --- UI-M05-13: operations monitor
    await go('/cloud/operations');
    await h1('m05.adm.ops.title');
    await expect(page.getByText(T(info, 'm05.adm.ops.gap'))).toBeVisible();
    await form('m05.adm.ops.lookup')
      .getByRole('button', { name: T(info, 'action.search') })
      .click();
    await expect(page.getByText(T(info, 'm05.adm.ops.lookup.invalid'))).toBeVisible();
    await audit(page, info, 'cloud-operations');

    // --- UI-M05-14: provider costs, RC-04 results and margin
    await go('/finance/provider-costs');
    await h1('m05.adm.cost.title');
    await expect(page.getByRole('heading', { name: T(info, 'm05.adm.rc4.title') })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: T(info, 'm05.adm.margin.title') }),
    ).toBeVisible();
    await audit(page, info, 'finance-provider-costs');

    // --- UI-M05-15: live verification is read-only: nothing in the page can start a run
    await go('/providers/live-verification');
    await h1('m05.adm.lv.title');
    await expect(page.getByText(T(info, 'm05.adm.lv.ownerOnly'))).toBeVisible();
    await expect(page.getByText('HG-05-01').first()).toBeVisible();
    await expect(page.locator('main').getByRole('button')).toHaveCount(0);
    await expect(page.locator('main form')).toHaveCount(0);
    await audit(page, info, 'provider-live-verification');

    // --- read-only role: security sees the data but gets no add form, no verify button, no rule editor
    await revoke(staffUser.id, 'platform_admin');
    await grant(staffUser.id, 'security');
    await go('/providers/accounts');
    await expect(form('m05.adm.acc.add')).toHaveCount(0);
    await expect(
      page.locator('main').getByRole('button', { name: T(info, 'm05.adm.acc.verify') }),
    ).toHaveCount(0);
    await go('/providers/routing');
    await expect(form('m05.adm.rt.newRule')).toHaveCount(0);

    // --- forbidden: a role without admin:provider:read sees the forbidden state and no nav entry
    await revoke(staffUser.id, 'security');
    await grant(staffUser.id, 'compliance_officer');
    await go('/providers');
    await expect(
      page.getByRole('alert').filter({ hasText: T(info, 'state.forbidden.title') }),
    ).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: T(info, 'nav.primary') }).getByRole('link', {
        name: T(info, 'nav.admin.providers'),
      }),
    ).toHaveCount(0);
    await audit(page, info, 'provider-forbidden');
  } finally {
    await revoke(staffUser.id, 'platform_admin');
    await revoke(staffUser.id, 'security');
    await grant(staffUser.id, 'compliance_officer');
  }
});
