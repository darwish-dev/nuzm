/**
 * DEV ONLY: turns every customer-facing capability flag ON globally (a `platform.feature_flags` row with `org_id` NULL), so every organization,
 * including ones registered later, sees AI, the app builder, domains, hosting, cloud, automation, marketplace, programs and enterprise screens.
 * Production defaults are untouched: flags stay OFF unless a row exists, and this refuses to run against a non-local database (CLAUDE.md §4: default
 * off until acceptance; this is a local-development convenience, never an acceptance statement). Idempotent: an existing global row is set to enabled.
 *
 * `app_builder.m09_stubs` is included because the app builder's M09-owned routes are dev stand-ins that only work behind it (and never in production).
 * Kill switches (`ai.killswitch`) are deliberately NOT touched.
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

export const DEV_FEATURE_FLAGS = [
  'ai.enabled',
  'app_builder.enabled',
  'app_builder.m09_stubs',
  'domains.enabled',
  'hosting.enabled',
  'cloud.provisioning',
  'automation.enabled',
  'webhooks.enabled',
  'marketplace.enabled',
  'agency.enabled',
  'reseller.enabled',
  'enterprise.sso',
  'enterprise.scim',
] as const;

export async function devEnableFeatures(url: string): Promise<string[]> {
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost', '::1'].includes(u.hostname))
    throw new Error('dev-enable-features only runs against a local database');
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    const changed: string[] = [];
    for (const key of DEV_FEATURE_FLAGS) {
      const r = await c.query(
        `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES ($1, $2, NULL, '{"enabled": true}')
         ON CONFLICT (key, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
         WHERE platform.feature_flags.value IS DISTINCT FROM EXCLUDED.value`,
        [randomUUID(), key],
      );
      if (r.rowCount) changed.push(key);
    }
    await c.query('COMMIT');
    return changed;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}
