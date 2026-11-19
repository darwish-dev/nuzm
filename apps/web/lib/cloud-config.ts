import type { Offer } from './compute';

/**
 * Pure helpers of the "get a new cloud server" screen: the offers (already filtered by the API to what this organization may buy) are grouped
 * by region, then by Nuzm Cloud product line, then by size. Nothing here knows who runs the infrastructure behind an offer: the API only
 * returns a Nuzm product line (`family`).
 */

/** Display order of the product lines; an unknown (newer) line goes last, a missing one is the generic `core`. */
export const FAMILY_ORDER = ['spark', 'nova', 'atlas', 'orbit', 'core'] as const;
const rankOf = (f: string) => {
  const i = (FAMILY_ORDER as readonly string[]).indexOf(f);
  return i === -1 ? FAMILY_ORDER.length : i;
};
export const familyOf = (o: Pick<Offer, 'family'>): string => o.family ?? 'core';

const price = (o: Offer) => BigInt(o.price.amount);
const byPrice = (a: Offer, b: Offer) =>
  price(a) < price(b) ? -1 : price(a) > price(b) ? 1 : a.offerId < b.offerId ? -1 : 1;

export interface RegionOption {
  country: string;
  dataRegion: string;
  offers: number;
}
/** Regions that have at least one offer: in-Kingdom first (it is the default placement), then by country code. */
export function regionsOf(offers: Offer[]): RegionOption[] {
  const by = new Map<string, RegionOption>();
  for (const o of offers) {
    const r = by.get(o.country) ?? { country: o.country, dataRegion: o.dataRegion, offers: 0 };
    r.offers += 1;
    by.set(o.country, r);
  }
  return [...by.values()].sort(
    (a, b) =>
      Number(b.dataRegion === 'in_kingdom') - Number(a.dataRegion === 'in_kingdom') ||
      a.country.localeCompare(b.country),
  );
}

export interface FamilyOption {
  family: string;
  /** The cheapest offer of the line in the region: "from" price. */
  from: Offer;
  sizes: number;
}
export function familiesIn(offers: Offer[], country: string): FamilyOption[] {
  const by = new Map<string, Offer[]>();
  for (const o of offers.filter((x) => x.country === country)) {
    const k = familyOf(o);
    by.set(k, [...(by.get(k) ?? []), o]);
  }
  return [...by.entries()]
    .map(([family, list]) => ({ family, from: [...list].sort(byPrice)[0]!, sizes: list.length }))
    .sort((a, b) => rankOf(a.family) - rankOf(b.family));
}

/** Sizes of one line in one region, smallest first. */
export function sizesFor(offers: Offer[], country: string, family: string): Offer[] {
  return offers
    .filter((o) => o.country === country && familyOf(o) === family)
    .sort(
      (a, b) => a.plan.vcpu - b.plan.vcpu || a.plan.memoryMb - b.plan.memoryMb || byPrice(a, b),
    );
}

export interface Selection {
  country: string;
  family: string;
  offerId: string;
}
/**
 * A valid selection for the offers: the wanted offer when it exists, otherwise the first region, its first line and that line's smallest size.
 * `prefer` lets a change of region or line keep the nearest size (same vCPU and memory) instead of jumping back to the smallest one.
 */
export function selectionFor(
  offers: Offer[],
  want: Partial<Selection> & { like?: Offer } = {},
): Selection | null {
  if (offers.length === 0) return null;
  const direct = want.offerId ? offers.find((o) => o.offerId === want.offerId) : undefined;
  if (direct) return { country: direct.country, family: familyOf(direct), offerId: direct.offerId };
  const country =
    want.country && offers.some((o) => o.country === want.country)
      ? want.country
      : regionsOf(offers)[0]!.country;
  const fams = familiesIn(offers, country);
  const family = fams.find((f) => f.family === want.family)?.family ?? fams[0]!.family;
  const sizes = sizesFor(offers, country, family);
  const like = want.like;
  const same = like
    ? sizes.find((s) => s.plan.vcpu === like.plan.vcpu && s.plan.memoryMb === like.plan.memoryMb)
    : undefined;
  return { country, family, offerId: (same ?? sizes[0]!).offerId };
}
