/**
 * Dynamic rate cards and currency conversion (S-AG4, gap G5). Integer BigInt math only: no float ever touches money (CLAUDE.md §4).
 * Nothing here knows a real price, a real exchange rate or a real margin: those are owner decisions (D6) and come in as DATA. The functions only
 * select, validate and convert; `deriveRateCard` produces a PREVIEW that a human reviews and saves through the provider `configure` action.
 */

// ───────────────────────────── decimals and currencies ─────────────────────────────

export interface Dec {
  /** the value times 10^scale */
  int: bigint;
  scale: number;
}
const DEC = /^(\d{1,15})(?:\.(\d{1,12}))?$/;
/** Parses a non-negative decimal string such as "4.00" or "0.0375". Anything else (sign, exponent, separators, empty) is refused. */
export function parseDec(s: string): Dec {
  const m = DEC.exec(s);
  if (!m) throw new RangeError('not a plain non-negative decimal');
  const frac = m[2] ?? '';
  return { int: BigInt(m[1]! + frac), scale: frac.length };
}
const pow10 = (n: number): bigint => 10n ** BigInt(n);
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
export type Rounding = 'up' | 'down' | 'half_up';
function divide(num: bigint, den: bigint, rounding: Rounding): bigint {
  if (den <= 0n || num < 0n) throw new RangeError('division of non-negative by positive only');
  if (rounding === 'up') return ceilDiv(num, den);
  if (rounding === 'down') return num / den;
  return (num * 2n + den) / (den * 2n);
}

/** Minor-unit exponents (ISO 4217) for the currencies the platform may meet. An unknown currency is refused, never guessed. */
export const MINOR_EXPONENT: Readonly<Record<string, number>> = {
  SAR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  QAR: 2,
  EGP: 2,
  KWD: 3,
  BHD: 3,
  OMR: 3,
  JOD: 3,
  JPY: 0,
};
export function minorExponent(currency: string): number {
  const e = MINOR_EXPONENT[currency];
  if (e === undefined) throw new RangeError(`unknown currency ${currency.slice(0, 8)}`);
  return e;
}

// ───────────────────────────── FX interface ─────────────────────────────

/** `rate` = units of `to` (major units) per ONE unit of `from` (major units), a plain decimal string. `asOf` is when the source published it. */
export interface FxQuote {
  from: string;
  to: string;
  rate: string;
  asOf: string;
  source: string;
}
export class FxUnavailableError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
    readonly reason: 'no_rate' | 'stale',
  ) {
    super(`no usable exchange rate ${from}->${to} (${reason})`);
    this.name = 'FxUnavailableError';
  }
}
/**
 * The interface a real rate source (central bank feed, treasury table, finance-approved fixed rate) implements later. Until the owner decides (D6) the only
 * implementation is `StaticFxRateSource`, fed with synthetic or owner-supplied numbers. A source must throw `FxUnavailableError` rather than guess.
 */
export interface FxRateSource {
  quote(from: string, to: string, at: Date): Promise<FxQuote>;
}
/** A fixed table (tests, or a finance-approved fixed rate). The inverse pair is NOT derived: it must be listed, so a rounding choice is never made silently. */
export class StaticFxRateSource implements FxRateSource {
  private readonly table = new Map<string, FxQuote>();
  constructor(
    quotes: FxQuote[],
    private readonly maxAgeMs: number | null = null,
  ) {
    for (const q of quotes) {
      parseDec(q.rate);
      if (parseDec(q.rate).int === 0n) throw new RangeError('a rate must be positive');
      minorExponent(q.from);
      minorExponent(q.to);
      this.table.set(`${q.from}>${q.to}`, q);
    }
  }
  async quote(from: string, to: string, at: Date): Promise<FxQuote> {
    if (from === to) return { from, to, rate: '1', asOf: at.toISOString(), source: 'identity' };
    const q = this.table.get(`${from}>${to}`);
    if (!q) throw new FxUnavailableError(from, to, 'no_rate');
    if (this.maxAgeMs !== null && at.getTime() - Date.parse(q.asOf) > this.maxAgeMs)
      throw new FxUnavailableError(from, to, 'stale');
    return q;
  }
}

/** Convert a non-negative amount in MINOR units of `quote.from` into minor units of `quote.to`. The caller picks the rounding; charges round `up`. */
export function convertMinor(
  amountMinor: bigint,
  quote: FxQuote,
  rounding: Rounding = 'up',
): bigint {
  if (amountMinor < 0n) throw new RangeError('amount must be non-negative');
  const r = parseDec(quote.rate);
  if (r.int === 0n) throw new RangeError('a rate must be positive');
  const num = amountMinor * r.int * pow10(minorExponent(quote.to));
  const den = pow10(r.scale) * pow10(minorExponent(quote.from));
  return divide(num, den, rounding);
}

// ───────────────────────────── rate card versions ─────────────────────────────

export interface RateCardEntry {
  creditsPerMillionInput: string;
  creditsPerMillionOutput: string;
}
export interface RateCardBasis {
  vendorCurrency: string;
  walletCurrency: string;
  fx: FxQuote;
  marginBps: number;
  creditUnitMinor: number;
  /** a reference to where the vendor price was read (document and date): the code never invents one */
  vendorPriceRef: string;
}
export interface RateCardVersion {
  version: string;
  /** ISO instant from which the card applies */
  effectiveFrom: string;
  models: Record<string, RateCardEntry>;
  /** how the numbers were derived, when they were derived with `deriveRateCard`; absent for a hand-entered card */
  basis?: RateCardBasis;
}
const INT_STR = /^\d{1,15}$/;

/** Problems in a version history; empty = usable. Versions must be unique, dated, and carry integer-string rates. */
export function validateRateCardHistory(versions: readonly RateCardVersion[]): string[] {
  const problems: string[] = [];
  const seenV = new Set<string>();
  const seenAt = new Set<number>();
  for (const v of versions) {
    if (!v.version || v.version.length > 40)
      problems.push(`version "${String(v.version).slice(0, 20)}": 1–40 characters`);
    if (seenV.has(v.version)) problems.push(`version ${v.version}: duplicate`);
    seenV.add(v.version);
    const t = Date.parse(v.effectiveFrom);
    if (Number.isNaN(t)) problems.push(`version ${v.version}: effectiveFrom is not a date`);
    else if (seenAt.has(t))
      problems.push(`version ${v.version}: same effectiveFrom as another version`);
    else seenAt.add(t);
    if (Object.keys(v.models).length === 0) problems.push(`version ${v.version}: no models`);
    for (const [id, e] of Object.entries(v.models))
      if (!INT_STR.test(e.creditsPerMillionInput) || !INT_STR.test(e.creditsPerMillionOutput))
        problems.push(`version ${v.version}/${id.slice(0, 40)}: rates must be integer strings`);
  }
  return problems;
}

/** The version in force at `at`: the one with the latest `effectiveFrom` that is not after `at`. `null` before the first version (unknown price = not offered). */
export function selectRateCardVersion(
  versions: readonly RateCardVersion[],
  at: Date,
): RateCardVersion | null {
  const problems = validateRateCardHistory(versions);
  if (problems.length > 0) throw new RangeError(`invalid rate card history: ${problems[0]}`);
  let best: RateCardVersion | null = null;
  for (const v of versions) {
    const t = Date.parse(v.effectiveFrom);
    if (t <= at.getTime() && (best === null || t > Date.parse(best.effectiveFrom))) best = v;
  }
  return best;
}

export interface RateCardChange {
  modelId: string;
  change: 'added' | 'removed' | 'changed';
  before?: RateCardEntry;
  after?: RateCardEntry;
}
/** What a new version changes against the one before (shown to the approver before the provider is re-enabled). */
export function diffRateCards(
  before: RateCardVersion | null,
  after: RateCardVersion,
): RateCardChange[] {
  const out: RateCardChange[] = [];
  const b = before?.models ?? {};
  for (const [id, e] of Object.entries(after.models)) {
    const p = b[id];
    if (!p) out.push({ modelId: id, change: 'added', after: e });
    else if (
      p.creditsPerMillionInput !== e.creditsPerMillionInput ||
      p.creditsPerMillionOutput !== e.creditsPerMillionOutput
    )
      out.push({ modelId: id, change: 'changed', before: p, after: e });
  }
  for (const [id, p] of Object.entries(b))
    if (!after.models[id]) out.push({ modelId: id, change: 'removed', before: p });
  return out.sort((x, y) => x.modelId.localeCompare(y.modelId));
}

// ───────────────────────────── derivation (preview) ─────────────────────────────

export interface VendorPrice {
  /** the vendor's price per million tokens in `vendorCurrency` MAJOR units, plain decimal strings (e.g. "4.00") */
  inputPerMillion: string;
  outputPerMillion: string;
}
export interface DeriveInput {
  vendorCurrency: string;
  walletCurrency: string;
  /** minor units of the wallet one credit is worth (AiConfig.creditUnitMinor) */
  creditUnitMinor: number;
  /** margin over cost in basis points (2000 = +20%); an owner decision (D6): required, no default */
  marginBps: number;
  vendorPriceRef: string;
  prices: Record<string, VendorPrice>;
}
/**
 * Vendor price → customer credits per million tokens, rounded UP at every step so a rounding can only favour the platform:
 * minor units of the vendor currency → wallet minor units (FX) → plus margin → credits. Returns a PREVIEW; applying it is a human action (`configure`).
 */
export async function deriveRateCard(
  fx: FxRateSource,
  at: Date,
  version: string,
  input: DeriveInput,
): Promise<RateCardVersion> {
  if (!Number.isInteger(input.marginBps) || input.marginBps < 0 || input.marginBps > 100_000)
    throw new RangeError('marginBps must be an integer 0–100000');
  if (!Number.isInteger(input.creditUnitMinor) || input.creditUnitMinor < 1)
    throw new RangeError('creditUnitMinor must be a positive integer');
  if (!input.vendorPriceRef.trim()) throw new RangeError('vendorPriceRef is required');
  const quote = await fx.quote(input.vendorCurrency, input.walletCurrency, at);
  const vexp = minorExponent(input.vendorCurrency);
  const toVendorMinor = (price: string): bigint => {
    const d = parseDec(price);
    // price (major units) → minor units of the vendor currency, rounded up
    return divide(d.int * pow10(vexp), pow10(d.scale), 'up');
  };
  const credits = (price: string): string => {
    const walletMinor = convertMinor(toVendorMinor(price), quote, 'up');
    const withMargin = divide(walletMinor * (10_000n + BigInt(input.marginBps)), 10_000n, 'up');
    return divide(withMargin, BigInt(input.creditUnitMinor), 'up').toString();
  };
  const models: Record<string, RateCardEntry> = {};
  for (const [id, p] of Object.entries(input.prices))
    models[id] = {
      creditsPerMillionInput: credits(p.inputPerMillion),
      creditsPerMillionOutput: credits(p.outputPerMillion),
    };
  const card: RateCardVersion = {
    version,
    effectiveFrom: at.toISOString(),
    models,
    basis: {
      vendorCurrency: input.vendorCurrency,
      walletCurrency: input.walletCurrency,
      fx: quote,
      marginBps: input.marginBps,
      creditUnitMinor: input.creditUnitMinor,
      vendorPriceRef: input.vendorPriceRef,
    },
  };
  const problems = validateRateCardHistory([card]);
  if (problems.length > 0) throw new RangeError(problems[0]);
  return card;
}
