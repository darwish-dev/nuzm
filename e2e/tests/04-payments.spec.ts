import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';
import { formatMinor } from '@nuzm/i18n';
import { T, audit, loc, signIn } from './helpers';
import { DB_URL as DB } from './env';

const sql = async <T extends Record<string, unknown>>(q: string, args: unknown[] = []) => {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(q, args)).rows as T[];
  } finally {
    await c.end();
  }
};

/** Test tooling: mark the owner's session as recently MFA-verified (as 03-billing does) so step-up never interrupts the flow. */
async function elevate(email: string) {
  await sql(
    `UPDATE identity.sessions SET mfa_level = 'totp', mfa_verified_at = now() WHERE user_id = (SELECT id FROM identity.users WHERE email = $1)`,
    [email],
  );
}

/** A non-placeholder price book that prices the seeded `starter` plan (the e2e database is fresh; created once, by whichever locale runs first). */
async function seedStarterPrice() {
  if ((await sql(`SELECT 1 FROM billing.price_books WHERE name = 'e2e-payments'`)).length > 0)
    return;
  const publisher = '00000000-0000-0000-0000-000000000001';
  const book = crypto.randomUUID();
  const version = crypto.randomUUID();
  await sql(
    `INSERT INTO metering.meters (id, unit, aggregation_window, basis) VALUES ('plan.starter_months','subscription_month','day','subscription') ON CONFLICT DO NOTHING`,
  );
  await sql(
    `INSERT INTO billing.price_books (id, name, currency, placeholder) VALUES ($1,'e2e-payments','SAR',false)`,
    [book],
  );
  await sql(
    `INSERT INTO billing.price_book_versions (id, price_book_id, version, status, effective_from) VALUES ($1,$2,1,'draft','2026-01-01T00:00:00Z')`,
    [version, book],
  );
  // rating uses the newest NON-placeholder book, so this book also carries every price the placeholder book has (earlier tests quote with them)
  await sql(
    `INSERT INTO billing.price_items (id, version_id, meter_id, tier_model, unit_price_minor, tiers, included_allowance, rounding)
     SELECT gen_random_uuid(), $1, i.meter_id, i.tier_model, i.unit_price_minor, i.tiers, i.included_allowance, i.rounding
       FROM billing.price_items i
       JOIN billing.price_book_versions v ON v.id = i.version_id AND v.status = 'published'
       JOIN billing.price_books b ON b.id = v.price_book_id AND b.placeholder`,
    [version],
  );
  await sql(
    `INSERT INTO billing.price_items (id, version_id, meter_id, tier_model, unit_price_minor) VALUES (gen_random_uuid(),$1,'plan.starter_months','flat','3000')`,
    [version],
  );
  await sql(
    `UPDATE billing.price_book_versions SET status = 'published', published_by = $2, published_at = now() WHERE id = $1`,
    [version, publisher],
  );
}

/** An issued, unpaid invoice (sandbox environment) for the organization: the same fixture shape the API integration tests use. */
async function openInvoice(orgId: string, number: number, totalMinor: string) {
  const id = crypto.randomUUID();
  await sql(
    `INSERT INTO invoicing.invoices (id, org_id, entity_id, series, number, number_text, status, environment, currency, period_start, period_end, issued_at, due_at, source_key, subtotal_minor, tax_minor, total_minor, paid_minor, buyer, seller)
     SELECT $1, $2, id, 'EE', $3::bigint, 'EE-' || $3::text, 'open', 'sandbox', 'SAR', '2026-11-01', '2026-11-30', now(), now() + interval '14 days', $4, $5, 0, $5, 0,
            '{"legalName":{"ar":"x","en":"x"},"vatNumber":null,"buyerType":"b2c"}', '{"legalName":{"ar":"x","en":"x"},"vatNumber":null,"placeholder":true}'
       FROM invoicing.billing_entities LIMIT 1`,
    [id, orgId, number, `e2e-open-${number}`, totalMinor],
  );
  return id;
}

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
    await expect(page.getByText(T(info, 'home.org', { org: `Payments ${L}` }))).toBeVisible();
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
