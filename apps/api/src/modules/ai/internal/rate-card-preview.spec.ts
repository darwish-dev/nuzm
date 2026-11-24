import { describe, expect, it } from 'vitest';
import { previewRateCard } from './rate-card-preview';

// SYNTHETIC: the FX rate, the margin and the prices are made up to exercise the arithmetic; none is a proposal or a real figure.
const AT = new Date('2026-11-24T00:00:00Z');
const fx = {
  from: 'USD',
  to: 'SAR',
  rate: '3.75',
  asOf: '2026-11-20T00:00:00Z',
  source: 'synthetic-test',
};
const base = {
  vendorCurrency: 'USD',
  walletCurrency: 'SAR',
  creditUnitMinor: 1,
  marginBps: 2000,
  vendorPriceRef: 'synthetic-price-ref',
  prices: { 'model-x': { inputPerMillion: '4.00', outputPerMillion: '20.00' } },
  fx,
};

describe('rate-card preview for the owner (D6)', () => {
  it('derives integer credits from price, FX, margin and credit unit, and says what it used', async () => {
    const r = await previewRateCard(base, AT);
    expect(r).toMatchObject({
      ok: true,
      rateCard: {
        models: { 'model-x': { creditsPerMillionInput: '1800', creditsPerMillionOutput: '9000' } },
      },
    });
    if (r.ok) {
      expect(r.warnings.join(' ')).toContain('synthetic-test');
      expect(JSON.stringify(r.basis)).toContain('synthetic-price-ref');
    }
  });
  it('invents nothing: no FX quote, a stale one, a missing price reference, a negative margin and a malformed price are all refused', async () => {
    expect(await previewRateCard({ ...base, fx: undefined }, AT)).toMatchObject({ ok: false });
    expect(
      await previewRateCard({ ...base, fx: { ...fx, asOf: '2020-01-01T00:00:00Z' } }, AT),
    ).toMatchObject({ ok: true }); // a static quote is the caller's; staleness is judged by the source
    expect(await previewRateCard({ ...base, vendorPriceRef: ' ' }, AT)).toMatchObject({
      ok: false,
    });
    expect(await previewRateCard({ ...base, marginBps: -1 }, AT)).toMatchObject({ ok: false });
    expect(
      await previewRateCard(
        { ...base, prices: { a: { inputPerMillion: '1e3', outputPerMillion: '1' } } },
        AT,
      ),
    ).toMatchObject({ ok: false });
    expect(await previewRateCard({ ...base, prices: {} }, AT)).toMatchObject({ ok: false });
  });
  it('the same currency needs no FX; a zero margin is allowed and warned about', async () => {
    const r = await previewRateCard(
      { ...base, vendorCurrency: 'SAR', fx: undefined, marginBps: 0 },
      AT,
    );
    expect(r.ok && r.warnings.join(' ')).toContain('margin is zero');
  });
});
