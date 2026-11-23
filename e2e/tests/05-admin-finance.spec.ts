import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';
import { T, audit, loc, signIn } from './helpers';
import { DB_URL as DB } from './env';

const ADMIN = 'http://127.0.0.1:3001';
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
 * Admin finance screens (UI-M03-13..21). Runs after 04-payments: it uses that test's organization, subscription and paid invoice.
 * UI-M03-13/14/15 read the S12d admin list APIs (invoices, payments + PSP events, refunds).
 */
test('admin finance: invoices, payments, refunds, reconciliation, e-invoicing onboarding and queue, dunning, reports', async ({
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
    await sql<{ id: string; invoice_id: string; number_text: string }>(
      `SELECT p.id, p.invoice_id, i.number_text FROM payments.payment_intents p JOIN invoicing.invoices i ON i.id = p.invoice_id
        WHERE p.org_id = $1 AND p.status = 'succeeded' AND i.series = 'EE' ORDER BY p.created_at LIMIT 1`,
      [org.id],
    )
  )[0];
  if (!sub || !paid) throw new Error('run 04-payments first: no subscription or paid invoice');

  // The seeded staff users are platform_admin, which by design cannot manage billing (refunds, run-now, dunning holds need `finance`):
  // give both the finance role before they sign in. The second person (`other`) keeps platform_admin's zatca:approve for the four-eyes step.
  for (const email of [staff, other])
    await sql(
      `INSERT INTO tenancy.platform_roles (user_id, role) SELECT id, 'finance' FROM identity.users WHERE email = $1 ON CONFLICT DO NOTHING`,
      [email],
    );
  await signIn(page, info, staff, ADMIN);
  await elevate(staff);

  // --- UI-M03-13: invoices across organizations: search by number, e-invoice state, correction guidance
  await adm('/invoices');
  await expect(
    page.getByRole('heading', { name: T(info, 'af.inv.title'), level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(T(info, 'af.inv.guide.title'))).toBeVisible();
  await audit(page, info, 'adminfin-invoices');
  await page.getByLabel(T(info, 'af.inv.f.number')).fill(paid.number_text.slice(0, 4));
  await page.getByRole('button', { name: T(info, 'action.search') }).click();
  const invRow = page.getByRole('row', { name: new RegExp(paid.number_text) });
  await expect(invRow).toBeVisible();
  await expect(invRow.getByText(T(info, 'af.inv.status.paid'), { exact: true })).toBeVisible();
  await expect(invRow.getByText(T(info, 'af.inv.ei.not_generated'), { exact: true })).toBeVisible();
  await audit(page, info, 'adminfin-invoices-search');
  await adm('/invoices?number=NO-SUCH-NUMBER');
  await expect(page.getByText(T(info, 'af.inv.none'))).toBeVisible();
  await audit(page, info, 'adminfin-invoices-empty');
  await adm('/invoices?org=not-a-uuid');
  await expect(
    page.getByRole('alert').filter({ hasText: T(info, 'af.inv.f.invalid') }),
  ).toBeVisible();

  // --- UI-M03-14: payments across organizations and the redacted PSP events with the duplicate indicator
  await sql(
    `INSERT INTO payments.psp_events (id, psp, event_id, type, org_id, intent_id, event_at, payload, status, duplicate_count, last_duplicate_at, processed_at)
     VALUES (gen_random_uuid(), 'mock', $1, 'payment.succeeded', $2, $3, now(), $4::jsonb, 'processed', 2, now(), now())`,
    [
      `e2e-evt-${L}`,
      org.id,
      paid.id,
      JSON.stringify({
        id: `e2e-evt-${L}`,
        type: 'payment.succeeded',
        merchantReference: 'nuzm_pi_e2e',
        pspPaymentRef: 'mock_pay_1234567890abcd',
        amountMinor: '11500',
        currency: 'SAR',
        failureCode: null,
      }),
    ],
  );
  await adm(`/payments?invoiceId=${paid.invoice_id}`);
  await expect(
    page.getByRole('heading', { name: T(info, 'af.pay.title'), level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole('row').filter({ hasText: T(info, 'af.pay.status.succeeded') }),
  ).toHaveCount(1);
  await audit(page, info, 'adminfin-payments');
  await page
    .getByRole('link', { name: new RegExp(paid.id.slice(0, 8)) })
    .first()
    .click();
  await expect(
    page.getByRole('heading', { name: T(info, 'af.pay.detail.title'), level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(T(info, 'af.pay.ev.dup', { count: 2 }))).toBeVisible();
  await expect(page.getByText(T(info, 'af.pay.detail.redaction'))).toBeVisible();
  await expect(page.getByText('mock_pay_1234567890abcd')).toHaveCount(0); // the provider reference is masked
  await expect(page.getByText('…abcd')).toBeVisible();
  await audit(page, info, 'adminfin-payment-events');
  await adm('/payments?status=refunded&org=' + org.id);
  await audit(page, info, 'adminfin-payments-filtered');

  // --- UI-M03-15: refund a captured payment (integer minor units, idempotent, step-up already satisfied)
  await adm('/refunds');
  await expect(
    page.getByRole('heading', { name: T(info, 'af.ref.title'), level: 1 }),
  ).toBeVisible();
  await audit(page, info, 'adminfin-refunds');
  const rform = page.getByRole('form', { name: T(info, 'af.ref.title') }); // the history filter has a payment id field too
  await rform.getByLabel(T(info, 'af.ref.payment')).fill('not-an-id');
  await rform.getByLabel(T(info, 'af.ref.amount')).fill('1.00');
  await rform.getByLabel(T(info, 'field.reason')).fill('duplicate charge');
  await rform.getByRole('button', { name: T(info, 'af.ref.submit') }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: T(info, 'af.ref.invalid') }),
  ).toBeVisible();
  await rform.getByLabel(T(info, 'af.ref.payment')).fill(paid.id);
  await rform.getByRole('button', { name: T(info, 'af.ref.submit') }).click();
  await expect(page.getByRole('list', { name: T(info, 'af.ref.result') })).toBeVisible();
  const refunds = await sql(`SELECT amount_minor FROM payments.refunds WHERE intent_id = $1`, [
    paid.id,
  ]);
  expect(refunds.map((r) => String(r.amount_minor))).toEqual(['100']);
  await audit(page, info, 'adminfin-refund-result');
  // the history lists it with its status (read from the API after a reload)
  await adm(`/refunds?paymentId=${paid.id}`);
  const histRow = page.getByRole('row', { name: new RegExp(paid.id.slice(0, 8)) });
  await expect(
    histRow.getByText(T(info, 'af.ref.status.succeeded'), { exact: true }),
  ).toBeVisible();
  await expect(histRow.getByText('duplicate charge')).toBeVisible();
  await audit(page, info, 'adminfin-refund-history');

  // --- UI-M03-16/17: reconciliation runs: run one from the screen, then work a completed run with two breaks
  // the database is shared by the ar and en runs: the other locale may already have created runs, so filter to a type that has none
  await adm('/reconciliations?type=RC-06');
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
  // the run started from the screen exists (the API worker may already have finished it, so its status is not asserted)
  await expect(page.getByRole('row', { name: /RC-02/ }).first()).toBeVisible(); // the other locale may have run one too
  await expect(
    page
      .getByRole('row', { name: /RC-01/ })
      .first()
      .getByText(T(info, 'af.rc.status.completed'), { exact: true }),
  ).toBeVisible();
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
    // the notice disappears with the refresh (the decision panel unmounts once nothing is pending): assert the resulting state instead
    await expect(
      page2.getByText(T(info, 'af.z.stepStatus.completed'), { exact: true }).first(),
    ).toBeVisible();
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
  await expect(page.getByRole('heading', { name: T(info, 'af.zs.title'), level: 1 })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: T(info, 'af.rp.title'), level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: T(info, 'af.rp.csv') })).toBeVisible();
  await audit(page, info, 'adminfin-reports');
  await page.getByLabel(T(info, 'af.rp.f.report'), { exact: true }).selectOption('ar_aging');
  await page.getByRole('button', { name: T(info, 'af.rp.show') }).click();
  await expect(page.getByText(T(info, 'af.rp.ledgerCheck')).first()).toBeVisible();
  await audit(page, info, 'adminfin-reports-aging');
  const today = new Date().toISOString().slice(0, 10); // a report cannot end in the future
  const monthStart = `${today.slice(0, 7)}-01`;
  const csv = await page.request.get(
    `${ADMIN}/${L}/billing/revenue-reports/export?report=revenue&from=${monthStart}&to=${today}`,
  );
  expect(csv.status()).toBe(200);
  expect(csv.headers()['content-type']).toContain('text/csv');
  const bad = await page.request.get(
    `${ADMIN}/${L}/billing/revenue-reports/export?report=nope&from=${monthStart}&to=${today}`,
  );
  expect(bad.status()).toBe(422);
});
