import { describe, expect, it } from 'vitest';
import type { Offer } from './compute';
import { familiesIn, regionsOf, selectionFor, sizesFor } from './cloud-config';

const o = (
  id: string,
  over: Partial<Offer> & { vcpu?: number; mem?: number; amount?: string } = {},
): Offer => ({
  offerId: id,
  kind: 'compute',
  family: over.family,
  country: over.country ?? 'SA',
  dataRegion: over.dataRegion ?? 'in_kingdom',
  plan: { vcpu: over.vcpu ?? 2, memoryMb: over.mem ?? 4096, diskGb: 80 },
  price: { amount: over.amount ?? '10000', currency: 'SAR', period: 'month' },
  capabilities: [],
  verifiedAt: null,
});

const offers = [
  o('ae-nova', { family: 'nova', country: 'AE', dataRegion: 'gcc' }),
  o('sa-orbit-2', { family: 'orbit', amount: '8000' }),
  o('sa-nova-4', { family: 'nova', vcpu: 4, mem: 8192, amount: '28440' }),
  o('sa-nova-2', { family: 'nova', amount: '14220' }),
  o('de-atlas', { family: 'atlas', country: 'DE', dataRegion: 'eu' }),
  o('sa-old'), // an API without product lines: the generic line
];

describe('cloud configurator grouping', () => {
  it('lists regions with the Kingdom first, then by country code', () => {
    expect(regionsOf(offers).map((r) => r.country)).toEqual(['SA', 'AE', 'DE']);
    expect(regionsOf(offers)[0]).toMatchObject({ dataRegion: 'in_kingdom', offers: 4 });
  });
  it('lists the product lines of a region in the Nuzm order, each with its cheapest offer', () => {
    const f = familiesIn(offers, 'SA');
    expect(f.map((x) => x.family)).toEqual(['nova', 'orbit', 'core']);
    expect(f[0]).toMatchObject({ sizes: 2 });
    expect(f[0]!.from.offerId).toBe('sa-nova-2');
  });
  it('lists the sizes of one line smallest first', () => {
    expect(sizesFor(offers, 'SA', 'nova').map((x) => x.offerId)).toEqual([
      'sa-nova-2',
      'sa-nova-4',
    ]);
  });
  it('picks the Kingdom, its first line and smallest size by default, and honours a wanted offer', () => {
    expect(selectionFor(offers)).toEqual({ country: 'SA', family: 'nova', offerId: 'sa-nova-2' });
    expect(selectionFor(offers, { offerId: 'de-atlas' })).toEqual({
      country: 'DE',
      family: 'atlas',
      offerId: 'de-atlas',
    });
    expect(selectionFor([])).toBeNull();
  });
  it('a change of region or line keeps the nearest size, and falls back when there is none', () => {
    const big = offers.find((x) => x.offerId === 'sa-nova-4')!;
    const more = [
      ...offers,
      o('sa-orbit-4', { family: 'orbit', vcpu: 4, mem: 8192, amount: '12000' }),
    ];
    expect(selectionFor(more, { country: 'SA', family: 'orbit', like: big })?.offerId).toBe(
      'sa-orbit-4',
    );
    expect(selectionFor(offers, { country: 'SA', family: 'orbit', like: big })?.offerId).toBe(
      'sa-orbit-2',
    );
    // an unknown region or line is replaced by a valid one
    expect(selectionFor(offers, { country: 'ZZ', family: 'nope' })).toEqual({
      country: 'SA',
      family: 'nova',
      offerId: 'sa-nova-2',
    });
  });
});
