import { parseDec } from './ratecard';
import { PROBE_INPUT_ALLOWANCE, PROBE_PLAN, probeWorstCase, type ProbeId } from './probe';

/**
 * The cost of the bounded capability probe, computed (not typed in) from a vendor list price (S-AG4, Phase 2). Integer math only: prices are decimal strings per million tokens,
 * amounts are NANO units (1e-9) of the price currency, rounded UP so a bound is never too low. The result is arithmetic on a list price: it is NOT a quote and NOT an invoice
 * (the contract price, tax and conversion are the owner's, D2/D6).
 *
 * The HARD MAXIMUM assumes the worst the harness permits:
 *  - every request uses its full output ceiling (`maxTokens`, thinking tokens included: they are billed as output and counted inside `max_tokens`) and the full input allowance;
 *  - NO retry is counted at all because none can happen: the adapter is built with `maxRetries: 0` and the probe never repeats a request (it stops at the first credential,
 *    availability, timeout, refusal or rate-limit failure). A caller that wants to price a retry anyway passes `retriesPerRequest`: each retry is then counted once more, in full;
 *  - an optional price multiplier (e.g. 1.1 for `inference_geo: "us"`, which the adapter never sends).
 */
export interface ProbeCostInput {
  currency: string;
  /** decimal string, price per million INPUT tokens */
  inputPerMillion: string;
  /** decimal string, price per million OUTPUT tokens */
  outputPerMillion: string;
  /** decimal string, applied to every token category (default "1") */
  multiplier?: string;
  /** extra full repetitions of every request (default 0: the probe never retries) */
  retriesPerRequest?: number;
}
export interface ProbeCostLine {
  id: ProbeId;
  inputTokens: number;
  outputTokens: number;
  /** nano units of the currency, as integer strings */
  inputNano: string;
  outputNano: string;
  totalNano: string;
}
export interface ProbeCost {
  currency: string;
  requests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  lines: ProbeCostLine[];
  /** the hard maximum: input at the input price, output at the output price */
  maxNano: string;
  /** an absolute ceiling that ignores which side a token is on: every token priced as OUTPUT */
  ceilingAllOutputNano: string;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** nano units of `tokens` at `price` per million tokens, times `mult`: tokens × price × mult × 1e9 / 1e6, rounded up. */
function nano(tokens: number, price: string, mult: string): bigint {
  const p = parseDec(price);
  const m = parseDec(mult);
  return ceilDiv(BigInt(tokens) * p.int * m.int * 1000n, 10n ** BigInt(p.scale + m.scale));
}

/** nano units of a token count at a price pair, rounded up (the same integer math as `probeCost`). */
export function tokenCostNano(
  inputTokens: number,
  outputTokens: number,
  p: { inputPerMillion: string; outputPerMillion: string },
  multiplier = '1',
): bigint {
  return (
    nano(inputTokens, p.inputPerMillion, multiplier) +
    nano(outputTokens, p.outputPerMillion, multiplier)
  );
}

export function probeCost(i: ProbeCostInput): ProbeCost {
  const mult = i.multiplier ?? '1';
  const reps = BigInt((i.retriesPerRequest ?? 0) + 1);
  if (!Number.isInteger(i.retriesPerRequest ?? 0) || (i.retriesPerRequest ?? 0) < 0)
    throw new RangeError('retriesPerRequest must be a non-negative integer');
  if (!/^[A-Z]{3}$/.test(i.currency)) throw new RangeError('currency must be an ISO 4217 code');
  const lines: ProbeCostLine[] = PROBE_PLAN.map((s) => {
    const inNano = nano(PROBE_INPUT_ALLOWANCE, i.inputPerMillion, mult) * reps;
    const outNano = nano(s.maxTokens, i.outputPerMillion, mult) * reps;
    return {
      id: s.id,
      inputTokens: PROBE_INPUT_ALLOWANCE,
      outputTokens: s.maxTokens,
      inputNano: inNano.toString(),
      outputNano: outNano.toString(),
      totalNano: (inNano + outNano).toString(),
    };
  });
  const w = probeWorstCase();
  const max = lines.reduce((n, l) => n + BigInt(l.totalNano), 0n);
  const totalIn = PROBE_INPUT_ALLOWANCE * w.requests;
  return {
    currency: i.currency,
    requests: w.requests,
    totalInputTokens: totalIn,
    totalOutputTokens: w.totalTokens - totalIn,
    totalTokens: w.totalTokens,
    lines,
    maxNano: max.toString(),
    ceilingAllOutputNano: (nano(w.totalTokens, i.outputPerMillion, mult) * reps).toString(),
  };
}

/** "0.080720" style text for a nano amount, 6 decimals, rounded UP (never shows less than the bound). */
export function formatNano(n: string | bigint, decimals = 6): string {
  const v = typeof n === 'bigint' ? n : BigInt(n);
  const unit = 10n ** BigInt(9 - decimals);
  const r = ceilDiv(v, unit);
  const s = r.toString().padStart(decimals + 1, '0');
  return `${s.slice(0, s.length - decimals)}.${s.slice(s.length - decimals)}`;
}
