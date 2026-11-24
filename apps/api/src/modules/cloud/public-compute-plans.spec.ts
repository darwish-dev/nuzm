import { afterEach, describe, expect, it } from 'vitest';
import { PublicComputePlansController } from './public-compute-plans.controller';
import type { OfferService } from './internal/offer.service';

const plans = [
  {
    vcpu: 1,
    memoryMb: 1024,
    diskGb: 20,
    price: { amountMinor: '5380', currency: 'SAR' },
    regions: ['gcc'],
  },
];
const ctl = (fail = false) =>
  new PublicComputePlansController({
    publicPlans: async () => {
      if (fail) throw new Error('catalog unavailable');
      return plans;
    },
  } as unknown as OfferService);

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe('public compute plans', () => {
  it('lists the sizes outside production, and nothing when the catalog fails (never a made-up list)', async () => {
    process.env.NODE_ENV = 'test';
    expect(await ctl().list()).toEqual({ items: plans });
    expect(await ctl(true).list()).toEqual({ items: [] });
  });

  it('is off in production until PUBLIC_PLANS_ENABLED=true, and can be switched off elsewhere', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.PUBLIC_PLANS_ENABLED;
    expect(await ctl().list()).toEqual({ items: [] });
    process.env.PUBLIC_PLANS_ENABLED = 'true';
    expect(await ctl().list()).toEqual({ items: plans });
    process.env.NODE_ENV = 'test';
    process.env.PUBLIC_PLANS_ENABLED = 'false';
    expect(await ctl().list()).toEqual({ items: [] });
  });
});
