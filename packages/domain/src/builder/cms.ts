import type { Locale, Localized, Section, SiteModel } from './site-model';

/**
 * CMS binding (M09 S41.3): a `faq`, `features`, `testimonials` or `pricing` section with `props.collection = <key>` takes its items from the PUBLISHED items of that
 * collection at BUILD time. The stored model keeps its placeholder items (the schema needs ≥ 1); the build output uses the collection. Plain-text values are used for
 * every declared locale; `localized_text` values must cover the declared locales or fall back to the first present one. Pure; the result is still a valid model.
 */
export interface BoundCollection {
  key: string;
  items: { data: Record<string, unknown> }[];
}
const MAPPING: Record<string, { prop: string; loc: string[]; str: string[]; max: number }> = {
  faq: { prop: 'items', loc: ['question', 'answer'], str: [], max: 20 },
  features: { prop: 'items', loc: ['title', 'text'], str: ['icon'], max: 12 },
  testimonials: { prop: 'items', loc: ['quote', 'role'], str: ['author'], max: 12 },
  pricing: {
    prop: 'plans',
    loc: ['name', 'description', 'period'],
    str: ['price', 'currency'],
    max: 8,
  },
};
const toLocalized = (v: unknown, locales: Locale[]): Localized | undefined => {
  if (typeof v === 'string' && v !== '')
    return Object.fromEntries(locales.map((l) => [l, v])) as Localized;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const first = (['ar', 'en'] as const)
      .map((l) => o[l])
      .find((x): x is string => typeof x === 'string' && x !== '');
    if (first === undefined) return undefined;
    return Object.fromEntries(
      locales.map((l) => [l, typeof o[l] === 'string' && o[l] !== '' ? o[l] : first]),
    ) as Localized;
  }
  return undefined;
};
export function bindCollections(model: SiteModel, collections: BoundCollection[]): SiteModel {
  const m = JSON.parse(JSON.stringify(model)) as SiteModel;
  for (const p of m.pages)
    for (const s of p.sections as Section[]) {
      const key = s.props.collection;
      const map = MAPPING[s.type];
      if (typeof key !== 'string' || !map) continue;
      const col = collections.find((c) => c.key === key);
      if (!col || col.items.length === 0) continue; // nothing published: keep the placeholder items
      const items = col.items.slice(0, map.max).map((it) => {
        const out: Record<string, unknown> = {};
        for (const k of map.loc) {
          const v = toLocalized(it.data[k], m.locales);
          if (v) out[k] = v;
        }
        for (const k of map.str) if (typeof it.data[k] === 'string') out[k] = it.data[k];
        if (s.type === 'pricing' && typeof it.data.price === 'number')
          out.price = String(it.data.price);
        return out;
      });
      s.props[map.prop] = items;
    }
  return m;
}
