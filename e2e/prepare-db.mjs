// Runs BEFORE Playwright starts its servers (`pnpm --filter @nuzm/e2e run e2e`): a fresh, migrated database for the E2E stack.
// The API's start-up writes rows of its own into the database it finds (for example the dev-mock registrar accounts); global setup used to DROP the database after the
// servers were up, which silently deleted them, so those screens could never be exercised. The database is now made here, first, and global setup keeps what the servers wrote.
// Skipped when the servers are already up (E2E_REUSE_SERVERS=1: scripts/e2e-stack.sh made the database before it started them).
import { execSync } from 'node:child_process';
import pg from 'pg';

if (process.env.E2E_REUSE_SERVERS === '1') process.exit(0);
const num = (v, d) => (v && Number.isInteger(Number(v)) ? Number(v) : d);
const db = process.env.E2E_DB ?? 'nuzm_e2e';
if (!num(process.env.E2E_PG_PORT, 0)) {
  console.error(
    'prepare-db: E2E_PG_PORT is mandatory (acquire an isolated test environment: node scripts/testenv/testenv.mjs acquire); there is no default database',
  );
  process.exit(2);
}
const admin = `postgres://nuzm_admin@127.0.0.1:${num(process.env.E2E_PG_PORT, 0)}`;

const c = new pg.Client({ connectionString: `${admin}/postgres` });
await c.connect();
await c.query(`DROP DATABASE IF EXISTS ${db}_tpl WITH (FORCE)`);
await c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
await c.query(`CREATE DATABASE ${db}`);
await c.end();
execSync('pnpm --filter @nuzm/db exec tsx src/cli.ts migrate', {
  stdio: 'ignore',
  env: { ...process.env, DATABASE_ADMIN_URL: `${admin}/${db}` },
});
