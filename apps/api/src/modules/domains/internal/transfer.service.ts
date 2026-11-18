import type { Db } from '@nuzm/platform';
import { decodeCursor, pageOf, parseLimit } from '../../../common/pagination';
import type { Row } from './common';

/** Transfer-in list. The auth code reference is never returned (it is a secret pointer); only state and names are. */
export class TransferService {
  constructor(private readonly db: Db) {}
  async list(orgId: string, q: { limit?: unknown; cursor?: unknown }) {
    const limit = parseLimit(q.limit);
    const cursor = decodeCursor(q.cursor);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT id, domain_id, order_id, name, state, failure_code, created_at, updated_at, completed_at FROM domains.domain_transfers WHERE ($1::uuid IS NULL OR id < $1) ORDER BY id DESC LIMIT $2`,
            [cursor, limit + 1],
          )
        ).rows as Row[],
    );
    const page = pageOf(rows as (Row & { id: string })[], limit);
    return {
      nextCursor: page.nextCursor,
      items: page.items.map((r) => ({
        id: r.id,
        domainId: r.domain_id,
        orderId: r.order_id,
        name: r.name,
        state: r.state,
        failureCode: r.failure_code ?? null,
        createdAt: (r.created_at as Date).toISOString(),
        completedAt: r.completed_at ? (r.completed_at as Date).toISOString() : null,
      })),
    };
  }
}
