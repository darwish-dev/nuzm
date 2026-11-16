import { v7 as uuidv7 } from 'uuid';
import { enqueue, type Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { assertBalanced, reversal, type Built, type PostingLine } from './recipes';

export interface PostResult {
  transactionId: string;
  /** True when the idempotency key had already been used with the same request (nothing was written). */
  duplicate: boolean;
}

interface PgError {
  code?: string;
  hint?: string;
  message?: string;
}

/**
 * The ONLY writer of ledger postings. It calls `billing.post()` (runtime roles have no INSERT on the ledger tables),
 * inside the organization's own transaction so the posting, its audit row and its wallet-refresh outbox event commit
 * together or not at all. Platform-level transactions (no organization) run in the admin-console scope.
 */
export class LedgerPostingService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  /** Post one recipe. `idempotencyKey` is the business event id; repeating it returns the first result. */
  async post(built: Built, idempotencyKey: string, actorUserId?: string): Promise<PostResult> {
    assertBalanced(built.postings);
    if (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.length < 1 ||
      idempotencyKey.length > 200
    )
      throw new ProblemException('validation_failed', 'idempotency key must be 1..200 characters');
    const txId = uuidv7();
    const run = async (c: import('pg').PoolClient): Promise<PostResult> => {
      const { rows } = await c.query<{ transaction_id: string; duplicate: boolean }>(
        'SELECT * FROM billing.post($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',
        [
          txId,
          built.orgId,
          idempotencyKey,
          built.kind,
          built.description,
          built.sourceEventId ?? null,
          actorUserId ?? null,
          JSON.stringify(built.postings),
          built.reversesId ?? null,
        ],
      );
      const r = rows[0]!;
      if (!r.duplicate) {
        if (built.orgId && built.affectsWallet)
          await enqueue(c, built.orgId, 'ledger.posted', {
            transactionId: r.transaction_id,
            wallet: true,
          });
        await this.audit.record({
          action: 'billing.ledger.posted',
          orgId: built.orgId ?? undefined,
          actorUserId,
          resource: { type: 'ledger_transaction', id: r.transaction_id },
          outcome: 'success',
          detail: { kind: built.kind, reverses: built.reversesId ?? null },
        });
      }
      return { transactionId: r.transaction_id, duplicate: r.duplicate };
    };
    try {
      return built.orgId
        ? await this.db.withOrg(built.orgId, run)
        : await this.db.withPlatformScope(run);
    } catch (e) {
      throw this.map(e);
    }
  }

  /**
   * Reverse a transaction (never an edit): reads the original postings in the admin scope, then posts the mirror image
   * referencing it. A transaction can be reversed once (unique index); a repeat with the same key is a duplicate.
   */
  async reverse(
    originalId: string,
    reason: string,
    idempotencyKey: string,
    actorUserId?: string,
  ): Promise<PostResult> {
    const { orgId, postings } = await this.db.withPlatformScope(async (c) => {
      const tx = (
        await c.query<{ org_id: string | null }>(
          'SELECT org_id FROM billing.ledger_transactions WHERE id = $1',
          [originalId],
        )
      ).rows[0];
      if (!tx) throw new ProblemException('not_found');
      const rows = (
        await c.query<{
          code: string;
          account_org_id: string | null;
          subledger_key: string | null;
          direction: 'debit' | 'credit';
          amount_minor: string;
          currency: string;
          dimensions: Record<string, unknown>;
        }>(
          `SELECT a.code, p.account_org_id, a.subledger_key, p.direction, p.amount_minor::text, p.currency, p.dimensions
             FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id = p.account_id
            WHERE p.transaction_id = $1 ORDER BY p.created_at, p.id`,
          [originalId],
        )
      ).rows;
      const postings: PostingLine[] = rows.map((r) => ({
        account: {
          code: r.code,
          org: r.account_org_id !== null,
          ...(r.subledger_key ? { subledger: r.subledger_key } : {}),
        },
        direction: r.direction,
        amountMinor: r.amount_minor,
        currency: r.currency,
        dimensions: r.dimensions,
      }));
      return { orgId: tx.org_id, postings };
    });
    return this.post(
      reversal({ orgId, originalId, original: postings, reason }),
      idempotencyKey,
      actorUserId,
    );
  }

  private map(e: unknown): unknown {
    const pg = e as PgError;
    if (pg.hint === 'idempotency_key_reuse') return new ProblemException('idempotency_key_reuse');
    if (pg.hint === 'insufficient_funds') return new ProblemException('insufficient_funds');
    if (pg.code === '23505' && /ledger_transactions_reverses_idx/.test(pg.message ?? ''))
      return new ProblemException('conflict', 'this transaction was already reversed');
    if (pg.code === '23514' && /unbalanced ledger transaction/.test(pg.message ?? ''))
      return new ProblemException('validation_failed', 'postings do not balance');
    if (pg.code === '22023') return new ProblemException('validation_failed', pg.message);
    return e;
  }
}
