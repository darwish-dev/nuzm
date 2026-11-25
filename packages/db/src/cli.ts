import { join } from 'node:path';
import { Client } from 'pg';
import { checkDatabase } from './checks';
import { checkClassification } from './classification';
import { collectEvidence } from './collectors';
import { syncControls } from './controls';
import { devSeedAiResidency } from './dev-ai-residency';
import { devSeedCloud } from './dev-cloud';
import { devEnableFeatures } from './dev-flags';
import { devSeed } from './dev-seed';
import { checkResidencyHooks } from './residency-hooks';
import { adapterKindsFromDocs, checkRopaCoverage } from './ropa-coverage';
import { loadManifest } from './migrations';
import { migrate, rollback } from './runner';

const root = join(__dirname, '..', '..', '..');
const manifest = loadManifest(join(root, 'spec/db/ownership.yaml'));
const migrationsDir = join(__dirname, '..', 'migrations');
const controlsPath = join(root, 'spec/compliance/controls.yaml');
// Session safety (scripts/testenv, DEFECT-19): the owner's development database (:54329) is a default ONLY when the OWNER opts in (NUZM_ALLOW_OWNER_DEV_DB=1 in their own
// shell profile). A session never does: it must pass an explicit DATABASE_ADMIN_URL, which a leased environment pins to its own cluster (NUZM_LEASE_PORT).
if (
  !process.env.DATABASE_ADMIN_URL &&
  (process.env.NUZM_FORBID_DEFAULT_DB === '1' || process.env.NUZM_ALLOW_OWNER_DEV_DB !== '1')
) {
  console.error(
    'db cli: DATABASE_ADMIN_URL is mandatory: the owner development database is a default ONLY with the owner own NUZM_ALLOW_OWNER_DEV_DB=1 opt-in (never in a session; use source scripts/session-env.sh <name>)',
  );
  process.exit(2);
}
const url = process.env.DATABASE_ADMIN_URL ?? 'postgres://nuzm_admin@127.0.0.1:54329/nuzm_dev';
if (process.env.NUZM_LEASE_PORT && new URL(url).port !== process.env.NUZM_LEASE_PORT) {
  console.error(
    `db cli: ${new URL(url).port} is not this session's leased database port (${process.env.NUZM_LEASE_PORT}): refused`,
  );
  process.exit(2);
}

async function ensureDatabase(target: string) {
  const u = new URL(target);
  const name = u.pathname.slice(1);
  if (!['127.0.0.1', 'localhost', '::1'].includes(u.hostname)) return; // never auto-create on remote hosts
  u.pathname = '/postgres';
  const c = new Client({ connectionString: u.toString() });
  await c.connect();
  try {
    const { rowCount } = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) await c.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
  } finally {
    await c.end();
  }
}

async function main() {
  const [cmd] = process.argv.slice(2);
  if (cmd === 'migrate') {
    await ensureDatabase(url);
    const done = await migrate({ url, migrationsDir, manifest });
    console.log(
      done.length
        ? `applied: ${done.map((m) => `${m.ordinal}:${m.slug}`).join(', ')}`
        : 'no pending migrations',
    );
    // the control catalog is loaded from spec/compliance/controls.yaml (idempotent; the runtime role cannot write it)
    const synced = await syncControls(url, controlsPath).catch((e: Error) => {
      if (/control_catalog|does not exist/.test(e.message)) return null; // before the M04 migration
      throw e;
    });
    if (synced)
      console.log(
        `controls: ${synced.inserted.length} added, ${synced.updated.length} updated, ${synced.unchanged.length} unchanged, ${synced.orphaned.length} orphaned`,
      );
  } else if (cmd === 'rollback') {
    const done = await rollback({ url, migrationsDir, manifest });
    console.log(`reverted: ${done.map((m) => `${m.ordinal}:${m.slug}`).join(', ') || 'nothing'}`);
  } else if (cmd === 'dev-logins') {
    // DEV ONLY: give the runtime roles LOGIN + a throwaway password on the project-local cluster.
    const u = new URL(url);
    if (!['127.0.0.1', 'localhost', '::1'].includes(u.hostname))
      throw new Error('dev-logins only runs against a local database');
    const pw = (process.env.NUZM_DEV_ROLE_PASSWORD ?? 'nuzm_dev_only').replace(/'/g, '');
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      for (const r of ['nuzm_app', 'nuzm_worker'])
        await c.query(`ALTER ROLE ${r} LOGIN PASSWORD '${pw}'`);
    } finally {
      await c.end();
    }
    console.log('dev logins enabled for nuzm_app, nuzm_worker (dev password)');
  } else if (cmd === 'dev-seed') {
    // DEV ONLY: demo servers, websites, domains and databases for one organization (refuses non-local databases).
    const [, org] = process.argv.slice(2);
    if (!org) throw new Error('usage: dev-seed <organization id, name or slug>');
    const r = await devSeed(url, org);
    for (const [k, v] of Object.entries(r))
      console.log(`${k}: ${v.length ? `added ${v.join(', ')}` : 'nothing new (already seeded)'}`);
  } else if (cmd === 'dev-seed-ai-residency') {
    // DEV ONLY: Claude as a processor of customer content in the US, and (with an organization) that organization's policy allowing the US (refuses non-local databases).
    const [, org] = process.argv.slice(2);
    const r = await devSeedAiResidency(url, org);
    for (const [k, v] of Object.entries(r))
      console.log(`${k}: ${v.length ? `added ${v.join(', ')}` : 'nothing new (already in place)'}`);
  } else if (cmd === 'dev-seed-cloud') {
    // DEV ONLY: a fake compute catalog (accounts, regions, sizes, images, a disk price) so the cloud screens have offers (refuses non-local databases).
    const [, org] = process.argv.slice(2); // optional: also allow the sandbox regions for this organization
    const r = await devSeedCloud(url, org);
    for (const [k, v] of Object.entries(r))
      console.log(`${k}: ${v.length ? `added ${v.length}` : 'nothing new (already seeded)'}`);
  } else if (cmd === 'dev-enable-features') {
    // DEV ONLY: every capability flag ON globally, so new registrations see every feature (refuses non-local databases).
    const changed = await devEnableFeatures(url);
    console.log(
      changed.length ? `enabled: ${changed.join(', ')}` : 'nothing new (all flags already on)',
    );
  } else if (cmd === 'grant-platform-role') {
    // DEV/OPERATOR bootstrap for platform staff (the assignment API, PA-12, awaits owner approval).
    // Production use is a human-gated action (CLAUDE.md §5); this refuses non-local databases.
    const [, email, role] = process.argv.slice(2);
    if (!email || !role) throw new Error('usage: grant-platform-role <email> <role>');
    const u = new URL(url);
    if (!['127.0.0.1', 'localhost', '::1'].includes(u.hostname))
      throw new Error('grant-platform-role only runs against a local database');
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      const r = await c.query(
        `SELECT 1 FROM tenancy.roles WHERE name = $1 AND scope = 'platform'`,
        [role],
      );
      if (!r.rowCount) throw new Error(`unknown platform role: ${role}`);
      const usr = await c.query(`SELECT id FROM identity.users WHERE lower(email) = lower($1)`, [
        email,
      ]);
      if (usr.rowCount !== 1)
        throw new Error(`expected exactly one user with email ${email} (sign in once first)`);
      await c.query('BEGIN');
      await c.query(`UPDATE identity.users SET is_platform_user = true WHERE id = $1`, [
        usr.rows[0].id,
      ]);
      await c.query(
        `INSERT INTO tenancy.platform_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [usr.rows[0].id, role],
      );
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    console.log(`granted platform role ${role} to ${email}`);
  } else if (cmd === 'check') {
    const v = await checkDatabase(url, manifest);
    if (v.length) {
      console.error(
        'DB CHECK FAILED:\n' + v.map((x) => ` - [${x.kind}] ${x.object}: ${x.detail}`).join('\n'),
      );
      process.exit(1);
    }
    console.log('db check OK: ownership + RLS rules hold');
  } else if (cmd === 'classification') {
    // compliance:classification-coverage (M04 S13a): every column has a known data class; no stale entries; sensitive names are not weakly classed
    const v = await checkClassification(url, manifest);
    if (v.length) {
      console.error(
        'CLASSIFICATION COVERAGE FAILED:\n' +
          v.map((x) => ` - [${x.kind}] ${x.object}: ${x.detail}`).join('\n'),
      );
      process.exit(1);
    }
    const cols = Object.values(manifest.classification.columns).reduce(
      (n, t) => n + Object.keys(t).length,
      0,
    );
    console.log(
      `classification coverage OK: ${cols} columns in ${Object.keys(manifest.classification.columns).length} tables, all classified`,
    );
  } else if (cmd === 'ropa-coverage') {
    // compliance:ropa-coverage (M04 S13b, AC-M04-04): an entry for every adapter kind of docs/09 and for every data class in use
    const v = await checkRopaCoverage(
      url,
      manifest,
      join(root, 'docs/09-provider-adapter-interfaces.md'),
    );
    if (v.length) {
      console.error(
        'ROPA COVERAGE FAILED:\n' +
          v.map((x) => ` - [${x.kind}] ${x.object}: ${x.detail}`).join('\n'),
      );
      process.exit(1);
    }
    console.log(
      'ropa coverage OK: every adapter kind of docs/09 and every data class in use has a ROPA entry',
    );
  } else if (cmd === 'residency-hooks') {
    // compliance:residency-hooks (M04 S14a, AC-M04-14): every data_region table and adapter kind has a registered hook; M05..M12 list their call sites
    const v = await checkResidencyHooks(
      url,
      join(root, 'spec/compliance/residency-hooks.yaml'),
      join(root, 'docs/09-provider-adapter-interfaces.md'),
      root,
      adapterKindsFromDocs,
    );
    if (v.length) {
      console.error(
        'RESIDENCY HOOKS FAILED:\n' +
          v.map((x) => ` - [${x.kind}] ${x.object}: ${x.detail}`).join('\n'),
      );
      process.exit(1);
    }
    console.log(
      'residency hooks OK: every data_region table and adapter kind has a hook; M05..M12 list their call sites',
    );
  } else if (cmd === 'sync-controls') {
    const r = await syncControls(url, controlsPath);
    console.log(
      `controls: ${r.inserted.length} added, ${r.updated.length} updated, ${r.unchanged.length} unchanged, ${r.orphaned.length} orphaned${r.orphaned.length ? ` (${r.orphaned.join(', ')})` : ''}`,
    );
  } else if (cmd === 'collect-evidence') {
    // compliance:collect-evidence (M04 S15): run the collectors, record immutable hashed evidence; a failing collector exits 1 after recording
    const only = process.argv.slice(3);
    const reports = await collectEvidence(
      { url, manifest, root, migrationsDir },
      only.length ? only : undefined,
    );
    for (const r of reports)
      console.log(
        `${r.ok ? 'ok  ' : 'FAIL'} ${r.collector} ${r.hash.slice(0, 12)} new=${r.created.length} same=${r.unchanged.length} ${JSON.stringify(r.summary)}`,
      );
    if (reports.some((r) => !r.ok)) process.exit(1);
  } else {
    console.error(
      'usage: cli.ts migrate|rollback|dev-logins|dev-seed|dev-seed-cloud|dev-seed-ai-residency|dev-enable-features|grant-platform-role|check|classification|ropa-coverage|residency-hooks|sync-controls|collect-evidence',
    );
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(String((e as Error).message ?? e));
  process.exit(1);
});
