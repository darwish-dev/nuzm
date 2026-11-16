export interface TaxEstimate {
  status: 'provisional';
  rateBps: number;
  source: 'config';
  note: string;
}

/**
 * Provisional tax estimate for quotes (M02 mock; the M03 tax engine replaces it). The rate is configuration, never a
 * constant in logic: `QUOTE_TAX_ESTIMATE_BPS` (default 1500 = 15 %, the Saudi standard VAT rate as documented in
 * docs/11 §4 which is itself marked [VERIFY] with the tax advisor, D-25). The result is always labelled provisional.
 */
export class TaxEstimator {
  constructor(private readonly rateBps: number) {
    if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000)
      throw new Error('QUOTE_TAX_ESTIMATE_BPS must be an integer in 0..10000');
  }
  static fromEnv(env: NodeJS.ProcessEnv = process.env): TaxEstimator {
    return new TaxEstimator(Number(env.QUOTE_TAX_ESTIMATE_BPS ?? 1500));
  }
  /** Half-up on the whole subtotal (integer arithmetic only). */
  estimate(subtotalMinor: bigint): { taxMinor: bigint; estimate: TaxEstimate } {
    const taxMinor = (subtotalMinor * BigInt(this.rateBps) + 5_000n) / 10_000n;
    return {
      taxMinor,
      estimate: {
        status: 'provisional',
        rateBps: this.rateBps,
        source: 'config',
        note: 'provisional estimate; the invoicing tax engine (M03) determines the real tax [VERIFY D-25]',
      },
    };
  }
}
