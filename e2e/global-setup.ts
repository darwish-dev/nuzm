import { execSync } from 'node:child_process';
import { Client } from 'pg';

const ADMIN = 'postgres://nuzm_admin@127.0.0.1:54329';
const DB = 'nuzm_e2e';
const ISSUER = 'http://127.0.0.1:4010';

/** Fresh database every run: migrate, then seed the two staff users (platform_admin) that the admin tests sign in as. */
export default async function globalSetup() {
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
  }
  await db.end();
}
