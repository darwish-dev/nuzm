import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxRelay, enqueue, eventId } from '@nuzm/platform';
import { ORG_A, ORG_B, createEnv, type TestEnv } from '@nuzm/platform/testing';
import { walletProjector } from './billing-consumers';

let env: TestEnv;
beforeAll(async () => {
  env = await createEnv();
});
afterAll(() => env.close());

const grant = (org: string, key: string, amount: string) =>
  env.app.withOrg(org, async (c) => {
    await c.query(
      `SELECT * FROM billing.post(gen_random_uuid(), $1, $2, 'credit_grant', 'g', NULL, NULL, $3::jsonb)`,
      [
        org,
        key,
        JSON.stringify([
          {
            account: { code: '4900', org: false },
            direction: 'debit',
            amountMinor: amount,
            currency: 'SAR',
          },
          {
            account: { code: '2100', org: true },
            direction: 'credit',
            amountMinor: amount,
            currency: 'SAR',
          },
        ]),
      ],
    );
    await enqueue(c, org, 'ledger.posted', { wallet: true });
  });
const projection = async (org: string) =>
  (
    await env.sql(
      `SELECT balance_minor::text b FROM billing.wallet_balances WHERE org_id=$1 AND currency='SAR'`,
      [org],
    )
  )[0]?.b;

describe('wallet projection consumer (outbox → nuzm_worker → billing.refresh_wallet)', () => {
  it('projects each organization from its own ledger, and redelivery is harmless', async () => {
    await grant(ORG_A, 'a-1', '1000');
    await grant(ORG_A, 'a-2', '250');
    await grant(ORG_B, 'b-1', '77');
    const relay = new OutboxRelay(env.worker, { batch: 50, lockSeconds: 30 });
    const handler = walletProjector(env.worker);
    const seen: string[] = [];
    const r = await relay.runOnce(async (row) => {
      seen.push(eventId(row));
      await handler(row.payload, { eventId: eventId(row), orgId: row.org_id });
    });
    expect(r).toEqual({ delivered: 3, failed: 0 });
    expect(await projection(ORG_A)).toBe('1250');
    expect(await projection(ORG_B)).toBe('77');
    // at-least-once: running the handler again for every event changes nothing
    for (const id of seen) await handler({}, { eventId: id, orgId: ORG_A });
    expect(await projection(ORG_A)).toBe('1250');
  });

  it('a late event after more postings catches the projection up (rebuild, not increment)', async () => {
    await grant(ORG_A, 'a-3', '5');
    expect(await projection(ORG_A)).toBe('1250'); // stale until the consumer runs: it is a projection
    const relay = new OutboxRelay(env.worker, { batch: 50, lockSeconds: 30 });
    const handler = walletProjector(env.worker);
    await relay.runOnce((row) =>
      handler(row.payload, { eventId: eventId(row), orgId: row.org_id }),
    );
    expect(await projection(ORG_A)).toBe('1255');
  });

  it('the worker role cannot write the ledger or the projection directly', async () => {
    await expect(
      env.worker.withOrg(ORG_A, (c) =>
        c.query(`UPDATE billing.wallet_balances SET balance_minor = 1`),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      env.worker.withOrg(ORG_A, (c) =>
        c.query(
          `INSERT INTO billing.ledger_transactions (id, org_id, idempotency_key, request_hash, kind) VALUES (gen_random_uuid(), $1,'w','h','k')`,
          [ORG_A],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
