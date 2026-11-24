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
    const withdrawn = await c.query(
      `UPDATE cloud.provider_regions r SET state = 'withdrawn'
         FROM cloud.provider_accounts a JOIN cloud.providers p ON p.id = a.provider_id
        WHERE r.account_id = a.id AND p.key <> 'mock' AND r.state <> 'withdrawn'`,
    );
    const sim = await c.query(
      `SELECT count(*)::int AS n FROM cloud.provider_regions r
         JOIN cloud.provider_accounts a ON a.id = r.account_id JOIN cloud.providers p ON p.id = a.provider_id
        WHERE p.key = 'mock' AND r.state = 'verified' AND r.country_code = 'SA'`,
    );
    const simulatorRegions = (sim.rows[0] as { n: number }).n;
    if (simulatorRegions < 1)
      throw new Error(
        'the synthetic compute catalog has no verified in-Kingdom simulator region: the seed did not run (run `pnpm db:migrate` on the e2e database first)',
      );
    return { simulatorRegions, withdrawnVendorRegions: withdrawn.rowCount ?? 0 };
  } finally {
    await c.end();
  }
}
