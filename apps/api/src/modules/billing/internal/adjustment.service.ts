import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { LedgerPostingService } from './ledger.service';
import { adjustment, type PostingLine } from './recipes';
import { UUID } from '@nuzm/domain';

type Row = Record<string, unknown>;

export interface AdjustmentDto {
  id: string;
  orgId: string;
  reversesTransactionId: string | null;
  lines: PostingLine[] | null;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  transactionId: string | null;
  createdAt: string;
}
const dto = (r: Row): AdjustmentDto => ({
  id: r.id as string,
  orgId: r.org_id as string,
  reversesTransactionId: (r.reverses_transaction_id as string | null) ?? null,
  lines: (r.lines as PostingLine[] | null) ?? null,
  reason: r.reason as string,
  status: r.status as AdjustmentDto['status'],
  requestedBy: r.requested_by as string,
  decidedBy: (r.decided_by as string | null) ?? null,
  decidedAt: r.decided_at ? (r.decided_at as Date).toISOString() : null,
  decisionNote: (r.decision_note as string | null) ?? null,
  transactionId: (r.transaction_id as string | null) ?? null,
  createdAt: (r.created_at as Date).toISOString(),
});

/**
 * Manual ledger adjustments with two-person approval (docs/04 `/v1/admin/billing/adjustments`, docs/11 §3). A request stores
 * the proposal; ONLY a different person's approval posts it, through `billing.post` (idempotent per request, append-only,
 * balanced), so a retry after an uncertain result reconciles instead of double posting. Customers never see these rows.
 */
export class AdjustmentService {
  constructor(
    private readonly db: Db,
    private readonly ledger: LedgerPostingService,
    private readonly audit: AuditSink,
  ) {}

  async request(
    requestedBy: string,
    input: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<{ adjustment: AdjustmentDto; replayed: boolean }> {
    if (idempotencyKey.length < 1 || idempotencyKey.length > 255)
      throw new ProblemException('validation_failed', 'Idempotency-Key must be 1..255 characters');
    const orgId = input.orgId;
    if (typeof orgId !== 'string' || !UUID.test(orgId))
      throw new ProblemException('validation_failed', 'orgId must be a uuid');
    if (
      typeof input.reason !== 'string' ||
      input.reason.trim().length < 1 ||
      input.reason.length > 500
    )
      throw new ProblemException('validation_failed', 'reason must be 1..500 characters');
    const reverses = input.reverses ?? null;
    const lines = input.lines ?? null;
    if ((reverses === null) === (lines === null))
      throw new ProblemException(
        'validation_failed',
        'send exactly one of reverses (a transaction id) or lines',
      );
    if (reverses !== null && (typeof reverses !== 'string' || !UUID.test(reverses)))
      throw new ProblemException('validation_failed', 'reverses must be a transaction id');
    if (lines !== null) {
      // validates shape, minor-unit strings, currency, balance per currency, at least two lines (throws validation_failed)
      adjustment({ orgId, lines: lines as PostingLine[], reason: input.reason });
    }
    const reason = input.reason.trim();
    const hash = createHash('sha256')
      .update(JSON.stringify({ orgId: orgId.toLowerCase(), reason, reverses, lines }))
      .digest('hex');
    const id = uuidv7();
    return this.db.withPlatformScope(async (c) => {
      const prior = (
        await c.query(
          `SELECT * FROM billing.adjustment_requests WHERE requested_by = $1 AND idempotency_key = $2`,
          [requestedBy, idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== hash) throw new ProblemException('idempotency_key_reuse');
        return { adjustment: dto(prior), replayed: true };
      }
      if (!(await c.query(`SELECT 1 FROM tenancy.organizations WHERE id = $1`, [orgId])).rowCount)
        throw new ProblemException('not_found', 'organization not found');
      if (reverses !== null) {
        const t = (
          await c.query(`SELECT org_id FROM billing.ledger_transactions WHERE id = $1`, [reverses])
        ).rows[0];
        if (!t || t.org_id !== orgId.toLowerCase())
          throw new ProblemException('not_found', 'no such transaction in this organization');
        if (
          (
            await c.query(`SELECT 1 FROM billing.ledger_transactions WHERE reverses_id = $1`, [
              reverses,
            ])
          ).rowCount
        )
          throw new ProblemException('conflict', 'this transaction has already been reversed');
      }
      const row = (
        await c.query(
          `INSERT INTO billing.adjustment_requests (id, org_id, reverses_transaction_id, lines, reason, requested_by, idempotency_key, request_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [
            id,
            orgId,
            reverses,
            lines === null ? null : JSON.stringify(lines),
            reason,
            requestedBy,
            idempotencyKey,
            hash,
          ],
        )
      ).rows[0]!;
      await this.audit.record({
        action: 'billing.adjustment.requested',
        actorUserId: requestedBy,
        orgId,
        resource: { type: 'adjustment_request', id },
        outcome: 'success',
        after: { reverses, lineCount: lines === null ? null : (lines as unknown[]).length },
      });
      return { adjustment: dto(row), replayed: false };
    });
  }

  async decide(approverId: string, input: Record<string, unknown>): Promise<AdjustmentDto> {
    const id = input.adjustmentId;
    if (typeof id !== 'string' || !UUID.test(id))
      throw new ProblemException('validation_failed', 'adjustmentId must be a uuid');
    if (input.decision !== 'approve' && input.decision !== 'reject')
      throw new ProblemException('validation_failed', "decision must be 'approve' or 'reject'");
    if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 500))
      throw new ProblemException('validation_failed', 'note must be at most 500 characters');
    const note = typeof input.note === 'string' ? input.note : null;
    const req = (await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(`SELECT * FROM billing.adjustment_requests WHERE id = $1`, [
            id.toLowerCase(),
          ])
        ).rows[0],
    )) as Row | undefined;
    if (!req) throw new ProblemException('not_found');
    if (req.status !== 'pending')
      throw new ProblemException('conflict', `this request is already ${req.status as string}`);
    if (req.requested_by === approverId)
      throw new ProblemException(
        'forbidden',
        'a second person must decide this adjustment (two-person approval)',
      );

    let transactionId: string | null = null;
    if (input.decision === 'approve') {
      // posting first and idempotently: if the process dies before the status update, the retry finds the same transaction
      const key = `adjustment:${req.id as string}`;
      const reason = req.reason as string;
      const r =
        req.reverses_transaction_id !== null
          ? await this.ledger.reverse(
              req.reverses_transaction_id as string,
              reason,
              key,
              approverId,
            )
          : await this.ledger.post(
              adjustment({
                orgId: req.org_id as string,
                lines: req.lines as PostingLine[],
                reason,
              }),
              key,
              approverId,
            );
      transactionId = r.transactionId;
    }
    return this.db.withPlatformScope(async (c) => {
      const row = (
        await c.query(
          `UPDATE billing.adjustment_requests SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4, transaction_id = $5
            WHERE id = $1 AND status = 'pending' RETURNING *`,
          [
            req.id,
            input.decision === 'approve' ? 'approved' : 'rejected',
            approverId,
            note,
            transactionId,
          ],
        )
      ).rows[0];
      if (!row) throw new ProblemException('conflict', 'this request was decided concurrently');
      await this.audit.record({
        action:
          input.decision === 'approve'
            ? 'billing.adjustment.approved'
            : 'billing.adjustment.rejected',
        actorUserId: approverId,
        orgId: req.org_id as string,
        resource: { type: 'adjustment_request', id: req.id as string },
        outcome: 'success',
        after: { transactionId },
      });
      return dto(row);
    });
  }
}
