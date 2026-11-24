import { describe, expect, it } from 'vitest';
import {
  FxUnavailableError,
  StaticFxRateSource,
  convertMinor,
  deriveRateCard,
  diffRateCards,
  minorExponent,
  parseDec,
  selectRateCardVersion,
  validateRateCardHistory,
  type FxQuote,
  type RateCardVersion,
} from './ratecard';

// SYNTHETIC numbers: nothing below is a real price, rate or margin (D6 is an owner decision).
const usdSar: FxQuote = {
  from: 'USD',
  to: 'SAR',
  rate: '3.75',
  asOf: '2026-11-01T00:00:00Z',
  source: 'synthetic-test',
};
const AT = new Date('2026-11-24T00:00:00Z');

describe('decimals and currencies', () => {
  it('parses plain non-negative decimals only', () => {
    expect(parseDec('4.00')).toEqual({ int: 400n, scale: 2 });
    expect(parseDec('0.0375')).toEqual({ int: 375n, scale: 4 });
    expect(parseDec('12')).toEqual({ int: 12n, scale: 0 });
    for (const bad of [
      '',
      '-1',
      '1e3',
      '1,5',
      '.5',
      '5.',
      ' 1',
      '1.1234567890123',
      'NaN',
      '1'.repeat(16),
    ])
      expect(() => parseDec(bad), bad).toThrow(RangeError);
  });
  it('knows minor exponents and refuses unknown currencies', () => {
    expect(minorExponent('SAR')).toBe(2);
    expect(minorExponent('KWD')).toBe(3);
    expect(minorExponent('JPY')).toBe(0);
    expect(() => minorExponent('XXX')).toThrow(RangeError);
  });
});

describe('convertMinor', () => {
  it('converts USD cents to SAR halalas exactly', () => {
    expect(convertMinor(400n, usdSar)).toBe(1500n);
    expect(convertMinor(0n, usdSar)).toBe(0n);
  });
  it('rounds as asked: up for charges, down, half-up', () => {
    const q = { ...usdSar, rate: '3.7501' };
    expect(convertMinor(1n, q, 'up')).toBe(4n);
    expect(convertMinor(1n, q, 'down')).toBe(3n);
    expect(convertMinor(1n, q, 'half_up')).toBe(4n);
    expect(convertMinor(1n, { ...usdSar, rate: '3.4' }, 'half_up')).toBe(3n);
  });
  it('handles different minor exponents (USD→KWD 3 digits, USD→JPY 0 digits)', () => {
    expect(
      convertMinor(100n, { from: 'USD', to: 'KWD', rate: '0.3', asOf: 'x', source: 's' }),
    ).toBe(300n); // 1.00 USD = 0.300 KWD
    expect(
      convertMinor(100n, { from: 'USD', to: 'JPY', rate: '150', asOf: 'x', source: 's' }),
    ).toBe(150n);
  });
  it('is exact for huge amounts (no float)', () => {
    expect(convertMinor(10n ** 18n, usdSar)).toBe(375n * 10n ** 16n);
  });
  it('refuses a negative amount, a zero rate, an unknown currency', () => {
    expect(() => convertMinor(-1n, usdSar)).toThrow(RangeError);
    expect(() => convertMinor(1n, { ...usdSar, rate: '0' })).toThrow(RangeError);
    expect(() => convertMinor(1n, { ...usdSar, to: 'XXX' })).toThrow(RangeError);
  });
});

describe('StaticFxRateSource', () => {
  it('returns the listed rate, identity for the same currency, and never derives an inverse', async () => {
    const s = new StaticFxRateSource([usdSar]);
    expect((await s.quote('USD', 'SAR', AT)).rate).toBe('3.75');
    expect((await s.quote('SAR', 'SAR', AT)).rate).toBe('1');
    await expect(s.quote('SAR', 'USD', AT)).rejects.toBeInstanceOf(FxUnavailableError);
    await expect(s.quote('USD', 'EUR', AT)).rejects.toMatchObject({ reason: 'no_rate' });
  });
  it('refuses a stale rate rather than using it', async () => {
    const s = new StaticFxRateSource([usdSar], 7 * 24 * 3600_000);
    await expect(s.quote('USD', 'SAR', new Date('2026-11-05T00:00:00Z'))).resolves.toBeTruthy();
    await expect(s.quote('USD', 'SAR', AT)).rejects.toMatchObject({ reason: 'stale' });
  });
  it('refuses a malformed table', () => {
    expect(() => new StaticFxRateSource([{ ...usdSar, rate: '0' }])).toThrow(RangeError);
    expect(() => new StaticFxRateSource([{ ...usdSar, rate: '-3' }])).toThrow(RangeError);
    expect(() => new StaticFxRateSource([{ ...usdSar, from: 'XXX' }])).toThrow(RangeError);
  });
});

const card = (
  version: string,
  from: string,
  models: RateCardVersion['models'],
): RateCardVersion => ({
  version,
  effectiveFrom: from,
  models,
});
const m = (i: string, o: string) => ({ creditsPerMillionInput: i, creditsPerMillionOutput: o });

describe('rate card versions', () => {
  const v1 = card('v1', '2026-11-01T00:00:00Z', { a: m('100', '500') });
  const v2 = card('v2', '2026-11-15T00:00:00Z', { a: m('120', '500'), b: m('10', '20') });
  it('selects the version in force at an instant; none before the first', () => {
    expect(selectRateCardVersion([v2, v1], new Date('2026-10-31T23:59:59Z'))).toBeNull();
    expect(selectRateCardVersion([v2, v1], new Date('2026-11-01T00:00:00Z'))?.version).toBe('v1');
    expect(selectRateCardVersion([v2, v1], new Date('2026-11-14T23:59:59Z'))?.version).toBe('v1');
    expect(selectRateCardVersion([v2, v1], new Date('2026-11-15T00:00:00Z'))?.version).toBe('v2');
    expect(selectRateCardVersion([], AT)).toBeNull();
  });
  it('validates the history: duplicates, bad dates, non-integer or huge rates, empty cards', () => {
    expect(validateRateCardHistory([v1, v2])).toEqual([]);
    expect(validateRateCardHistory([v1, { ...v2, version: 'v1' }])).toEqual(
      expect.arrayContaining([expect.stringContaining('duplicate')]),
    );
    expect(validateRateCardHistory([v1, { ...v2, effectiveFrom: v1.effectiveFrom }])).toEqual(
      expect.arrayContaining([expect.stringContaining('same effectiveFrom')]),
    );
    expect(validateRateCardHistory([{ ...v1, effectiveFrom: 'yesterday' }])).toEqual(
      expect.arrayContaining([expect.stringContaining('not a date')]),
    );
    expect(validateRateCardHistory([card('x', v1.effectiveFrom, { a: m('1.5', '2') })])).toEqual(
      expect.arrayContaining([expect.stringContaining('integer strings')]),
    );
    expect(
      validateRateCardHistory([card('x', v1.effectiveFrom, { a: m('1'.repeat(16), '2') })]).length,
    ).toBe(1);
    expect(validateRateCardHistory([card('x', v1.effectiveFrom, {})])).toEqual(
      expect.arrayContaining([expect.stringContaining('no models')]),
    );
    expect(() => selectRateCardVersion([{ ...v1, effectiveFrom: 'nope' }], AT)).toThrow(RangeError);
  });
  it('diffs added, changed and removed models', () => {
    expect(diffRateCards(null, v1)).toEqual([
      { modelId: 'a', change: 'added', after: m('100', '500') },
    ]);
    expect(diffRateCards(v1, v2)).toEqual([
      { modelId: 'a', change: 'changed', before: m('100', '500'), after: m('120', '500') },
      { modelId: 'b', change: 'added', after: m('10', '20') },
    ]);
    expect(diffRateCards(v2, v1).map((c) => [c.modelId, c.change])).toEqual([
      ['a', 'changed'],
      ['b', 'removed'],
    ]);
    expect(diffRateCards(v1, { ...v1, version: 'same' })).toEqual([]);
  });
});

describe('deriveRateCard (a preview; the numbers are synthetic)', () => {
  const fx = new StaticFxRateSource([usdSar]);
  const base = {
    vendorCurrency: 'USD',
    walletCurrency: 'SAR',
    creditUnitMinor: 1,
    marginBps: 2000,
    vendorPriceRef: 'synthetic-fixture-2026-11-24',
    prices: { 'model-x': { inputPerMillion: '4.00', outputPerMillion: '20.00' } },
  };
  it('applies fx then margin then the credit unit, rounding up', async () => {
    const c = await deriveRateCard(fx, AT, 'draft-1', base);
    // 4.00 USD = 400 cents → 1500 halalas → +20% = 1800 credits; 20.00 USD → 7500 → 9000
    expect(c.models['model-x']).toEqual({
      creditsPerMillionInput: '1800',
      creditsPerMillionOutput: '9000',
    });
    expect(c.basis).toMatchObject({
      marginBps: 2000,
      vendorPriceRef: 'synthetic-fixture-2026-11-24',
      fx: { rate: '3.75' },
    });
    expect(c.effectiveFrom).toBe(AT.toISOString());
    expect(validateRateCardHistory([c])).toEqual([]);
  });
  it('a credit worth 10 minor units divides the credits, rounding up', async () => {
    const c = await deriveRateCard(fx, AT, 'draft-2', { ...base, creditUnitMinor: 10 });
    expect(c.models['model-x']).toEqual({
      creditsPerMillionInput: '180',
      creditsPerMillionOutput: '900',
    });
    const odd = await deriveRateCard(fx, AT, 'draft-3', { ...base, creditUnitMinor: 7 });
    expect(odd.models['model-x']!.creditsPerMillionInput).toBe('258'); // ceil(1800/7)
  });
  it('same currency needs no rate; a zero margin is allowed; fractional vendor prices round up to a minor unit', async () => {
    const c = await deriveRateCard(fx, AT, 'd', {
      ...base,
      vendorCurrency: 'SAR',
      marginBps: 0,
      prices: { z: { inputPerMillion: '0.0375', outputPerMillion: '1' } },
    });
    expect(c.models['z']).toEqual({ creditsPerMillionInput: '4', creditsPerMillionOutput: '100' });
  });
  it('refuses a missing rate, invalid margin/unit/reference and bad prices — never a silent default', async () => {
    await expect(deriveRateCard(new StaticFxRateSource([]), AT, 'd', base)).rejects.toBeInstanceOf(
      FxUnavailableError,
    );
    await expect(deriveRateCard(fx, AT, 'd', { ...base, marginBps: -1 })).rejects.toThrow(
      RangeError,
    );
    await expect(deriveRateCard(fx, AT, 'd', { ...base, marginBps: 1.5 })).rejects.toThrow(
      RangeError,
    );
    await expect(deriveRateCard(fx, AT, 'd', { ...base, creditUnitMinor: 0 })).rejects.toThrow(
      RangeError,
    );
    await expect(deriveRateCard(fx, AT, 'd', { ...base, vendorPriceRef: ' ' })).rejects.toThrow(
      RangeError,
    );
    await expect(deriveRateCard(fx, AT, 'd', { ...base, prices: {} })).rejects.toThrow(RangeError);
    await expect(
      deriveRateCard(fx, AT, 'd', {
        ...base,
        prices: { a: { inputPerMillion: '1e3', outputPerMillion: '1' } },
      }),
    ).rejects.toThrow(RangeError);
  });
});
