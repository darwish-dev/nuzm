import { execSync } from 'node:child_process';
import { Client } from 'pg';
import { rmSync } from 'node:fs';
import { E2E_DB, IDP, PG_ADMIN, STORE_DIR } from './tests/env';

const ADMIN = PG_ADMIN;
const DB = E2E_DB;
const ISSUER = IDP;

/** Fresh database every run: migrate, then seed the two staff users (platform_admin) that the admin tests sign in as. */
export default async function globalSetup() {
  rmSync(STORE_DIR, { recursive: true, force: true }); // the knowledge object store starts empty, like the database
  const root = new Client({ connectionString: `${ADMIN}/postgres` });
  await root.connect();
  await root.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await root.query(`CREATE DATABASE ${DB}`);
  await root.end();
  execSync('pnpm --filter @nuzm/db exec tsx src/cli.ts migrate', {
    stdio: 'inherit',
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
}
