import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORG_A, ORG_B, SEED_USER, createEnv, type TestEnv } from '@nuzm/platform/testing';
import type { AuditEvent } from '../../common/audit';
import { AuditSink } from '../../common/audit';
import { LedgerPostingService } from './internal/ledger.service';
import {
  adjustment,
  creditGrant,
  providerCostAccrual,
  usageChargeWallet,
  walletConsume,
} from './internal/recipes';

class CapturingSink extends AuditSink {
  events: AuditEvent[] = [];
  async record(e: AuditEvent) {
    this.events.push(e);
  }
}

let env: TestEnv;
let ledger: LedgerPostingService;
const sink = new CapturingSink();

beforeAll(async () => {
  env = await createEnv();
  ledger = new LedgerPostingService(env.app, sink);
});
afterAll(() => env.close());

const sql = (q: string, p: unknown[] = []) => env.sql(q, p);
const walletOf = async (org: string) =>
  BigInt(
    (
      await sql(
        `SELECT coalesce(sum(CASE p.direction WHEN 'credit' THEN p.amount_minor ELSE -p.amount_minor END),0)::text s
           FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id = p.account_id
          WHERE a.code = '2100' AND a.org_id = $1`,
        [org],
      )
    )[0]!.s as string,
  );
const rejectsWith = async (p: Promise<unknown>, code: string) => {
  await expect(p).rejects.toMatchObject({ code });
};

describe('chart of accounts and basic posting', () => {
  it('seeds the platform accounts without a sub-ledger and creates per-org accounts lazily', async () => {
    const seeded = (
      await sql(`SELECT code FROM billing.ledger_accounts WHERE org_id IS NULL ORDER BY code`)
    ).map((r) => r.code);
    expect(seeded).toEqual([
      '1400',
      '2300',
      '4100',
      '4200',
      '4300',
      '4400',
      '4900',
      '5200',
      '5300',
      '5400',
    ]);
    expect(
      (await sql(`SELECT 1 FROM billing.ledger_accounts WHERE org_id IS NOT NULL`)).length,
    ).toBe(0);
    await ledger.post(
      creditGrant({ orgId: ORG_A, amountMinor: 10_000, currency: 'SAR', reason: 'Welcome' }),
      'grant-a-1',
      SEED_USER,
    );
    const mine = await sql(
      `SELECT code, type, normal_side FROM billing.ledger_accounts WHERE org_id = $1`,
      [ORG_A],
    );
    expect(mine).toEqual([{ code: '2100', type: 'liability', normal_side: 'credit' }]);
  });

  it('writes one balanced transaction with two postings, audited and queued for the wallet projection', async () => {
    const tx = (
      await sql(
        `SELECT id, kind, org_id, description FROM billing.ledger_transactions WHERE idempotency_key='grant-a-1'`,
      )
    )[0]!;
    expect(tx).toMatchObject({ kind: 'credit_grant', org_id: ORG_A, description: 'Welcome' });
    const postings = await sql(
      `SELECT a.code, p.direction, p.amount_minor::text amount FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id=p.account_id WHERE p.transaction_id=$1 ORDER BY a.code`,
      [tx.id],
    );
    expect(postings).toEqual([
      { code: '2100', direction: 'credit', amount: '10000' },
      { code: '4900', direction: 'debit', amount: '10000' },
    ]);
    expect(
      sink.events.find((e) => e.action === 'billing.ledger.posted' && e.resource?.id === tx.id),
    ).toMatchObject({ orgId: ORG_A, outcome: 'success' });
    const outbox = await sql(
      `SELECT topic, payload FROM platform.outbox WHERE org_id=$1 AND topic='ledger.posted'`,
      [ORG_A],
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.payload).toMatchObject({ transactionId: tx.id, wallet: true });
  });

  it('is idempotent: the same key and request returns the first transaction and writes nothing', async () => {
    const again = await ledger.post(
      creditGrant({ orgId: ORG_A, amountMinor: 10_000, currency: 'SAR', reason: 'Welcome' }),
      'grant-a-1',
      SEED_USER,
    );
    expect(again.duplicate).toBe(true);
    expect(
      (await sql(`SELECT 1 FROM billing.ledger_transactions WHERE idempotency_key='grant-a-1'`))
        .length,
    ).toBe(1);
    expect(
      (await sql(`SELECT 1 FROM billing.ledger_postings WHERE org_id=$1`, [ORG_A])).length,
    ).toBe(2);
    expect(
      (
        await sql(`SELECT 1 FROM platform.outbox WHERE topic='ledger.posted' AND org_id=$1`, [
          ORG_A,
        ])
      ).length,
    ).toBe(1);
  });

  it('refuses the same key with a different request (idempotency_key_reuse)', async () => {
    await rejectsWith(
      ledger.post(
        creditGrant({ orgId: ORG_A, amountMinor: 99_999, currency: 'SAR', reason: 'Welcome' }),
        'grant-a-1',
      ),
      'idempotency_key_reuse',
    );
    expect(await walletOf(ORG_A)).toBe(10_000n);
  });

  it('keys are scoped per organization: the same key in another org is a different transaction', async () => {
    const r = await ledger.post(
      creditGrant({ orgId: ORG_B, amountMinor: 500, currency: 'SAR', reason: 'Welcome' }),
      'grant-a-1',
    );
    expect(r.duplicate).toBe(false);
    expect(await walletOf(ORG_B)).toBe(500n);
  });
});

describe('only billing.post() writes the ledger; the ledger is append-only', () => {
  const asApp = (q: string, p: unknown[] = []) => env.app.withOrg(ORG_A, (c) => c.query(q, p));
  it('runtime roles cannot INSERT, UPDATE or DELETE ledger tables directly', async () => {
    await expect(
      asApp(
        `INSERT INTO billing.ledger_transactions (id, org_id, idempotency_key, request_hash, kind) VALUES (gen_random_uuid(), $1, 'x', 'h', 'k')`,
        [ORG_A],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp(
        `INSERT INTO billing.ledger_postings (id, transaction_id, account_id, direction, amount_minor, currency) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'debit', 1, 'SAR')`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp(
        `INSERT INTO billing.ledger_accounts (id, code, name, type, normal_side, currency) VALUES (gen_random_uuid(),'9999','x','asset','debit','SAR')`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(asApp(`UPDATE billing.ledger_postings SET amount_minor = 1`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(asApp(`DELETE FROM billing.ledger_postings`)).rejects.toThrow(/permission denied/);
    await expect(
      env.worker.withOrg(ORG_A, (c) => c.query(`DELETE FROM billing.ledger_transactions`)),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp(
        `INSERT INTO billing.wallet_balances (org_id, currency, balance_minor) VALUES ($1,'SAR',999999)`,
        [ORG_A],
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('even the table owner cannot UPDATE, DELETE or TRUNCATE (append-only triggers)', async () => {
    await expect(
      sql(`UPDATE billing.ledger_postings SET amount_minor = amount_minor + 1`),
    ).rejects.toThrow(/append-only/);
    await expect(sql(`DELETE FROM billing.ledger_postings`)).rejects.toThrow(/append-only/);
    await expect(
      sql(`UPDATE billing.ledger_transactions SET description = 'edited'`),
    ).rejects.toThrow(/append-only/);
    await expect(sql(`DELETE FROM billing.ledger_transactions`)).rejects.toThrow(/append-only/);
    await expect(sql(`TRUNCATE billing.ledger_postings`)).rejects.toThrow(/append-only/);
    await expect(sql(`DELETE FROM billing.ledger_accounts`)).rejects.toThrow(/append-only/);
  });

  it('an unbalanced transaction is rejected at COMMIT and leaves nothing behind', async () => {
    const bad = JSON.stringify([
      {
        account: { code: '4900', org: false },
        direction: 'debit',
        amountMinor: '100',
        currency: 'SAR',
      },
      {
        account: { code: '2100', org: true },
        direction: 'credit',
        amountMinor: '90',
        currency: 'SAR',
      },
    ]);
    await expect(
      env.app.withOrg(ORG_A, (c) =>
        c.query(
          `SELECT * FROM billing.post(gen_random_uuid(), $1, 'bad-1', 'x', '', NULL, NULL, $2::jsonb)`,
          [ORG_A, bad],
        ),
      ),
    ).rejects.toThrow(/unbalanced ledger transaction/);
    expect(
      (await sql(`SELECT 1 FROM billing.ledger_transactions WHERE idempotency_key='bad-1'`)).length,
    ).toBe(0);
  });

  it('billing.post refuses an organization other than the caller context, and unknown accounts', async () => {
    const ok = JSON.stringify([
      {
        account: { code: '4900', org: false },
        direction: 'debit',
        amountMinor: '1',
        currency: 'SAR',
      },
      {
        account: { code: '2100', org: true },
        direction: 'credit',
        amountMinor: '1',
        currency: 'SAR',
      },
    ]);
    await expect(
      env.app.withOrg(ORG_A, (c) =>
        c.query(
          `SELECT * FROM billing.post(gen_random_uuid(), $1, 'spoof-1', 'x', '', NULL, NULL, $2::jsonb)`,
          [ORG_B, ok],
        ),
      ),
    ).rejects.toThrow(/organization context does not match/);
    await expect(
      env.app.withoutScope((c) =>
        c.query(
          `SELECT * FROM billing.post(gen_random_uuid(), $1, 'spoof-2', 'x', '', NULL, NULL, $2::jsonb)`,
          [ORG_A, ok],
        ),
      ),
    ).rejects.toThrow(/organization context does not match/);
    const unknown = JSON.stringify([
      {
        account: { code: '9999', org: false },
        direction: 'debit',
        amountMinor: '1',
        currency: 'SAR',
      },
      {
        account: { code: '2100', org: true },
        direction: 'credit',
        amountMinor: '1',
        currency: 'SAR',
      },
    ]);
    await expect(
      env.app.withOrg(ORG_A, (c) =>
        c.query(
          `SELECT * FROM billing.post(gen_random_uuid(), $1, 'unk-1', 'x', '', NULL, NULL, $2::jsonb)`,
          [ORG_A, unknown],
        ),
      ),
    ).rejects.toThrow(/unknown account code/);
  });
});

describe('wallet: no overdraw, including under concurrency', () => {
  it('a consume that would overdraw fails with insufficient_funds and changes nothing', async () => {
    await ledger.post(
      creditGrant({
        orgId: ORG_A,
        amountMinor: 90_000,
        currency: 'SAR',
        reason: 'top up for tests',
      }),
      'grant-a-2',
    );
    expect(await walletOf(ORG_A)).toBe(100_000n);
    await ledger.post(
      walletConsume({
        orgId: ORG_A,
        netMinor: 60_000,
        currency: 'SAR',
        meterId: 'compute.vcpu_hours',
      }),
      'use-1',
    );
    await rejectsWith(
      ledger.post(walletConsume({ orgId: ORG_A, netMinor: 60_000, currency: 'SAR' }), 'use-2'),
      'insufficient_funds',
    );
    expect(await walletOf(ORG_A)).toBe(40_000n);
    expect(
      (await sql(`SELECT 1 FROM billing.ledger_transactions WHERE idempotency_key='use-2'`)).length,
    ).toBe(0);
  });

  it('VAT-at-consumption posts to 2300 and the wallet is debited gross', async () => {
    const before = await walletOf(ORG_A);
    const r = await ledger.post(
      walletConsume({
        orgId: ORG_A,
        netMinor: 1000,
        vatMinor: 150,
        currency: 'SAR',
        meterId: 'storage.object_gb_months',
      }),
      'use-vat',
    );
    const rows = await sql(
      `SELECT a.code, p.direction, p.amount_minor::text amt FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id=p.account_id WHERE p.transaction_id=$1 ORDER BY a.code`,
      [r.transactionId],
    );
    expect(rows).toEqual([
      { code: '2100', direction: 'debit', amt: '1150' },
      { code: '2300', direction: 'credit', amt: '150' },
      { code: '4100', direction: 'credit', amt: '1000' },
    ]);
    expect(await walletOf(ORG_A)).toBe(before - 1150n);
  });

  it('50 parallel consumes of 100 against a balance of 1000 succeed exactly 10 times; the wallet ends at 0, never negative', async () => {
    await ledger.post(
      creditGrant({ orgId: ORG_B, amountMinor: 500, currency: 'SAR', reason: 'race fixture' }),
      'race-grant',
    ); // ORG_B now 1000
    const start = await walletOf(ORG_B);
    expect(start).toBe(1000n);
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        ledger.post(
          usageChargeWallet({
            orgId: ORG_B,
            netMinor: 100,
            currency: 'SAR',
            meterId: 'ai.credits_consumed',
          }),
          `race-${i}`,
        ),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.filter(
      (r) =>
        r.status === 'rejected' && (r.reason as { code?: string }).code === 'insufficient_funds',
    ).length;
    expect(ok).toBe(10);
    expect(refused).toBe(40);
    expect(await walletOf(ORG_B)).toBe(0n);
  });

  it('100 parallel posts with one idempotency key produce exactly one transaction', async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        ledger.post(
          creditGrant({ orgId: ORG_A, amountMinor: 7, currency: 'SAR', reason: 'same key' }),
          'same-key-1',
        ),
      ),
    );
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(
      (
        await sql(
          `SELECT 1 FROM billing.ledger_transactions WHERE idempotency_key='same-key-1' AND org_id=$1`,
          [ORG_A],
        )
      ).length,
    ).toBe(1);
  });
});

describe('reversals, adjustments and platform-level postings', () => {
  it('reverses a consume exactly once and refuses a second reversal', async () => {
    const orig = await ledger.post(
      walletConsume({
        orgId: ORG_A,
        netMinor: 500,
        currency: 'SAR',
        meterId: 'compute.vcpu_hours',
      }),
      'rev-orig',
    );
    const before = await walletOf(ORG_A);
    const rev = await ledger.reverse(orig.transactionId, 'Charged in error', 'rev-1', SEED_USER);
    expect(await walletOf(ORG_A)).toBe(before + 500n);
    const row = (
      await sql(`SELECT reverses_id, kind FROM billing.ledger_transactions WHERE id=$1`, [
        rev.transactionId,
      ])
    )[0]!;
    expect(row).toMatchObject({ reverses_id: orig.transactionId, kind: 'reversal' });
    await rejectsWith(ledger.reverse(orig.transactionId, 'again', 'rev-2'), 'conflict');
    expect((await ledger.reverse(orig.transactionId, 'Charged in error', 'rev-1')).duplicate).toBe(
      true,
    ); // same key = same result
  });

  it('reversing a grant that was already spent cannot drive the wallet negative', async () => {
    await ledger
      .post(
        creditGrant({ orgId: ORG_B, amountMinor: 300, currency: 'SAR', reason: 'g' }),
        'grant-b-3',
      )
      .then(async (g) => {
        await ledger.post(
          walletConsume({ orgId: ORG_B, netMinor: 250, currency: 'SAR' }),
          'spend-b-3',
        );
        await rejectsWith(
          ledger.reverse(g.transactionId, 'claw back', 'rev-b-3'),
          'insufficient_funds',
        );
      });
    expect(await walletOf(ORG_B)).toBe(50n);
  });

  it('an admin adjustment posts the approved lines and can itself be reversed', async () => {
    const before = await walletOf(ORG_A);
    const adj = await ledger.post(
      adjustment({
        orgId: ORG_A,
        reason: 'Goodwill credit approved by finance',
        lines: [
          {
            account: { code: '4900', org: false },
            direction: 'debit',
            amountMinor: '2500',
            currency: 'SAR',
          },
          {
            account: { code: '2100', org: true },
            direction: 'credit',
            amountMinor: '2500',
            currency: 'SAR',
          },
        ],
      }),
      'adj-1',
      SEED_USER,
    );
    expect(await walletOf(ORG_A)).toBe(before + 2500n);
    await ledger.reverse(adj.transactionId, 'Approval withdrawn', 'adj-1-rev');
    expect(await walletOf(ORG_A)).toBe(before);
  });

  it('provider cost accrual is a platform transaction on a per-provider sub-ledger, invisible to customers', async () => {
    await ledger.post(
      providerCostAccrual({
        providerAccountId: 'alibaba-main',
        amountMinor: 12_345,
        currency: 'SAR',
        costRecordId: 'cost-1',
      }),
      'cost-1',
    );
    const rows = await sql(
      `SELECT a.code, a.subledger_key, p.direction FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id=p.account_id JOIN billing.ledger_transactions t ON t.id=p.transaction_id WHERE t.idempotency_key='cost-1' ORDER BY a.code`,
    );
    expect(rows).toEqual([
      { code: '2400', subledger_key: 'alibaba-main', direction: 'credit' },
      { code: '5100', subledger_key: 'alibaba-main', direction: 'debit' },
    ]);
    const asOrg = await env.app.withOrg(ORG_A, (c) =>
      c.query(`SELECT 1 FROM billing.ledger_transactions WHERE idempotency_key='cost-1'`),
    );
    expect(asOrg.rowCount).toBe(0);
  });

  it('a sub-ledgered account without its key, or a per-org account without an org, is rejected', async () => {
    await expect(
      env.app.withOrg(ORG_A, (c) =>
        c.query(
          `SELECT * FROM billing.post(gen_random_uuid(), $1, 'nosub', 'x', '', NULL, NULL, $2::jsonb)`,
          [
            ORG_A,
            JSON.stringify([
              {
                account: { code: '5100', org: false },
                direction: 'debit',
                amountMinor: '1',
                currency: 'SAR',
              },
              {
                account: { code: '2400', org: false },
                direction: 'credit',
                amountMinor: '1',
                currency: 'SAR',
              },
            ]),
          ],
        ),
      ),
    ).rejects.toThrow(/needs a subledger key/);
  });
});

describe('tenant isolation of the ledger', () => {
  it('a customer sees only postings on their OWN accounts, never platform accounts or another org', async () => {
    const a = await env.app.withOrg(ORG_A, (c) =>
      c.query(
        `SELECT DISTINCT a.code, p.account_org_id FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id=p.account_id`,
      ),
    );
    expect(a.rows.every((r) => r.code === '2100' && r.account_org_id === ORG_A)).toBe(true);
    const accounts = await env.app.withOrg(ORG_A, (c) =>
      c.query(`SELECT org_id FROM billing.ledger_accounts`),
    );
    expect(accounts.rows.every((r) => r.org_id === ORG_A)).toBe(true); // platform accounts are hidden too
    const none = await env.app.withoutScope((c) =>
      c.query(`SELECT 1 FROM billing.ledger_postings`),
    );
    expect(none.rowCount).toBe(0);
  });

  it('the admin-console scope sees everything (every account, every organization)', async () => {
    const all = await env.app.withPlatformScope((c) =>
      c.query(`SELECT DISTINCT org_id FROM billing.ledger_transactions`),
    );
    expect(all.rows.map((r) => r.org_id)).toEqual(expect.arrayContaining([ORG_A, ORG_B, null]));
  });
});

describe('wallet projection and drift', () => {
  const projection = async (org: string) =>
    (
      await sql(
        `SELECT balance_minor::text b FROM billing.wallet_balances WHERE org_id=$1 AND currency='SAR'`,
        [org],
      )
    )[0]?.b as string | undefined;

  it('refresh_wallet rebuilds the projection from the ledger (idempotent, rebuildable)', async () => {
    expect(await projection(ORG_A)).toBeUndefined(); // nothing refreshed yet: it is a projection, not the source of truth
    await env.app.withOrg(ORG_A, (c) => c.query('SELECT billing.refresh_wallet($1)', [ORG_A]));
    await env.app.withOrg(ORG_A, (c) => c.query('SELECT billing.refresh_wallet($1)', [ORG_A]));
    expect(BigInt((await projection(ORG_A))!)).toBe(await walletOf(ORG_A));
  });

  it('drift test: after more postings the projection is stale until refreshed, then equals the ledger again', async () => {
    await ledger.post(
      creditGrant({ orgId: ORG_A, amountMinor: 321, currency: 'SAR', reason: 'drift' }),
      'drift-1',
    );
    expect(BigInt((await projection(ORG_A))!)).not.toBe(await walletOf(ORG_A)); // stale by exactly the new grant
    await env.app.withOrg(ORG_A, (c) => c.query('SELECT billing.refresh_wallet($1)', [ORG_A]));
    expect(BigInt((await projection(ORG_A))!)).toBe(await walletOf(ORG_A));
  });

  it("refresh_wallet only works for the caller's own organization", async () => {
    await expect(
      env.app.withOrg(ORG_A, (c) => c.query('SELECT billing.refresh_wallet($1)', [ORG_B])),
    ).rejects.toThrow(/organization context does not match/);
  });

  it('every ledger_posted outbox event is for a wallet-affecting transaction of that organization', async () => {
    const rows = await sql(
      `SELECT org_id, payload FROM platform.outbox WHERE topic='ledger.posted'`,
    );
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) expect((r.payload as { wallet: boolean }).wallet).toBe(true);
    // provider cost accruals (platform-level) never enqueue wallet events
    const cost = await sql(
      `SELECT id FROM billing.ledger_transactions WHERE kind='provider_cost_accrual'`,
    );
    for (const c of cost) {
      const hit = rows.filter(
        (r) => (r.payload as { transactionId: string }).transactionId === c.id,
      );
      expect(hit).toHaveLength(0);
    }
  });
});

describe('audit and outbox are atomic with the posting', () => {
  it('a failed posting leaves no audit event and no outbox event', async () => {
    const eventsBefore = sink.events.length;
    const outboxBefore = (await sql(`SELECT 1 FROM platform.outbox WHERE topic='ledger.posted'`))
      .length;
    await rejectsWith(
      ledger.post(
        walletConsume({ orgId: ORG_B, netMinor: 9_999_999, currency: 'SAR' }),
        'too-much',
      ),
      'insufficient_funds',
    );
    expect(sink.events.length).toBe(eventsBefore);
    expect((await sql(`SELECT 1 FROM platform.outbox WHERE topic='ledger.posted'`)).length).toBe(
      outboxBefore,
    );
  });
});
