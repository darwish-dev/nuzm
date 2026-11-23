import { execSync } from 'node:child_process';
import { Client } from 'pg';
import { rmSync } from 'node:fs';
import { E2E_DB, IDP, PG_ADMIN, STORE_DIR } from './tests/env';

const ADMIN = PG_ADMIN;
const DB = E2E_DB;
const ISSUER = IDP;

/** Fresh database every run: migrate, then seed the two staff users (platform_admin) that the admin tests sign in as. */
export default async function globalSetup() {
  const tpl = `${DB}_tpl`;
  const root = new Client({ connectionString: `${ADMIN}/postgres` });
  await root.connect();
  const exists =
    (await root.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [tpl])).rowCount === 1;
  await root.end();
  // a pristine copy exists from an earlier run against these same servers (scripts/e2e-stack.sh): nothing to seed, every spec file resets from it
  if (exists) return;
  rmSync(STORE_DIR, { recursive: true, force: true }); // the knowledge object store starts empty, like the database
  // the database was created and migrated before the servers started (prepare-db.mjs, or scripts/e2e-stack.sh); what the servers wrote into it at start-up stays
  execSync('pnpm --filter @nuzm/db exec tsx src/cli.ts migrate', {
    stdio: 'ignore',
    env: { ...process.env, DATABASE_ADMIN_URL: `${ADMIN}/${DB}` },
  });
  const db = new Client({ connectionString: `${ADMIN}/${DB}` });
  await db.connect();
  for (const loc of ['ar', 'en']) {
    const r = await db.query(
      `INSERT INTO identity.users (id, issuer, subject, email, email_verified, is_platform_user)
       VALUES (gen_random_uuid(), $1, $2, $3, true, true) RETURNING id`,
      [ISSUER, `e2e-staff-${loc}`, `staff-${loc}@example.test`],
    );
    await db.query(
      `INSERT INTO tenancy.platform_roles (user_id, role) VALUES ($1, 'platform_admin')`,
      [r.rows[0].id],
    );
    // S-K2a approvers: a security reviewer and a second platform admin (both hold admin:ai_knowledge:publish)
    for (const [who, role] of [
      ['approver1', 'security'],
      ['approver2', 'platform_admin'],
    ] as const) {
      const a = await db.query(
        `INSERT INTO identity.users (id, issuer, subject, email, email_verified, is_platform_user)
         VALUES (gen_random_uuid(), $1, $2, $3, true, true) RETURNING id`,
        [ISSUER, `e2e-${who}-${loc}`, `${who}-${loc}@example.test`],
      );
      await db.query(`INSERT INTO tenancy.platform_roles (user_id, role) VALUES ($1, $2)`, [
        a.rows[0].id,
        role,
      ]);
    }
  }
  await db.end();
  // a pristine copy of the migrated and seeded database: every spec file starts from it (`resetDatabase`, tests/reset.ts), so no spec can depend on what another one left behind

  const admin = new Client({ connectionString: `${ADMIN}/postgres` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${tpl} WITH (FORCE)`);
  for (let attempt = 1; ; attempt++) {
    try {
      // the API may reconnect between the migration and this copy (a template must have no other session): end its sessions and try again
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [DB],
      );
      await admin.query(`CREATE DATABASE ${tpl} TEMPLATE ${DB}`);
      break;
    } catch (e) {
      if (attempt >= 20) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await admin.end();
}
