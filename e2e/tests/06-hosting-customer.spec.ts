import { expect, test } from '@playwright/test';
import { Client } from 'pg';
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

/**
 * Customer hosting screens UI-M06-01, 03, 04, 05, 06, 07, 08, 09 (read-only; creation wizard UI-M06-02 and settings UI-M06-10 are NOT BUILT).
 * Runs after 01-customer (it uses that test's owner organization). STATUS: written, NOT RUN (the E2E ports belong to another session; see the M06 report).
 */
test('customer hosting: plans, sites, site overview, domains, TLS, databases, backups, usage (ar/en, axe, states)', async ({
  page,
}, info) => {
  const L = loc(info);
  const owner = `owner-${L}@example.test`;
  const org = (
    await sql<{ id: string; user_id: string }>(
      `SELECT m.org_id AS id, m.user_id FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`,
      [owner],
    )
  )[0];
  if (!org) throw new Error('run 01-customer first: no owner organization');
  await sql(
    `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'hosting.enabled', NULL, 'true') ON CONFLICT DO NOTHING`,
  );
  await signIn(page, info, owner);
  const base = `http://127.0.0.1:3000/${L}/hosting`;

  // empty states first: no node, no plan, no site
  await page.goto(`${base}/plans`);
  await expect(page.getByRole('heading', { name: T(info, 'host.title.plans') })).toBeVisible();
  await expect(page.getByText(T(info, 'host.none.plans'))).toBeVisible();
  await audit(page, info, 'hosting-plans-empty');
  await page.goto(`${base}/sites`);
  await expect(page.getByText(T(info, 'host.none.sites'))).toBeVisible();
  await audit(page, info, 'hosting-sites-empty');

  // seed: an active node with capacity, one plan, one site in creation (a real node/agent is not available: HG-06-01)
  const node = crypto.randomUUID();
  const plan = crypto.randomUUID();
  const site = crypto.randomUUID();
  await sql(
    `INSERT INTO hosting.nodes (id, name, compute_instance_id, region, data_region, status, health, runtimes) VALUES ($1,$2,$3,'r','sa-central','active','healthy','["php:8.3"]')`,
    [node, `e2e-${L}-${node.slice(0, 6)}`, `e2e-i-${node}`],
  );
  for (const [dim, v] of [
    ['cpu_millicores', 4000],
    ['memory_mb', 8000],
    ['disk_mb', 100000],
    ['sites', 10],
  ] as const)
    await sql(
      `INSERT INTO hosting.node_capacity (node_id, dim, physical, sellable) VALUES ($1,$2,$3,$3)`,
      [node, dim, v],
    );
  await sql(
    `INSERT INTO hosting.plan_definitions (id, key, name_ar, name_en, status, quotas, runtimes, reservation, price_minor, placeholder) VALUES ($1,$2,'خطة اختبار','Test plan','active','{"diskMb":100,"inodes":5000,"bandwidthGb":10,"dbCount":1,"sitesCount":1}','["php"]','{"cpu_millicores":100,"memory_mb":128,"disk_mb":500}',10000,true)`,
    [plan, `e2e-${L}-${plan.slice(0, 6)}`],
  );
  await page.goto(`${base}/plans`);
  // the plans shop: the hosting types as tabs and the plan as a card (the comparison table opens on demand)
  await expect(page.getByRole('tablist', { name: T(info, 'host.shop.types') })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: L === 'ar' ? 'خطة اختبار' : 'Test plan' }),
  ).toBeVisible();
  await page.getByRole('button', { name: T(info, 'host.shop.compare') }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await audit(page, info, 'hosting-plans');

  await sql(
    `INSERT INTO hosting.sites (id, org_id, name, token, node_name, plan_id, runtime, status, data_region, node_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,'php:8.3','creating','sa-central',$7,$8)`,
    [
      site,
      org.id,
      `e2e-site-${L}`,
      'a'.repeat(64),
      `s-${site.replace(/-/g, '').slice(0, 20)}`,
      plan,
      node,
      org.user_id,
    ],
  );
  await page.goto(`${base}/sites`);
  await expect(page.getByRole('link', { name: `e2e-site-${L}` })).toBeVisible();
  await audit(page, info, 'hosting-sites');
  await page.goto(`${base}/sites/${site}`);
  await expect(page.getByText(T(info, 'host.banner.creating'))).toBeVisible(); // creating banner (UI-M06-04)
  await audit(page, info, 'hosting-site-creating');
  for (const [path, shot, text] of [
    ['domains', 'hosting-domains', 'host.none.domains'],
    ['ssl', 'hosting-ssl', 'host.none.certs'],
    ['databases', 'hosting-databases', 'host.db.unavailable'],
    ['backups', 'hosting-backups', 'host.none.backups'],
  ] as const) {
    await page.goto(`${base}/sites/${site}/${path}`);
    await expect(page.getByText(T(info, text))).toBeVisible();
    await audit(page, info, shot);
  }
  await page.goto(`${base}/sites/${site}/usage`);
  await expect(page.getByRole('heading', { name: T(info, 'host.tab.usage') })).toBeVisible();
  await audit(page, info, 'hosting-usage');

  // another organization's site is not found (404 from the API, an error state here); the feature flag off hides everything
  await sql(
    `UPDATE platform.feature_flags SET value = 'false' WHERE key = 'hosting.enabled' AND org_id IS NULL`,
  );
  await page.goto(`${base}/sites`);
  await expect(page.getByRole('heading', { name: T(info, 'state.error.title') })).toBeVisible();
  await sql(
    `UPDATE platform.feature_flags SET value = 'true' WHERE key = 'hosting.enabled' AND org_id IS NULL`,
  );
});
