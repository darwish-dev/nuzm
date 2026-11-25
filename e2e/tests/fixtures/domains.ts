import { expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { DB_URL as DB, WEB } from '../env';
import { T, loc } from '../helpers';
import { sql } from './templates';

const cookie = async (page: Page, name: string) =>
  (await page.context().cookies()).find((c) => c.name === name)?.value ?? '';

/** Test tooling: registrar processors in the ROPA, the residency policy that allows them, the disclosure consent and wallet funds (all through the real tables/APIs). */
export async function prepareDomains(page: Page, org: string) {
  await sql(
    `INSERT INTO compliance.ropa_entries (id, entry_key, version, kind, adapter_kind, activity, purpose, data_classes, processors, regions, status, change_note)
     SELECT gen_random_uuid(),'adapter:registrar', coalesce((SELECT max(version) FROM compliance.ropa_entries WHERE entry_key='adapter:registrar'),0)+1,'adapter','registrar','Domain registrar','Register and manage domains for customers','{personal,internal}',
       '[{"name":"openprovider","role":"processor","region":"NL","dataClasses":["personal","internal"],"contractRef":null},{"name":"resellerclub","role":"processor","region":"IN","dataClasses":["personal","internal"],"contractRef":null}]'::jsonb,'{}','draft','e2e'
       WHERE NOT EXISTS (SELECT 1 FROM compliance.ropa_entries WHERE entry_key='adapter:registrar' AND change_note='e2e')`,
  );
  const hdr = { 'x-csrf-token': await cookie(page, 'nuzm_csrf'), 'x-nuzm-org': org };
  const cur = await page.request.get(`${WEB}/v1/compliance/residency-policy`, { headers: hdr });
  const put = await page.request.put(`${WEB}/v1/compliance/residency-policy`, {
    headers: { ...hdr, ...(cur.headers().etag ? { 'if-match': cur.headers().etag! } : {}) },
    data: { mode: 'allow_listed', allowedCountriesByClass: { personal: ['NL', 'IN'] } },
  });
  expect([200, 201]).toContain(put.status());
  const c = await page.request.post(`${WEB}/v1/compliance/consents`, {
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

/** Buys a domain through the customer's checkout screen (mock registrar, NOT VERIFIED) and waits until it is active. Returns the domain id. */
export async function registerDomain(page: Page, info: TestInfo, name: string): Promise<string> {
  const L = loc(info);
  await page.goto(`${WEB}/${L}/domains/checkout?name=${name}`);
  await page.getByRole('button', { name: T(info, 'dom.checkout.quote') }).click();
  await expect(page.getByRole('timer')).toBeVisible();
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
  await expect(page).toHaveURL(/\/domains\/[0-9a-f-]{36}$/);
  const id = page.url().split('/').pop()!;
  await expect
    .poll(
      async () =>
        (await sql<{ state: string }>(`SELECT state FROM domains.domains WHERE id = $1`, [id]))[0]
          ?.state,
      {
        timeout: 60_000,
      },
    )
    .toBe('active');
  return id;
}
