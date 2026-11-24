import { describe, expect, it } from 'vitest';
import { formatNano, probeCost } from './probe-cost';
import { PROBE_INPUT_ALLOWANCE, PROBE_PLAN, probeWorstCase } from './probe';

// The prices below are the LIST prices read from the vendor's public pages on 2026-11-24 (docs/ai-intelligence/S-AG4-PRICING.md): not a quote.
const OPUS_55 = { currency: 'USD', inputPerMillion: '4.00', outputPerMillion: '20.00' };

describe('probeCost: the arithmetic behind the probe budget', () => {
  it('itemizes every request and sums to the hard maximum (USD 0.080720 at 4/20)', () => {
    const c = probeCost(OPUS_55);
    expect(c.requests).toBe(8);
    expect(c.totalInputTokens).toBe(9_600);
    expect(c.totalOutputTokens).toBe(2_116);
    expect(c.totalTokens).toBe(11_716);
    // input 9,600 x $4/M = $0.0384; output 2,116 x $20/M = $0.04232
    expect(formatNano(c.maxNano)).toBe('0.080720');
    expect(Object.fromEntries(c.lines.map((l) => [l.id, formatNano(l.totalNano)]))).toEqual({
      auto_call: '0.010800',
      forced_call: '0.010800',
      parallel_calls: '0.012800',
      streamed_call: '0.010800',
      tool_round_trip: '0.010800',
      tool_choice_none: '0.008800',
      truncated_call: '0.005120',
      cancelled_stream: '0.010800',
    });
    expect(c.lines.reduce((n, l) => n + BigInt(l.totalNano), 0n)).toBe(BigInt(c.maxNano));
  });
  it('the all-output ceiling stays under the earlier USD 0.24 bound (0.23432)', () => {
    const c = probeCost(OPUS_55);
    expect(formatNano(c.ceilingAllOutputNano)).toBe('0.234320');
    expect(BigInt(c.ceilingAllOutputNano)).toBeLessThan(240_000_000n);
    expect(BigInt(c.ceilingAllOutputNano)).toBeGreaterThanOrEqual(BigInt(c.maxNano));
  });
  it('a US-only inference multiplier of 1.1 raises both bounds by exactly 10 percent', () => {
    const c = probeCost({ ...OPUS_55, multiplier: '1.1' });
    expect(formatNano(c.maxNano)).toBe('0.088792');
    expect(formatNano(c.ceilingAllOutputNano)).toBe('0.257752');
  });
  it('counts a retry in full only when asked, and rejects nonsense', () => {
    expect(formatNano(probeCost({ ...OPUS_55, retriesPerRequest: 1 }).maxNano)).toBe('0.161440');
    expect(() => probeCost({ ...OPUS_55, retriesPerRequest: -1 })).toThrow(RangeError);
    expect(() => probeCost({ ...OPUS_55, retriesPerRequest: 0.5 })).toThrow(RangeError);
    expect(() => probeCost({ ...OPUS_55, currency: 'usd' })).toThrow(RangeError);
    expect(() => probeCost({ ...OPUS_55, inputPerMillion: '4e1' })).toThrow(RangeError);
  });
  it('rounds up, never down (a fractional nano still counts)', () => {
    const c = probeCost({
      currency: 'USD',
      inputPerMillion: '0.0000001',
      outputPerMillion: '0.0000001',
    });
    expect(BigInt(c.maxNano)).toBeGreaterThan(0n);
    expect(formatNano(1n)).toBe('0.000001');
  });
  it('stays consistent with the plan constants (a changed plan changes the bound)', () => {
    const w = probeWorstCase();
    expect(w.totalTokens).toBe(
      PROBE_PLAN.reduce((n, s) => n + s.maxTokens, 0) + PROBE_INPUT_ALLOWANCE * PROBE_PLAN.length,
    );
  });
});
