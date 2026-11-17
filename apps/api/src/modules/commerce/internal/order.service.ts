import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { formatDec, parseDec } from '../../../common/rating';
import type { DunningService, QuotaService, SpendService } from '../../billing';

export interface OrderDto {
  id: string;
  quoteId: string;
  kind: string;
  status: string;
  currency: string;
  totalMinor: string;
  authorizationId: string | null;
  spendApprovalId: string | null;
}

/**
 * Quote → order (no HTTP endpoint in M02: the typed create endpoints of M05-M08 call this with their `quoteId`). Enforces,
 * at the moment of commitment (orders are not counted in the month's spend until M03/M05 define consumption, so concurrent
 * orders under the cap are not serialized): the quote is valid (not expired) and unused, hard quotas still allow it, and the spend cap
 * allows it — or an approved, unused spend approval for exactly this quote covers it (recorded as an authorization).
 */
export class OrderService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly quotas: Pick<QuotaService, 'assertAllowed'>,
    private readonly spend: Pick<SpendService, 'evaluate'>,
    private readonly dunning: Pick<DunningService, 'assertNotRestricted'>,
  ) {}

  async createFromQuote(
    orgId: string,
    quoteId: string,
    actorUserId: string,
    now = new Date(),
  ): Promise<OrderDto> {
    // an organization with an overdue invoice at the restriction stage cannot start NEW purchases (everything it already has keeps working)
    await this.dunning.assertNotRestricted(orgId);
    // 1. read (short transaction): the quote, its items, and whether it was already ordered
    const { q, items, ordered } = await this.db.withOrg(orgId, async (c) => {
      const quote = (
        await c.query(`SELECT * FROM commerce.quotes WHERE id = $1 AND org_id = $2`, [
          quoteId,
          orgId,
        ])
      ).rows[0];
      if (!quote) throw new ProblemException('not_found');
      return {
        q: quote,
        items: (
          await c.query(
            `SELECT * FROM commerce.quote_items WHERE quote_id = $1 ORDER BY position`,
            [quoteId],
          )
        ).rows,
        ordered:
          (
            await c.query(`SELECT 1 FROM commerce.orders WHERE org_id = $1 AND quote_id = $2`, [
              orgId,
              quoteId,
            ])
          ).rowCount === 1,
      };
    });
    if ((q.expires_at as Date).getTime() <= now.getTime())
      throw new ProblemException('gone', 'this quote has expired; request a new one');
    if (ordered) throw new ProblemException('conflict', 'this quote has already been ordered');

    // 2. policy checks (each in its own short transaction; none is held open while another needs a connection)
    const byGroup = new Map<string, bigint>();
    for (const i of items)
      if (i.meter_group)
        byGroup.set(
          i.meter_group as string,
          (byGroup.get(i.meter_group as string) ?? 0n) + parseDec(String(i.quantity)),
        );
    for (const [group, qty] of byGroup)
      await this.quotas.assertAllowed(orgId, group, formatDec(qty), now);
    const currency = (q.currency as string).trim();
    const decision = await this.spend.evaluate(
      orgId,
      {
        amountMinor: String(q.total_minor),
        currency,
        projectId: (q.project_id as string | null) ?? null,
        subject: { kind: 'quote', id: quoteId },
      },
      now,
    );
    if (!decision.allowed)
      throw new ProblemException(
        'spend_approval_required',
        'this order would exceed the monthly spending limit; request an approval for this quote',
      );

    // 3. commit: one transaction; the unique constraints (one order per quote, one order per approval) are the arbiters,
    //    so parallel attempts for the same quote or approval produce exactly one order
    try {
      return await this.db.withOrg(orgId, async (c) => {
        const orderId = uuidv7();
        await c.query(
          `INSERT INTO commerce.orders (id, org_id, quote_id, kind, currency, total_minor, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [orderId, orgId, quoteId, q.kind, currency, String(q.total_minor), actorUserId, now],
        );
        for (const i of items)
          await c.query(
            `INSERT INTO commerce.order_items (id, order_id, org_id, position, description, meter_id, quantity, unit, amount_minor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              uuidv7(),
              orderId,
              orgId,
              i.position,
              i.description,
              i.meter_id,
              String(i.quantity),
              i.unit,
              String(i.amount_minor),
            ],
          );
        let authorizationId: string | null = null;
        if (decision.approvalId) {
          authorizationId = uuidv7();
          await c.query(
            `INSERT INTO commerce.authorizations (id, org_id, kind, order_id, spend_approval_id, amount_minor, currency) VALUES ($1,$2,'spend_approval',$3,$4,$5,$6)`,
            [authorizationId, orgId, orderId, decision.approvalId, String(q.total_minor), currency],
          );
        }
        await this.audit.record({
          action: 'commerce.order.created',
          actorUserId,
          orgId,
          resource: { type: 'order', id: orderId },
          outcome: 'success',
          after: {
            quoteId,
            totalMinor: String(q.total_minor),
            currency,
            spendApprovalId: decision.approvalId,
          },
        });
        return {
          id: orderId,
          quoteId,
          kind: q.kind as string,
          status: 'created',
          currency,
          totalMinor: String(q.total_minor),
          authorizationId,
          spendApprovalId: decision.approvalId,
        };
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException(
          'conflict',
          'this quote or its spend approval has already been used',
        );
      throw e;
    }
  }
}
