import type { Db } from '@nuzm/platform';

/**
 * Outbox consumer for `ledger.posted`: refreshes the org's wallet projection from the ledger. The refresh is a
 * rebuild (sum of the 2100 postings), so redelivery, reordering and replays are all harmless (at-least-once safe).
 */
export function walletProjector(db: Db) {
  return async (_payload: unknown, meta: { eventId: string; orgId: string }): Promise<void> => {
    await db.withOrg(meta.orgId, (c) => c.query('SELECT billing.refresh_wallet($1)', [meta.orgId]));
  };
}
