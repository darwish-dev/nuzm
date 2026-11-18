import { describe, expect, it } from 'vitest';
import { ctx } from './test-kit';
import {
  providerCacheSkeleton,
  providerDatabaseSkeleton,
  providerMailboxSkeleton,
  providerObjectStorageSkeleton,
  providerTransactionalEmailSkeleton,
} from './provider-skeleton';

describe('provider-* skeletons: undocumented => every capability unknown, every call unsupported', () => {
  it.each([
    ['database', providerDatabaseSkeleton()],
    ['cache', providerCacheSkeleton()],
    ['object-storage', providerObjectStorageSkeleton()],
    ['transactional-email', providerTransactionalEmailSkeleton()],
    ['mailbox', providerMailboxSkeleton()],
  ] as const)('%s', async (kind, a) => {
    expect(a.kind).toBe(kind);
    const p = await a.probe(ctx);
    expect(Object.values(p.capabilities).every((c) => c === 'unknown')).toBe(true);
    type Lookup = {
      findByToken?: (
        c: typeof ctx,
        t: string,
      ) => Promise<{ status: string; error?: { category: string } }>;
      findBucketByToken?: (
        c: typeof ctx,
        t: string,
      ) => Promise<{ status: string; error?: { category: string } }>;
    };
    const l = a as unknown as Lookup;
    const r = await (l.findByToken ?? l.findBucketByToken)!.call(a, ctx, 'x');
    expect(r.status).toBe('failed');
    expect(r.error?.category).toBe('unsupported');
  });
});
