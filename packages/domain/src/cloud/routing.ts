/**
 * Compute routing (M05 task 7). Explicit mode picks (provider, region); automatic mode picks among eligible offers for a country or geo
 * group. Rules (`cloud.routing_rules`) adjust the candidate set (exclude / pin) and rank (prefer); the tie-break is total and
 * deterministic: rank, then customer price, then provider key, account id, provider region id, plan ref. The decision is recorded in the quote.
 */
export interface RouteCandidate {
  offerId: string;
  providerKey: string;
  accountId: string;
  providerRegionId: string;
  country: string;
  geoGroup: string;
  planRef: string;
  /** Customer price per period in integer minor units. */
  priceMinor: bigint;
}
export interface RoutingRule {
  ruleKey: string;
  version: number;
  priority: number;
  enabled: boolean;
  match: { country?: string[]; geoGroup?: string[]; mode?: 'explicit' | 'automatic' };
  action: {
    type: 'prefer' | 'exclude' | 'pin';
    providerKey?: string;
    accountId?: string;
    providerRegionId?: string;
  };
}
export interface RoutingRequest {
  mode: 'explicit' | 'automatic';
  provider?: string;
  region?: string;
  country?: string;
  geoGroup?: string;
}
export interface RoutingDecision {
  mode: 'explicit' | 'automatic';
  considered: number;
  afterFilters: number;
  chosenOfferId: string | null;
  rulesApplied: { ruleKey: string; version: number; type: string; effect: string }[];
  order: string[];
  tieBreak: string[];
}

export const TIE_BREAK = [
  'rank',
  'priceMinor',
  'providerKey',
  'accountId',
  'providerRegionId',
  'planRef',
] as const;

const ruleMatches = (r: RoutingRule, req: RoutingRequest, c: RouteCandidate): boolean => {
  if (r.match.mode && r.match.mode !== req.mode) return false;
  const country = (req.country ?? c.country).toUpperCase();
  if (r.match.country && !r.match.country.map((x) => x.toUpperCase()).includes(country))
    return false;
  const group = req.geoGroup ?? c.geoGroup;
  if (r.match.geoGroup && !r.match.geoGroup.includes(group)) return false;
  return true;
};
const actionTargets = (r: RoutingRule, c: RouteCandidate): boolean =>
  (r.action.providerKey === undefined || r.action.providerKey === c.providerKey) &&
  (r.action.accountId === undefined || r.action.accountId === c.accountId) &&
  (r.action.providerRegionId === undefined || r.action.providerRegionId === c.providerRegionId);

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function route(
  candidates: readonly RouteCandidate[],
  req: RoutingRequest,
  rules: readonly RoutingRule[],
): { chosen: RouteCandidate | null; decision: RoutingDecision } {
  const applied: RoutingDecision['rulesApplied'] = [];
  let pool = candidates.filter((c) => {
    if (req.mode === 'explicit') {
      if (req.provider !== undefined && c.providerKey !== req.provider) return false;
      if (req.region !== undefined && c.providerRegionId !== req.region) return false;
      if (req.country !== undefined && c.country.toUpperCase() !== req.country.toUpperCase())
        return false;
      return true;
    }
    if (req.country !== undefined && c.country.toUpperCase() !== req.country.toUpperCase())
      return false;
    if (req.geoGroup !== undefined && c.geoGroup !== req.geoGroup) return false;
    return true;
  });
  const afterFilters = pool.length;
  const ordered = [...rules]
    .filter((r) => r.enabled)
    .sort((a, b) => a.priority - b.priority || cmp(a.ruleKey, b.ruleKey) || a.version - b.version);
  const rank = new Map<string, number>();
  for (const r of ordered) {
    const hit = pool.filter((c) => ruleMatches(r, req, c));
    if (!hit.length) continue;
    if (r.action.type === 'exclude') {
      const drop = new Set(hit.filter((c) => actionTargets(r, c)).map((c) => c.offerId));
      if (!drop.size) continue;
      pool = pool.filter((c) => !drop.has(c.offerId));
      applied.push({
        ruleKey: r.ruleKey,
        version: r.version,
        type: 'exclude',
        effect: `excluded ${drop.size}`,
      });
    } else if (r.action.type === 'pin') {
      const keep = pool.filter((c) => ruleMatches(r, req, c) && actionTargets(r, c));
      if (!keep.length) {
        applied.push({
          ruleKey: r.ruleKey,
          version: r.version,
          type: 'pin',
          effect: 'ignored: no candidate matches the pin',
        });
        continue;
      }
      const keepIds = new Set(keep.map((c) => c.offerId));
      pool = pool.filter((c) => keepIds.has(c.offerId));
      applied.push({
        ruleKey: r.ruleKey,
        version: r.version,
        type: 'pin',
        effect: `pinned ${keep.length}`,
      });
    } else {
      const pref = hit.filter((c) => actionTargets(r, c));
      if (!pref.length) continue;
      for (const c of pref) if (!rank.has(c.offerId)) rank.set(c.offerId, r.priority);
      applied.push({
        ruleKey: r.ruleKey,
        version: r.version,
        type: 'prefer',
        effect: `preferred ${pref.length}`,
      });
    }
  }
  const sorted = [...pool].sort(
    (a, b) =>
      (rank.get(a.offerId) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.offerId) ?? Number.MAX_SAFE_INTEGER) ||
      (a.priceMinor < b.priceMinor ? -1 : a.priceMinor > b.priceMinor ? 1 : 0) ||
      cmp(a.providerKey, b.providerKey) ||
      cmp(a.accountId, b.accountId) ||
      cmp(a.providerRegionId, b.providerRegionId) ||
      cmp(a.planRef, b.planRef) ||
      cmp(a.offerId, b.offerId),
  );
  const chosen = sorted[0] ?? null;
  return {
    chosen,
    decision: {
      mode: req.mode,
      considered: candidates.length,
      afterFilters,
      chosenOfferId: chosen?.offerId ?? null,
      rulesApplied: applied,
      order: sorted.slice(0, 10).map((c) => c.offerId),
      tieBreak: [...TIE_BREAK],
    },
  };
}
