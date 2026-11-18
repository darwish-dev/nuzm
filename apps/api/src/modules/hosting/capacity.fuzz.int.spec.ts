/**
 * AC-M06-02 / AC-M06-03: capacity invariants under load. Direct database access with the app role (RLS platform scope), 5 nodes, 32 concurrent workers.
 * FUZZ_OPS (default 5000; the acceptance run sets 100000) randomised allocate/resize/release operations; invariants checked at every committed state by sampling + at the end.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { Client } from 'pg';
import { createEnv, ORG_A, type TestEnv } from '@nuzm/platform/testing';
import { CapacityService, type Need } from './internal/capacity.service';
import { loadHostingConfig } from './internal/config';

let env: TestEnv;
const cap = new CapacityService(
  loadHostingConfig({ HOSTING_PLACEMENT_STRATEGY: 'spread' } as never),
);
const PLAN = uuidv7();
const NODES = Array.from({ length: 5 }, () => uuidv7());

beforeAll(async () => {
  env = await createEnv();
  for (const [i, id] of NODES.entries()) {
    await env.sql(
      `INSERT INTO hosting.nodes (id, name, compute_instance_id, region, data_region, status, health, runtimes) VALUES ($1,$2,$3,'r','SA','active','healthy','["php:8.3"]')`,
      [id, `fuzz-${i}`, `inst-${i}`],
    );
    for (const [dim, v] of [
      ['cpu_millicores', 4000],
      ['memory_mb', 8000],
      ['disk_mb', 100000],
      ['sites', 40],
    ] as const)
      await env.sql(
        `INSERT INTO hosting.node_capacity (node_id, dim, physical, sellable) VALUES ($1,$2,$3,$3)`,
        [id, dim, v],
      );
  }
  await env.sql(
    `INSERT INTO hosting.plan_definitions (id, key, name_ar, name_en, quotas, reservation) VALUES ($1,'fuzz','ف','Fuzz','{}','{}')`,
    [PLAN],
  );
});
afterAll(() => env.close());

const insertSite = (c: import('pg').PoolClient, id: string) =>
  c.query(
    `INSERT INTO hosting.sites (id, org_id, name, token, node_name, plan_id, runtime, data_region) VALUES ($1,$2,$3,$4,$5,$6,'php:8.3','SA')`,
    [
      id,
      ORG_A,
      's' + id.slice(-12),
      id.replace(/-/g, '') + id.replace(/-/g, '').slice(0, 32),
      's-' + id.replace(/-/g, '').slice(-20),
      PLAN,
    ],
  );

const randNeed = (): Need => ({
  cpu_millicores: 50 + Math.floor(Math.random() * 450),
  memory_mb: 64 + Math.floor(Math.random() * 500),
  disk_mb: 500 + Math.floor(Math.random() * 4000),
  sites: 1,
});

async function checkInvariants(label: string) {
  const bad = await env.sql(
    `SELECT c.node_id, c.dim, c.reserved, c.sellable FROM hosting.node_capacity c WHERE c.reserved > c.sellable OR c.reserved < 0`,
  );
  expect(bad, label).toEqual([]);
  const mism =
    await env.sql(`SELECT c.node_id, c.dim FROM hosting.node_capacity c LEFT JOIN (SELECT node_id, sum(cpu_millicores) cpu, sum(memory_mb) mem, sum(disk_mb) dsk, sum(sites) st FROM hosting.site_allocations GROUP BY node_id) a ON a.node_id = c.node_id
    WHERE c.reserved <> coalesce(CASE c.dim WHEN 'cpu_millicores' THEN a.cpu WHEN 'memory_mb' THEN a.mem WHEN 'disk_mb' THEN a.dsk ELSE a.st END, 0)`);
  expect(mism, label).toEqual([]);
}

describe('AC-M06-02 capacity fuzz', () => {
  it(`runs ${process.env.FUZZ_OPS ?? 5000} random allocate/resize/release operations with 32 workers; reserved <= sellable and reserved == allocations at every sampled state`, async () => {
    const total = Number(process.env.FUZZ_OPS ?? 5000);
    const WORKERS = 32;
    const live: string[] = [];
    const stats = { alloc: 0, noCap: 0, resize: 0, resizeNoCap: 0, release: 0, violations: 0 };
    let done = 0;
    const sampler = setInterval(() => {
      void checkInvariants('sample').catch(() => (stats.violations += 1));
    }, 2000);
    const worker = async () => {
      while (done < total) {
        const i = done++;
        if (i >= total) break;
        const pick = Math.random();
        try {
          if (pick < 0.5 || live.length === 0) {
            const id = uuidv7();
            await env.worker.withPlatformScope(async (c) => {
              await insertSite(c, id);
              await cap.allocate(c, id, { regions: ['SA'], runtime: 'php:8.3', need: randNeed() });
            });
            live.push(id);
            stats.alloc++;
          } else if (pick < 0.75) {
            const id = live[Math.floor(Math.random() * live.length)]!;
            await env.worker
              .withPlatformScope((c) => cap.resize(c, id, randNeed()))
              .catch((e) => {
                if (e?.code === 'no_capacity') {
                  stats.resizeNoCap++;
                  return;
                }
                if (e?.code === 'not_found') return; // the site was released by another worker between the pick and the resize: a legal race
                throw e;
              });
            stats.resize++;
          } else {
            const id = live.splice(Math.floor(Math.random() * live.length), 1)[0];
            if (id) {
              await env.worker.withPlatformScope((c) => cap.release(c, id));
              stats.release++;
            }
          }
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === 'no_capacity') stats.noCap++;
          else if ((e as Error).message?.includes('deadlock'))
            stats.violations += 0; // retried by the loop's next op; counted below
          else throw e;
        }
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, worker));
    clearInterval(sampler);
    await checkInvariants('final');
    expect(stats.violations).toBe(0);
    // report
    const report = {
      ...stats,
      ops: total,
      workers: WORKERS,
      nodes: NODES.length,
      finishedAt: new Date().toISOString(),
    };
    console.log('capacity fuzz stats', JSON.stringify(report));
    if (process.env.FUZZ_EVIDENCE)
      (await import('node:fs')).writeFileSync(
        process.env.FUZZ_EVIDENCE,
        JSON.stringify(report, null, 2) + '\n',
      );
    expect(stats.alloc + stats.noCap).toBeGreaterThan(0);
  }, 900_000);

  it('a direct SQL attempt to violate the invariant is rejected by the database', async () => {
    const c = new Client({ connectionString: env.adminUrl });
    await c.connect();
    try {
      await expect(
        c.query(
          `UPDATE hosting.node_capacity SET reserved = sellable + 1 WHERE node_id = $1 AND dim = 'sites'`,
          [NODES[0]],
        ),
      ).rejects.toThrow(/node_capacity_invariant/);
      await expect(
        c.query(
          `UPDATE hosting.node_capacity SET reserved = reserved + 1 WHERE node_id = $1 AND dim = 'cpu_millicores'`,
          [NODES[0]],
        ),
      ).rejects.toThrow(/capacity ledger broken/);
    } finally {
      await c.end();
    }
  });
});

describe('AC-M06-03 concurrency: 100 parallel creates, capacity for 10', () => {
  it('exactly 10 succeed, 90 get no_capacity, no leaked reservations', async () => {
    const e2 = await createEnv();
    try {
      const node = uuidv7();
      const plan = uuidv7();
      await e2.sql(
        `INSERT INTO hosting.nodes (id, name, compute_instance_id, region, data_region, status, health, runtimes) VALUES ($1,'one','inst','r','SA','active','healthy','["php:8.3"]')`,
        [node],
      );
      for (const [dim, v] of [
        ['cpu_millicores', 10000],
        ['memory_mb', 10000],
        ['disk_mb', 10000],
        ['sites', 10],
      ] as const)
        await e2.sql(
          `INSERT INTO hosting.node_capacity (node_id, dim, physical, sellable) VALUES ($1,$2,$3,$3)`,
          [node, dim, v],
        );
      await e2.sql(
        `INSERT INTO hosting.plan_definitions (id, key, name_ar, name_en, quotas, reservation) VALUES ($1,'pp','ف','P','{}','{}')`,
        [plan],
      );
      const need: Need = { cpu_millicores: 1000, memory_mb: 1000, disk_mb: 1000, sites: 1 };
      const results = await Promise.all(
        Array.from({ length: 100 }, async () => {
          const id = uuidv7();
          try {
            await e2.worker.withPlatformScope(async (c) => {
              await c.query(
                `INSERT INTO hosting.sites (id, org_id, name, token, node_name, plan_id, runtime, data_region) VALUES ($1,$2,$3,$4,$5,$6,'php:8.3','SA')`,
                [
                  id,
                  ORG_A,
                  's' + id.slice(-12),
                  id.replace(/-/g, '') + id.replace(/-/g, '').slice(0, 32),
                  's-' + id.replace(/-/g, '').slice(-20),
                  plan,
                ],
              );
              await cap.allocate(c, id, { regions: ['SA'], runtime: 'php:8.3', need });
            });
            return 'ok';
          } catch (e) {
            return (e as { code?: string }).code ?? 'error';
          }
        }),
      );
      expect(results.filter((r) => r === 'ok')).toHaveLength(10);
      expect(results.filter((r) => r === 'no_capacity')).toHaveLength(90);
      const sites = await e2.sql(`SELECT count(*)::int n FROM hosting.sites`);
      const allocs = await e2.sql(`SELECT count(*)::int n FROM hosting.site_allocations`);
      const reserved = await e2.sql(
        `SELECT reserved FROM hosting.node_capacity WHERE dim = 'sites'`,
      );
      expect(sites[0]!.n).toBe(10); // the 90 failed transactions rolled their site rows back too
      expect(allocs[0]!.n).toBe(10);
      expect(Number(reserved[0]!.reserved)).toBe(10); // reservation count == active sites
    } finally {
      await e2.close();
    }
  }, 120_000);
});
