import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';
import { T, audit, loc } from './helpers';
import { DB_URL as DB } from './env';

/**
 * M07 domain screens (UI-M07-01..08 customer, UI-M07-09..12 admin) in ar and en. NOT RUN in the session that wrote it (the e2e ports belong to other sessions):
 * recorded as NOT RUN in docs/reports/S31-report.md. Runs after 01-customer (it uses this locale's owner organization) against the dev stack with
 * DOMAINS_DEV_MOCKS: the registrars are local MOCKS, so what is shown is NOT VERIFIED vendor behaviour.
 */
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
const cookie = async (page: Page, name: string) =>
  (await page.context().cookies()).find((c) => c.name === name)?.value ?? '';

/** Test tooling: registrar processors in the ROPA, the residency policy that allows them, the disclosure consent and wallet funds (all through the real tables/APIs). */
async function prepare(page: Page, org: string) {
  await sql(
    `INSERT INTO compliance.ropa_entries (id, entry_key, version, kind, adapter_kind, activity, purpose, data_classes, processors, regions, status, change_note)
     SELECT gen_random_uuid(),'adapter:registrar', coalesce(max(version),0)+1,'adapter','registrar','Domain registrar','Register and manage domains for customers','{personal,internal}',
       '[{"name":"openprovider","role":"processor","region":"NL","dataClasses":["personal","internal"],"contractRef":null},{"name":"resellerclub","role":"processor","region":"IN","dataClasses":["personal","internal"],"contractRef":null}]'::jsonb,'{}','draft','e2e'
       FROM compliance.ropa_entries WHERE entry_key='adapter:registrar' AND NOT EXISTS (SELECT 1 FROM compliance.ropa_entries WHERE entry_key='adapter:registrar' AND change_note='e2e')`,
  );
  const hdr = { 'x-csrf-token': await cookie(page, 'nuzm_csrf'), 'x-nuzm-org': org };
  const cur = await page.request.get('/v1/compliance/residency-policy', { headers: hdr });
  const put = await page.request.put('/v1/compliance/residency-policy', {
    headers: { ...hdr, ...(cur.headers().etag ? { 'if-match': cur.headers().etag! } : {}) },
    data: { mode: 'allow_listed', allowedCountriesByClass: { personal: ['NL', 'IN'] } },
  });
  expect([200, 201]).toContain(put.status());
  const c = await page.request.post('/v1/compliance/consents', {
    headers: { ...hdr, 'idempotency-key': `e2e-consent-${Date.now()}` },
    data: {
      purposeId: 'domain_registrant_disclosure',
      granted: true,
      localeShown: 'en',
      textVersion: 'placeholder-1',
      subjectRef: 'org',
    },
  });
  expect([200, 201]).toContain(c.status());
  const db = new Client({ connectionString: DB });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
    await db.query(
      `SELECT * FROM billing.post(gen_random_uuid(), $1, $2, 'credit_grant', 'e2e funds', $2, NULL, $3::jsonb, NULL)`,
      [
        org,
        `e2e-fund-${org}`,
        JSON.stringify([
          {
            account: { code: '4900', org: false },
            direction: 'debit',
            amountMinor: '5000000',
            currency: 'SAR',
          },
          {
            account: { code: '2100', org: true },
            direction: 'credit',
            amountMinor: '5000000',
            currency: 'SAR',
          },
        ]),
      ],
    );
    await db.query('COMMIT');
  } finally {
    await db.end();
  }
}

test('customer domains: list, search (Saudi TLD blocked with its reason), checkout, domain, DNS, contacts, transfers, hosting', async ({
  page,
}, info) => {
  const L = loc(info);
  const email = `owner-${L}@example.test`;
  const go = (path: string) => page.goto(`/${L}${path}`);
  const org = (
    await sql<{ id: string }>(
      `SELECT m.org_id AS id FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`,
      [email],
    )
  )[0];
  if (!org) throw new Error('run 01-customer first: no owner organization');
  await page.goto(`/${L}/login`);
  await page.getByRole('link', { name: T(info, 'action.signin') }).click();
  await page.getByRole('link', { name: new RegExp(email.replace('.', '\\.')) }).click();
  await prepare(page, org.id);

  // UI-M07-01: empty list leads to search
  await go('/domains');
  await expect(page.getByRole('heading', { name: T(info, 'dom.title') })).toBeVisible();
  await expect(page.getByText(T(info, 'dom.empty.title'))).toBeVisible();
  await audit(page, info, 'domains-empty');

  // UI-M07-02: search, with a blocked Saudi TLD that explains itself
  await go(`/domains/search?q=e2e-horizon-${L}&tlds=com,sa`);
  await expect(page.getByText(T(info, 'dom.search.available'))).toBeVisible();
  await expect(page.getByText(T(info, 'dom.search.reason.policy.saudi_absent'))).toBeVisible();
  await audit(page, info, 'domains-search');

  // UI-M07-03: checkout (quote, contacts, consent, confirm)
  await go(`/domains/checkout?name=e2e-horizon-${L}.com`);
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
  await expect(page).toHaveURL(new RegExp(`/${L}/domains/[0-9a-f-]{36}$`));
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
  await expect(page.getByRole('link', { name: `e2e-horizon-${L}.com` })).toBeVisible();
  await audit(page, info, 'domains-list');
});

test('admin domains: registrars (NOT VERIFIED), orders queue, RC-04 reconciliation, support lookup with masked contacts', async ({
  page,
}, info) => {
  const L = loc(info);
  const staff = `staff-${L}@example.test`;
  await page.goto(`${ADMIN}/${L}/login`);
  await page.getByRole('link', { name: T(info, 'action.signin') }).click();
  await page.getByRole('link', { name: new RegExp(staff.replace('.', '\\.')) }).click();
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
  const d = (
    await sql<{ id: string }>(`SELECT id FROM domains.domains ORDER BY created_at DESC LIMIT 1`)
  )[0];
  if (d) {
    await page.goto(`${ADMIN}/${L}/domains/${d.id}`);
    await expect(page.getByText(T(info, 'dom.admin.detail.masked'))).toBeVisible();
    await audit(page, info, 'admin-domain-lookup');
  }
});
