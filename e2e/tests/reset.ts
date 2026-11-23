import { mkdirSync, rmSync } from 'node:fs';
import { Client } from 'pg';
import { E2E_DB, PG_ADMIN, STORE_DIR } from './env';

/**
 * Puts the database and the object store back to the state global setup left them in (migrated, the staff users seeded, nothing else). Every spec file calls it once, first
 * (`test.beforeAll(resetDatabase)`), so a spec never depends on what an earlier one created and a failure cannot leak into the next file. The servers stay up: their connections
 * to the dropped database end and are opened again on the next request.
 */
export async function resetDatabase(): Promise<void> {
  rmSync(STORE_DIR, { recursive: true, force: true });
  mkdirSync(STORE_DIR, { recursive: true });
  const c = new Client({ connectionString: `${PG_ADMIN}/postgres` });
  await c.connect();
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await c.query(`DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)`);
        await c.query(`CREATE DATABASE ${E2E_DB} TEMPLATE ${E2E_DB}_tpl`);
        return;
      } catch (e) {
        if (attempt >= 10) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } finally {
    await c.end();
  }
}
