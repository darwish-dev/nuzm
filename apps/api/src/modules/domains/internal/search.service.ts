import type { AvailabilityResult } from '@nuzm/registrar-contracts';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { SlidingWindowLimiter } from '../../../common/rate-limit';
import { badRequest, normalizeDomainName, splitDomain } from './common';
import type { EligibilityService } from './eligibility.service';
import { customerUnitPrice } from './pricing';
import type { DomainsConfig } from './ports';
import type { RegistrarAccessService, RegistrarAccount } from './registrar-access.service';

export interface SearchItem {
  name: string;
  tld: string;
  /** null = not asked (the TLD is not sold); 'unknown' = the registry did not answer: never shown as available. */
  available: boolean | 'unknown' | null;
  premium: boolean;
  price: { amountMinor: string; currency: string } | null;
  eligibility: { state: 'allowed' | 'blocked'; rule: string; reason: string };
  purchasable: boolean;
  cacheTtl: number;
  stale: boolean;
}

/**
 * Domain search (M07 S28 task 4). Availability is cached 60 s per registrar account and name, the TLD catalogue 15 min (proposal values, config). Only TLDs
 * that the platform policy allows AND a verified, enabled registrar account supports are asked about (the rest are listed as blocked with the reason, no vendor
 * call). Search terms are `internal` data, not `personal`: they are never logged with the caller's identity. A per-organization rate limit applies.
 */
export class SearchService {
  private readonly cache = new Map<string, { at: number; v: AvailabilityResult }>();
  private readonly limiter = new SlidingWindowLimiter();
  constructor(
    private readonly access: RegistrarAccessService,
    private readonly eligibility: EligibilityService,
    private readonly audit: AuditSink,
    private readonly cfg: DomainsConfig,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** Cached availability for one account; `fresh` bypasses the cache (quote time). */
  async availability(
    account: RegistrarAccount,
    names: string[],
    tlds: string[],
    traceId: string,
    opts: { fresh?: boolean } = {},
  ): Promise<AvailabilityResult[]> {
    const acc = this.access.accessFor(account, traceId);
    if (!acc)
      throw new ProblemException(
        'unsupported_capability',
        'no adapter is available for this registrar',
      );
    const now = this.clock();
    const out: AvailabilityResult[] = [];
    const missing: { label: string; tld: string }[] = [];
    for (const label of names)
      for (const tld of tlds) {
        const hit = opts.fresh ? undefined : this.cache.get(`${account.id}|${label}.${tld}`);
        if (
          hit &&
          now - hit.at < Math.max(hit.v.cacheTtlSeconds, 0) * 1000 &&
          hit.v.cacheTtlSeconds > 0
        )
          out.push(hit.v);
        else missing.push({ label, tld });
      }
    if (missing.length) {
      const labels = [...new Set(missing.map((m) => m.label))];
      const ts = [...new Set(missing.map((m) => m.tld))];
      const fetched = await acc.adapter.search(acc.ctx, labels, ts);
      for (const r of fetched) {
        const ttl = Math.min(r.cacheTtlSeconds, this.cfg.availabilityTtlSeconds);
        const v = { ...r, cacheTtlSeconds: ttl };
        if (v.available !== 'unknown') this.cache.set(`${account.id}|${r.name}`, { at: now, v });
        if (missing.some((m) => `${m.label}.${m.tld}` === r.name)) out.push(v);
      }
    }
    return out;
  }

  async search(
    orgId: string,
    actorUserId: string,
    q: { q?: unknown; tlds?: unknown; country?: unknown },
    traceId: string,
  ): Promise<{ items: SearchItem[]; ruleSetVersion: string }> {
    if (
      !this.limiter.allow(`search:${orgId}`, this.cfg.searchRatePerMinute, 60_000, this.clock())
    ) {
      await this.audit.record({
        action: 'domain.search.quota_exceeded',
        orgId,
        actorUserId,
        outcome: 'failure',
        resource: { type: 'domain_search' },
      });
      throw new ProblemException('rate_limited', 'too many domain searches; try again in a minute');
    }
    if (typeof q.q !== 'string' || q.q.trim() === '') throw badRequest('q is required');
    if (
      q.country !== undefined &&
      (typeof q.country !== 'string' || !/^[A-Za-z]{2}$/.test(q.country))
    )
      throw badRequest('country must be an ISO 3166-1 alpha-2 code');
    const accounts = await this.access.sellableAccounts();
    const known = new Set<string>();
    for (const a of accounts) for (const t of a.tldSupport) known.add(t.tld);
    const typed = normalizeDomainName(q.q);
    if (!typed) throw badRequest('q is not a valid domain name or label');
    let label = typed;
    let wanted: string[] = [];
    if (Array.isArray(q.tlds) || typeof q.tlds === 'string') {
      wanted = (Array.isArray(q.tlds) ? q.tlds : String(q.tlds).split(','))
        .map((t) => String(t).trim().toLowerCase().replace(/^\./, ''))
        .filter(Boolean);
      if (wanted.length > 20 || wanted.some((t) => !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(t)))
        throw badRequest('tlds must be at most 20 valid TLDs');
    }
    if (typed.includes('.')) {
      const s = splitDomain(typed, [...known, ...wanted]);
      if (!s) throw badRequest('q must be a single label or a name under a known TLD');
      label = s.label;
      if (!wanted.includes(s.tld)) wanted.push(s.tld);
    }
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      throw badRequest('q is not a valid domain label');
    if (wanted.length === 0)
      wanted = [...known].filter(
        (t) =>
          this.eligibility.decide(
            t,
            'register',
            accounts.flatMap((a) => a.tldSupport).find((x) => x.tld === t),
          ).result === 'allowed',
      );
    if (wanted.length === 0)
      throw new ProblemException(
        'unsupported_capability',
        'no verified registrar currently sells any TLD',
      );

    const items: SearchItem[] = [];
    const byAccount = new Map<string, { account: RegistrarAccount; tlds: string[] }>();
    for (const tld of wanted) {
      const pick = await this.access.pick(tld, ['registrar.search', 'registrar.register']);
      const d = this.eligibility.decide(tld, 'register', pick?.support);
      if (d.result !== 'allowed' || !pick) {
        items.push({
          name: `${label}.${tld}`,
          tld,
          available: null,
          premium: false,
          price: null,
          eligibility: { state: 'blocked', rule: d.rule, reason: d.reason },
          purchasable: false,
          cacheTtl: 0,
          stale: false,
        });
        continue;
      }
      const g = byAccount.get(pick.account.id) ?? { account: pick.account, tlds: [] };
      g.tlds.push(tld);
      byAccount.set(pick.account.id, g);
    }
    for (const g of byAccount.values()) {
      let results: AvailabilityResult[];
      try {
        results = await this.availability(g.account, [label], g.tlds, traceId);
      } catch (e) {
        if (e instanceof ProblemException) throw e;
        results = g.tlds.map((tld) => ({
          name: `${label}.${tld}`,
          tld,
          available: 'unknown' as const,
          premium: false,
          registerPrice: null,
          renewPrice: null,
          transferPrice: null,
          cacheTtlSeconds: 0,
          observedAt: new Date(this.clock()).toISOString(),
        }));
      }
      for (const r of results) {
        const unit = r.registerPrice ? customerUnitPrice(r.registerPrice, this.cfg) : null;
        const price = unit
          ? { amountMinor: unit.unitMinor.toString(), currency: unit.currency }
          : null;
        items.push({
          name: r.name,
          tld: r.tld,
          available: r.available,
          premium: r.premium,
          price,
          eligibility: {
            state: 'allowed',
            rule: 'policy.allowed',
            reason: 'enabled in the policy and supported by a verified registrar account',
          },
          purchasable: r.available === true && !r.premium && price !== null,
          cacheTtl: r.cacheTtlSeconds,
          stale: r.available === 'unknown',
        });
      }
    }
    items.sort((a, b) => a.tld.localeCompare(b.tld));
    return { items, ruleSetVersion: this.eligibility.ruleSetVersion };
  }
}
