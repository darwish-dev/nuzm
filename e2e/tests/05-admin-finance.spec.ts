import { expect, test, type Page } from '@playwright/test';
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

/** Test tooling: the staff user enrolled MFA in the admin test; mark this session as recently verified (as 03-billing does for the owner). */
async function elevate(email: string) {
  await sql(
    `UPDATE identity.sessions SET mfa_level = 'totp', mfa_verified_at = now() WHERE user_id = (SELECT id FROM identity.users WHERE email = $1)`,
    [email],
  );
}

/**
 * Admin finance screens (UI-M03-15..21). Runs after 04-payments: it uses that test's organization, subscription and paid invoice.
 * UI-M03-13/14 (cross-organization invoice and payment search) have no API in the specification yet and are not built.
 */
test('admin finance: refund, reconciliation, e-invoicing onboarding and queue, dunning, reports', async ({
  page,
  browser,
}, info) => {
  const L = loc(info);
  const staff = `staff-${L}@example.test`;
  const other = `staff-${L === 'ar' ? 'en' : 'ar'}@example.test`;
  const adm = (p: string, pg: Page = page) => pg.goto(`${ADMIN}/${L}/billing${p}`);

  // --- data from the customer tests: this locale's owner organization, its subscription and the invoice paid in 04-payments
  const org = (
    await sql<{ id: string }>(
      `SELECT m.org_id AS id FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`,
      [`owner-${L}@example.test`],
    )
  )[0];
  if (!org) throw new Error('run 01-customer and 04-payments first: no owner organization');
  const sub = (
    await sql<{ id: string }>(
      `SELECT id FROM billing.subscriptions WHERE org_id = $1 ORDER BY created_at LIMIT 1`,
      [org.id],
    )
  )[0];
  const paid = (
    await sql<{ id: string }>(
      `SELECT p.id FROM payments.payment_intents p JOIN invoicing.invoices i ON i.id = p.invoice_id
        WHERE p.org_id = $1 AND p.status = 'succeeded' AND i.series = 'EE' ORDER BY p.created_at LIMIT 1`,
      [org.id],
    )
  )[0];
  if (!sub || !paid) throw new Error('run 04-payments first: no subscription or paid invoice');

  await signIn(page, info, staff, ADMIN);
  await elevate(staff);

  // --- UI-M03-15: refund a captured payment (integer minor units, idempotent, step-up already satisfied)
  await adm('/refunds');
  await expect(page.getByRole('heading', { name: T(info, 'af.ref.title') })).toBeVisible();
  await audit(page, info, 'adminfin-refunds');
  await page.getByLabel(T(info, 'af.ref.payment')).fill('not-an-id');
  await page.getByLabel(T(info, 'af.ref.amount')).fill('1.00');
  await page.getByLabel(T(info, 'field.reason')).fill('duplicate charge');
  await page.getByRole('button', { name: T(info, 'af.ref.submit') }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: T(info, 'af.ref.invalid') }),
  ).toBeVisible();
  await page.getByLabel(T(info, 'af.ref.payment')).fill(paid.id);
  await page.getByRole('button', { name: T(info, 'af.ref.submit') }).click();
  await expect(page.getByRole('list', { name: T(info, 'af.ref.result') })).toBeVisible();
  const refunds = await sql(`SELECT amount_minor FROM payments.refunds WHERE intent_id = $1`, [
    paid.id,
  ]);
  expect(refunds.map((r) => String(r.amount_minor))).toEqual(['100']);
  await audit(page, info, 'adminfin-refund-result');

  // --- UI-M03-16/17: reconciliation runs: run one from the screen, then work a completed run with two breaks
  await adm('/reconciliations');
  await expect(page.getByText(T(info, 'af.rc.none'))).toBeVisible();
  await audit(page, info, 'adminfin-reconciliations-empty');
  await page.getByLabel(/RC-02/).check();
  await page.getByRole('button', { name: T(info, 'af.rc.run.submit') }).click();
  await expect(page.getByText(T(info, 'af.rc.run.queued', { count: 1 }))).toBeVisible();
  const run = crypto.randomUUID();
  await sql(
    `INSERT INTO finrec.reconciliation_runs (id, type, period_from, period_to, status, trigger, items_checked, breaks_count, summary, created_at, started_at, completed_at)
     VALUES ($1, 'RC-01', '2026-11-01', '2026-11-16', 'completed', 'manual', 14, 2, '{"unmatchedPayments":2}', now(), now(), now())`,
    [run],
  );
  for (const [kind, key] of [
    ['missing_settlement', `pay-${L}-1`],
    ['amount_mismatch', `pay-${L}-2`],
  ] as const)
    await sql(
      `INSERT INTO finrec.reconciliation_items (id, run_id, type, match_key, kind, related_org, details)
       VALUES (gen_random_uuid(), $1, 'RC-01', $2, $3, $4, '{"expectedMinor":"11500","settledMinor":"0"}')`,
      [run, key, kind, org.id],
    );
  await adm('/reconciliations');
  await expect(page.getByRole('table').getByText(T(info, 'af.rc.status.queued'))).toBeVisible();
  await expect(page.getByRole('table').getByText(T(info, 'af.rc.status.completed'))).toBeVisible();
  await audit(page, info, 'adminfin-reconciliations');
  await page.goto(`${ADMIN}/${L}/billing/reconciliations/${run}`);
  await expect(page.getByRole('cell', { name: /missing_settlement/ })).toBeVisible();
  await audit(page, info, 'adminfin-reconciliation-detail');
  // take the first break, accept the second one as a variance with a note
  await page
    .getByRole('row', { name: /missing_settlement/ })
    .getByRole('button', { name: T(info, 'af.rc.act.assign') })
    .click();
  await expect(
    page
      .getByRole('row', { name: /missing_settlement/ })
      .getByText(T(info, 'af.rc.item.assigned'), { exact: true }),
  ).toBeVisible();
  const second = page.getByRole('row', { name: /amount_mismatch/ });
  await second.getByRole('button', { name: T(info, 'af.rc.act.accept') }).click();
  await second.getByLabel(T(info, 'af.rc.f.note')).fill('Rounding at the provider, 0.01 SAR');
  await second
    .getByRole('button', { name: T(info, 'af.rc.act.accept') })
    .last()
    .click();
  await expect(second.getByText(T(info, 'af.rc.item.resolved'), { exact: true })).toBeVisible();
  await audit(page, info, 'adminfin-reconciliation-worked');

  // --- UI-M03-18: e-invoicing onboarding (SIMULATION, production locked); a second person decides the credential step
  await adm('/zatca');
  await expect(page.getByText(T(info, 'af.z.banner.simulation'))).toBeVisible();
  await expect(page.getByText(T(info, 'af.z.prod'))).toBeVisible();
  const request = page.getByRole('button', {
    name: T(info, 'af.z.request', { step: T(info, 'af.z.step.csr') }),
  });
  if (await request.isVisible()) {
    await request.click();
    await expect(
      page.getByText(T(info, 'af.z.stepStatus.pending_approval'), { exact: true }),
    ).toBeVisible();
    // the requester cannot approve their own request (four-eyes)
    await page.getByRole('button', { name: T(info, 'af.z.approve') }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: T(info, 'af.z.err.self') }),
    ).toBeVisible();
    await audit(page, info, 'adminfin-zatca-pending');
    const ctx = await browser.newContext({
      locale: info.project.use.locale ?? 'en-GB',
      viewport: { width: 1280, height: 900 },
    });
    const page2 = await ctx.newPage();
    await signIn(page2, info, other, ADMIN);
    await elevate(other);
    await adm('/zatca', page2);
    await page2.getByRole('button', { name: T(info, 'af.z.approve') }).click();
    await expect(page2.getByText(T(info, 'af.z.decided'))).toBeVisible();
    await ctx.close();
    await adm('/zatca');
  }
  await expect(
    page.getByText(T(info, 'af.z.stepStatus.completed'), { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText(T(info, 'af.z.credsNote'))).toBeVisible();
  await audit(page, info, 'adminfin-zatca');

  // --- UI-M03-19: submission queue (no document has been generated: the empty queue and the gauge say so)
  await adm('/zatca/submissions');
  await expect(page.getByRole('heading', { name: T(info, 'af.zs.title') })).toBeVisible();
  await expect(page.getByText(T(info, 'af.zs.slo.none'))).toBeVisible();
  await audit(page, info, 'adminfin-submissions');

  // --- UI-M03-20: dunning case: hold with a reason, then resume
  await sql(
    `INSERT INTO billing.dunning_cases (id, org_id, subscription_id, invoice_id, stage, policy_version, opened_at, stage_changed_at, retries_done)
     VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), 'reminder_1', 1, now() - interval '5 days', now() - interval '1 day', 1)`,
    [org.id, sub.id],
  );
  await adm('/dunning');
  await expect(
    page.getByText(T(info, 'af.dn.stage.reminder_1'), { exact: true }).last(),
  ).toBeVisible();
  await audit(page, info, 'adminfin-dunning');
  const caseRow = page.getByRole('row', { name: new RegExp(org.id.slice(0, 8)) });
  await caseRow.getByLabel(T(info, 'af.dn.f.reason')).fill('Customer promised payment on Sunday');
  await caseRow.getByRole('button', { name: T(info, 'af.dn.act.hold') }).click();
  await expect(caseRow.getByText(T(info, 'af.dn.held'))).toBeVisible();
  await audit(page, info, 'adminfin-dunning-held');
  await caseRow.getByLabel(T(info, 'af.dn.f.reason')).fill('Payment promise expired');
  await caseRow.getByRole('button', { name: T(info, 'af.dn.act.resume') }).click();
  await expect(caseRow.getByText(T(info, 'af.dn.opened'), { exact: true })).toBeVisible();

  // --- UI-M03-21: reports: table, chart, ledger check badge, CSV
  await adm('/revenue-reports');
  await expect(page.getByRole('heading', { name: T(info, 'af.rp.title') })).toBeVisible();
  await expect(page.getByRole('link', { name: T(info, 'af.rp.csv') })).toBeVisible();
  await audit(page, info, 'adminfin-reports');
  await page.getByLabel(T(info, 'af.rp.f.report')).selectOption('ar_aging');
  await page.getByRole('button', { name: T(info, 'af.rp.show') }).click();
  await expect(page.getByText(T(info, 'af.rp.ledgerCheck')).first()).toBeVisible();
  await audit(page, info, 'adminfin-reports-aging');
  const csv = await page.request.get(
    `${ADMIN}/${L}/billing/revenue-reports/export?report=revenue&from=2026-11-01&to=2026-11-30`,
  );
  expect(csv.status()).toBe(200);
  expect(csv.headers()['content-type']).toContain('text/csv');
  const bad = await page.request.get(
    `${ADMIN}/${L}/billing/revenue-reports/export?report=nope&from=2026-11-01&to=2026-11-30`,
  );
  expect(bad.status()).toBe(422);
});
