import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '@nuzm/platform';
import { PublicUsagePricesController } from './public-usage-prices.controller';
import type { PriceBookService } from './internal/price-book.service';

const item = (meterId: string) => ({
  meterId,
  tierModel: 'flat' as const,
  unitPriceMinor: '1',
  tiers: null,
  includedAllowance: '0',
  rounding: 'half_up',
});
const book = (production: boolean) => ({
  placeholder: true,
  versions: [
    {
      effectiveFrom: '2026-01-01T00:00:00Z',
      items: [
        item('ai.credits_consumed'),
        item('compute.vcpu_hours'),
        item('email.transactional_messages'),
      ],
    },
  ],
  production,
});
const ctl = (refuse = false) =>
  new PublicUsagePricesController(
    { withPlatformScope: async (fn: (c: unknown) => unknown) => fn({}) } as unknown as Db,
    {
      resolveForRating: async (_c: unknown, _cur: string, o: { production: boolean }) => {
        if (refuse && o.production) throw new Error('placeholder book refused');
        return book(o.production);
      },
    } as unknown as PriceBookService,
  );

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe('public usage prices', () => {
  it('lists only the short fixed list of meters (compute and the rest are never published here)', async () => {
    process.env.NODE_ENV = 'test';
    const r = await ctl().list();
    expect(r.items.map((i) => i.meterId).sort()).toEqual([
      'ai.credits_consumed',
      'email.transactional_messages',
    ]);
  });

  it('is empty in production while the book is the placeholder, and while the switch is off', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PUBLIC_PLANS_ENABLED = 'true';
    expect((await ctl(true).list()).items).toEqual([]);
    delete process.env.PUBLIC_PLANS_ENABLED;
    expect((await ctl().list()).items).toEqual([]);
  });
});
