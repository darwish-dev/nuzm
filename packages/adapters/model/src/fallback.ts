/**
 * Approved fallback routing (S-AG4, gap G4). PURE. The gateway ranks only candidates that residency, data terms, capability, context and budget already allowed
 * (`@nuzm/domain` routing); this policy narrows WHICH of those may stand in for another when a call fails. It can only REMOVE candidates from the allowed list,
 * never add one, so no policy can cross residency, data terms or a budget.
 *
 *  - `any_allowed` (default, today's behaviour): every allowed candidate is a fallback for every other.
 *  - `approved_only`: the best-ranked candidate is the primary; another candidate is a fallback only when an administrator listed it as approved for a candidate that
 *    comes before it (`approved["provider/model"] = ["provider/model", …]`). Approval is directional: A→B does not approve B→A. Chains work (A→B, B→C).
 */
export type FallbackMode = 'any_allowed' | 'approved_only';
export interface FallbackPolicy {
  mode: FallbackMode;
  approved: Record<string, string[]>;
}
export const DEFAULT_FALLBACK_POLICY: FallbackPolicy = { mode: 'any_allowed', approved: {} };
export const candidateKey = (c: { providerCode: string; modelId: string }): string =>
  `${c.providerCode}/${c.modelId}`;

/** Parse a policy from untrusted JSON (an environment value or an admin payload). Anything malformed is `null`: the caller keeps the safe default. */
export function parseFallbackPolicy(raw: unknown): FallbackPolicy | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { mode?: unknown; approved?: unknown };
  if (r.mode !== 'any_allowed' && r.mode !== 'approved_only') return null;
  const approved: Record<string, string[]> = {};
  if (r.approved !== undefined) {
    if (!r.approved || typeof r.approved !== 'object' || Array.isArray(r.approved)) return null;
    for (const [k, v] of Object.entries(r.approved)) {
      if (!KEY.test(k) || !Array.isArray(v) || v.length > 32 || v.some((x) => typeof x !== 'string' || !KEY.test(x)))
        return null;
      approved[k] = [...new Set(v as string[])];
    }
  }
  return { mode: r.mode, approved };
}
const KEY = /^[a-z][a-z0-9-]{0,62}\/[A-Za-z0-9._:-]{1,128}$/;

/** The candidates the gateway may try, in ranked order. */
export function applyFallbackPolicy<T extends { providerCode: string; modelId: string }>(
  ranked: readonly T[],
  policy: FallbackPolicy | null | undefined,
): T[] {
  if (!policy || policy.mode === 'any_allowed' || ranked.length <= 1) return [...ranked];
  const out: T[] = [ranked[0]!];
  for (const c of ranked.slice(1)) {
    const k = candidateKey(c);
    // approved for ANY earlier eligible candidate (the one that may have failed before this one is tried)
    if (out.some((p) => policy.approved[candidateKey(p)]?.includes(k))) out.push(c);
  }
  return out;
}
