import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { T, audit, loc, signIn } from './helpers';

/**
 * Customer screens of M11: automation (UI-M11-01..05) and marketplace (UI-M11-06..09), Arabic and English projects.
 *
 * STATUS: NOT RUN. Written without running Playwright (the E2E ports and the local database belong to other sessions). No selector, timing or
 * seeded-data assumption below has been exercised; expect to adjust them on the first real run. The axe/screenshot step of `audit` is part of
 * the same NOT RUN status: no accessibility result or screenshot exists for these screens yet.
 *
 * Preconditions: runs after 01-customer (it uses that test's owner organization). The feature flags `automation.enabled`, `webhooks.enabled`
 * and `marketplace.enabled` are switched on through `platform.feature_flags` (global row), as 06/08 do for their flags. The workflow run needs the
 * API's operation worker to be active in the e2e stack; the marketplace purchase needs a residency decision that allows the seeded region and a
 * listing in an organization other than the buyer (seeded below as test data directly in the database; the artifact store is NOT seeded, so the
 * install step asserts "an install result is shown" rather than success). Nothing here touches a real provider or a real payment.
 */

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

async function flag(key: string, on: boolean) {
  await sql(`DELETE FROM platform.feature_flags WHERE key = $1 AND org_id IS NULL`, [key]);
  await sql(
    `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), $1, NULL, $2::jsonb)`,
    [key, on ? 'true' : 'false'],
  );
}

/** Test tooling: mark the session as recently MFA-verified (as 03/08 do) so step-up never interrupts the flow. */
async function elevate(email: string) {
  await sql(
    `UPDATE identity.sessions SET mfa_level = 'totp', mfa_verified_at = now() WHERE user_id = (SELECT id FROM identity.users WHERE email = $1)`,
    [email],
  );
}

async function owner(page: Page, info: TestInfo) {
  const L = loc(info);
  const email = `owner-${L}@example.test`;
  const org = (
    await sql<{ id: string; user_id: string }>(
      `SELECT m.org_id AS id, m.user_id FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id JOIN tenancy.organizations o ON o.id = m.org_id WHERE u.email = $1 AND o.type = 'customer' ORDER BY o.created_at LIMIT 1`,
      [email],
    )
  )[0];
  if (!org) throw new Error('run 01-customer first: no owner organization');
  await signIn(page, info, email);
  await elevate(email);
  return { email, ...org };
}

/** Poll a page until a condition shows (the operation runs in the background). */
const eventually = (page: Page, check: () => Promise<void>, timeout = 90_000) =>
  expect(async () => {
    await page.reload();
    await check();
  }).toPass({ timeout, intervals: [1500, 3000, 5000] });

test('automation: navigation, build a workflow, publish with errors, activate, run, inspect (UI-M11-01..03)', async ({
  page,
}, info) => {
  const L = loc(info);
  const go = (p: string) => page.goto(`/${L}${p}`);
  const nav = page.getByRole('navigation', { name: T(info, 'nav.primary') });
  await owner(page, info);

  // --- the entries are hidden while the flag is off, shown when it is on
  await flag('automation.enabled', false);
  await go('/');
  await expect(nav.getByRole('link', { name: T(info, 'm11.nav.workflows') })).toHaveCount(0);
  await go('/automation/workflows');
  await expect(page.getByText(T(info, 'm11.state.featureOff.title'))).toBeVisible();
  await flag('automation.enabled', true);
  await flag('webhooks.enabled', true);
  await go('/');
  await expect(nav.getByRole('link', { name: T(info, 'm11.nav.workflows') })).toBeVisible();

  // --- UI-M11-01: the list
  await go('/automation/workflows');
  await expect(
    page.getByRole('heading', { name: T(info, 'm11.wf.title'), level: 1 }),
  ).toBeVisible();
  await audit(page, info, 'm11-workflows');

  // --- UI-M11-02: create (canvas + JSON), the name is required
  await go('/automation/workflows/new');
  await page.getByRole('button', { name: T(info, 'm11.wf.new.publish') }).click();
  await expect(page.getByText(T(info, 'm11.wf.new.errName'))).toBeVisible();
  const name = `E2E flow ${L} ${Date.now()}`;
  await page.getByLabel(T(info, 'field.name'), { exact: true }).fill(name);
  // the canvas draws the starter definition as cards; selecting one opens its inspector
  await expect(
    page.getByRole('list', { name: T(info, 'm11.wf.canvas.steps') }).getByRole('button'),
  ).toHaveCount(2);
  await page
    .getByRole('list', { name: T(info, 'm11.wf.canvas.steps') })
    .getByRole('button')
    .first()
    .click();
  await expect(page.getByRole('region', { name: T(info, 'm11.wf.insp.title') })).toBeVisible();
  await audit(page, info, 'm11-workflow-new');
  await page.getByRole('button', { name: T(info, 'm11.wf.new.publish') }).click();
  await page.waitForURL(/\/automation\/workflows\/[0-9a-f-]{36}\/edit$/);
  const editUrl = page.url();

  // --- UI-M11-02: a definition the server refuses (a cycle): the 422 errors are shown inline, nothing is published
  await page.getByRole('button', { name: T(info, 'm11.wf.view.json') }).click();
  const cyc = {
    schemaVersion: 1,
    start: 'a',
    steps: [
      { id: 'a', type: 'delay', params: { seconds: 1 }, next: 'b' },
      { id: 'b', type: 'delay', params: { seconds: 1 }, next: 'a' },
    ],
  };
  await page.getByLabel(T(info, 'm11.wf.json.label')).fill(JSON.stringify(cyc, null, 2));
  await expect(page.getByText(/cycle/).first()).toBeVisible(); // the browser's own hint
  await page.getByRole('button', { name: T(info, 'm11.wf.publish.action') }).click();
  await expect(page.getByText(T(info, 'm11.issues.title'))).toBeVisible();
  await expect(page.getByRole('alert').getByText('cycle')).toBeVisible();
  await audit(page, info, 'm11-workflow-edit-422');

  // --- a valid new version from the canvas: add a step, publish
  await page.goto(editUrl);
  await page.getByRole('button', { name: T(info, 'm11.wf.add.action') }).click();
  await page.getByRole('button', { name: T(info, 'm11.wf.publish.action') }).click();
  await expect(page.getByText(T(info, 'm11.wf.publish.done', { version: 2 }))).toBeVisible();
  await page.getByRole('button', { name: T(info, 'm11.wf.status.activate') }).click();
  await expect(
    page.getByText(T(info, 'm11.wf.status.active'), { exact: true }).first(),
  ).toBeVisible();
  await audit(page, info, 'm11-workflow-edit');

  // --- run → UI-M11-03: the execution timeline; replay is shown but disabled with the SCR note
  await page.getByRole('button', { name: T(info, 'm11.run.action') }).click();
  await page.getByRole('link', { name: T(info, 'm11.run.open') }).click();
  await page.waitForURL(/\/automation\/executions\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: T(info, 'm11.exec.timeline') })).toBeVisible();
  await eventually(page, () =>
    expect(
      page.getByText(T(info, 'm11.exec.status.succeeded'), { exact: true }).first(),
    ).toBeVisible(),
  );
  await expect(page.getByText(T(info, 'm11.exec.dlqEmpty'))).toBeVisible();
  await audit(page, info, 'm11-execution');
  // another organization's execution id is "not found"
  await go(`/automation/executions/${crypto.randomUUID()}`);
  await expect(page.getByText(T(info, 'm11.state.notFound.title'))).toBeVisible();
});

test('automation: connectors authorize with a vault reference only; webhooks show the secret once (UI-M11-04..05)', async ({
  page,
}, info) => {
  const L = loc(info);
  const go = (p: string) => page.goto(`/${L}${p}`);
  const me = await owner(page, info);
  await flag('automation.enabled', true);
  await flag('webhooks.enabled', true);

  // --- UI-M11-04
  await go('/automation/connectors');
  await expect(
    page.getByRole('heading', { name: T(info, 'm11.cn.title'), level: 1 }),
  ).toBeVisible();
  const cname = `e2e-http-${L}-${Date.now()}`;
  await page.getByLabel(T(info, 'field.name'), { exact: true }).fill(cname);
  await page.getByLabel(T(info, 'm11.cn.hosts')).fill('api.example.com');
  await page.getByRole('button', { name: T(info, 'action.create') }).click();
  const row = page.getByRole('row').filter({ hasText: cname });
  await expect(row).toBeVisible();
  await audit(page, info, 'm11-connectors');
  await row.getByRole('button', { name: T(info, 'm11.cn.authorize') }).click();
  // a pasted secret is refused in the browser; only a reference of THIS organization goes through
  await page.getByLabel(T(info, 'm11.cn.vaultRef')).fill('sk_live_abcdefghijklmnop');
  await page.getByRole('button', { name: T(info, 'm11.cn.authorizeAction') }).click();
  await expect(page.getByText(T(info, 'm11.cn.errVaultRef', { org: me.id }))).toBeVisible();
  await page.getByLabel(T(info, 'm11.cn.vaultRef')).fill(`vault://kv/tenant-${me.id}-e2e`);
  await page.getByRole('button', { name: T(info, 'm11.cn.authorizeAction') }).click();
  await expect(
    page.getByRole('row').filter({ hasText: cname }).getByText(T(info, 'm11.cn.auth.active')),
  ).toBeVisible();

  // --- UI-M11-05
  await go('/settings/webhooks');
  await expect(
    page.getByRole('heading', { name: T(info, 'm11.wh.title'), level: 1 }),
  ).toBeVisible();
  await page.getByLabel(T(info, 'm11.wh.url')).fill('https://10.0.0.1/hook');
  await page.getByRole('button', { name: T(info, 'action.create') }).click();
  await expect(page.getByText(T(info, 'm11.err.ssrf'))).toBeVisible(); // a private address is refused
  const url = `https://example.com/e2e-${L}-${Date.now()}`;
  await page.getByLabel(T(info, 'm11.wh.url')).fill(url);
  await page.getByRole('button', { name: T(info, 'action.create') }).click();
  const secret = page.getByTestId('secret-value');
  await expect(secret).toContainText('whsec_');
  await audit(page, info, 'm11-webhooks-secret', [secret]);
  await page.getByRole('button', { name: T(info, 'm11.secret.stored') }).click();
  await expect(page.getByText('whsec_')).toHaveCount(0); // never shown again
  // rotate: a new secret, shown once
  await page
    .getByRole('row')
    .filter({ hasText: url })
    .getByRole('button', { name: T(info, 'm11.wh.rotate') })
    .click();
  await page.getByRole('button', { name: T(info, 'm11.wh.rotateAction') }).click();
  await expect(page.getByTestId('secret-value')).toContainText('whsec_');
  await page.getByRole('button', { name: T(info, 'm11.secret.stored') }).click();
  // deliveries and the test event are blocked until SCR-M11-02 is approved
  for (const k of ['m11.wh.viewDeliveries', 'm11.wh.testEvent'] as const)
    await expect(page.getByRole('button', { name: T(info, k) })).toBeDisabled();
  await expect(page.getByText(T(info, 'm11.wh.scr02')).first()).toBeVisible();
  await audit(page, info, 'm11-webhooks');
});

test('marketplace: browse, detail with VAT estimate, buy, invoice link, entitlement, install (UI-M11-06..09)', async ({
  page,
}, info) => {
  const L = loc(info);
  const go = (p: string) => page.goto(`/${L}${p}`);
  const buyer = await owner(page, info);
  await flag('automation.enabled', true);
  await flag('marketplace.enabled', true);

  // seed (test data): a verified publisher in ANOTHER organization with one approved workflow-template version
  const pubOrg = crypto.randomUUID();
  const publisher = crypto.randomUUID();
  const listing = crypto.randomUUID();
  const version = crypto.randomUUID();
  const title = `E2E template ${L} ${Date.now()}`;
  await sql(
    `INSERT INTO tenancy.organizations (id, name, slug, type, country, created_by) VALUES ($1,$2,$2,'customer','SA',$3)`,
    [pubOrg, `e2e-pub-${pubOrg.slice(0, 8)}`, buyer.user_id],
  );
  await sql(
    `INSERT INTO marketplace.publisher_accounts (id, org_id, status, verified_by, verified_at) VALUES ($1,$2,'verified',$3,now())`,
    [publisher, pubOrg, buyer.user_id],
  );
  await sql(
    `INSERT INTO marketplace.listings (id, org_id, publisher_id, type, title_ar, title_en, description_en, status, licence, seats, price_minor, currency, data_region, created_by)
     VALUES ($1,$2,$3,'workflow-template',$4,$4,'Seeded for the E2E run','published','single_org',1,4900,'SAR','sa-central',$5)`,
    [listing, pubOrg, publisher, title, buyer.user_id],
  );
  await sql(
    `INSERT INTO marketplace.listing_versions (id, org_id, listing_id, version, artifact_ref, content_hash, moderation_status, created_by)
     VALUES ($1,$2,$3,'1.0.0',$4,repeat('a',64),'approved',$5)`,
    [version, pubOrg, listing, `artifact://${pubOrg}/e2e.json`, buyer.user_id],
  );

  // --- UI-M11-06: browse and search
  await go('/marketplace');
  await expect(
    page.getByRole('heading', { name: T(info, 'm11.mkt.title'), level: 1 }),
  ).toBeVisible();
  await page.getByLabel(T(info, 'field.search')).fill(title);
  await page.getByRole('button', { name: T(info, 'action.search') }).click();
  await expect(page.getByRole('link', { name: title })).toBeVisible();
  await audit(page, info, 'm11-marketplace');
  await page.getByLabel(T(info, 'field.search')).fill('no-such-listing-xyz');
  await page.getByRole('button', { name: T(info, 'action.search') }).click();
  await expect(page.getByText(T(info, 'm11.mkt.emptyFiltered'))).toBeVisible();

  // --- UI-M11-07: detail, price + VAT estimate, quote then purchase
  await go(`/marketplace/listings/${listing}`);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.getByRole('button', { name: T(info, 'm11.buy.getQuote') }).click();
  await expect(page.getByText(T(info, 'm11.buy.vatNote')).first()).toBeVisible();
  await audit(page, info, 'm11-listing-quote');
  await page.getByRole('button', { name: T(info, 'm11.buy.confirm') }).click();
  // the licence is NOT active until the invoice is paid: the result links to the invoice and the existing pay screen
  await expect(page.getByText(T(info, 'm11.buy.pending'))).toBeVisible();
  await expect(page.getByRole('link', { name: T(info, 'm11.buy.payInvoice') })).toBeVisible();
  await audit(page, info, 'm11-listing-bought');

  // --- UI-M11-08: purchases list (from the entitlements), pending licence cannot be installed yet
  await go('/marketplace/purchases');
  await expect(page.getByRole('row').filter({ hasText: title })).toBeVisible();
  await expect(page.getByText(T(info, 'm11.inst.needsActive'))).toBeVisible();
  await audit(page, info, 'm11-purchases');
});

test('marketplace publisher: dashboard, accrual label, verification-pending state (UI-M11-09)', async ({
  page,
}, info) => {
  const L = loc(info);
  const go = (p: string) => page.goto(`/${L}${p}`);
  await owner(page, info);
  await flag('marketplace.enabled', true);
  await go('/marketplace/publisher');
  await expect(
    page.getByRole('heading', { name: T(info, 'm11.pub.title'), level: 1 }),
  ).toBeVisible();
  // revenue is labelled "accrued, not paid out"
  await expect(page.getByText(T(info, 'm11.pub.accrual.label'))).toBeVisible();
  await expect(page.getByText(T(info, 'm11.pub.accrual.note'))).toBeVisible();
  // an unverified organization gets the verification-pending state on create (403 publisher_not_verified)
  await page.getByLabel(T(info, 'm11.pub.titleAr')).fill('قالب اختبار');
  await page.getByLabel(T(info, 'm11.pub.titleEn')).fill('Test template');
  await page.getByLabel(T(info, 'm11.pub.price'), { exact: true }).fill('10.00');
  await page.getByRole('button', { name: T(info, 'action.create') }).click();
  await expect(page.getByText(T(info, 'm11.pub.pending.title'))).toBeVisible();
  await audit(page, info, 'm11-publisher-pending');
});
