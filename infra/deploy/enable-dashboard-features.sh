#!/usr/bin/env bash
# Explicit operator action. Does not enable mock adapters, grant roles or seed resources.
#   enable-dashboard-features.sh <organization-slug>   the dashboard modules for ONE organization (an organization row)
#   enable-dashboard-features.sh --all-organizations   the same modules as the platform DEFAULT (global rows, org_id NULL): every
#                                                       organization, including every future registration, sees them unless it has
#                                                       its own row saying otherwise. A module whose provider is not configured in
#                                                       production still shows its screens with empty or "not available" states.
set -euo pipefail
TARGET="${1:?organization slug or --all-organizations required}"
if [ "$TARGET" != "--all-organizations" ]; then
  [[ "$TARGET" =~ ^[a-z0-9][a-z0-9-]{1,62}$ ]] || exit 2
fi
export TARGET
set -a
. /etc/nuzm/migrate.env
set +a
cd /srv/nuzm/current
node <<'JS'
const { Client } = require('./packages/platform/node_modules/pg');
const { randomUUID } = require('node:crypto');
const flags = [
  'cloud.provisioning', 'domains.enabled', 'hosting.enabled', 'ai.enabled', 'app_builder.enabled',
  'mobile_builder.enabled', 'automation.enabled', 'webhooks.enabled', 'marketplace.enabled', 'agency.enabled', 'reseller.enabled',
];
const all = process.env.TARGET === '--all-organizations';
(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    let orgId = null;
    let label = 'all organizations (platform default)';
    if (!all) {
      const orgs = await client.query('SELECT id, slug FROM tenancy.organizations WHERE slug=$1', [process.env.TARGET]);
      if (orgs.rows.length !== 1) throw new Error('Expected exactly one organization matching the supplied slug');
      orgId = orgs.rows[0].id;
      label = orgs.rows[0].slug;
    }
    for (const key of flags) {
      await client.query(
        `INSERT INTO platform.feature_flags (id,key,org_id,value) VALUES ($1,$2,$3,'{"enabled":true}')
         ON CONFLICT (key, COALESCE(org_id,'00000000-0000-0000-0000-000000000000'::uuid))
         DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
        [randomUUID(), key, orgId],
      );
    }
    const result = await client.query(
      'SELECT key,value FROM platform.feature_flags WHERE org_id IS NOT DISTINCT FROM $1 AND key=ANY($2::text[]) ORDER BY key',
      [orgId, flags],
    );
    if (result.rows.length !== flags.length || result.rows.some(row => row.value.enabled !== true))
      throw new Error('Feature verification failed');
    await client.query('COMMIT');
    console.log(JSON.stringify({ scope: label, enabled: result.rows.map(row => row.key) }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { await client.end(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
JS
