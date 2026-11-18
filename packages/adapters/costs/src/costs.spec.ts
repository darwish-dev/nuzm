import { describe, expect, it } from 'vitest';
import {
  CostImportError,
  closedWindow,
  lineRefs,
  parseManualCosts,
  toBillLines,
  toCostRows,
} from './index';

const rec = (over: Partial<Parameters<typeof lineRefs>[1][number]> = {}) => ({
  providerRef: 'i-aaa',
  periodStart: '2026-01-01T00:00:00.000Z',
  periodEnd: '2026-02-01T00:00:00.000Z',
  amountMinor: '1250',
  currency: 'USD',
  description: 'ecs.g6.large',
  ...over,
});

describe('provider cost rows', () => {
  it('line references are stable across fetches and tell identical lines apart', () => {
    const a = lineRefs('acct', [rec(), rec(), rec({ providerRef: 'i-bbb' })]);
    const b = lineRefs('acct', [rec(), rec(), rec({ providerRef: 'i-bbb' })]);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(3);
    expect(lineRefs('other', [rec()])[0]).not.toBe(a[0]);
  });

  it('rows carry the attribution, inclusive period end, the provider currency, and the FX note; unknown references stay unattributed', () => {
    const rows = toCostRows({
      providerAccountId: 'acct',
      records: [rec(), rec({ providerRef: 'i-zzz' }), rec({ providerRef: null })],
      source: 'api',
      capturedBy: null,
      attribute: (r) =>
        r === 'i-aaa'
          ? { resourceId: 'res-1', orgId: '00000000-0000-4000-8000-000000000001' }
          : null,
      fx: { currency: 'USD', rateToSar: '3.75', date: '2026-02-03' },
    });
    expect(rows[0]).toMatchObject({
      resourceId: 'res-1',
      orgId: '00000000-0000-4000-8000-000000000001',
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      costMinor: '1250',
      currency: 'USD',
      evidenceRef: 'fx:USD/SAR=3.75@2026-02-03',
    });
    expect(rows[1]).toMatchObject({ resourceId: null, orgId: null });
    expect(rows[2]!.orgId).toBeNull();
  });

  it('bill lines and cost rows share the same references (RC-04 matches on them)', () => {
    const rs = [rec(), rec({ providerRef: 'i-bbb' })];
    expect(toBillLines('acct', rs).map((b) => b.lineRef)).toEqual(
      toCostRows({ providerAccountId: 'acct', records: rs, source: 'api' }).map(
        (r) => r.providerLineRef,
      ),
    );
  });

  it('refuses a non-integer amount (no floats in money)', () => {
    expect(() =>
      toCostRows({
        providerAccountId: 'a',
        records: [rec({ amountMinor: '12.5' })],
        source: 'api',
      }),
    ).toThrow(RangeError);
  });

  it('only closed billing periods are captured', () => {
    const now = new Date('2026-03-15T00:00:00Z');
    expect(
      closedWindow({ from: '2026-01-01T00:00:00Z', to: '2026-03-31T00:00:00Z' }, now)?.to,
    ).toBe('2026-02-28T23:59:59.999Z');
    expect(
      closedWindow({ from: '2026-03-01T00:00:00Z', to: '2026-03-31T00:00:00Z' }, now),
    ).toBeNull();
  });
});

describe('manual bill import (providers without a billing API)', () => {
  const H = 'period,reference,description,amount,currency';
  it('parses decimals to integer minor units', () => {
    const r = parseManualCosts(
      `${H}\n2026-01,V153-1,Cloud VPS 4,12.5,EUR\n2026-01,,Setup fee,7,EUR\n`,
    );
    expect(r.map((x) => [x.providerRef, x.amountMinor, x.currency])).toEqual([
      ['V153-1', '1250', 'EUR'],
      [null, '700', 'EUR'],
    ]);
    expect(r[0]!.periodEnd).toBe('2026-02-01T00:00:00.000Z');
  });
  it('rejects anything it would have to guess', () => {
    for (const bad of [
      'p,r,d,a,c\n',
      `${H}\n2026-13,,x,1,EUR`,
      `${H}\n2026-01,,x,1.234,EUR`,
      `${H}\n2026-01,,x,-1,EUR`,
      `${H}\n2026-01,,x,1e3,EUR`,
      `${H}\n2026-01,,x,1,eur`,
      `${H}\n2026-01,,x,1`,
    ])
      expect(() => parseManualCosts(bad)).toThrow(CostImportError);
  });
});
