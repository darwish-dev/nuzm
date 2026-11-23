import { expect, type Page, type TestInfo } from '@playwright/test';
import { formatMinor } from '@nuzm/i18n';
import { WEB } from '../env';
import { T, loc } from '../helpers';
import { ensureOwnerOrg, sql } from './templates';

/** Test tooling: mark the owner's session as recently MFA-verified (as 03-billing does) so step-up never interrupts the flow. */
export async function elevate(email: string) {
  await sql(
    `UPDATE identity.sessions SET mfa_level = 'totp', mfa_verified_at = now() WHERE user_id = (SELECT id FROM identity.users WHERE email = $1)`,
    [email],
  );
}

/** A non-placeholder price book that prices the seeded `starter` plan (the e2e database is fresh; created once, by whichever locale runs first). */
export async function seedStarterPrice() {
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
export async function openInvoice(orgId: string, number: number, totalMinor: string) {
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

/**
 * What the admin finance screens act on, created through the customer screens as a customer would (no spec depends on another one's data): the locale's owner organization, a
 * sandbox card, a Starter subscription (its first invoice is paid) and an open invoice paid now with the card. Returns the organization id.
 */
export async function seedPaidInvoice(page: Page, info: TestInfo): Promise<string> {
  const L = loc(info);
  const owner = `owner-${L}@example.test`;
  const orgId = await ensureOwnerOrg(page, info, `Payments ${L}`);
  await seedStarterPrice();
  await elevate(owner);
  await page.goto(`${WEB}/${L}/billing/payment-methods/add`);
  await page.getByRole('button', { name: T(info, 'pay.add.submit') }).click();
  await expect(page.getByText(T(info, 'pay.methods.default'), { exact: true })).toBeVisible();
  await page.goto(`${WEB}/${L}/billing/subscriptions`);
  const starter = await page
    .locator('#sub-plan option', { hasText: L === 'ar' ? 'المبتدئ' : 'Starter' })
    .getAttribute('value');
  await page.locator('#subscriptions').getByLabel(T(info, 'sub.pickPlan')).selectOption(starter!);
  await page
    .locator('#subscriptions')
    .getByRole('button', { name: T(info, 'sub.subscribe') })
    .click();
  await expect(page.getByRole('heading', { name: 'starter' })).toBeVisible();
  const number = L === 'ar' ? 9001 : 9002;
  await openInvoice(orgId, number, '11500');
  await page.goto(`${WEB}/${L}/billing/invoices`);
  await page.getByRole('link', { name: `EE-${number}` }).click();
  const pay = page.getByRole('button', {
    name: T(info, 'inv.pay.submit', { amount: formatMinor('11500', 'SAR', L) }),
  });
  await pay.click();
  await expect(pay).toHaveCount(0); // the pay form goes away once the refreshed page shows the invoice as paid
  return orgId;
}
