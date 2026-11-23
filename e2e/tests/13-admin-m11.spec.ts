import { expect, test } from '@playwright/test';
import { Client } from 'pg';
import { T, audit, loc, signIn } from './helpers';
import { ADMIN, DB_URL as DB } from './env';
import { resetDatabase } from './reset';

test.beforeAll(resetDatabase);

/**
 * Admin console screens of M11 (UI-M11-20..22), Arabic and English projects.
 *
 * STATUS: NOT RUN. Written without running Playwright (the E2E ports and the local database belong to other sessions). No selector or data
 * assumption has been exercised; the axe/screenshot step of `audit` is part of the same NOT RUN status.
 *
 * The three screens are honest BLOCKED states (the list routes are SCR-M11-05, not approved) except for what the API supports: the moderation
 * DECISION form, and the organizations list filtered to agencies and resellers. The decision is exercised against a listing seeded directly in the
 * database (a version that is `pending`); a wrong id and a stale decision are asserted too.
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

test('admin: moderation decision, programs oversight, automation abuse (UI-M11-20..22)', async ({
  page,
}, info) => {
  const L = loc(info);
  const staff = `staff-${L}@example.test`;
  await signIn(page, info, staff, ADMIN);
  await sql(
    `UPDATE identity.sessions SET mfa_level = 'totp', mfa_verified_at = now() WHERE user_id = (SELECT id FROM identity.users WHERE email = $1)`,
    [staff],
  );
  const nav = page.getByRole('navigation', { name: T(info, 'nc.nav.side') }); // the section navigation lists the items of the current category

  // seed (test data): a publisher org, a listing and one PENDING version with its moderation case
  const staffId = (
    await sql<{ id: string }>(`SELECT id FROM identity.users WHERE email = $1`, [staff])
  )[0]!.id;
  const org = crypto.randomUUID();
  const publisher = crypto.randomUUID();
  const listing = crypto.randomUUID();
  const version = crypto.randomUUID();
  await sql(
    `INSERT INTO tenancy.organizations (id, name, slug, type, country, created_by) VALUES ($1,$2,$2,'customer','SA',$3)`,
    [org, `e2e-mod-${org.slice(0, 8)}`, staffId],
  );
  await sql(
    `INSERT INTO marketplace.publisher_accounts (id, org_id, status, verified_by, verified_at) VALUES ($1,$2,'verified',$3,now())`,
    [publisher, org, staffId],
  );
  await sql(
    `INSERT INTO marketplace.listings (id, org_id, publisher_id, type, title_ar, title_en, status, licence, seats, price_minor, currency, data_region, created_by) VALUES ($1,$2,$3,'workflow-template','قالب','Template','draft','single_org',1,1000,'SAR','sa-central',$4)`,
    [listing, org, publisher, staffId],
  );
  await sql(
    `INSERT INTO marketplace.listing_versions (id, org_id, listing_id, version, artifact_ref, content_hash, moderation_status, created_by) VALUES ($1,$2,$3,'1.0.0',$4,repeat('b',64),'pending',$5)`,
    [version, org, listing, `artifact://${org}/a.json`, staffId],
  );
  await sql(
    `INSERT INTO marketplace.moderation_cases (id, org_id, listing_id, listing_version_id, scan_results, scan_verdict) VALUES (gen_random_uuid(),$1,$2,$3,'{}'::jsonb,'clean')`,
    [org, listing, version],
  );

  // --- UI-M11-20: the queue is BLOCKED; the decision form works
  await page.goto(`${ADMIN}/${L}/marketplace/moderation`);
  await expect(nav.getByRole('link', { name: T(info, 'm11.nav.admin.moderation') })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: T(info, 'm11.adm.mod.title'), level: 1 }),
  ).toBeVisible();
  await expect(page.getByText('BLOCKED')).toBeVisible();
  await expect(page.getByText(T(info, 'm11.adm.mod.queueBlocked'))).toBeVisible();
  await audit(page, info, 'm11-admin-moderation');
  // validation first
  await page.getByRole('button', { name: T(info, 'm11.adm.mod.submit.approve') }).click();
  await expect(page.getByText(T(info, 'm11.adm.mod.err.listing'))).toBeVisible();
  await expect(page.getByText(T(info, 'm11.adm.mod.err.reason'))).toBeVisible();
  // an unknown listing is "not found"
  await page.getByLabel(T(info, 'm11.adm.mod.listingId')).fill(crypto.randomUUID());
  await page.getByLabel(T(info, 'm11.adm.mod.reason'), { exact: true }).fill('reviewed_ok');
  await page.getByRole('button', { name: T(info, 'm11.adm.mod.submit.approve') }).click();
  await expect(page.getByText(T(info, 'm11.adm.mod.notFound'))).toBeVisible();
  // the real one is approved
  await page.getByLabel(T(info, 'm11.adm.mod.listingId')).fill(listing);
  await page.getByRole('button', { name: T(info, 'm11.adm.mod.submit.approve') }).click();
  await expect(
    page.getByText(
      T(info, 'm11.adm.mod.done', { decision: T(info, 'm11.adm.mod.decision.approve') }),
    ),
  ).toBeVisible();
  await expect(page.getByText(T(info, 'm11.pub.mod.approved'), { exact: true })).toBeVisible();
  await audit(page, info, 'm11-admin-moderation-done');
  // deciding again on a version that is no longer pending is stale (409)
  await page.getByRole('button', { name: T(info, 'm11.adm.mod.submit.approve') }).click();
  await expect(page.getByText(T(info, 'm11.adm.mod.stale'))).toBeVisible();

  // --- UI-M11-21: programs oversight is BLOCKED; the agency/reseller organizations list is real
  await page.goto(`${ADMIN}/${L}/programs`);
  await expect(
    page.getByRole('heading', { name: T(info, 'm11.adm.prog.title'), level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(T(info, 'm11.adm.prog.oversightBlocked'))).toBeVisible();
  await audit(page, info, 'm11-admin-programs');

  // --- UI-M11-22: automation abuse is BLOCKED in all three parts
  await page.goto(`${ADMIN}/${L}/automation/abuse`);
  await expect(
    page.getByRole('heading', { name: T(info, 'm11.adm.abuse.title'), level: 1 }),
  ).toBeVisible();
  await expect(page.getByText('BLOCKED')).toHaveCount(3);
  await audit(page, info, 'm11-admin-abuse');
});
