import { ProblemException } from '../../../common/errors';

/**
 * Reseller price rules (M11 S54.3): pure arithmetic and validation. A rule adds a MARKUP to the wholesale rating of a plan or a meter:
 *   percent: retail = wholesale + floor(wholesale × bps / 10000)
 *   fixed:   retail = wholesale + round-half-up(amountMinor × billable quantity)      (per unit, exact decimal arithmetic)
 * A markup can never be negative: retail below wholesale cost is refused (`below_cost`). Money is integer minor units only; quantities are decimal STRINGS. Rules are effective-dated and
 * versioned: the rule in force at an instant is, per (scope, key), the one from the highest rule-set version whose effective date has passed.
 */
export type Markup = { type: 'percent'; bps: number } | { type: 'fixed'; amountMinor: string; currency: string };
export interface RuleInput {
  scope: 'plan' | 'meter';
  scopeKey: string;
  markup: Markup;
  effectiveFrom: string;
}
export interface StoredRule {
  scope: 'plan' | 'meter';
  scopeKey: string;
  markup: Markup;
  effectiveFrom: Date;
  ruleSetVersion: number;
}
export const MIN_LEAD_MS = 86_400_000; // effective date >= now + 1 day
export const MAX_RULES = 200;

const bad = (detail: string, errors?: unknown[]) => new ProblemException('validation_failed', detail, errors);
const below = (detail: string, errors: unknown[]) => new ProblemException('below_cost', detail, errors);

export function validateRules(input: unknown, now: Date, currency: string): RuleInput[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_RULES) throw bad(`rules must be 1..${MAX_RULES} entries`);
  const seen = new Set<string>();
  const out: RuleInput[] = [];
  for (const [i, raw] of input.entries()) {
    const r = raw as Partial<RuleInput> | null;
    if (!r || typeof r !== 'object') throw bad(`rules[${i}] must be an object`);
    if (r.scope !== 'plan' && r.scope !== 'meter') throw bad(`rules[${i}].scope must be plan or meter`);
    if (typeof r.scopeKey !== 'string' || !/^[a-z][a-z0-9_.-]{0,119}$/.test(r.scopeKey)) throw bad(`rules[${i}].scopeKey must be a plan key or meter id`);
    const dup = `${r.scope}:${r.scopeKey}`;
    if (seen.has(dup)) throw bad(`rules[${i}] repeats ${dup}`);
    seen.add(dup);
    const t = typeof r.effectiveFrom === 'string' ? new Date(r.effectiveFrom) : null;
    if (!t || Number.isNaN(t.getTime())) throw bad(`rules[${i}].effectiveFrom must be an RFC 3339 timestamp`);
    if (t.getTime() < now.getTime() + MIN_LEAD_MS) throw bad(`rules[${i}].effectiveFrom must be at least one day from now`, [{ code: 'effective_date_too_soon', path: `rules[${i}].effectiveFrom` }]);
    const m = r.markup as Markup | undefined;
    if (!m || typeof m !== 'object') throw bad(`rules[${i}].markup is required`);
    if (m.type === 'percent') {
      if (!Number.isInteger(m.bps)) throw bad(`rules[${i}].markup.bps must be an integer`);
      if (m.bps < 0) throw below(`rules[${i}]: a negative markup sells below the wholesale cost`, [{ code: 'below_cost', path: `rules[${i}].markup.bps` }]);
      if (m.bps > 100_000) throw bad(`rules[${i}].markup.bps is at most 100000 (1000 %)`);
    } else if (m.type === 'fixed') {
      if (typeof m.amountMinor !== 'string' || !/^-?\d{1,15}$/.test(m.amountMinor)) throw bad(`rules[${i}].markup.amountMinor must be an integer string`);
      if (m.amountMinor.startsWith('-')) throw below(`rules[${i}]: a negative markup sells below the wholesale cost`, [{ code: 'below_cost', path: `rules[${i}].markup.amountMinor` }]);
      if (m.currency !== currency) throw bad(`rules[${i}].markup.currency must be ${currency}`);
    } else throw bad(`rules[${i}].markup.type must be percent or fixed`);
    out.push({ scope: r.scope, scopeKey: r.scopeKey, markup: m, effectiveFrom: t.toISOString() });
  }
  return out;
}

/** Exact decimal × integer, rounded half up. `quantity` has up to 8 decimals (the metering scale). */
export function mulRoundHalfUp(amountMinor: bigint, quantity: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(quantity);
  if (!m) throw bad('quantity must be a non-negative decimal string');
  const frac = (m[2] ?? '').padEnd(8, '0');
  const q = BigInt(m[1]! + frac);
  const p = amountMinor * q;
  const d = 10n ** 8n;
  return (p + d / 2n) / d;
}

export function retailAmount(wholesaleMinor: bigint, quantity: string, markup: Markup | null): bigint {
  if (wholesaleMinor < 0n) throw bad('wholesale must not be negative');
  if (!markup) return wholesaleMinor;
  if (markup.type === 'percent') return wholesaleMinor + (wholesaleMinor * BigInt(markup.bps)) / 10_000n;
  return wholesaleMinor + mulRoundHalfUp(BigInt(markup.amountMinor), quantity);
}

/** The rule in force at `at` for a (scope, key): the highest rule-set version among rules whose effective date has passed; a meter rule beats a plan rule when both exist. */
export function ruleAt(rules: readonly StoredRule[], key: { meterId: string; planKey?: string | null }, at: Date): StoredRule | null {
  const pick = (scope: 'plan' | 'meter', k: string | null | undefined) =>
    k ? rules.filter((r) => r.scope === scope && r.scopeKey === k && r.effectiveFrom.getTime() <= at.getTime()).sort((a, b) => b.ruleSetVersion - a.ruleSetVersion)[0] ?? null : null;
  return pick('meter', key.meterId) ?? pick('plan', key.planKey);
}
