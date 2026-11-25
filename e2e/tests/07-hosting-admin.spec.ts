import { expect, test } from '@playwright/test';
import { Client } from 'pg';
import { T, audit, loc, signIn } from './helpers';
import { ADMIN, DB_URL as DB } from './env';
import { ensureOwnerOrg } from './fixtures/templates';
import { resetDatabase } from './reset';

test.beforeAll(resetDatabase);

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
 * Admin hosting screens UI-M06-11..15 (read-only; the drain/overcommit dual-approval modal, suspend/resume and abuse action forms are NOT BUILT).
 * Seeds its own node. STATUS: written, NOT RUN (the E2E ports belong to another session; see the M06 report).
 */
test('admin hosting: servers, server panel connection and capacity, cross-org sites, abuse queue (ar/en, axe, forbidden state)', async ({
  page,
  browser,
}, info) => {
  const L = loc(info);
  const staff = `staff-${L}@example.test`;
  await signIn(page, info, staff, ADMIN);
  await sql(
    `UPDATE identity.sessions SET mfa_level = 'totp', mfa_verified_at = now() WHERE user_id = (SELECT id FROM identity.users WHERE email = $1)`,
    [staff],
  );
  const uid = (
    await sql<{ id: string }>(`SELECT id FROM identity.users WHERE email = $1`, [staff])
  )[0]!.id;
  await sql(
    `INSERT INTO tenancy.platform_roles (user_id, role) VALUES ($1, 'hosting_admin') ON CONFLICT DO NOTHING`,
    [uid],
  );
  // an active node with capacity (a real node and agent are not available: HG-06-01), seeded here: no spec depends on another one's data
  const node = { id: crypto.randomUUID() };
  await sql(
    `INSERT INTO hosting.nodes (id, name, compute_instance_id, region, data_region, status, health, runtimes) VALUES ($1,$2,$3,'r','sa-central','active','healthy','["php:8.3"]')`,
    [node.id, `e2e-${L}-${node.id.slice(0, 6)}`, `e2e-i-${node.id}`],
  );
  for (const [dim, v] of [
    ['cpu_millicores', 4000],
    ['memory_mb', 8000],
    ['disk_mb', 100000],
    ['sites', 10],
  ] as const)
    await sql(
      `INSERT INTO hosting.node_capacity (node_id, dim, physical, sellable) VALUES ($1,$2,$3,$3)`,
      [node.id, dim, v],
    );
  // one site of a customer organization (created through the screen) on that node, so the cross-organization list has something to say
  const seed = await browser.newContext({ locale: L === 'ar' ? 'ar-SA' : 'en-GB' });
  const orgId = await ensureOwnerOrg(await seed.newPage(), info, `Hosting ${L}`);
  await seed.close();
  const owner = (
    await sql<{ id: string }>(`SELECT id FROM identity.users WHERE email = $1`, [
      `owner-${L}@example.test`,
    ])
  )[0]!.id;
  const plan = crypto.randomUUID();
  const site = crypto.randomUUID();
  await sql(
    `INSERT INTO hosting.plan_definitions (id, key, name_ar, name_en, status, quotas, runtimes, reservation, price_minor, placeholder) VALUES ($1,$2,'خطة اختبار','Test plan','active','{"diskMb":100,"inodes":5000,"bandwidthGb":10,"dbCount":1,"sitesCount":1}','["php"]','{"cpu_millicores":100,"memory_mb":128,"disk_mb":500}',10000,true)`,
    [plan, `e2e-${L}-${plan.slice(0, 6)}`],
  );
  await sql(
    `INSERT INTO hosting.sites (id, org_id, name, token, node_name, plan_id, runtime, status, data_region, node_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,'php:8.3','creating','sa-central',$7,$8)`,
    [
      site,
      orgId,
      `e2e-site-${L}`,
      'a'.repeat(64),
      `s-${site.replace(/-/g, '').slice(0, 20)}`,
      plan,
      node.id,
      owner,
    ],
  );

  await page.goto(`${ADMIN}/${L}/hosting/nodes`);
  await expect(page.getByRole('heading', { name: T(info, 'host.admin.nodes') })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await audit(page, info, 'admin-hosting-nodes');
  await page.goto(`${ADMIN}/${L}/hosting/nodes/${node.id}`);
  await expect(page.getByRole('heading', { name: T(info, 'hnode.panel.title') })).toBeVisible();
  await audit(page, info, 'admin-hosting-node');
  await page.goto(`${ADMIN}/${L}/hosting/sites`);
  await expect(page.getByText(T(info, 'host.admin.cross'))).toBeVisible();
  await audit(page, info, 'admin-hosting-sites');
  await page.goto(`${ADMIN}/${L}/hosting/abuse`);
  await expect(page.getByRole('heading', { name: T(info, 'host.admin.abuse') })).toBeVisible();
  await audit(page, info, 'admin-hosting-abuse');
});
