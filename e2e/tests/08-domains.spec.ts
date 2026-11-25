import { expect, test } from '@playwright/test';
import { Client } from 'pg';
import { T, audit, loc } from './helpers';
import { ADMIN, DB_URL as DB } from './env';
import { prepareDomains, registerDomain } from './fixtures/domains';
import { ensureOwnerOrg } from './fixtures/templates';
import { signIn } from './helpers';
import { resetDatabase } from './reset';

test.beforeAll(resetDatabase);

/**
 * M07 domain screens (UI-M07-01..08 customer, UI-M07-09..12 admin) in ar and en. NOT RUN in the session that wrote it (the e2e ports belong to other sessions):
 * recorded as NOT RUN in docs/reports/S31-report.md. Runs after 01-customer (it uses this locale's owner organization) against the dev stack with
 * DOMAINS_DEV_MOCKS: the registrars are local MOCKS, so what is shown is NOT VERIFIED vendor behaviour.
 */
const sql = async <T extends Record<string, unknown>>(q: string, args: unknown[] = []) => {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(q, args)).rows as T[];
  } finally {
    await c.end();
  }
};
test('customer domains: list, search (Saudi TLD blocked with its reason), checkout, domain, DNS, contacts, transfers, hosting', async ({
  page,
}, info) => {
  const L = loc(info);
  // unique per run: the dev-mock registrar lives in the API process, so a name bought once stays taken across database resets
  const horizon = `e2e-horizon-${L}-${Date.now().toString(36)}`;
  const email = `owner-${L}@example.test`;
  const go = (path: string) => page.goto(`/${L}${path}`);
  // the owner organization is created here, through the screen (this also signs the owner in); no spec depends on another one's data
  await ensureOwnerOrg(page, info, `Domains ${L}`);
  const org = (
    await sql<{ id: string }>(
      `SELECT m.org_id AS id FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`,
      [email],
    )
  )[0];
  if (!org) throw new Error('the owner organization was not created');
  await prepareDomains(page, org.id);

  // UI-M07-01: empty list leads to search
  await go('/domains');
  await expect(
    page.getByRole('heading', { name: T(info, 'dom.title'), exact: true }),
  ).toBeVisible();
  await expect(page.getByText(T(info, 'dom.empty.title'))).toBeVisible();
  await audit(page, info, 'domains-empty');

  // UI-M07-02: search, with a blocked Saudi TLD that explains itself
  await go(`/domains/search?q=${horizon}&tlds=com,sa`);
  await expect(page.getByText(T(info, 'dom.search.available'), { exact: true })).toBeVisible();
  await expect(page.getByText(T(info, 'dom.search.reason.policy.saudi_absent'))).toBeVisible();
  await audit(page, info, 'domains-search');

  // UI-M07-03: checkout (quote, contacts, consent, confirm)
  await go(`/domains/checkout?name=${horizon}.com`);
  await page.getByRole('button', { name: T(info, 'dom.checkout.quote') }).click();
  await expect(page.getByRole('timer')).toBeVisible();
  await audit(page, info, 'domains-checkout');
  const f = (id: string, v: string) => page.locator(`#ct-${id}`).fill(v);
  await f('first', 'Layla');
  await f('last', 'Alharbi');
  await f('email', `registrant-${L}@example.test`);
  await f('phone', '+966500000000');
  await f('street', 'King Fahd Rd');
  await f('city', 'Riyadh');
  await f('postal', '12211');
  await page.getByLabel(T(info, 'dom.checkout.consent')).check();
  await page.getByRole('button', { name: T(info, 'dom.checkout.confirm') }).click();

  // UI-M07-04: the domain page (the operation finishes in the background; pending is an allowed intermediate state)
  await expect(page).toHaveURL(/\/domains\/[0-9a-f-]{36}$/);
  await audit(page, info, 'domain-detail');
  const id = page.url().split('/').pop()!;
  await expect
    .poll(
      async () =>
        (await sql<{ state: string }>(`SELECT state FROM domains.domains WHERE id = $1`, [id]))[0]
          ?.state,
      { timeout: 60_000 },
    )
    .toBe('active');
  await page.reload();
  await expect(page.getByText(T(info, 'dom.state.active'))).toBeVisible();

  // UI-M07-05: DNS zone, add a record, apply the change-set
  await go(`/domains/${id}/dns`);
  await page.getByRole('button', { name: T(info, 'dom.dns.create') }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await page.locator('#dn-name').fill('www');
  await page.locator('#dn-val').fill('192.0.2.10');
  await page
    .getByRole('button', { name: T(info, 'dom.dns.add') })
    .first()
    .click();
  // queued changes are not live: the unsaved-changes bar says so until they are applied
  await expect(page.getByText(T(info, 'dom.dns.unsaved', { count: 1 }))).toBeVisible();
  await audit(page, info, 'domain-dns-pending');
  await page.getByRole('button', { name: T(info, 'dom.dns.apply') }).click();
  await expect(page.getByText(T(info, 'dom.dns.applied'))).toBeVisible();
  // an invalid record is explained per change and nothing is applied
  await page.locator('#dn-name').fill('@');
  await page.locator('#dn-type').selectOption('CNAME');
  await page.locator('#dn-val').fill('target.example.net');
  await page
    .getByRole('button', { name: T(info, 'dom.dns.add') })
    .first()
    .click();
  await page.getByRole('button', { name: T(info, 'dom.dns.apply') }).click();
  await expect(page.getByText(T(info, 'dom.dns.errors'))).toBeVisible();
  await audit(page, info, 'domain-dns-errors');

  // UI-M07-06 contacts, UI-M07-07 transfers, UI-M07-08 hosting (disabled while M06 is a fake)
  await go(`/domains/${id}/contacts`);
  await expect(page.locator('#ct-email')).toBeVisible();
  await audit(page, info, 'domain-contacts');
  await go('/domains/transfers');
  await expect(page.getByLabel(T(info, 'dom.tr.authCode'))).toHaveAttribute('type', 'password');
  await audit(page, info, 'domain-transfers');
  await go(`/domains/${id}/hosting`);
  await audit(page, info, 'domain-hosting');
  await go('/domains');
  await expect(page.getByRole('link', { name: `${horizon}.com` })).toBeVisible();
  await audit(page, info, 'domains-list');
});

test('admin domains: registrars (NOT VERIFIED), orders queue, RC-04 reconciliation, support lookup with masked contacts', async ({
  page,
  browser,
}, info) => {
  const L = loc(info);
  // unique per run: the dev-mock registrar lives in the API process, so a name bought once stays taken across database resets
  const horizon = `e2e-horizon-${L}-${Date.now().toString(36)}`;
  const staff = `staff-${L}@example.test`;
  // a customer domain to look up, bought through the customer's own checkout screen (no spec depends on another one's data)
  const customer = await browser.newContext({ locale: L === 'ar' ? 'ar-SA' : 'en-GB' });
  const cp = await customer.newPage();
  const orgId = await ensureOwnerOrg(cp, info, `Domains ${L}`);
  await prepareDomains(cp, orgId);
  const domain = await registerDomain(cp, info, `${horizon}.com`);
  await customer.close();

  await signIn(page, info, staff, ADMIN);
  await sql(
    `UPDATE identity.sessions SET mfa_level = 'totp', mfa_verified_at = now() WHERE user_id = (SELECT id FROM identity.users WHERE email = $1)`,
    [staff],
  );
  await page.goto(`${ADMIN}/${L}/domains/registrars`);
  await expect(page.getByText(T(info, 'dom.admin.verified')).first()).toBeVisible(); // a mock is never shown as verified
  await audit(page, info, 'admin-registrars');
  await page.goto(`${ADMIN}/${L}/domains/orders`);
  await audit(page, info, 'admin-domain-orders');
  await page.goto(`${ADMIN}/${L}/domains/reconciliation`);
  await expect(page.getByText(T(info, 'dom.admin.recon.help'))).toBeVisible();
  await audit(page, info, 'admin-domain-reconciliation');
  await page.goto(`${ADMIN}/${L}/domains/${domain}`);
  await expect(page.getByText(T(info, 'dom.admin.detail.masked'))).toBeVisible();
  await audit(page, info, 'admin-domain-lookup');
});
