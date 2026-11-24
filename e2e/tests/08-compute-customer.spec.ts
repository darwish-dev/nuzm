/**
 * M05 customer compute screens (UI-M05-01..07, 16), ar + en projects, with axe and stored screenshots via `audit`.
 *
 * STATUS: NOT RUN. This file was written in a tree that does not contain the S17 backend (offers, compute quotes and instances,
 * the `cloud.provisioning` flag, the compute permissions), so it could not be executed or even smoke-checked against a live API.
 * Nothing here has produced a screenshot. Run it after the M05 branches are merged:  pnpm test:e2e  (ports 3000/3001/4000/4010 free).
 *
 * Three tests, from least to most demanding on the stack:
 *  1. flag OFF: no Compute navigation entry; offers/instances answer with the "not available" state (never a crash).
 *  2. flag ON, no catalog needed: offers filter form, the AC-M05-03 empty state (country=SA with no verified Saudi region),
 *     empty instance list, wizard with no offers, unknown instance ids, spend approvals screen, forbidden view.
 *  3. flag ON + synthetic mock catalog (seeded BY THE TEST: fixtures/qa-compute-catalog.ts, Session 07; formerly skipped unless
 *     M05_E2E_MOCK_CATALOG was set): offer -> quote -> create -> instance -> stop -> delete. The provisioning spend approval,
 *     quote-expired and residency-denied states are covered by the S17 integration tests (compute-flow.int.spec.ts), not here.
 * The flag is switched through `platform.feature_flags` (global row, org_id NULL), as the S17 integration tests do; if the API
 * caches flags, allow its TTL to pass (the helper retries navigation).
 */
import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';
import { T, audit, loc, signIn, expectActiveOrg } from './helpers';
import { DB_URL as DB } from './env';
import { resetDatabase } from './reset';
import { seedMockComputeCatalog } from './fixtures/qa-compute-catalog';

test.beforeAll(resetDatabase);

const FLAG = 'cloud.provisioning';
const sql = async <R extends Record<string, unknown>>(q: string, args: unknown[] = []) => {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(q, args)).rows as R[];
  } finally {
    await c.end();
  }
};
const setFlag = async (on: boolean) => {
  await sql(`DELETE FROM platform.feature_flags WHERE key = $1 AND org_id IS NULL`, [FLAG]);
  if (on)
    await sql(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), $1, NULL, 'true'::jsonb)`,
      [FLAG],
    );
};

/** Owner of the locale's organization (created by 01-customer; created here when this spec runs alone). */
async function ownerOrg(page: Page, info: Parameters<typeof T>[0]) {
  const L = loc(info);
  const email = `owner-${L}@example.test`;
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
    await page.goto(`/${L}/orgs/new`);
    await page.getByLabel(T(info, 'field.name')).fill(`Compute ${L}`);
    await page.getByRole('button', { name: T(info, 'action.create') }).click();
    await expectActiveOrg(page, info, `Compute ${L}`);
    org = (await find())!;
  }
  return org.id;
}

/** The console's navigation rail: the Cloud servers category (its one page is the instances list) appears only for a member with the permissions while the flag is on. */
const cloudNav = (page: Page, info: Parameters<typeof T>[0]) =>
  page
    .getByRole('navigation', { name: T(info, 'nc.nav.rail') })
    .getByRole('link', { name: T(info, 'nc.cat.cloud') });

test.describe.configure({ mode: 'serial' });

test('compute: flag off hides the navigation and shows "not available"', async ({ page }, info) => {
  const L = loc(info);
  await setFlag(false);
  await ownerOrg(page, info);
  await page.goto(`/${L}`);
  await expect(cloudNav(page, info)).toHaveCount(0);
  for (const path of ['/compute/offers', '/compute/instances', '/compute/instances/new']) {
    await page.goto(`/${L}${path}`);
    await expect(
      page.getByRole('heading', { name: T(info, 'm05.web.unavailable.title') }),
    ).toBeVisible();
  }
  await audit(page, info, 'compute-unavailable');
  // the agency client view is hidden (404) as well: no delegation flag, and the owner's organization is not an agency
  const res = await page.goto(`/${L}/agency/clients/00000000-0000-4000-8000-000000000000/compute`);
  expect(res?.status()).toBe(404);
});

test('compute: offers, empty states, wizard guard, approvals and forbidden views (flag on)', async ({
  page,
  browser,
}, info) => {
  const L = loc(info);
  const go = (p: string, pg: Page = page) => pg.goto(`/${L}${p}`);
  const h1 = (pg: Page, key: Parameters<typeof T>[1]) =>
    expect(pg.getByRole('heading', { level: 1, name: T(info, key) })).toBeVisible();
  await setFlag(true);
  const orgId = await ownerOrg(page, info);

  // navigation entries appear for a member with the permissions
  await expect(async () => {
    await go('');
    await expect(cloudNav(page, info)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await cloudNav(page, info).click();
  await expect(page).toHaveURL(/\/compute\/instances/);

  // --- UI-M05-01: filters; AC-M05-03: country=SA with no verified Saudi region shows the empty state, never a stale offer
  await go('/compute/offers');
  await h1(page, 'm05.web.offers.title');
  await audit(page, info, 'compute-offers');
  await page.getByLabel(T(info, 'field.country')).fill('SA');
  await page.getByRole('button', { name: T(info, 'action.search') }).click();
  await expect(page).toHaveURL(/country=SA/);
  await expect(
    page.getByRole('heading', { name: T(info, 'm05.web.offers.empty.title') }),
  ).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await audit(page, info, 'compute-offers-empty-sa');
  await go('/compute/offers?country=SAU&minVcpu=0'); // invalid filters: reported next to the fields, nothing sent to the API
  await expect(page.getByText(T(info, 'm05.web.offers.country.err'))).toBeVisible();
  await expect(page.getByText(T(info, 'm05.web.offers.num.err'))).toBeVisible();

  // --- UI-M05-03: instance list (empty for a fresh organization)
  await go('/compute/instances');
  await h1(page, 'm05.web.instances.title');
  await audit(page, info, 'compute-instances');

  // --- UI-M05-02: the wizard needs at least one verified offer
  await go('/compute/instances/new');
  await h1(page, 'cloud.new.title');
  const noOffers = page.getByText(T(info, 'm05.web.wiz.noOffers.title'));
  const stepper = page.getByRole('list', { name: T(info, 'm05.web.wiz.steps') });
  await expect(noOffers.or(stepper)).toBeVisible();
  await audit(page, info, 'compute-wizard');

  // --- UI-M05-04..06: an unknown id answers 404 -> the clean "not available" state on every sub-page
  const unknown = '00000000-0000-4000-8000-000000000000';
  for (const sub of ['', '/metrics', '/snapshots']) {
    await go(`/compute/instances/${unknown}${sub}`);
    await expect(
      page.getByRole('heading', { name: T(info, 'm05.web.unavailable.title') }),
    ).toBeVisible();
  }
  await audit(page, info, 'compute-instance-unknown');
  await go('/compute/instances/not-a-uuid'); // malformed id: Next 404 page, not a crash
  await expect(page.getByRole('heading', { name: T(info, 'm05.web.detail.title') })).toHaveCount(0);

  // --- UI-M05-07: the spend approvals screen still works with the provisioning extension, and accepts a prefill from the wizard
  await go(`/billing/approvals?quoteId=${crypto.randomUUID()}&amountMinor=11500`);
  await h1(page, 'bill.approvals.title');
  await expect(page.getByLabel(T(info, 'bill.f.amount'))).toHaveValue('115');
  await expect(page.getByLabel(T(info, 'bill.f.reason'))).toHaveValue(
    T(info, 'm05.web.approvals.reasonPrefill'),
  );
  await audit(page, info, 'compute-approvals');

  // --- forbidden view: a member without compute permissions (the billing admin of 03-billing holds no offers:read)
  const ctx = await browser.newContext({
    locale: info.project.use.locale ?? 'en-GB',
    viewport: { width: 1280, height: 900 },
  });
  const member = await ctx.newPage();
  const email2 = `billing-${L}@example.test`;
  await signIn(member, info, email2);
  const user2 = (
    await sql<{ id: string }>(`SELECT id FROM identity.users WHERE email = $1`, [email2])
  )[0]!;
  await sql(
    `INSERT INTO tenancy.memberships (id, org_id, user_id, role)
     SELECT gen_random_uuid(), $1, $2, 'billing_admin'
      WHERE NOT EXISTS (SELECT 1 FROM tenancy.memberships WHERE org_id = $1 AND user_id = $2)`,
    [orgId, user2.id],
  );
  await go('/compute/instances/new', member);
  await expect(member.getByRole('alert').getByText(T(info, 'state.forbidden.title'))).toBeVisible();
  await audit(member, info, 'compute-wizard-forbidden');
  await ctx.close();
});

test('compute: offer -> quote -> create -> instance actions -> delete on the mock catalog', async ({
  page,
}, info) => {
  // Session 07: no longer skipped behind M05_E2E_MOCK_CATALOG. The test seeds the approved synthetic catalog itself (fixtures/qa-compute-catalog.ts: the simulator account, a
  // verified in-Kingdom region with `mock` evidence, a SAR price book, the allowed processor, an allowance and a residency policy for THIS organization; the vendor slots
  // that have no adapter in a dev stack are withdrawn so the first offer is the simulator's). A failed seed FAILS the test; it is never a silent skip.
  const L = loc(info);
  const go = (p: string) => page.goto(`/${L}${p}`);
  await setFlag(true);
  const orgId = await ownerOrg(page, info);
  const catalog = await seedMockComputeCatalog(orgId);
  expect(catalog.simulatorRegions).toBeGreaterThan(0);

  // UI-M05-01: a verified offer with a price in SAR
  await go('/compute/offers?geoGroup=in_kingdom');
  await expect(page.getByRole('table')).toBeVisible();
  await audit(page, info, 'compute-offers-list');
  await expect(page.locator('body')).not.toContainText(/alibaba|huawei|contabo/i); // provider identity never reaches customers
  await page
    .getByRole('link', { name: new RegExp(`^${T(info, 'm05.web.offers.use')}`) })
    .first()
    .click();

  // UI-M05-02: configurator, offer preselected -> an operating system from the offer's list -> name -> keys -> quote review
  await expect(
    page.getByRole('heading', { name: T(info, 'm05.web.wiz.step.configure') }),
  ).toBeVisible();
  const name = `e2e-${L}-${Date.now() % 100000}`;
  await page.getByLabel(T(info, 'field.name')).fill(name);
  await page.getByRole('radio', { name: /Ubuntu 22\.04/ }).check(); // the mock catalog publishes its images by name
  await page.getByRole('button', { name: T(info, 'action.next') }).click();
  await page.getByRole('button', { name: T(info, 'm05.web.wiz.getQuote') }).click();
  await expect(page.getByText(T(info, 'm05.web.quote.provisional'))).toBeVisible();
  await expect(
    page.getByRole('heading', { name: T(info, 'm05.web.quote.residency') }),
  ).toBeVisible();
  await audit(page, info, 'compute-wizard-review');
  await page.getByRole('button', { name: T(info, 'm05.web.wiz.confirm') }).click();

  // UI-M05-04: the instance page follows the operation to "running"; only supported actions are offered
  await expect(page).toHaveURL(/\/compute\/instances\/[0-9a-f-]{36}$/);
  await expect(page.getByText(T(info, 'm05.web.status.running'))).toBeVisible({ timeout: 90_000 });
  await audit(page, info, 'compute-instance-running');
  await expect(
    page.getByRole('heading', { name: T(info, 'm05.web.timeline.title') }),
  ).toBeVisible();
  const stop = page.getByRole('button', { name: T(info, 'm05.web.act.stop'), exact: true });
  if (await stop.count()) {
    await stop.click();
    await expect(page.getByText(T(info, 'm05.web.status.stopped'))).toBeVisible({
      timeout: 90_000,
    });
  }
  // UI-M05-05 / 06: unsupported capabilities are an empty state, supported ones render
  const base = page.url();
  await page.goto(`${base}/metrics`);
  await expect(
    page.getByText(T(info, 'm05.web.metrics.unsupported.title')).or(page.getByRole('region')),
  ).toBeVisible();
  await audit(page, info, 'compute-instance-metrics');
  await page.goto(`${base}/snapshots`);
  await expect(
    page
      .getByText(T(info, 'm05.web.snap.unsupported.title'))
      .or(page.getByRole('heading', { name: T(info, 'm05.web.snap.title') })),
  ).toBeVisible();
  await audit(page, info, 'compute-instance-snapshots');

  // list shows the instance; delete asks for confirmation first
  await go('/compute/instances');
  await expect(page.getByRole('link', { name })).toBeVisible();
  await audit(page, info, 'compute-instances-list');
  await page.getByRole('link', { name }).click();
  await page.getByRole('button', { name: T(info, 'm05.web.delete.start') }).click();
  await page.getByRole('button', { name: T(info, 'm05.web.delete.confirmBtn') }).click();
  await expect(page.getByText(T(info, 'm05.web.delete.accepted'))).toBeVisible();
});
