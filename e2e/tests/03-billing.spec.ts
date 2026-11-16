import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { formatMinor } from '@nuzm/i18n';
import { PRODUCER_KEY } from '../playwright.config';
import { T, audit, loc, signIn, totp } from './helpers';

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

const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
const at = (hours: number) => new Date(monthStart.getTime() + hours * 3_600_000).toISOString();

/** Synthetic producer: real events through the real ingest endpoint (service key), as a node agent would send them. */
async function emit(orgId: string, meterId: string, unit: string, quantity: string, hour: number) {
  const r = await fetch('http://127.0.0.1:4000/v1/internal/metering/events', {
    method: 'POST',
    headers: { authorization: `Bearer ${PRODUCER_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      events: [
        {
          eventId: crypto.randomUUID(),
          orgId,
          meterId,
          quantity,
          unit,
          resourceId: '11111111-1111-4111-8111-111111111111',
          windowStart: at(hour),
          windowEnd: at(hour + 1),
          occurredAt: new Date().toISOString(),
          dimensions: { region: 'sa-central' },
          dataRegion: 'sa-pending',
        },
      ],
    }),
  });
  const body = (await r.json()) as { summary: { accepted: number } };
  expect(body.summary.accepted).toBe(1);
}

/** A prepaid credit on the organization's wallet (ledger recipe shape of billing.post), as the admin tooling would post. */
async function creditWallet(orgId: string, minor: string) {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
    await c.query(
      `SELECT * FROM billing.post(gen_random_uuid(), $1, $2, 'credit_grant', 'welcome credit', NULL, NULL, $3::jsonb, NULL)`,
      [
        orgId,
        `e2e-credit-${orgId}`,
        JSON.stringify([
          {
            account: { code: '4900', org: false },
            direction: 'debit',
            amountMinor: minor,
            currency: 'SAR',
          },
          {
            account: { code: '2100', org: true },
            direction: 'credit',
            amountMinor: minor,
            currency: 'SAR',
          },
        ]),
      ],
    );
    await c.query('SELECT billing.refresh_wallet($1)', [orgId]);
    await c.query('COMMIT');
  } finally {
    await c.end();
  }
}

/** Test tooling: the owner enrolled MFA in the customer test; mark this session as recently verified (as the API harness does). */
async function elevate(email: string) {
  await sql(
    `UPDATE identity.sessions SET mfa_level = 'totp', mfa_verified_at = now() WHERE user_id = (SELECT id FROM identity.users WHERE email = $1)`,
    [email],
  );
}

async function enrolMfa(page: Page, info: TestInfo) {
  await page.goto(`/${loc(info)}/account/security/mfa`);
  await page.getByRole('button', { name: T(info, 'mfa.start') }).click();
  await expect(page.getByRole('img', { name: T(info, 'mfa.qr') })).toBeVisible();
  const secret = (await page.locator('main bdi').first().innerText()).trim();
  await page.getByLabel(T(info, 'field.code')).fill(totp(secret));
  await page.getByRole('button', { name: T(info, 'action.verify') }).click();
  await expect(page.getByText(T(info, 'mfa.done'))).toBeVisible();
}

test('billing: usage, quotas, statement, spending cap, quote and four-eyes approval', async ({
  page,
  browser,
}, info) => {
  const L = loc(info);
  const email = `owner-${L}@example.test`;
  const go = (p: string, pg: Page = page) => pg.goto(`/${L}${p}`);
  const money = (m: string) => formatMinor(m, 'SAR', L);

  // --- owner and organization (created by the customer test; created here when this test runs alone)
  await signIn(page, info, email);
  let org = (
    await sql<{ id: string }>(
      `SELECT m.org_id AS id FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`,
      [email],
    )
  )[0];
  if (!org) {
    await go('/orgs/new');
    await page.getByLabel(T(info, 'field.name')).fill(`Billing ${L}`);
    await page.getByRole('button', { name: T(info, 'action.create') }).click();
    await expect(page.getByText(T(info, 'home.org', { org: `Billing ${L}` }))).toBeVisible();
    org = (
      await sql<{ id: string }>(
        `SELECT m.org_id AS id FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`,
        [email],
      )
    )[0]!;
  }
  const orgId = org.id;

  // --- synthetic producer + a wallet credit
  await emit(orgId, 'network.egress_gb', 'gb', '3', 2);
  await emit(orgId, 'storage.object_gb_months', 'gib_month', '4', 3); // 80 % of the free plan's 5 (soft)
  await emit(orgId, 'compute.vcpu_hours', 'vcpu_hour', '2', 4); // free plan compute limit is 0 (hard)
  await creditWallet(orgId, '5000');

  // --- overview
  await go('/billing');
  await expect(page.getByRole('heading', { name: T(info, 'bill.balance.title') })).toBeVisible();
  await expect(page.getByText(money('5000')).first()).toBeVisible();
  await expect(
    page.getByText(
      T(info, 'bill.alerts.quota', {
        group: 'compute',
        percent: 100,
        state: T(info, 'bill.state.hard'),
      }),
    ),
  ).toBeVisible();
  await audit(page, info, 'billing-overview');

  // --- plans
  await go('/billing/plans');
  await expect(page.getByRole('heading', { name: T(info, 'bill.plans.limits') })).toBeVisible();
  await expect(page.getByText(T(info, 'bill.plans.placeholder')).first()).toBeVisible();
  await audit(page, info, 'billing-plans');

  // --- usage explorer, drill-down and CSV
  await go('/billing/usage');
  await expect(page.getByRole('cell', { name: 'network.egress_gb' }).first()).toBeVisible();
  await expect(page.getByText('sa-pending').first()).toBeVisible();
  await audit(page, info, 'billing-usage');
  await page.getByRole('link', { name: 'network.egress_gb' }).first().click();
  await expect(
    page.getByRole('heading', {
      name: T(info, 'bill.usage.drill', { meter: 'network.egress_gb' }),
    }),
  ).toBeVisible();
  await audit(page, info, 'billing-usage-meter');
  const csv = await page.request.get(`/${L}/billing/usage/export?granularity=day`);
  expect(csv.status()).toBe(200);
  expect(csv.headers()['content-type']).toContain('text/csv');
  const text = await csv.text();
  expect(text.split('\r\n')[0]).toBe(
    'bucketStart,meterId,resourceId,quantity,unit,eventCount,billingPeriodStart,dataRegion',
  );
  expect(text).toContain('network.egress_gb');

  // --- quotas: the hard quota is restricted, the soft one is near its limit
  await go('/billing/quotas');
  await expect(
    page.getByRole('alert').filter({ hasText: T(info, 'bill.quotas.restricted') }),
  ).toBeVisible();
  await expect(page.getByText(T(info, 'bill.state.hard'), { exact: true }).first()).toBeVisible();
  await audit(page, info, 'billing-quotas');

  // --- statement with running balance
  await go('/billing/ledger');
  await expect(page.getByRole('cell', { name: 'credit_grant' })).toBeVisible();
  await expect(page.getByRole('cell', { name: money('5000') }).first()).toBeVisible();
  await audit(page, info, 'billing-ledger');

  // --- spending cap (10 SAR) → saved; the screen shows it after a reload
  await go('/billing/spending-limits');
  await page.getByLabel(T(info, 'bill.f.cap')).fill('10');
  await page.getByRole('button', { name: T(info, 'action.save') }).click();
  await expect(page.getByText(T(info, 'bill.limits.saved'))).toBeVisible();
  await go('/billing/spending-limits');
  await expect(page.getByLabel(T(info, 'bill.f.cap'))).toHaveValue('10');
  await audit(page, info, 'billing-spending-limits');
  await page.getByLabel(T(info, 'bill.f.cap')).fill('1.234'); // invalid: more than two decimals
  await page.getByRole('button', { name: T(info, 'action.save') }).click();
  await expect(page.getByText(T(info, 'bill.limits.invalid'))).toBeVisible();

  // --- a quote above the cap: provisional tax, requires an approval, one request per subject
  const csrf = (await page.context().cookies()).find((c) => c.name === 'nuzm_csrf')!.value;
  const q = await page.request.post('/v1/quotes', {
    data: { kind: 'ai-credit', items: [{ credits: '1000' }] },
    headers: { 'x-csrf-token': csrf, 'x-nuzm-org': orgId, 'idempotency-key': `e2e-quote-${L}` },
  });
  expect(q.status()).toBe(201);
  const quote = (await q.json()) as { id: string; totalMinor: string; requiresApproval: boolean };
  expect(quote.requiresApproval).toBe(true);
  await go(`/billing/quotes/${quote.id}`);
  await expect(page.getByText(T(info, 'bill.quote.needsApproval'))).toBeVisible();
  await expect(page.getByText(T(info, 'bill.quote.provisional'))).toBeVisible();
  await expect(page.getByText(money(quote.totalMinor)).first()).toBeVisible();
  await audit(page, info, 'billing-quote');
  await page.getByRole('button', { name: T(info, 'bill.quote.request') }).click();
  await expect(page.getByText(T(info, 'bill.approvals.requested'))).toBeVisible();

  // --- approvals: the requester cannot decide their own request (four-eyes)
  await go('/billing/approvals');
  await expect(page.getByText(T(info, 'bill.status.pending'))).toBeVisible();
  await audit(page, info, 'billing-approvals');
  await elevate(email);
  await go('/billing/approvals');
  await page.getByRole('button', { name: T(info, 'bill.act.approve') }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: T(info, 'bill.approvals.self') }),
  ).toBeVisible();

  // --- a second person (billing admin) approves
  const ctx2 = await browser.newContext({
    locale: info.project.use.locale ?? 'en-GB',
    viewport: { width: 1280, height: 900 },
  });
  const page2 = await ctx2.newPage();
  const email2 = `billing-${L}@example.test`;
  await signIn(page2, info, email2);
  const user2 = (
    await sql<{ id: string }>(`SELECT id FROM identity.users WHERE email = $1`, [email2])
  )[0]!;
  await sql(
    `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, 'billing_admin')`,
    [orgId, user2.id],
  );
  await enrolMfa(page2, info);
  await go('/billing/approvals', page2);
  await page2.getByRole('button', { name: T(info, 'bill.act.approve') }).click();
  await expect(page2.getByText(T(info, 'bill.approvals.decided'))).toBeVisible();
  await expect(page2.getByText(T(info, 'bill.status.approved'), { exact: true })).toBeVisible();
  await audit(page2, info, 'billing-approval-decided');
  await ctx2.close();
});
