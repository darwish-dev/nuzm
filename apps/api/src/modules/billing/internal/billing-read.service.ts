import type { Db } from '@nuzm/platform';
import {
  cursorTimeSql,
  decodeCursor,
  decodeTimeCursor,
  encodeTimeCursor,
} from '../../../common/pagination';

export interface StatementFilter {
  limit: number;
  cursor?: string | null;
  from?: Date;
  to?: Date;
  kind?: string;
}

/** Read side of the ledger: customer statement/balance, and the finance/admin views. RLS does tenant isolation. */
export class BillingReadService {
  constructor(private readonly db: Db) {}

  /**
   * Wallet statement: postings on the organization's own wallet account (2100) with a running balance. Platform accounts
   * are never exposed: RLS only lets an organization see postings whose account belongs to it.
   */
  async statement(orgId: string, f: StatementFilter) {
    const cur = decodeTimeCursor(f.cursor);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM (
               SELECT p.id, p.transaction_id, p.created_at, ${cursorTimeSql('p.created_at')} AS cursor_t, t.kind, t.description, t.source_event_id, p.direction,
                      p.amount_minor::text AS amount_minor, p.currency,
                      (sum(CASE p.direction WHEN 'credit' THEN p.amount_minor ELSE -p.amount_minor END)
                         OVER (PARTITION BY p.currency ORDER BY p.created_at, p.id))::text AS balance_minor
                 FROM billing.ledger_postings p
                 JOIN billing.ledger_accounts a ON a.id = p.account_id
                 JOIN billing.ledger_transactions t ON t.id = p.transaction_id
                WHERE a.code = '2100'
             ) s
              WHERE ($1::timestamptz IS NULL OR created_at >= $1) AND ($2::timestamptz IS NULL OR created_at < $2)
                AND ($3::text IS NULL OR kind = $3)
                AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
              ORDER BY created_at DESC, id DESC LIMIT $6`,
            [
              f.from ?? null,
              f.to ?? null,
              f.kind ?? null,
              cur?.t ?? null,
              cur?.id ?? null,
              f.limit + 1,
            ],
          )
        ).rows,
    );
    const items = rows.slice(0, f.limit).map((r) => ({
      id: r.id as string,
      transactionId: r.transaction_id as string,
      occurredAt: (r.created_at as Date).toISOString(),
      kind: r.kind as string,
      description: r.description as string,
      direction: r.direction as 'debit' | 'credit',
      amountMinor: r.amount_minor as string,
      currency: (r.currency as string).trim(),
      balanceMinor: r.balance_minor as string,
      reference: (r.source_event_id as string | null) ?? null,
    }));
    const last = rows.length > f.limit ? rows[f.limit - 1] : undefined;
    return {
      items,
      nextCursor: last ? encodeTimeCursor(last.cursor_t as string, last.id as string) : null,
    };
  }

  /** Wallet balance per currency from the projection (RC-06 compares it with the ledger). */
  async balance(orgId: string) {
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT currency, balance_minor::text AS balance_minor FROM billing.wallet_balances WHERE org_id = $1 ORDER BY currency`,
            [orgId],
          )
        ).rows,
    );
    return {
      balances: rows.map((r) => ({
        currency: (r.currency as string).trim(),
        balanceMinor: r.balance_minor as string,
      })),
    };
  }

  // ---- admin ---------------------------------------------------------------------------------------------
  async adminAccounts(o: { limit: number; cursor?: string | null; code?: string; orgId?: string }) {
    const cur = decodeCursor(o.cursor);
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT a.id, a.code, a.name, a.type, a.normal_side, a.org_id, a.subledger_key, a.currency,
                    coalesce(sum(CASE WHEN p.direction = a.normal_side THEN p.amount_minor ELSE -p.amount_minor END), 0)::text AS balance_minor
               FROM billing.ledger_accounts a LEFT JOIN billing.ledger_postings p ON p.account_id = a.id
              WHERE ($1::text IS NULL OR a.code = $1) AND ($2::uuid IS NULL OR a.org_id = $2) AND ($3::uuid IS NULL OR a.id > $3)
              GROUP BY a.id ORDER BY a.id LIMIT $4`,
            [o.code ?? null, o.orgId ?? null, cur, o.limit + 1],
          )
        ).rows,
    );
    const items = rows.slice(0, o.limit).map((r) => ({
      id: r.id as string,
      code: r.code as string,
      name: r.name as string,
      type: r.type as string,
      normalSide: r.normal_side as 'debit' | 'credit',
      orgId: (r.org_id as string | null) ?? null,
      subledgerKey: (r.subledger_key as string | null) ?? null,
      currency: (r.currency as string).trim(),
      balanceMinor: r.balance_minor as string,
    }));
    return {
      items,
      nextCursor:
        rows.length > o.limit
          ? Buffer.from(items[items.length - 1]!.id).toString('base64url')
          : null,
    };
  }

  async adminTransactions(o: {
    limit: number;
    cursor?: string | null;
    orgId?: string;
    kind?: string;
  }) {
    const cur = decodeTimeCursor(o.cursor);
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT t.id, t.org_id, t.kind, t.description, t.idempotency_key, t.reverses_id, t.occurred_at, ${cursorTimeSql('t.occurred_at')} AS cursor_t,
                    (SELECT json_agg(json_build_object('accountCode', a.code, 'direction', p.direction,
                              'amountMinor', p.amount_minor::text, 'currency', p.currency, 'dimensions', p.dimensions)
                             ORDER BY p.created_at, p.id)
                       FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id = p.account_id
                      WHERE p.transaction_id = t.id) AS postings
               FROM billing.ledger_transactions t
              WHERE ($1::uuid IS NULL OR t.org_id = $1) AND ($2::text IS NULL OR t.kind = $2)
                AND ($3::timestamptz IS NULL OR (t.occurred_at, t.id) < ($3::timestamptz, $4::uuid))
              ORDER BY t.occurred_at DESC, t.id DESC LIMIT $5`,
            [o.orgId ?? null, o.kind ?? null, cur?.t ?? null, cur?.id ?? null, o.limit + 1],
          )
        ).rows,
    );
    const items = rows.slice(0, o.limit).map((r) => ({
      id: r.id as string,
      orgId: (r.org_id as string | null) ?? null,
      kind: r.kind as string,
      description: r.description as string,
      idempotencyKey: r.idempotency_key as string,
      reversesId: (r.reverses_id as string | null) ?? null,
      occurredAt: (r.occurred_at as Date).toISOString(),
      postings: (r.postings ?? []) as unknown[],
    }));
    const last = rows.length > o.limit ? rows[o.limit - 1] : undefined;
    return {
      items,
      nextCursor: last ? encodeTimeCursor(last.cursor_t as string, last.id as string) : null,
    };
  }
}
