import { expect, test } from '@playwright/test';
import { Client } from 'pg';
import { T, audit, loc, signIn } from './helpers';
import { DB_URL as DB } from './env';

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

/**
 * Admin hosting screens UI-M06-11..15 (read-only; the drain/overcommit dual-approval modal, suspend/resume and abuse action forms are NOT BUILT).
 * Runs after 02-admin and 06-hosting-customer. STATUS: written, NOT RUN (the E2E ports belong to another session; see the M06 report).
 */
test('admin hosting: nodes, node capacity, cross-org sites, abuse queue, agents (ar/en, axe, forbidden state)', async ({
  page,
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
  const node = (
    await sql<{ id: string }>(`SELECT id FROM hosting.nodes ORDER BY created_at DESC LIMIT 1`)
  )[0];
  if (!node) throw new Error('run 06-hosting-customer first: no node');

  await page.goto(`${ADMIN}/${L}/hosting/nodes`);
  await expect(page.getByRole('heading', { name: T(info, 'host.admin.nodes') })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await audit(page, info, 'admin-hosting-nodes');
  await page.goto(`${ADMIN}/${L}/hosting/nodes/${node.id}`);
  await expect(
    page.getByRole('heading', { name: T(info, 'host.admin.capacity') }).or(page.getByRole('table')),
  ).toBeVisible();
  await audit(page, info, 'admin-hosting-node');
  await page.goto(`${ADMIN}/${L}/hosting/sites`);
  await expect(page.getByText(T(info, 'host.admin.cross'))).toBeVisible();
  await audit(page, info, 'admin-hosting-sites');
  await page.goto(`${ADMIN}/${L}/hosting/abuse`);
  await expect(page.getByRole('heading', { name: T(info, 'host.admin.abuse') })).toBeVisible();
  await audit(page, info, 'admin-hosting-abuse');
  await page.goto(`${ADMIN}/${L}/hosting/agents`);
  await expect(page.getByRole('heading', { name: T(info, 'host.admin.agents') })).toBeVisible();
  await audit(page, info, 'admin-hosting-agents');
});
