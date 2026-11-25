import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';
import { formatMinor } from '@nuzm/i18n';
import { T, audit, loc, signIn, expectActiveOrg } from './helpers';
import { DB_URL as DB } from './env';
import { elevate, openInvoice, seedStarterPrice } from './fixtures/payments';
import { resetDatabase } from './reset';

test.beforeAll(resetDatabase);

const sql = async <T extends Record<string, unknown>>(q: string, args: unknown[] = []) => {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(q, args)).rows as T[];
  } finally {
    await c.end();
  }
};

test('payments: methods, tax profile, subscription, invoices, pay now, wallet top-up, payments, return page', async ({
  page,
}, info) => {
  const L = loc(info);
  const email = `owner-${L}@example.test`;
  const go = (p: string, pg: Page = page) => pg.goto(`/${L}${p}`);
  const money = (m: string) => formatMinor(m, 'SAR', L);

  // --- owner and organization (created by the earlier tests; created here when this test runs alone)
  await signIn(page, info, email);
  const find = async () =>
    (
      await sql<{ id: string }>(
        `SELECT m.org_id AS id FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`,
        [email],
      )
    )[0];
  let org = await find();
  if (!org) {
    await go('/orgs/new');
    await page.getByLabel(T(info, 'field.name')).fill(`Payments ${L}`);
    await page.getByRole('button', { name: T(info, 'action.create') }).click();
    await expectActiveOrg(page, info, `Payments ${L}`);
    org = (await find())!;
  }
  const orgId = org.id;
  await seedStarterPrice();
  await elevate(email);

  // --- UI-M03-01/02: payment methods — empty, then add a sandbox card (a token choice; the form has no card-number field)
  // billing tabs stack their screens: the old routes land on their sections (payment methods → payments page)
  await go('/billing/payment-methods');
  await expect(page).toHaveURL(/\/billing\/payments#methods$/);
  await expect(page.locator('#methods').getByText(T(info, 'pay.methods.none'))).toBeVisible();
  await audit(page, info, 'payments-methods-empty');
  await go('/billing/payment-methods/add');
  await expect(page.getByLabel(T(info, 'pay.add.scenario'))).toBeVisible();
  expect(await page.locator('main input, main textarea').count()).toBe(0);
  await audit(page, info, 'payments-method-add');
  await page.getByRole('button', { name: T(info, 'pay.add.submit') }).click();
  await expect(page.getByText(T(info, 'pay.methods.default'), { exact: true })).toBeVisible();
  await audit(page, info, 'payments-methods');

  // --- UI-M03-10: tax profile (B2B with a VAT number); saved, then shown again after a reload
  await go('/billing/tax-profile');
  await expect(page.getByText(T(info, 'tax.none'))).toBeVisible();
  await page.getByLabel(T(info, 'tax.f.type')).selectOption('b2b');
  await page.getByLabel(T(info, 'tax.f.nameAr')).fill('شركة الاختبار');
  await page.getByLabel(T(info, 'tax.f.nameEn')).fill('Test Company');
  await page.getByLabel(T(info, 'tax.f.vat')).fill('300000000000003');
  await page.getByLabel(T(info, 'tax.f.cr')).fill('1010000000');
  await page.getByLabel(T(info, 'tax.f.street')).fill('King Fahd Road');
  await page.getByLabel(T(info, 'tax.f.building')).fill('1234');
  await page.getByLabel(T(info, 'tax.f.district')).fill('Olaya');
  await page.getByLabel(T(info, 'tax.f.city')).fill('Riyadh');
  await page.getByLabel(T(info, 'tax.f.postal')).fill('12211');
  await page.getByRole('button', { name: T(info, 'action.save') }).click();
  await expect(page.getByText(T(info, 'tax.saved'))).toBeVisible();
  await go('/billing/tax-profile');
  await expect(page.getByLabel(T(info, 'tax.f.vat'))).toHaveValue('300000000000003');
  await audit(page, info, 'payments-tax-profile');
  // an invalid VAT number is refused with a message (never a silent save)
  await page.getByLabel(T(info, 'tax.f.vat')).fill('12345');
  await page.getByRole('button', { name: T(info, 'action.save') }).click();
  await expect(page.getByText(T(info, 'tax.invalid'))).toBeVisible();

  // --- UI-M03-03/04: subscribe (first period is invoiced and paid with the sandbox card), then the detail screen
  await go('/billing/subscriptions');
  await expect(page.locator('#subscriptions').getByText(T(info, 'sub.none'))).toBeVisible();
  await audit(page, info, 'payments-subscriptions-empty');
  // the priced plan is Starter (the list order is not fixed): choose it by name
  const starter = await page
    .locator('#sub-plan option', { hasText: L === 'ar' ? 'المبتدئ' : 'Starter' })
    .getAttribute('value');
  await page.locator('#subscriptions').getByLabel(T(info, 'sub.pickPlan')).selectOption(starter!);
  await page
    .locator('#subscriptions')
    .getByRole('button', { name: T(info, 'sub.subscribe') })
    .click();
  // creating the subscription lands on its detail screen: active, with the plan and the cancel action
  await expect(page.getByRole('heading', { name: 'starter' })).toBeVisible();
  await expect(page.getByText(T(info, 'sub.status.active'), { exact: true })).toBeVisible();
  await audit(page, info, 'payments-subscription-detail');
  await page.getByRole('button', { name: T(info, 'sub.cancel') }).click();
  await expect(page.getByText(T(info, 'sub.cancelDone'))).toBeVisible();
  await go('/billing/subscriptions');
  await expect(page.locator('#subscriptions').getByRole('link', { name: 'starter' })).toBeVisible();
  await audit(page, info, 'payments-subscriptions');

  // --- UI-M03-05/06: invoices — the subscription's first invoice is paid; an open one is paid now with the saved card
  await go('/billing/invoices');
  await expect(
    page
      .locator('#invoices')
      .getByRole('table')
      .getByText(T(info, 'inv.status.paid'), { exact: true })
      .first(),
  ).toBeVisible();
  await audit(page, info, 'payments-invoices');
  const open = await openInvoice(orgId, L === 'ar' ? 9001 : 9002, '11500');
  await go('/billing/invoices');
  await page.getByRole('link', { name: `EE-${L === 'ar' ? 9001 : 9002}` }).click();
  await expect(page.getByText(money('11500')).first()).toBeVisible();
  await audit(page, info, 'payments-invoice-open');
  await page
    .getByRole('button', { name: T(info, 'inv.pay.submit', { amount: money('11500') }) })
    .click();
  // the success text lives in the pay form, which goes away when the refreshed page shows the invoice as paid: assert the lasting result
  const payButton = page.getByRole('button', {
    name: T(info, 'inv.pay.submit', { amount: money('11500') }),
  });
  await expect(payButton).toHaveCount(0);
  await go(`/billing/invoices/${open}`);
  await expect(page.getByText(T(info, 'inv.status.paid'), { exact: true }).first()).toBeVisible();
  await audit(page, info, 'payments-invoice-paid');
  const pdf = await page.request.get(`/${L}/billing/invoices/${open}/pdf?lang=${L}`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toContain('application/pdf');

  // --- UI-M03-07: credit notes (none yet)
  await go('/billing/credit-notes');
  await expect(page).toHaveURL(/\/billing\/invoices#creditNotes$/);
  await expect(page.locator('#creditNotes').getByText(T(info, 'cn.none'))).toBeVisible();
  await audit(page, info, 'payments-credit-notes');

  // --- UI-M03-09: wallet top-up; an amount outside the allowed range is refused on the screen
  await go('/billing/wallet');
  const wallet = page.locator('#wallet');
  await wallet.getByLabel(T(info, 'wallet.amount')).fill('0.50');
  await wallet.getByRole('button', { name: T(info, 'wallet.submit') }).click();
  await expect(wallet.getByText(T(info, 'wallet.invalid'))).toBeVisible();
  await wallet.getByLabel(T(info, 'wallet.amount')).fill('50');
  await wallet.getByRole('button', { name: T(info, 'wallet.submit') }).click();
  await expect(wallet.getByText(T(info, 'wallet.ok'))).toBeVisible();
  await go('/billing/wallet');
  await expect(page.locator('#wallet').getByText(money('5000')).first()).toBeVisible();
  await audit(page, info, 'payments-wallet');

  // --- UI-M03-08: payments list (invoice payments and the top-up)
  await go('/billing/payments');
  await expect(
    page
      .locator('#payments')
      .getByRole('table')
      .getByText(T(info, 'pay.status.succeeded'), { exact: true })
      .first(),
  ).toBeVisible();
  await audit(page, info, 'payments-list');

  // --- UI-M03-12: the return page — no payment, then a finished one
  await page.evaluate(() => sessionStorage.clear()); // the page remembers the last payment of this browser tab
  await go('/billing/payment-return');
  await expect(page.getByText(T(info, 'ret.missing'))).toBeVisible();
  await audit(page, info, 'payments-return-missing');
  const paid = (
    await sql<{ id: string }>(
      `SELECT id FROM payments.payment_intents WHERE org_id = $1 AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1`,
      [orgId],
    )
  )[0]!;
  await go(`/billing/payment-return?paymentId=${paid.id}`);
  await expect(page.getByText(T(info, 'ret.success'))).toBeVisible();
  await audit(page, info, 'payments-return-success');

  // --- UI-M03-11: checkout review of a quote (paying a quote is not offered yet; the screen says so)
  const csrf = (await page.context().cookies()).find((c) => c.name === 'nuzm_csrf')!.value;
  const q = await page.request.post('/v1/quotes', {
    data: { kind: 'ai-credit', items: [{ credits: '10' }] },
    headers: { 'x-csrf-token': csrf, 'x-nuzm-org': orgId, 'idempotency-key': `e2e-chk-${L}` },
  });
  expect(q.status()).toBe(201);
  const quote = (await q.json()) as { id: string };
  await go(`/billing/checkout/${quote.id}`);
  await expect(page.getByRole('heading', { name: T(info, 'chk.title') })).toBeVisible();
  await audit(page, info, 'payments-checkout');
});
