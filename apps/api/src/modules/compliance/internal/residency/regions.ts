import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';

export type RegionGroup = 'in_kingdom' | 'gcc' | 'eu' | 'other';
export const GROUPS: RegionGroup[] = ['in_kingdom', 'gcc', 'eu', 'other'];

export interface Target {
  /** What the caller asked for (region id, country code or group). */
  input: string;
  country: string | null;
  group: RegionGroup;
  /** True only for a region with verification evidence. A country code or a group name carries none. */
  verified: boolean;
}

export interface RegionRegistry {
  resolve(targetRegion: string): Target;
}

export interface RegionData {
  groups: Record<RegionGroup, string[]>;
  fixtures: { id: string; country: string; verified: boolean }[];
}

const ISO = /^[A-Z]{2}$/;

export function parseRegionGroups(text: string): RegionData {
  const raw = parse(text) as { groups?: Record<string, unknown>; fixtures?: unknown } | null;
  const fail = (m: string): never => {
    throw new Error(`region groups: ${m}`);
  };
  if (!raw?.groups) return fail('groups are required');
  const groups = { in_kingdom: [], gcc: [], eu: [], other: [] } as Record<RegionGroup, string[]>;
  const seen = new Set<string>();
  for (const g of ['in_kingdom', 'gcc', 'eu'] as const) {
    const list = raw.groups[g];
    if (!Array.isArray(list) || list.some((c) => typeof c !== 'string' || !ISO.test(c)))
      fail(`${g} must be a list of ISO country codes`);
    for (const c of list as string[]) {
      if (seen.has(c)) fail(`country ${c} is in two groups`);
      seen.add(c);
    }
    groups[g] = list as string[];
  }
  if (groups.in_kingdom.length === 0) fail('in_kingdom needs at least one country');
  const fixtures = Array.isArray(raw.fixtures)
    ? (raw.fixtures as { id?: unknown; country?: unknown; verified?: unknown }[])
    : [];
  const out: RegionData['fixtures'] = [];
  for (const f of fixtures) {
    if (typeof f.id !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(f.id))
      fail(`bad fixture id ${JSON.stringify(f.id)}`);
    if (typeof f.country !== 'string' || !ISO.test(f.country))
      fail(`fixture ${String(f.id)}: bad country`);
    if (typeof f.verified !== 'boolean')
      fail(`fixture ${String(f.id)}: verified must be true or false`);
    out.push({ id: f.id as string, country: f.country as string, verified: f.verified as boolean });
  }
  return { groups, fixtures: out };
}

export function loadRegionData(path = process.env.REGION_GROUPS_PATH): RegionData {
  if (path) return parseRegionGroups(readFileSync(resolve(path), 'utf8'));
  for (let d = __dirname, i = 0; i < 12; i++, d = dirname(d)) {
    const f = join(d, 'spec/compliance/region-groups.yaml');
    if (existsSync(f)) return parseRegionGroups(readFileSync(f, 'utf8'));
  }
  throw new Error('region groups: spec/compliance/region-groups.yaml not found');
}

/**
 * Region registry on MOCK fixtures until the M05 provider registry (`cloud.provider_regions`) exists. Rules: a region id resolves through its
 * fixture; an UNVERIFIED region is never `in_kingdom` (a name proves nothing); an unknown id is `other` and unverified; an ISO country code or a
 * group name is accepted for processors that are described by country, and carries no verification (a bare `SA` is not in-Kingdom proof, so it is
 * `in_kingdom` only as a COUNTRY GROUP for policy lists, while region-level placement needs a verified region).
 */
export class MockRegionRegistry implements RegionRegistry {
  private readonly byId = new Map<string, { country: string; verified: boolean }>();
  private readonly groupOf = new Map<string, RegionGroup>();
  constructor(private readonly data: RegionData = loadRegionData()) {
    for (const f of data.fixtures)
      this.byId.set(f.id, { country: f.country, verified: f.verified });
    for (const g of ['in_kingdom', 'gcc', 'eu'] as const)
      for (const c of data.groups[g]) this.groupOf.set(c, g);
  }
  group(country: string): RegionGroup {
    return this.groupOf.get(country) ?? 'other';
  }
  resolve(targetRegion: string): Target {
    const input = String(targetRegion ?? '').slice(0, 64);
    const fx = this.byId.get(input);
    if (fx) {
      const group = fx.verified
        ? this.group(fx.country)
        : this.group(fx.country) === 'in_kingdom'
          ? 'other'
          : this.group(fx.country);
      return { input, country: fx.country, group, verified: fx.verified };
    }
    if ((GROUPS as string[]).includes(input))
      return { input, country: null, group: input as RegionGroup, verified: false };
    if (ISO.test(input))
      return {
        input,
        country: input,
        group: this.group(input) === 'in_kingdom' ? 'other' : this.group(input),
        verified: false,
      };
    return { input, country: null, group: 'other', verified: false };
  }
}
