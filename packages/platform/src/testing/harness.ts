import { join } from 'node:path';
import { Client } from 'pg';
import { loadManifest, migrate } from '@nuzm/db';
import { Db } from '../db';

const admin = process.env.NUZM_TEST_ADMIN_URL ?? 'postgres://nuzm_admin@127.0.0.1:54329/postgres';
const DEV_PW = 'nuzm_dev_only'; // dev/test cluster only; never used outside the project-local cluster

export const ORG_A = '00000000-0000-7000-8000-00000000000a';
export const ORG_B = '00000000-0000-7000-8000-00000000000b';
/** Seed user who created ORG_A/ORG_B. */
export const SEED_USER = '00000000-0000-7000-8000-0000000000f1';

export interface TestEnv {
  name: string;
  adminUrl: string;
  appUrl: string;
  workerUrl: string;
  app: Db;
  worker: Db;
  sql: (q: string, p?: unknown[]) => Promise<Record<string, unknown>[]>;
  close: () => Promise<void>;
}

/** Fresh database, all migrations applied, runtime roles given LOGIN so RLS is genuinely enforced. */
export async function createEnv(): Promise<TestEnv> {
  const name = `nuzm_test_p_${Date.now()}_${Math.floor(Math.random() * 1e5)}`;
  const root = new Client({ connectionString: admin });
  await root.connect();
  await root.query(`CREATE DATABASE "${name}"`);
  const adminUrl = admin.replace(/\/[^/]*$/, `/${name}`);
  const repo = join(__dirname, '../../../..');
  await migrate({
    url: adminUrl,
    migrationsDir: join(repo, 'packages/db/migrations'),
    manifest: loadManifest(join(repo, 'spec/db/ownership.yaml')),
  });
  for (const r of ['nuzm_app', 'nuzm_worker'])
    await root.query(`ALTER ROLE ${r} LOGIN PASSWORD '${DEV_PW}'`);
  await root.end();
  // Seed a user and the two organizations that tests use (FKs require real rows).
  const seed = new Client({ connectionString: adminUrl });
  await seed.connect();
  await seed.query(
    `INSERT INTO identity.users (id, issuer, subject, email) VALUES ($1,'seed','seed-user','seed@example.test')`,
    [SEED_USER],
  );
  for (const [org, slug] of [
    [ORG_A, 'org-a'],
    [ORG_B, 'org-b'],
  ] as const) {
    await seed.query(
      `INSERT INTO tenancy.organizations (id, name, slug, type, country, created_by) VALUES ($1,$2,$2,'customer','SA',$3)`,
      [org, slug, SEED_USER],
    );
  }
  await seed.end();
  const asRole = (r: string) => adminUrl.replace('nuzm_admin@', `${r}:${DEV_PW}@`);
  const appUrl = asRole('nuzm_app');
  const workerUrl = asRole('nuzm_worker');
  const app = new Db(appUrl);
  const worker = new Db(workerUrl);
  return {
    name,
    adminUrl,
    appUrl,
    workerUrl,
    app,
    worker,
    sql: async (q, p = []) => {
      const c = new Client({ connectionString: adminUrl });
      await c.connect();
      try {
        return (await c.query(q, p)).rows;
      } finally {
        await c.end();
      }
    },
    close: async () => {
      await app.close();
      await worker.close();
      const c = new Client({ connectionString: admin });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await c.end();
    },
  };
}
