#!/usr/bin/env bash
# Explicit operator action for one organization. Does not enable mock adapters, grant roles or seed resources.
set -euo pipefail
export ORGANIZATION_SLUG="${1:?organization slug required}"
[[ "$ORGANIZATION_SLUG" =~ ^[a-z0-9][a-z0-9-]{1,62}$ ]] || exit 2
set -a
. /etc/nuzm/migrate.env
set +a
cd /srv/nuzm/current
node <<'JS'
const { Client } = require('./packages/platform/node_modules/pg');
const { randomUUID } = require('node:crypto');
const flags = ['cloud.provisioning', 'domains.enabled', 'hosting.enabled', 'ai.enabled', 'app_builder.enabled'];
(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    const orgs = await client.query('SELECT id, slug FROM tenancy.organizations WHERE slug=$1', [process.env.ORGANIZATION_SLUG]);
    if (orgs.rows.length !== 1) throw new Error('Expected exactly one organization matching the supplied slug');
    const org = orgs.rows[0];
    for (const key of flags) {
      await client.query(
        `INSERT INTO platform.feature_flags (id,key,org_id,value) VALUES ($1,$2,$3,'{"enabled":true}')
         ON CONFLICT (key, COALESCE(org_id,'00000000-0000-0000-0000-000000000000'::uuid))
         DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
        [randomUUID(), key, org.id],
      );
    }
    const result = await client.query('SELECT key,value FROM platform.feature_flags WHERE org_id=$1 AND key=ANY($2::text[]) ORDER BY key', [org.id, flags]);
    if (result.rows.length !== flags.length || result.rows.some(row => row.value.enabled !== true))
      throw new Error('Feature verification failed');
    await client.query('COMMIT');
    console.log(JSON.stringify({ organization: org.slug, enabled: result.rows.map(row => row.key) }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { await client.end(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
JS
