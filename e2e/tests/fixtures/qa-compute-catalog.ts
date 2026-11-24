import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { DB_URL as DB } from '../env';

/**
 * QA fixture (Session 07): the APPROVED SYNTHETIC compute catalog for `08-compute-customer` (mock catalog test). Throw-away e2e database only; nothing live.
 *
 * What it uses: the existing dev seed (`packages/db/src/dev-cloud.ts`, refuses a non-local database): the simulator ("mock") provider account `demo-mock (dev seed)` with
 * `vault://dev/demo/...` references (no secret), regions carrying `mock` evidence, sizes, five operating-system images, a placeholder price book completed with a disk
 * meter (marked DRAFT-NOT-APPROVED, HG-02-01), the sandbox processors in the ROPA (not a DPO review), and for the given organization a dev compute allowance and a
 * residency policy that allows the sandbox regions. That is the "verified in-Kingdom offer, SAR price book and allowed processor" the spec header asks for.
 *
 * What it adds: the three vendor slots (alibaba, huawei, contabo) have no live adapter in a dev stack, so for them a quote works but "create" fails honestly. The test
 * must drive the simulator, so every region of those accounts is WITHDRAWN here (a state the schema allows; the offers list shows verified regions only). Customers never
 * see which provider an offer belongs to, so the spec cannot choose by name: removing the others is what makes "the first offer" the simulator's.
 *
 * Offline, simulated evidence: it proves the screens and the mock provisioning flow, never a real provider (NOT VERIFIED for any real vendor).
 */
export interface MockComputeCatalog {
  simulatorRegions: number;
  /** every other region of the seed (vendor slots and the seed's own `dev-*` regions) */
  withdrawnVendorRegions: number;
}

export async function seedMockComputeCatalog(orgId: string): Promise<MockComputeCatalog> {
  if (!/^[0-9a-f-]{36}$/i.test(orgId))
    throw new Error('seedMockComputeCatalog: orgId must be a uuid');
  // argv, not a shell string: the organization id is never interpolated into a command line
  execFileSync(
    'pnpm',
    ['--filter', '@nuzm/db', 'exec', 'tsx', 'src/cli.ts', 'dev-seed-cloud', orgId],
    { stdio: 'ignore', env: { ...process.env, DATABASE_ADMIN_URL: DB } },
  );
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    // The dev seed's simulator ids (`dev-sa-1`, `spark-1`, `dev-ubuntu-22-04-lts`) are NOT in the mock-compute adapter's own catalog, so the adapter rejects a create with
    // `region_not_listed` (found by the first real run of this spec: the instance finished "failed", provider rejected the request). The simulator accepts exactly what it lists:
    // region `mock-sa-1` (SA), plans `mock.small`/`mock.medium`, images `mock-ubuntu`/`mock-debian` (packages/adapters/mock-compute/src/mock-compute.ts). So this fixture
    // publishes THAT catalog for the simulator account, as a verified `mock`-evidence region, and withdraws every other region (vendor slots and the seed's `dev-*` regions).
    const account = (
      await c.query(
        `SELECT a.id FROM cloud.provider_accounts a JOIN cloud.providers p ON p.id = a.provider_id WHERE p.key = 'mock' AND a.name = 'demo-mock (dev seed)'`,
      )
    ).rows[0] as { id: string } | undefined;
    if (!account)
      throw new Error('the simulator account of the dev seed is missing: the seed did not run');
    const region = (
      await c.query(
        `INSERT INTO cloud.provider_regions (id, account_id, provider_region_id, country_code, display_name, state, verified_at, evidence_ref, evidence_kind)
         VALUES (gen_random_uuid(), $1, 'mock-sa-1', 'SA', 'Riyadh (simulator)', 'verified', now(), 'qa-fixture: mock-compute catalog', 'mock')
         ON CONFLICT (account_id, provider_region_id) DO UPDATE SET state = 'verified', verified_at = now(), last_seen_at = now()
         RETURNING id`,
        [account.id],
      )
    ).rows[0] as { id: string };
    for (const [ref, vcpu, mem, disk, hourly] of [
      ['mock.small', 1, 2048, 40, 12],
      ['mock.medium', 2, 4096, 80, 24],
    ] as const)
      await c.query(
        `INSERT INTO cloud.provider_plans (id, account_id, region_id, plan_ref, vcpu, memory_mb, disk_gb, provider_price_minor, currency, period, availability)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'SAR', 'hour', 'available')
         ON CONFLICT (account_id, region_id, plan_ref) DO UPDATE SET availability = 'available', last_seen_at = now()`,
        [account.id, region.id, ref, vcpu, mem, disk, hourly],
      );
    for (const [ref, name] of [
      ['mock-ubuntu', 'Mock Ubuntu'],
      ['mock-debian', 'Mock Debian'],
    ] as const)
      await c.query(
        `INSERT INTO compute.images (id, account_id, provider_region_id, image_ref, name, os_family)
         VALUES (gen_random_uuid(), $1, 'mock-sa-1', $2, $3, 'linux')
         ON CONFLICT (account_id, provider_region_id, image_ref) DO NOTHING`,
        [account.id, ref, name],
      );
    const withdrawn = await c.query(
      `UPDATE cloud.provider_regions SET state = 'withdrawn'
        WHERE state <> 'withdrawn' AND id <> $1`,
      [region.id],
    );
    return { simulatorRegions: 1, withdrawnVendorRegions: withdrawn.rowCount ?? 0 };
  } finally {
    await c.end();
  }
}
