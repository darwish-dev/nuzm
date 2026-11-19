import type { CatalogPlan } from './hosting-catalog';

/**
 * The hosting basket. Choosing a plan puts one line (one future website) in the basket; the basket lives in this browser, per organization, until the
 * checkout turns each line into a real quote and a real site. It holds no money of its own: a line carries the plan's price as the API listed it
 * (integer minor units, never a float) only to show a running total, and the checkout always asks the API for the real quote.
 */
export const CART_MAX = 10;
export const cartKey = (orgId: string): string => `nuzm_cart:${orgId}`;

interface LineBase {
  /** One line = one thing to buy; the same plan can be in the basket twice. */
  id: string;
  /** The price as the API listed it (integer minor units), or null when it is quoted at checkout. */
  priceMinor: string | null;
  currency: string | null;
  addedAt: number;
}
/** One future website on a hosting plan. */
export interface HostingLine extends LineBase {
  kind: 'hosting';
  planId: string;
  key: string;
  name: { ar: string; en: string };
  quotas: { diskMb: number; bandwidthGb: number; dbCount: number; sitesCount: number };
  runtimes: string[];
}
/** One domain name to register (its registrant details and consents are collected by the domain checkout, never here). */
export interface DomainLine extends LineBase {
  kind: 'domain';
  domain: string;
  years: number;
}
/** One cloud server: the exact offer and operating system that were chosen. Its name, SSH keys and the final quote are asked when it is ordered. */
export interface ServerLine extends LineBase {
  kind: 'server';
  offerId: string;
  family: string;
  country: string;
  dataRegion: string;
  vcpu: number;
  memoryMb: number;
  diskGb: number;
  imageId: string;
  imageName: string;
}
export type CartLine = HostingLine | DomainLine | ServerLine;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v: unknown, max = 200): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;

/** Reads the stored basket defensively: anything that is not a well-formed line is dropped, a broken value is an empty basket. */
export function parseCart(raw: string | null | undefined): CartLine[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: CartLine[] = [];
  for (const x of data.slice(0, CART_MAX)) {
    if (!isObj(x)) continue;
    const id = str(x.id, 64);
    if (!id) continue;
    const price =
      typeof x.priceMinor === 'string' && /^\d{1,15}$/.test(x.priceMinor) ? x.priceMinor : null;
    const currency =
      typeof x.currency === 'string' && /^[A-Z]{3}$/.test(x.currency) ? x.currency : null;
    const base = {
      id,
      priceMinor: price && currency ? price : null,
      currency: price && currency ? currency : null,
      addedAt: num(x.addedAt),
    };
    if (x.kind === 'server') {
      const offerId = str(x.offerId, 64);
      const imageId = str(x.imageId, 64);
      const imageName = str(x.imageName, 120);
      const family = str(x.family, 30);
      const country =
        typeof x.country === 'string' && /^[A-Z]{2}$/.test(x.country) ? x.country : null;
      const dataRegion = str(x.dataRegion, 30);
      if (!offerId || !imageId || !imageName || !family || !country || !dataRegion) continue;
      out.push({
        ...base,
        kind: 'server',
        offerId,
        family,
        country,
        dataRegion,
        vcpu: num(x.vcpu),
        memoryMb: num(x.memoryMb),
        diskGb: num(x.diskGb),
        imageId,
        imageName,
      });
      continue;
    }
    if (x.kind === 'domain') {
      const domain = str(x.domain, 253);
      if (!domain || !/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(domain)) continue;
      const years =
        Number.isInteger(x.years) && (x.years as number) >= 1 && (x.years as number) <= 10
          ? (x.years as number)
          : 1;
      out.push({ ...base, kind: 'domain', domain, years });
      continue;
    }
    // a line stored before baskets had kinds is a hosting line
    if (!isObj(x.name) || !isObj(x.quotas)) continue;
    const planId = str(x.planId, 64);
    const key = str(x.key, 64);
    const ar = str(x.name.ar, 120);
    const en = str(x.name.en, 120);
    if (!planId || !key || !ar || !en) continue;
    out.push({
      ...base,
      kind: 'hosting',
      planId,
      key,
      name: { ar, en },
      quotas: {
        diskMb: num(x.quotas.diskMb),
        bandwidthGb: num(x.quotas.bandwidthGb),
        dbCount: num(x.quotas.dbCount),
        sitesCount: num(x.quotas.sitesCount),
      },
      runtimes: Array.isArray(x.runtimes)
        ? x.runtimes.filter((r): r is string => typeof r === 'string').slice(0, 12)
        : [],
    });
  }
  return out;
}

export const serializeCart = (lines: CartLine[]): string =>
  JSON.stringify(lines.slice(0, CART_MAX));

export function lineFromPlan(plan: CatalogPlan, id: string, now = Date.now()): HostingLine {
  const price = plan.price;
  const approved =
    price && !price.placeholder && price.amountMinor && price.currency ? price : null;
  return {
    kind: 'hosting',
    id,
    planId: plan.id,
    key: plan.key,
    name: plan.name,
    quotas: {
      diskMb: plan.quotas.diskMb,
      bandwidthGb: plan.quotas.bandwidthGb,
      dbCount: plan.quotas.dbCount,
      sitesCount: plan.quotas.sitesCount,
    },
    runtimes: plan.runtimes,
    priceMinor: approved?.amountMinor ?? null,
    currency: approved?.currency ?? null,
    addedAt: now,
  };
}

export function lineFromDomain(
  domain: string,
  price: { amountMinor?: string; currency?: string } | null,
  id: string,
  now = Date.now(),
): DomainLine {
  const ok =
    price?.amountMinor && price.currency && /^\d{1,15}$/.test(price.amountMinor) ? price : null;
  return {
    kind: 'domain',
    id,
    domain: domain.toLowerCase(),
    years: 1,
    priceMinor: ok?.amountMinor ?? null,
    currency: ok?.currency ?? null,
    addedAt: now,
  };
}

export function lineFromServer(
  o: {
    offerId: string;
    family?: string;
    country: string;
    dataRegion: string;
    plan: { vcpu: number; memoryMb: number; diskGb: number };
    price: { amount: string; currency: string };
  },
  image: { id: string; name: string },
  id: string,
  now = Date.now(),
): ServerLine {
  return {
    kind: 'server',
    id,
    offerId: o.offerId,
    family: o.family ?? 'core',
    country: o.country,
    dataRegion: o.dataRegion,
    vcpu: o.plan.vcpu,
    memoryMb: o.plan.memoryMb,
    diskGb: o.plan.diskGb,
    imageId: image.id,
    imageName: image.name,
    priceMinor: /^\d{1,15}$/.test(o.price.amount) ? o.price.amount : null,
    currency: /^[A-Z]{3}$/.test(o.price.currency) ? o.price.currency : null,
    addedAt: now,
  };
}

/** Adds a line unless the basket is full. A domain name already in the basket is not added twice. */
export function addLine(lines: CartLine[], line: CartLine): { lines: CartLine[]; added: boolean } {
  if (line.kind === 'domain' && lines.some((l) => l.kind === 'domain' && l.domain === line.domain))
    return { lines, added: true };
  if (lines.length >= CART_MAX) return { lines, added: false };
  return { lines: [...lines, line], added: true };
}
export const removeLine = (lines: CartLine[], id: string): CartLine[] =>
  lines.filter((l) => l.id !== id);

export interface CartTotals {
  count: number;
  /** The common currency of the priced lines, or null when none is priced. */
  currency: string | null;
  /** Sum of the lines that have a price, in minor units. */
  knownMinor: bigint;
  /** Lines whose price is only quoted at checkout. */
  unpriced: number;
  /** Priced lines in more than one currency: no single total is shown. */
  mixedCurrency: boolean;
}
export function totals(lines: CartLine[]): CartTotals {
  let known = 0n;
  let unpriced = 0;
  const currencies = new Set<string>();
  for (const l of lines) {
    if (l.priceMinor && l.currency) {
      known += BigInt(l.priceMinor);
      currencies.add(l.currency);
    } else unpriced += 1;
  }
  return {
    count: lines.length,
    currency: currencies.size === 1 ? [...currencies][0]! : null,
    knownMinor: known,
    unpriced,
    mixedCurrency: currencies.size > 1,
  };
}
