import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { T, audit, loc, signIn, expectActiveOrg } from './helpers';
import { ADMIN, DB_URL as DB } from './env';
import { resetDatabase } from './reset';

test.beforeAll(resetDatabase);

/**
 * Managed data and email screens (UI-M08-01..14), customer console, Arabic and English projects.
 *
 * STATUS: NOT RUN (written without running Playwright: the ports and the local database were in use by another session).
 *
 * Preconditions of the provider-dependent flows (database, bucket, domain): the e2e API is started with `DATA_LOCAL_REFERENCE=true`
 * (dev-reference `mock-*` adapters; never in production) and DATA_KICK/worker settings that complete operations. Without it the same
 * screens are still checked in their "not available" state (422 `unsupported_capability`) and the provider-dependent flows are skipped
 * explicitly. Everything shown here is a simulated dev reference: NOT VERIFIED against any real provider.
 *
 * Runs after 01..05: it uses the owner organization created by the customer test and the MFA enrolment of the staff users.
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

/** Test tooling: mark the session as recently MFA-verified (as 03-billing does) so step-up never interrupts the flow. */
async function elevate(email: string) {
  await sql(
    `UPDATE identity.sessions SET mfa_level = 'totp', mfa_verified_at = now() WHERE user_id = (SELECT id FROM identity.users WHERE email = $1)`,
    [email],
  );
}

/** A non-placeholder price book with the M08 meters (test fixture: the real price list is HG-02-01). Created once per database. */
async function seedM08Prices() {
  if ((await sql(`SELECT 1 FROM billing.price_books WHERE name = 'e2e-m08'`)).length > 0) return;
  const publisher = '00000000-0000-0000-0000-000000000001';
  const book = crypto.randomUUID();
  const version = crypto.randomUUID();
  const items: [string, string][] = [
    ['database.instance_hours', '1.00000000'],
    ['cache.instance_hours', '0.50000000'],
    ['database.storage_gb_months', '10.00000000'],
    ['database.backup_gb_months', '5.00000000'],
    ['storage.object_gb_months', '8.00000000'],
    ['email.transactional_messages', '0.10000000'],
    ['email.mailbox_months', '500.00000000'],
    ['email.mailbox_storage_gb_months', '1.00000000'],
  ];
  await sql(
    `INSERT INTO billing.price_books (id, name, currency, placeholder) VALUES ($1,'e2e-m08','SAR',false)`,
    [book],
  );
  await sql(
    `INSERT INTO billing.price_book_versions (id, price_book_id, version, status, effective_from) VALUES ($1,$2,1,'draft','2026-01-01T00:00:00Z')`,
    [version, book],
  );
  for (const [meter, price] of items)
    await sql(
      `INSERT INTO billing.price_items (id, version_id, meter_id, tier_model, unit_price_minor) VALUES (gen_random_uuid(),$1,$2,'flat',$3)`,
      [version, meter, price],
    );
  // rating uses the newest non-placeholder book: carry the prices of the earlier published books so the other screens keep quoting
  await sql(
    `INSERT INTO billing.price_items (id, version_id, meter_id, tier_model, unit_price_minor, tiers, included_allowance, rounding)
     SELECT DISTINCT ON (i.meter_id) gen_random_uuid(), $1, i.meter_id, i.tier_model, i.unit_price_minor, i.tiers, i.included_allowance, i.rounding
       FROM billing.price_items i
       JOIN billing.price_book_versions v ON v.id = i.version_id AND v.status = 'published'
      WHERE i.version_id <> $1 AND i.meter_id NOT IN (SELECT meter_id FROM billing.price_items WHERE version_id = $1)
      ORDER BY i.meter_id, v.effective_from DESC`,
    [version],
  );
  await sql(
    `UPDATE billing.price_book_versions SET status = 'published', published_by = $2, published_at = now() WHERE id = $1`,
    [version, publisher],
  );
}

const PROVIDERS: { service: string; code: string; config: Record<string, unknown> }[] = [
  {
    service: 'database',
    code: 'mock-database',
    config: { defaultRegion: 'sa-central', versions: { postgresql: ['16'], mysql: ['8.4'] } },
  },
  {
    service: 'object-storage',
    code: 'mock-object-storage',
    config: { defaultRegion: 'sa-central' },
  },
  {
    service: 'transactional-email',
    code: 'mock-transactional-email',
    config: { processingRegion: 'sa-central' }, // the dev-reference sender "processes" in-Kingdom, like the mailbox one: an unstated region is never allowed
  },
  { service: 'mailbox', code: 'mock-mailbox', config: { processingRegion: 'sa-central' } },
];

/**
 * Enable the local dev-reference providers through the admin API (the path an operator uses: configure, probe, request, enable).
 * Returns false when the API was not started with DATA_LOCAL_REFERENCE=true (the adapters are then not registered and enabling is refused).
 */
async function enableLocalProviders(browser: Browser, info: TestInfo): Promise<boolean> {
  const L = loc(info);
  const staff = `staff-${L}@example.test`;
  const ctx = await browser.newContext({ locale: info.project.use.locale });
  try {
    const page = await ctx.newPage();
    await signIn(page, info, staff, ADMIN);
    await elevate(staff);
    const csrf = (await ctx.cookies(ADMIN)).find((c) => c.name === 'nuzm_admin_csrf')?.value ?? '';
    const headers = { 'x-csrf-token': csrf, 'x-nuzm-realm': 'admin' };
    const post = (data: Record<string, unknown>) =>
      page.request.post(`${ADMIN}/v1/admin/data-providers`, { data, headers });
    const list = async () =>
      (
        (await (
          await page.request.get(`${ADMIN}/v1/admin/data-providers`, { headers })
        ).json()) as { items: { id: string; providerCode: string; enabled: boolean }[] }
      ).items;
    for (const p of PROVIDERS) {
      let row = (await list()).find((r) => r.providerCode === p.code);
      if (row?.enabled) continue;
      if (!row) {
        const c = await post({
          action: 'configure',
          service: p.service,
          family: `self-operated-${p.code.replace(/^mock-/, '')}`,
          providerCode: p.code,
          environment: 'local',
          config: { credentialRef: 'vault://mock/acct', ...p.config },
        });
        if (c.status() !== 200) return false;
        row = (await c.json()) as { id: string; providerCode: string; enabled: boolean };
      }
      for (const body of [
        { action: 'probe', id: row.id },
        {
          action: 'request_enable',
          id: row.id,
          evidenceRef: 'LOCAL-REFERENCE-NOT-VERIFIED',
          verifiedAt: new Date().toISOString(),
        },
        { action: 'enable', id: row.id },
      ])
        if ((await post(body)).status() !== 200) return false;
    }
    return true;
  } finally {
    await ctx.close();
  }
}

/** Test tooling: take every provider out of service (as the admin "disable" action does) so the "not available" state is what the screens show first. */
async function disableProviders() {
  await sql(
    `UPDATE data.data_providers SET enabled = false, enabled_at = NULL, requested_by = NULL, approved_by = NULL, version = version + 1 WHERE enabled`,
  );
}

async function ownerOrg(page: Page, info: TestInfo, email: string) {
  const L = loc(info);
  await signIn(page, info, email);
  const org = (
    await sql<{ id: string }>(
      `SELECT m.org_id AS id FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`,
      [email],
    )
  )[0];
  if (!org) {
    await page.goto(`/${L}/orgs/new`);
    await page.getByLabel(T(info, 'field.name'), { exact: true }).fill(`M08 ${L}`);
    await page.getByRole('button', { name: T(info, 'action.create') }).click();
    await expectActiveOrg(page, info, `M08 ${L}`);
  }
  await elevate(email);
}

/** Poll a page until a condition shows (the operation runs in the background). */
const eventually = (page: Page, check: () => Promise<void>, timeout = 90_000) =>
  expect(async () => {
    await page.reload();
    await check();
  }).toPass({ timeout, intervals: [1500, 3000, 5000] });

test('managed data: databases and buckets (UI-M08-01..07)', async ({ page, browser }, info) => {
  const L = loc(info);
  const email = `owner-${L}@example.test`;
  const go = (p: string) => page.goto(`/${L}${p}`);
  const dbName = `orders-${L}`;
  const restored = `orders-copy-${L}`;
  const bucket = `files-${L}`;

  await ownerOrg(page, info, email);
  await seedM08Prices();

  // --- navigation entries for the owner
  await go('/databases');
  const nav = page.getByRole('navigation', { name: T(info, 'nc.nav.rail') });
  // the rail offers the Data and Email categories (databases and storage are the Data category's tabs)
  for (const k of ['nc.cat.data', 'nc.cat.email'] as const)
    await expect(nav.getByRole('link', { name: T(info, k) })).toBeVisible();

  // --- UI-M08-01: empty list
  await expect(page.getByRole('heading', { name: T(info, 'm8.db.title'), level: 1 })).toBeVisible();
  await expect(page.getByText(T(info, 'm8.db.empty'))).toBeVisible();
  await audit(page, info, 'm8-databases-empty');

  // --- UI-M08-02: with no provider enabled the offer is refused with a plain message and the estimate button is greyed out with the reason
  await go('/databases/new');
  await page.getByLabel(T(info, 'field.name'), { exact: true }).fill(dbName);
  await page.getByLabel(T(info, 'm8.db.col.version'), { exact: true }).fill('16');
  await page.getByLabel(T(info, 'm8.dbn.plan'), { exact: true }).fill('mock-db-s');
  // an allow-list that opens the database to the whole internet never leaves the browser
  await page.getByLabel(T(info, 'm8.dbn.network')).selectOption('allowlist');
  await page.getByLabel(T(info, 'm8.dbn.cidrs')).fill('0.0.0.0/0');
  await page.getByRole('button', { name: T(info, 'm8.q.request') }).click();
  await expect(page.getByText(T(info, 'm8.dbn.err.open'))).toBeVisible();
  await page.getByLabel(T(info, 'm8.dbn.network')).selectOption('private');

  // the service refuses the offer: a plain message, the estimate button greyed out WITH the reason (nothing is faked)
  await disableProviders();
  await page.getByRole('button', { name: T(info, 'm8.q.request') }).click();
  await expect(
    page.getByText(T(info, 'm8.err.unsupported'), { exact: false }).first(),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: T(info, 'm8.q.request') })).toBeDisabled();
  await expect(page.getByText(T(info, 'm8.dbn.greyed'))).toBeVisible();
  await audit(page, info, 'm8-database-new-unavailable');

  const ready = await enableLocalProviders(browser, info);
  test.skip(
    !ready,
    'the e2e API has no dev-reference providers (start it with DATA_LOCAL_REFERENCE=true): provider-dependent flows skipped',
  );

  // --- UI-M08-02: estimate → residency + price → confirm
  await go('/databases/new');
  await page.getByLabel(T(info, 'field.name'), { exact: true }).fill(dbName);
  await page.getByLabel(T(info, 'm8.db.col.version'), { exact: true }).fill('16');
  await page.getByLabel(T(info, 'm8.dbn.plan'), { exact: true }).fill('mock-db-s');
  await page.getByRole('button', { name: T(info, 'm8.q.request') }).click();
  await expect(page.getByText(T(info, 'm8.q.residencyOk'))).toBeVisible();
  await audit(page, info, 'm8-database-new-quote');
  // changing an option invalidates the estimate
  await page.getByLabel(T(info, 'm8.dbn.storage')).fill('30');
  await expect(page.getByText(T(info, 'm8.q.changed'))).toBeVisible();
  await expect(page.getByRole('button', { name: T(info, 'm8.q.confirm') })).toBeDisabled();
  await page.getByRole('button', { name: T(info, 'm8.q.request') }).click();
  await page.getByRole('button', { name: T(info, 'm8.q.confirm') }).click();

  // --- UI-M08-03: detail: provisioning banner first, then running; the secret is only a reference and the reveal is disabled
  await page.waitForURL(/\/databases\/[0-9a-f-]{36}$/);
  const detailUrl = page.url();
  await eventually(page, () =>
    expect(page.getByText(T(info, 'm8.db.status.running'), { exact: true }).first()).toBeVisible(),
  );
  await expect(page.getByText('vault://').first()).toBeVisible();
  await expect(page.getByRole('button', { name: T(info, 'm8.dbd.reveal') })).toBeDisabled();
  await expect(page.getByText(T(info, 'm8.dbd.revealPending'))).toBeVisible();
  await audit(page, info, 'm8-database-detail');

  // --- UI-M08-04: manual backup → available; restore to a NEW database (the default)
  await page.goto(`${detailUrl}/backups`);
  await expect(page.getByText(T(info, 'm8.bk.empty'))).toBeVisible();
  await audit(page, info, 'm8-database-backups-empty');
  await page.getByRole('button', { name: T(info, 'm8.bk.create') }).click();
  await expect(page.getByText(T(info, 'm8.bk.created'))).toBeVisible();
  await eventually(page, () =>
    expect(page.getByRole('cell', { name: T(info, 'm8.bk.state.available') })).toBeVisible(),
  );
  await page
    .getByRole('button', { name: T(info, 'm8.bk.restore'), exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(T(info, 'm8.rd.newHelp'))).toBeVisible();
  await audit(page, info, 'm8-database-restore-dialog');
  // the in-place option sits behind its own confirmation: name + tick are both required
  await dialog.getByRole('button', { name: T(info, 'm8.rd.switchInPlace') }).click();
  const overwrite = dialog.getByRole('button', { name: T(info, 'm8.rd.submitInPlace') });
  await expect(overwrite).toBeDisabled();
  await dialog.getByLabel(T(info, 'm8.rd.typeName', { name: dbName })).fill(dbName);
  await expect(overwrite).toBeDisabled();
  await dialog.getByLabel(T(info, 'm8.rd.ack')).check();
  await expect(overwrite).toBeEnabled();
  await dialog.getByRole('button', { name: T(info, 'm8.rd.switchNew') }).click();
  await dialog.getByLabel(T(info, 'm8.rd.newName')).fill(restored);
  await dialog.getByRole('button', { name: T(info, 'm8.rd.submitNew') }).click();
  await expect(page.getByText(T(info, 'm8.rd.accepted'))).toBeVisible();
  await eventually(page, () =>
    expect(page.getByText(T(info, 'm8.rs.state.succeeded'), { exact: true }).first()).toBeVisible(),
  );
  await expect(page.getByText(T(info, 'm8.bk.verified')).first()).toBeVisible();
  await audit(page, info, 'm8-database-backups');

  // --- UI-M08-05: settings: backup policy (If-Match), rotation, delete with the name typed
  await page.goto(`${detailUrl}/settings`);
  await page.getByLabel(T(info, 'm8.dbs.retention')).fill('14');
  await page.getByRole('button', { name: T(info, 'action.save') }).click();
  await expect(page.getByText(T(info, 'm8.dbs.policySaved'))).toBeVisible();
  await audit(page, info, 'm8-database-settings');
  const del = page.getByRole('button', { name: T(info, 'm8.dbs.deleteAction') });
  await expect(del).toBeDisabled();
  await page.getByLabel(T(info, 'm8.dbs.typeName', { name: dbName })).fill(dbName);
  await del.click();
  await page.waitForURL(/\/databases$/);
  // the restored copy is a database of its own
  await expect(page.getByRole('link', { name: restored })).toBeVisible();
  await audit(page, info, 'm8-databases-list');

  // --- UI-M08-06/07: buckets
  await go('/storage/buckets');
  await expect(page.getByText(T(info, 'm8.st.empty'))).toBeVisible();
  await audit(page, info, 'm8-buckets-empty');
  await go('/storage/buckets/new');
  await page.getByLabel(T(info, 'field.name'), { exact: true }).fill(bucket);
  await page.getByLabel(T(info, 'm8.stn.estimatedGb')).fill('5');
  await page.getByRole('button', { name: T(info, 'm8.q.request') }).click();
  await expect(page.getByText(T(info, 'm8.q.residencyOk'))).toBeVisible();
  await page.getByRole('button', { name: T(info, 'm8.q.confirm') }).click();
  await page.waitForURL(/\/storage\/buckets\/[0-9a-f-]{36}$/);
  await eventually(page, () =>
    expect(page.getByRole('heading', { name: T(info, 'm8.stb.policy') })).toBeVisible(),
  );
  await expect(page.getByText(T(info, 'm8.stb.publicBanner'))).toHaveCount(0); // private by default
  await expect(page.getByRole('button', { name: T(info, 'm8.dbd.reveal') })).toBeDisabled();
  await audit(page, info, 'm8-bucket-detail');

  // policy: public-read goes through the warning and the explicit confirmation
  await page.getByLabel(T(info, 'm8.stb.access')).selectOption('public-read');
  await page.getByRole('button', { name: T(info, 'm8.stb.savePolicy') }).click();
  const warn = page.getByRole('dialog');
  await expect(warn.getByText(T(info, 'm8.stb.publicTitle'))).toBeVisible();
  await expect(warn.getByRole('button', { name: T(info, 'm8.stb.publicConfirm') })).toBeDisabled();
  await audit(page, info, 'm8-bucket-public-warning');
  await warn.getByLabel(T(info, 'm8.stb.publicAck')).check();
  await warn.getByRole('button', { name: T(info, 'm8.stb.publicConfirm') }).click();
  await expect(page.getByText(T(info, 'm8.stb.publicBanner')).first()).toBeVisible();
  await audit(page, info, 'm8-bucket-public');
  // back to private: the banner goes away
  await page.getByLabel(T(info, 'm8.stb.access')).selectOption('private');
  await page.getByRole('button', { name: T(info, 'm8.stb.savePolicy') }).click();
  await expect(page.getByText(T(info, 'm8.stb.policySaved'))).toBeVisible();
  await page.reload();
  await expect(page.getByText(T(info, 'm8.stb.publicBanner'))).toHaveCount(0);

  // signed URL: shown once, copyable, never persisted (gone after a reload); masked in the stored screenshot
  await page.getByLabel(T(info, 'm8.stb.su.key')).fill('docs/readme.txt');
  await page.getByRole('button', { name: T(info, 'm8.stb.su.create') }).click();
  const url = page.getByTestId('signed-url');
  await expect(url).toBeVisible();
  await expect(page.getByRole('button', { name: T(info, 'm8.stb.su.copy') })).toBeVisible();
  await audit(page, info, 'm8-bucket-signed-url', [url]);
  await page.reload();
  await expect(page.getByTestId('signed-url')).toHaveCount(0);

  // delete: type the name
  await page.getByLabel(T(info, 'm8.stb.typeName', { name: bucket })).fill(bucket);
  await page.getByRole('button', { name: T(info, 'm8.stb.deleteAction') }).click();
  await page.waitForURL(/\/storage\/buckets$/);
});

test('email: domains, senders, templates, suppressions (UI-M08-08..14)', async ({
  page,
  browser,
}, info) => {
  const L = loc(info);
  const email = `owner-${L}@example.test`;
  const go = (p: string) => page.goto(`/${L}${p}`);
  const domain = `mail-${L}.example.com`;

  await ownerOrg(page, info, email);

  // --- UI-M08-08: empty list and the add form
  await go('/email/domains');
  await expect(page.getByText(T(info, 'm8.emd.empty'))).toBeVisible();
  await audit(page, info, 'm8-email-domains-empty');

  // without a provider the answer is a plain "not available" (422 unsupported_capability), never a fake domain
  await disableProviders();
  await page.getByLabel(T(info, 'm8.emd.domain'), { exact: true }).fill(domain);
  await page.getByRole('button', { name: T(info, 'm8.emd.addAction') }).click();
  await expect(
    page.getByText(T(info, 'm8.err.unsupported'), { exact: false }).first(),
  ).toBeVisible();
  await audit(page, info, 'm8-email-domains-unavailable');

  if (await enableLocalProviders(browser, info)) {
    // --- UI-M08-09: required records, per-record status, copy, DMARC, manual instructions, re-check
    await go('/email/domains');
    await page.getByLabel(T(info, 'm8.emd.domain'), { exact: true }).fill(domain);
    await page.getByRole('button', { name: T(info, 'm8.emd.addAction') }).click();
    await page.waitForURL(/\/email\/domains\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: domain, level: 1 })).toBeVisible();
    await expect(
      page
        .getByRole('table', { name: T(info, 'm8.emd.records') })
        .getByRole('row')
        .nth(1),
    ).toBeVisible();
    await expect(page.getByText(T(info, 'm8.emd.manual'))).toBeVisible(); // not a Nuzm DNS zone: no automatic apply
    await expect(page.getByRole('button', { name: T(info, 'm8.emd.apply') })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: T(info, 'm8.emd.dmarc') })).toBeVisible();
    await expect(page.getByRole('button', { name: T(info, 'action.copy') }).first()).toBeVisible();
    await page.getByRole('button', { name: T(info, 'm8.emd.recheck') }).click();
    await expect(page.getByText(T(info, 'm8.emd.rechecked'))).toBeVisible();
    // nothing was published in DNS: the domain is not verified and says so
    await expect(
      page.getByText(T(info, 'm8.emd.state.pending'), { exact: true }).first(),
    ).toBeVisible();
    await audit(page, info, 'm8-email-domain');

    // --- UI-M08-10 / 11 / 13 depend on a verified domain: the screens explain what is missing
    await go('/email/mailboxes');
    await expect(page.getByText(T(info, 'm8.mb.noDomains'))).toBeVisible();
    await audit(page, info, 'm8-email-mailboxes');
    await go('/email/senders');
    await page.getByLabel(T(info, 'm8.sn.from')).fill(`noreply@${domain}`);
    await page.getByRole('button', { name: T(info, 'm8.sn.add') }).click();
    await expect(page.getByText(T(info, 'm8.sn.created'))).toBeVisible();
    await expect(page.getByRole('cell', { name: T(info, 'm8.sn.status.pending') })).toBeVisible();
    await audit(page, info, 'm8-email-senders');
    await go('/email/messages');
    await expect(page.getByText(T(info, 'm8.ms.noSender'))).toBeVisible();
    await expect(page.getByText(T(info, 'm8.ms.empty'))).toBeVisible();
    await audit(page, info, 'm8-email-messages');
  }

  // --- UI-M08-12: templates (no provider needed): live sandboxed preview in the template's direction; saving creates versions
  await go('/email/templates');
  await expect(page.getByRole('heading', { name: T(info, 'm8.tp.editor') })).toBeVisible();
  await page.getByLabel(T(info, 'm8.tp.key')).fill(`welcome-${L}`);
  await page.getByLabel(T(info, 'field.name'), { exact: true }).fill('Welcome');
  await page.getByLabel(T(info, 'field.locale')).selectOption('ar');
  await page.getByLabel(T(info, 'm8.tp.subject')).fill('مرحبًا {{name}}');
  await page
    .getByLabel(T(info, 'm8.tp.html'), { exact: true })
    .fill('<p>أهلًا {{name}}</p><script>alert(1)</script>');
  const frame = page.locator('iframe[sandbox=""]');
  await expect(frame).toHaveAttribute('sandbox', '');
  const body = page.frameLocator('iframe[sandbox=""]').locator('body');
  await expect(body).toContainText('أهلًا');
  await expect(page.frameLocator('iframe[sandbox=""]').locator('html')).toHaveAttribute(
    'dir',
    'rtl',
  );
  await expect(page.getByText(T(info, 'm8.tp.rtl'), { exact: true })).toBeVisible();
  await page.getByLabel(T(info, 'field.locale')).selectOption('en');
  await expect(page.frameLocator('iframe[sandbox=""]').locator('html')).toHaveAttribute(
    'dir',
    'ltr',
  );
  await page.getByLabel(T(info, 'field.locale')).selectOption('ar');
  // the detected {{name}} placeholder is declared as a variable
  await expect(page.getByLabel(T(info, 'm8.tp.varType', { name: 'name' }))).toBeVisible();
  // the preview frame is sandboxed without scripts (axe cannot run inside it) and shows the customer's own email HTML, not the console's UI: the editor around it is audited
  await audit(page, info, 'm8-email-template-editor', [], ['iframe[sandbox=""]']);
  await page.getByRole('button', { name: T(info, 'm8.tp.save') }).click();
  await expect(page.getByText(T(info, 'm8.tp.saved', { version: 1 }))).toBeVisible();
  // the sanitized html the API returned is previewed: the script is gone
  await expect(page.getByText(T(info, 'm8.tp.previewSaved'))).toBeVisible();
  await expect(body).not.toContainText('alert(1)');
  // a second save is the next version of the same key
  await page.getByLabel(T(info, 'm8.tp.subject')).fill('مرحبًا مجددًا {{name}}');
  await page.getByRole('button', { name: T(info, 'm8.tp.save') }).click();
  await expect(page.getByText(T(info, 'm8.tp.saved', { version: 2 }))).toBeVisible();
  await go('/email/templates');
  await expect(page.getByRole('cell', { name: `welcome-${L} v2` })).toBeVisible();
  await expect(page.getByRole('cell', { name: `welcome-${L} v1` })).toBeVisible();
  await audit(page, info, 'm8-email-templates');

  // --- UI-M08-14: suppressions: add manually, remove (a manual one needs no override)
  await go('/email/suppressions');
  await expect(page.getByText(T(info, 'm8.su.empty'))).toBeVisible();
  const address = `blocked-${L}@example.com`;
  await page.getByLabel(T(info, 'm8.su.address')).fill(address);
  await page.getByRole('button', { name: T(info, 'm8.su.addAction') }).click();
  await expect(page.getByText(T(info, 'm8.su.added'))).toBeVisible();
  await expect(page.getByRole('cell', { name: address, exact: true })).toBeVisible();
  await audit(page, info, 'm8-email-suppressions');
  await page.getByRole('button', { name: T(info, 'm8.su.removeFor', { address }) }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel(T(info, 'm8.su.override'))).toHaveCount(0); // not a protective reason
  await audit(page, info, 'm8-email-suppression-remove');
  await dialog.getByRole('button', { name: T(info, 'm8.su.removeAction') }).click();
  await expect(page.getByRole('cell', { name: address, exact: true })).toHaveCount(0);
});
