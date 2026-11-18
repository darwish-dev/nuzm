import { Resolver } from 'node:dns/promises';
import type { RequiredDnsRecord } from '@nuzm/adapter-data';

/** What one resolver saw for one name and type. `ttl` in seconds (300 when the resolver API does not expose it). `error` = the lookup itself failed (not "no record"). */
export interface DnsAnswer {
  values: string[];
  ttl: number;
  error?: string;
}
export interface DnsResolverPort {
  readonly name: string;
  resolve(name: string, type: 'TXT' | 'MX' | 'CNAME'): Promise<DnsAnswer>;
}

/** Real lookups against public resolvers (several, so one poisoned or stale cache cannot decide alone). Used outside tests only. */
export class SystemDnsResolver implements DnsResolverPort {
  private readonly r: Resolver;
  constructor(
    readonly name: string,
    servers: string[],
    timeoutMs = 3000,
  ) {
    this.r = new Resolver({ timeout: timeoutMs, tries: 1 });
    this.r.setServers(servers);
  }
  async resolve(name: string, type: 'TXT' | 'MX' | 'CNAME'): Promise<DnsAnswer> {
    try {
      if (type === 'TXT')
        return { values: (await this.r.resolveTxt(name)).map((c) => c.join('')), ttl: 300 };
      if (type === 'MX')
        return {
          values: (await this.r.resolveMx(name)).map((m) => `${m.priority} ${m.exchange}`),
          ttl: 300,
        };
      return { values: await this.r.resolveCname(name), ttl: 300 };
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN')
        return { values: [], ttl: 300 };
      return { values: [], ttl: 60, error: code || 'resolver_error' };
    }
  }
}
export const defaultResolvers = (): DnsResolverPort[] => [
  new SystemDnsResolver('cloudflare', ['1.1.1.1']),
  new SystemDnsResolver('google', ['8.8.8.8']),
  new SystemDnsResolver('quad9', ['9.9.9.9']),
];

export type RecordStatus = 'ok' | 'missing' | 'conflict' | 'unknown';
export interface CheckedRecord extends RequiredDnsRecord {
  status: RecordStatus;
  detail?: string;
}
export interface DmarcState {
  state: 'missing' | 'none' | 'quarantine' | 'reject' | 'invalid' | 'duplicate';
  /** Configuration guidance only (docs/10): the start policy is p=none; Nuzm gives no advice beyond what the DNS currently says. */
  suggestion?: string;
}
export interface DomainCheck {
  records: CheckedRecord[];
  dmarc: DmarcState;
  state: 'pending' | 'partial' | 'verified';
  /** Smallest TTL seen (seconds): when to look again. */
  minTtl: number;
  /** True when every resolver failed: nothing was learned, the state must not change. */
  inconclusive: boolean;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\.$/, '');
const strip = (s: string) => s.replace(/^"+|"+$/g, '');

/** Evaluate ONE record against the answers of every resolver; a verdict needs a strict majority of the resolvers that answered. */
async function checkOne(
  r: RequiredDnsRecord,
  resolvers: DnsResolverPort[],
  domain: string,
): Promise<{ rec: CheckedRecord; ttl: number; answered: number }> {
  const answers = await Promise.all(resolvers.map((x) => x.resolve(r.name, r.type)));
  const live = answers.filter((a) => !a.error);
  const ttl = Math.min(...answers.map((a) => a.ttl), 3600);
  if (live.length === 0)
    return {
      rec: { ...r, status: 'unknown', detail: 'no resolver could be reached' },
      ttl,
      answered: 0,
    };
  const verdicts = live.map((a) => verdict(r, a.values, domain));
  const count = (s: RecordStatus) => verdicts.filter((v) => v.status === s).length;
  const need = Math.floor(live.length / 2) + 1;
  let pick = verdicts.find((v) => v.status === 'missing')!;
  for (const s of ['ok', 'conflict'] as const)
    if (count(s) >= need) pick = verdicts.find((v) => v.status === s)!;
  // no majority at all (resolvers disagree): not verified, and not "missing" either
  if (count('ok') < need && count('conflict') < need && count('missing') < need)
    pick = {
      status: 'conflict',
      detail: 'resolvers disagree about this record (propagation in progress?)',
    };
  return {
    rec: { ...r, status: pick.status, ...(pick.detail ? { detail: pick.detail } : {}) },
    ttl,
    answered: live.length,
  };
}
function verdict(
  r: RequiredDnsRecord,
  values: string[],
  domain: string,
): { status: RecordStatus; detail?: string } {
  if (r.type === 'CNAME') {
    if (values.length === 0) return { status: 'missing' };
    return values.some((v) => norm(v) === norm(r.value))
      ? { status: 'ok' }
      : { status: 'conflict', detail: 'the CNAME points somewhere else' };
  }
  if (r.type === 'MX') return { status: 'missing' }; // MX is evaluated as a set in checkDomain
  const txt = values.map(strip);
  if (r.purpose === 'ownership')
    return txt.some((v) => v.trim() === r.value) ? { status: 'ok' } : { status: 'missing' };
  if (r.purpose === 'spf') {
    const spf = txt.filter((v) => /^v=spf1(\s|$)/i.test(v.trim()));
    if (spf.length === 0) return { status: 'missing' };
    if (spf.length > 1)
      return {
        status: 'conflict',
        detail:
          'more than one SPF record exists: receivers treat that as a permanent error (merge them into one)',
      };
    const need = r.value.split(/\s+/).filter((t) => /^(include|redirect|ip4|ip6|a|mx):/i.test(t));
    const have = spf[0]!.toLowerCase().split(/\s+/);
    const missing = need.filter((t) => !have.includes(t.toLowerCase()));
    if (/(^|\s)\+all(\s|$)/i.test(spf[0]!))
      return { status: 'conflict', detail: 'the SPF record allows every sender (+all)' };
    return missing.length
      ? { status: 'conflict', detail: `the SPF record lacks ${missing.join(', ')}` }
      : { status: 'ok' };
  }
  void domain;
  return { status: 'missing' };
}

function evalMx(required: RequiredDnsRecord[], answers: DnsAnswer[]): CheckedRecord[] {
  const live = answers.filter((a) => !a.error);
  if (live.length === 0)
    return required.map((r) => ({
      ...r,
      status: 'unknown' as const,
      detail: 'no resolver could be reached',
    }));
  const need = Math.floor(live.length / 2) + 1;
  const per = live.map((a) =>
    a.values.map((v) => ({ p: Number(v.split(' ')[0]), h: norm(v.split(' ').slice(1).join(' ')) })),
  );
  const best = Math.min(...required.map((r) => r.priority ?? 10));
  return required.map((r) => {
    const has = per.filter((l) =>
      l.some((m) => m.h === norm(r.value) && m.p === (r.priority ?? 10)),
    ).length;
    if (has >= need) {
      // a foreign MX at an equal or better preference would receive (some of) the mail instead
      const foreign = per.filter((l) =>
        l.some((m) => !required.some((q) => norm(q.value) === m.h) && m.p <= best),
      ).length;
      return foreign >= need
        ? {
            ...r,
            status: 'conflict' as const,
            detail:
              'another MX record has the same or a better preference: mail would not reach this provider',
          }
        : { ...r, status: 'ok' as const };
    }
    const any = per.filter((l) => l.length > 0).length;
    return {
      ...r,
      status: (any >= need ? 'conflict' : 'missing') as RecordStatus,
      ...(any >= need ? { detail: 'the domain has other MX records' } : {}),
    };
  });
}

function dmarcOf(txtPerResolver: DnsAnswer[]): DmarcState {
  const live = txtPerResolver.filter((a) => !a.error);
  const sets = live.map((a) => a.values.map(strip).filter((v) => /^v=DMARC1\b/i.test(v.trim())));
  const need = Math.floor(live.length / 2) + 1;
  if (live.length === 0 || sets.filter((s) => s.length === 0).length >= need)
    return { state: 'missing', suggestion: 'start with p=none (monitor only), then tighten' };
  const multi = sets.filter((s) => s.length > 1).length;
  if (multi >= need) return { state: 'duplicate' };
  const one = sets.find((s) => s.length === 1)?.[0];
  if (!one) return { state: 'invalid' };
  const p = /(?:^|;)\s*p\s*=\s*(none|quarantine|reject)\s*(?:;|$)/i.exec(one);
  return p ? { state: p[1]!.toLowerCase() as DmarcState['state'] } : { state: 'invalid' };
}

/**
 * Live DNS verification (M08 S35 task 1): every required record is looked up on SEVERAL resolvers and judged by majority. SPF must be exactly one record containing the
 * required mechanisms, DKIM selectors are separate required CNAMEs, MX is judged as a set, DMARC is guidance (never blocks). `verified` needs every REQUIRED record ok.
 * A lookup failure on every resolver is `inconclusive`: the previous state stays and the caller retries sooner.
 */
export async function checkDomain(
  domain: string,
  required: RequiredDnsRecord[],
  resolvers: DnsResolverPort[],
): Promise<DomainCheck> {
  const records: CheckedRecord[] = [];
  let minTtl = 3600;
  let answered = 0;
  const mx = required.filter((r) => r.type === 'MX');
  const rest = required.filter((r) => r.type !== 'MX');
  for (const r of rest) {
    const c = await checkOne(r, resolvers, domain);
    records.push(c.rec);
    minTtl = Math.min(minTtl, c.ttl);
    answered += c.answered;
  }
  if (mx.length) {
    const answers = await Promise.all(resolvers.map((x) => x.resolve(mx[0]!.name, 'MX')));
    for (const a of answers) minTtl = Math.min(minTtl, a.ttl);
    answered += answers.filter((a) => !a.error).length;
    records.push(...evalMx(mx, answers));
  }
  const dmarcAnswers = await Promise.all(
    resolvers.map((x) => x.resolve(`_dmarc.${domain}`, 'TXT')),
  );
  const dmarc = dmarcOf(dmarcAnswers);
  const order = new Map(required.map((r, i) => [`${r.type}|${r.name}|${r.value}`, i]));
  records.sort(
    (a, b) =>
      (order.get(`${a.type}|${a.name}|${a.value}`) ?? 0) -
      (order.get(`${b.type}|${b.name}|${b.value}`) ?? 0),
  );
  const req = records.filter((r) => r.required);
  const okReq = req.filter((r) => r.status === 'ok').length;
  const state: DomainCheck['state'] =
    req.length > 0 && okReq === req.length ? 'verified' : okReq > 0 ? 'partial' : 'pending';
  return { records, dmarc, state, minTtl: Math.max(60, minTtl), inconclusive: answered === 0 };
}

/** Records Nuzm adds itself on top of the provider's: the ownership proof and DMARC guidance (p=none start). */
export const ownershipRecord = (domain: string, token: string): RequiredDnsRecord => ({
  type: 'TXT',
  name: `_nuzm-verify.${domain}`,
  value: `nuzm-verification=${token}`,
  purpose: 'ownership',
  required: true,
});
export const dmarcGuidanceRecord = (domain: string): RequiredDnsRecord => ({
  type: 'TXT',
  name: `_dmarc.${domain}`,
  value: 'v=DMARC1; p=none',
  purpose: 'dmarc',
  required: false,
});

/** In-memory resolver for tests: a zone map per resolver (so tests can make resolvers disagree) and optional failure. */
export class FakeDnsResolver implements DnsResolverPort {
  readonly zone = new Map<string, string[]>();
  failing = false;
  ttl = 300;
  constructor(readonly name = 'fake') {}
  set(type: 'TXT' | 'MX' | 'CNAME', name: string, values: string[]) {
    this.zone.set(`${type}|${name.toLowerCase()}`, values);
  }
  add(type: 'TXT' | 'MX' | 'CNAME', name: string, value: string) {
    const k = `${type}|${name.toLowerCase()}`;
    this.zone.set(k, [...(this.zone.get(k) ?? []), value]);
  }
  clear() {
    this.zone.clear();
  }
  async resolve(name: string, type: 'TXT' | 'MX' | 'CNAME'): Promise<DnsAnswer> {
    if (this.failing) return { values: [], ttl: 60, error: 'ESERVFAIL' };
    return { values: this.zone.get(`${type}|${name.toLowerCase()}`) ?? [], ttl: this.ttl };
  }
}
