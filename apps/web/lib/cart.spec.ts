import { describe, expect, it } from 'vitest';
import {
  CART_MAX,
  addLine,
  lineFromDomain,
  lineFromPlan,
  lineFromServer,
  parseCart,
  removeLine,
  serializeCart,
  totals,
} from './cart';
import type { CatalogPlan } from './hosting-catalog';

const plan = (key: string, price: CatalogPlan['price'] = null): CatalogPlan => ({
  id: `id-${key}`,
  key,
  name: { ar: key, en: key },
  quotas: { diskMb: 1024, inodes: 1000, bandwidthGb: 10, dbCount: 1, sitesCount: 1 },
  runtimes: ['php:8.3'],
  price,
});
const priced = (key: string, minor: string, cur = 'SAR') =>
  lineFromPlan(plan(key, { amountMinor: minor, currency: cur, placeholder: false }), `l-${key}`);

describe('basket lines', () => {
  it('keeps the plan price as integer minor units only when it is approved; a placeholder price is quoted at checkout', () => {
    expect(priced('a', '5900').priceMinor).toBe('5900');
    const ph = lineFromPlan(
      plan('b', { amountMinor: '100', currency: 'SAR', placeholder: true }),
      'l-b',
    );
    expect(ph.priceMinor).toBeNull();
    expect(lineFromPlan(plan('c'), 'l-c').priceMinor).toBeNull();
  });
  it('adds lines, allows the same plan twice, stops at the limit, and removes by line id', () => {
    let lines = [] as ReturnType<typeof parseCart>;
    for (let i = 0; i < CART_MAX; i++)
      lines = addLine(lines, { ...priced('a', '100'), id: `x${i}` }).lines;
    expect(lines).toHaveLength(CART_MAX);
    expect(addLine(lines, priced('b', '1'))).toEqual({ lines, added: false });
    expect(removeLine(lines, 'x3')).toHaveLength(CART_MAX - 1);
    expect(removeLine(lines, 'x3').some((l) => l.id === 'x3')).toBe(false);
  });
});

describe('basket totals', () => {
  it('sums priced lines exactly (no float), counts the unpriced ones, and refuses a single total across currencies', () => {
    const t = totals([priced('a', '5900'), priced('b', '2900'), lineFromPlan(plan('c'), 'l-c')]);
    expect(t).toMatchObject({
      count: 3,
      currency: 'SAR',
      knownMinor: 8800n,
      unpriced: 1,
      mixedCurrency: false,
    });
    expect(totals([priced('a', '100'), priced('b', '100', 'USD')])).toMatchObject({
      currency: null,
      mixedCurrency: true,
    });
    expect(totals([])).toMatchObject({ count: 0, knownMinor: 0n, unpriced: 0 });
    // a number too big for a float is still exact
    expect(totals([priced('a', '9007199254740993'), priced('b', '2')]).knownMinor).toBe(
      9007199254740995n,
    );
  });
});

describe('stored basket', () => {
  it('round-trips, and ignores broken, foreign or oversized data', () => {
    const lines = [priced('a', '5900'), lineFromPlan(plan('b'), 'l-b')];
    expect(parseCart(serializeCart(lines))).toEqual(lines);
    for (const bad of [null, undefined, '', 'nope', '{}', '[1,2]', '[{"id":"x"}]'])
      expect(parseCart(bad as string)).toEqual([]);
    const evil = JSON.stringify([
      { ...lines[0], priceMinor: '12.5' },
      { ...lines[1], id: 'k'.repeat(100) },
    ]);
    const parsed = parseCart(evil);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.priceMinor).toBeNull(); // a price that is not integer minor units is dropped, never trusted
    expect(parseCart(JSON.stringify(Array.from({ length: 50 }, () => lines[0]))).length).toBe(
      CART_MAX,
    );
  });
});

describe('domain and server lines', () => {
  it('a domain is added once (1 year), keeps its listed price and is validated when read back', () => {
    const d = lineFromDomain('Shop.Example.COM', { amountMinor: '3686', currency: 'SAR' }, 'd1');
    expect(d).toMatchObject({
      kind: 'domain',
      domain: 'shop.example.com',
      years: 1,
      priceMinor: '3686',
      currency: 'SAR',
    });
    const once = addLine([], d);
    expect(addLine(once.lines, { ...d, id: 'd2' }).lines).toHaveLength(1); // the same name is not added twice
    expect(parseCart(serializeCart([d]))).toEqual([d]);
    const bad = JSON.stringify([
      { ...d, domain: 'not a domain' },
      { ...d, id: 'd3', years: 99 },
    ]);
    expect(parseCart(bad).map((x) => (x.kind === 'domain' ? x.years : 0))).toEqual([1]); // a bad name is dropped; a wild year count falls back to 1
  });
  it('a server keeps the exact offer and operating system chosen, and an unpriced offer stays unpriced', () => {
    const offer = {
      offerId: 'o1',
      family: 'nova',
      country: 'SA',
      dataRegion: 'in_kingdom',
      plan: { vcpu: 4, memoryMb: 8192, diskGb: 160 },
      price: { amount: '28440', currency: 'SAR' },
    };
    const s = lineFromServer(offer, { id: 'img1', name: 'Ubuntu 24.04 LTS' }, 's1');
    expect(s).toMatchObject({
      kind: 'server',
      offerId: 'o1',
      imageId: 'img1',
      imageName: 'Ubuntu 24.04 LTS',
      priceMinor: '28440',
    });
    expect(parseCart(serializeCart([s]))).toEqual([s]);
    expect(parseCart(JSON.stringify([{ ...s, country: 'saudi' }]))).toEqual([]);
  });
  it('totals mix the three kinds and count the ones with no price', () => {
    const lines = [
      priced('a', '5900'),
      lineFromDomain('a.com', { amountMinor: '3686', currency: 'SAR' }, 'd1'),
      lineFromDomain('b.com', null, 'd2'),
    ];
    expect(totals(lines)).toMatchObject({ knownMinor: 9586n, unpriced: 1, currency: 'SAR' });
  });
});
