import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { LedgerPostingService } from './ledger.service';
import { parseCurrency, parseMinor, walletTopUp } from './recipes';
import { UUID } from '@nuzm/domain';

type Row = Record<string, unknown>;

export interface WalletTopupDto {
  id: string;
  amountMinor: string;
  currency: string;
  status: 'pending' | 'credited';
  createdAt: string;
  creditedAt: string | null;
}
const dto = (r: Row): WalletTopupDto => ({
  id: r.id as string,
  amountMinor: String(r.amount_minor),
  currency: (r.currency as string).trim(),
  status: r.status as WalletTopupDto['status'],
  createdAt: (r.created_at as Date).toISOString(),
  creditedAt: r.credited_at ? (r.credited_at as Date).toISOString() : null,
});

export interface WalletPolicy {
  minMinor: bigint;
  maxMinor: bigint;
  /**
   * When VAT on prepaid credit is booked (D-25, [VERIFY HG-03-04]). Only `consumption` is implemented: top-ups post no VAT and each
   * consumption carries it. `topup` would need an advance-payment tax document, which is not built, so it is refused at start-up.
   */
  vatTiming: 'consumption';
}

export function walletPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): WalletPolicy {
  const timing = env.WALLET_VAT_TIMING ?? 'consumption';
  if (timing !== 'consumption')
    throw new Error(
      `WALLET_VAT_TIMING=${timing} is not supported yet: only "consumption" is implemented (D-25 / HG-03-04)`,
    );
  const min = BigInt(env.WALLET_TOPUP_MIN_MINOR ?? '1000'); // 10.00 in a 2-decimal currency
  const max = BigInt(env.WALLET_TOPUP_MAX_MINOR ?? '10000000'); // 100,000.00
  if (min < 1n || max < min) throw new Error('WALLET_TOPUP_MIN_MINOR/MAX_MINOR are inconsistent');
  return { minMinor: min, maxMinor: max, vatTiming: 'consumption' };
}

/**
 * Prepaid wallet top-ups and debits (docs/11 §3.1). A top-up is a REQUEST (a row, no ledger entry); the wallet is credited only when the
 * payment for it is captured, through the `walletTopUp` recipe and `billing.post`, idempotently. Consumption debits go through the
 * same ledger service and can never overdraw the wallet (the ledger enforces it).
 */
export class WalletTopupService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ledger: Pick<LedgerPostingService, 'post'>,
    private readonly policy: WalletPolicy = walletPolicyFromEnv(),
  ) {}

  /** Parse `{amount:{amount,currency}}` (docs/04 money shape) against the policy: integer minor units, min/max. */
  parseAmount(input: unknown): { amountMinor: string; currency: string } {
    const a = (input ?? null) as { amount?: unknown; currency?: unknown } | null;
    if (typeof a !== 'object' || a === null)
      throw new ProblemException('validation_failed', 'amount must be {amount, currency}');
    if (typeof a.amount !== 'string' || typeof a.currency !== 'string')
      throw new ProblemException(
        'validation_failed',
        'amount.amount must be an integer string of minor units and amount.currency a currency code',
      );
    const amountMinor = parseMinor(a.amount, 'amount');
    const currency = parseCurrency(a.currency);
    const n = BigInt(amountMinor);
    if (n < this.policy.minMinor || n > this.policy.maxMinor)
      throw new ProblemException(
        'validation_failed',
        `a top-up must be between ${this.policy.minMinor.toString()} and ${this.policy.maxMinor.toString()} minor units`,
      );
    return { amountMinor, currency };
  }

  async create(
    orgId: string,
    actorUserId: string,
    amount: { amountMinor: string; currency: string },
    now = new Date(),
  ): Promise<WalletTopupDto> {
    const id = uuidv7();
    return this.db.withOrg(orgId, async (c) => {
      const row = (
        await c.query(
          `INSERT INTO billing.wallet_topups (id, org_id, amount_minor, currency, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [id, orgId, amount.amountMinor, amount.currency, actorUserId, now],
        )
      ).rows[0]!;
      await this.audit.record({
        action: 'billing.wallet_topup.requested',
        actorUserId,
        orgId,
        resource: { type: 'wallet_topup', id },
        outcome: 'success',
        after: { amountMinor: amount.amountMinor, currency: amount.currency },
      });
      return dto(row);
    });
  }

  async get(orgId: string, id: string): Promise<WalletTopupDto> {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT * FROM billing.wallet_topups WHERE id = $1 AND org_id = $2`, [
            id,
            orgId,
          ])
        ).rows[0],
    );
    if (!r) throw new ProblemException('not_found', 'wallet top-up not found');
    return dto(r);
  }

  /**
   * Credit the wallet for a captured payment. Idempotent end to end: the ledger key is per payment, and the top-up is marked credited once.
   * A crash between the two steps is repaired by calling this again.
   */
  async credit(
    orgId: string,
    topupId: string,
    p: { paymentId: string; pspAccountCode: string; amountMinor: string; currency: string },
  ): Promise<{ transactionId: string }> {
    const t = await this.get(orgId, topupId);
    if (t.amountMinor !== p.amountMinor || t.currency !== p.currency)
      throw new ProblemException('conflict', 'the captured amount does not match the top-up');
    const r = await this.ledger.post(
      walletTopUp({
        orgId,
        topupId,
        paymentId: p.paymentId,
        pspAccountCode: p.pspAccountCode,
        currency: p.currency,
        amountMinor: p.amountMinor,
      }),
      `payment:${p.paymentId}:capture`,
    );
    await this.db.withOrg(orgId, async (c) => {
      const done = await c.query(
        `UPDATE billing.wallet_topups SET status = 'credited', ledger_transaction_id = $2, credited_at = now() WHERE id = $1 AND status = 'pending'`,
        [topupId, r.transactionId],
      );
      if (done.rowCount)
        await this.audit.record({
          action: 'billing.wallet_topup.credited',
          actorType: 'system',
          orgId,
          resource: { type: 'wallet_topup', id: topupId },
          outcome: 'success',
          after: { transactionId: r.transactionId },
        });
    });
    return { transactionId: r.transactionId };
  }
}
