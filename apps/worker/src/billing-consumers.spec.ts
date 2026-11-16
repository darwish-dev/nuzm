import { describe, expect, it } from 'vitest';
import type { Db } from '@nuzm/platform';
import { walletProjector } from './billing-consumers';

describe('walletProjector', () => {
  it('refreshes exactly the organization named by the event, inside that organization context', async () => {
    const calls: { org: string; sql: string; params: unknown[] }[] = [];
    const db = {
      withOrg: async (
        org: string,
        fn: (c: { query: (s: string, p: unknown[]) => Promise<unknown> }) => Promise<unknown>,
      ) => fn({ query: async (sql, params) => void calls.push({ org, sql, params }) }),
    } as unknown as Db;
    await walletProjector(db)({}, { eventId: 'e1', orgId: 'org-1' });
    expect(calls).toEqual([
      { org: 'org-1', sql: 'SELECT billing.refresh_wallet($1)', params: ['org-1'] },
    ]);
  });
});
