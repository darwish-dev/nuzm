import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Where the E2E stack listens and which database it uses. The defaults are the historical fixed values, so `pnpm test:e2e` is unchanged; set the variables to run the
 * whole stack beside other work (another session's servers, another database) without touching any of it:
 *   E2E_WEB_PORT (3000) E2E_ADMIN_PORT (3001) E2E_API_PORT (4000) E2E_IDP_PORT (4010) E2E_DB (nuzm_e2e)
 * Playwright starts the servers BEFORE global setup recreates the database, so a database name used for the first time must exist and be migrated once:
 *   createdb -h 127.0.0.1 -p 54329 -U nuzm_admin $E2E_DB && DATABASE_ADMIN_URL=postgres://nuzm_admin@127.0.0.1:54329/$E2E_DB pnpm --filter @nuzm/db exec tsx src/cli.ts migrate
 * The consoles' API origin is baked into their build (Next evaluates rewrites at build time), so build them with the same `API_ORIGIN`.
 */
const num = (v: string | undefined, d: number) =>
  v && Number.isInteger(Number(v)) ? Number(v) : d;
export const WEB_PORT = num(process.env.E2E_WEB_PORT, 3000);
export const ADMIN_PORT = num(process.env.E2E_ADMIN_PORT, 3001);
export const API_PORT = num(process.env.E2E_API_PORT, 4000);
export const IDP_PORT = num(process.env.E2E_IDP_PORT, 4010);
export const E2E_DB = process.env.E2E_DB ?? 'nuzm_e2e';
export const WEB = `http://127.0.0.1:${WEB_PORT}`;
export const ADMIN = `http://127.0.0.1:${ADMIN_PORT}`;
export const API = `http://127.0.0.1:${API_PORT}`;
export const IDP = `http://127.0.0.1:${IDP_PORT}`;
/** Where the API's development object store writes (the tests read it to prove what was stored). */
export const STORE_DIR =
  process.env.E2E_STORE_DIR ??
  join(tmpdir(), `nuzm-e2e-knowledge-${process.env.E2E_DB ?? 'nuzm_e2e'}`);
export const PG_ADMIN = 'postgres://nuzm_admin@127.0.0.1:54329';
export const DB_URL = `${PG_ADMIN}/${E2E_DB}`;
