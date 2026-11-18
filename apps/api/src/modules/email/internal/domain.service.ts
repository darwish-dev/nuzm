import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import {
  idempotencyToken,
  type AccountContext,
  type DataCatalogSnapshot,
  type OperationResult,
  type RequiredDnsRecord,
} from '@nuzm/adapter-data';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';
import type { ResidencyService } from '../../compliance';
import { DataAdapterRegistry, DataProviderService, isUuid, type DataRow as Row } from '../../data';
import {
  checkDomain,
  dmarcGuidanceRecord,
  ownershipRecord,
  type CheckedRecord,
  type DmarcState,
  type DnsResolverPort,
} from './dns';
import type { DnsLinkagePort } from './dns-linkage.port';

/** The calls domain verification needs from either kind of email adapter (the two `checkDomain`s differ in their argument, so they are typed loosely here). */
interface EmailAdapters {
  catalog(ctx: AccountContext): Promise<DataCatalogSnapshot>;
  verifyDomain(
    ctx: AccountContext,
    domain: string,
    token: string,
  ): Promise<OperationResult<{ providerRef: string; requiredRecords: RequiredDnsRecord[] }>>;
  dnsRequirements(
    ctx: AccountContext,
    domain: string,
  ): Promise<OperationResult<{ requiredRecords: RequiredDnsRecord[] }>>;
  checkDomain(ctx: AccountContext, ref: string): Promise<OperationResult<{ state: string }>>;
}

export interface EmailDomainDto {
  id: string;
  domain: string;
  purposes: ('mailbox' | 'transactional')[];
  state: 'pending' | 'partial' | 'verified' | 'failed';
  requiredRecords: CheckedRecord[];
  dmarc: DmarcState | null;
  /** Set when the domain's DNS is a Nuzm zone: the console offers one-click apply. */
  dnsZoneId: string | null;
  dataRegion: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  etag: number;
  createdAt: string;
}
const iso = (v: unknown) => (v ? (v as Date).toISOString() : null);
const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MAX_ATTEMPTS = 60;

/** One SPF record per name: the transactional and the mailbox provider each need an include; they are merged into ONE record (two SPF records are a permanent error). */
export function mergeRecords(recs: RequiredDnsRecord[]): RequiredDnsRecord[] {
  const out: RequiredDnsRecord[] = [];
  for (const r of recs) {
    const same = out.find(
      (x) =>
        x.type === r.type &&
        x.name === r.name &&
        x.value === r.value &&
        (x.priority ?? 0) === (r.priority ?? 0),
    );
    if (same) {
      same.required = same.required || r.required;
      continue;
    }
    if (r.purpose === 'spf') {
      const spf = out.find((x) => x.purpose === 'spf' && x.name === r.name);
      if (spf) {
        const inc = (v: string) =>
          v.split(/\s+/).filter((t) => /^(include|redirect|ip4|ip6|a|mx):/i.test(t));
        const all = [...new Set([...inc(spf.value), ...inc(r.value)])];
        spf.value = `v=spf1 ${all.join(' ')} ~all`;
        spf.required = spf.required || r.required;
        continue;
      }
    }
    out.push({ ...r });
  }
  return out;
}

/**
 * Email domains (M08 S35 task 1). Adding a domain asks the enabled provider(s) for their REQUIRED records (declaratively), adds Nuzm's own ownership TXT
 * (a token bound to this organization) and DMARC guidance, and stores them. Verification re-reads DNS on several resolvers (majority), then also asks the
 * provider whether IT considers the domain verified; only both together make the domain `verified`. Only one organization can hold a verified claim.
 */
export class EmailDomainService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly providers: DataProviderService,
    private readonly registry: DataAdapterRegistry,
    private readonly residency: Pick<ResidencyService, 'evaluate'>,
    private readonly dns: () => DnsResolverPort[],
    private readonly linkage: DnsLinkagePort,
  ) {}

  dto(r: Row): EmailDomainDto {
    return {
      id: r.id as string,
      domain: r.domain as string,
      purposes: r.purposes as EmailDomainDto['purposes'],
      state: r.verification_state as EmailDomainDto['state'],
      requiredRecords: (r.required_records as CheckedRecord[]) ?? [],
      dmarc: (r.dmarc as DmarcState | null) ?? null,
      dnsZoneId: (r.dns_zone_id as string | null) ?? null,
      dataRegion: r.data_region as string,
      verifiedAt: iso(r.verified_at),
      lastCheckedAt: iso(r.last_checked_at),
      nextCheckAt: iso(r.next_check_at),
      etag: r.version_lock as number,
      createdAt: iso(r.created_at)!,
    };
  }

  async create(
    orgId: string,
    actor: string,
    body: Record<string, unknown>,
  ): Promise<EmailDomainDto> {
    const domain =
      typeof body.domain === 'string' ? body.domain.trim().toLowerCase().replace(/\.$/, '') : '';
    if (!DOMAIN.test(domain) || domain.length > 253)
      throw new ProblemException(
        'validation_failed',
        'domain must be a fully qualified domain name (IDNs in punycode)',
      );
    const purposes = body.purposes;
    if (
      !Array.isArray(purposes) ||
      purposes.length < 1 ||
      purposes.some((p) => p !== 'mailbox' && p !== 'transactional') ||
      new Set(purposes).size !== purposes.length
    )
      throw new ProblemException(
        'validation_failed',
        'purposes must be a non-empty subset of mailbox, transactional',
      );
    if (Object.keys(body).some((k) => !['domain', 'purposes'].includes(k)))
      throw new ProblemException('validation_failed', 'unknown field');
    // a domain another account has already VERIFIED cannot be claimed again (an unverified claim proves nothing and never blocks anyone)
    const taken = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT 1 FROM email.email_domains WHERE domain = $1 AND verification_state = 'verified' AND deleted_at IS NULL AND org_id <> $2`,
            [domain, orgId],
          )
        ).rowCount,
    );
    if (taken)
      throw new ProblemException(
        'domain_not_owned',
        'this domain is already verified by another account',
      );
    const token = randomBytes(30).toString('base64url');
    let records: RequiredDnsRecord[] = [ownershipRecord(domain, token)];
    let txRef: string | null = null;
    let txProvider: string | null = null;
    let mbProvider: string | null = null;
    let region = '';
    for (const purpose of purposes as ('mailbox' | 'transactional')[]) {
      const service = purpose === 'mailbox' ? 'mailbox' : 'transactional-email';
      const p = await this.providers.resolveEnabled(orgId, service); // 422 unsupported_capability when none is enabled: never a mock in production
      const caps = p.row.probe?.capabilities ?? {};
      const need = purpose === 'mailbox' ? 'mailbox.dns-requirements' : 'email.domain-verification';
      if (!p.row.probe?.passed || caps[need] !== 'supported')
        throw new ProblemException(
          'unsupported_capability',
          `the ${service} provider probe does not report ${need} as supported`,
        );
      const ctx = this.registry.ctx({ id: p.row.id, config: p.row.config }, 'email-domain');
      // email metadata and content go to the provider's processing region: residency is evaluated BEFORE the provider is told about the domain
      const adapter = p.adapter as unknown as EmailAdapters;
      const cat = await adapter.catalog(ctx);
      const target =
        (p.row.config.processingRegion as string | undefined) ??
        cat.regions[0]?.providerRegionId ??
        'unknown';
      const res = await this.residency.evaluate({
        orgId,
        dataClass: 'personal',
        targetRegion: target,
        purpose: 'email_domain',
        operation: 'write',
        // a vendor (provider-*) is a processor that must be in the ROPA; a Nuzm-run family is not a third party
        ...(p.row.family.startsWith('provider-') ? { processorId: p.row.providerCode } : {}),
      });
      if (res.decision !== 'allow')
        throw new ProblemException(
          'residency_denied',
          res.reasons.map((r) => r.message.en).join('; ') ||
            'email processing in this region is not allowed by the residency policy',
        );
      region = target;
      if (purpose === 'transactional') {
        const r = await adapter.verifyDomain(
          ctx,
          domain,
          idempotencyToken(orgId, domain, 'email-domain'),
        );
        if (r.status !== 'succeeded' && r.status !== 'accepted')
          throw new ProblemException(
            r.error?.category === 'unsupported' ? 'unsupported_capability' : 'service_unavailable',
            'the provider could not register the domain',
          );
        // Nuzm's own ownership proof is the one for `_nuzm-verify`; a provider record that wants the same name is replaced by it (a provider-specific proof elsewhere is kept)
        records = [
          ...records,
          ...r.data!.requiredRecords.filter(
            (x) => !(x.purpose === 'ownership' && x.name === records[0]!.name),
          ),
        ];
        txRef = r.data!.providerRef;
        txProvider = p.row.id;
      } else {
        const r = await adapter.dnsRequirements(ctx, domain);
        if (r.status !== 'succeeded' && r.status !== 'accepted')
          throw new ProblemException(
            r.error?.category === 'unsupported' ? 'unsupported_capability' : 'service_unavailable',
            'the provider could not describe the DNS records',
          );
        records = [...records, ...r.data!.requiredRecords.filter((x) => x.purpose !== 'ownership')];
        mbProvider = p.row.id;
      }
    }
    if (!records.some((r) => r.purpose === 'dmarc')) records.push(dmarcGuidanceRecord(domain));
    const merged = mergeRecords(records.filter((r) => r.purpose !== 'dmarc' || r.required)).concat(
      records.filter((r) => r.purpose === 'dmarc' && !r.required).slice(0, 1),
    );
    const checked: CheckedRecord[] = merged.map((r) => ({ ...r, status: 'unknown' }));
    const zone = await this.linkage.findZone(orgId, domain);
    try {
      const row = await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `INSERT INTO email.email_domains (id, org_id, domain, purposes, ownership_token, required_records, tx_provider_id, tx_provider_ref, mailbox_provider_id, dns_zone_id, data_region, next_check_at, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), $12) RETURNING *`,
              [
                uuidv7(),
                orgId,
                domain,
                purposes,
                token,
                JSON.stringify(checked),
                txProvider,
                txRef,
                mbProvider,
                zone?.zoneId ?? null,
                region,
                actor,
              ],
            )
          ).rows[0] as Row,
      );
      await this.audit.record({
        action: 'email.domain.added',
        actorUserId: actor,
        orgId,
        resource: { type: 'email_domain', id: row.id as string },
        outcome: 'success',
        after: { domain, purposes, dataRegion: region },
      });
      return this.dto(row);
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException('conflict', 'this domain is already added to the organization');
      throw e;
    }
  }

  async list(orgId: string, q: { limit: number; cursor?: string }): Promise<Page<EmailDomainDto>> {
    const before = decodeCursor(q.cursor);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM email.email_domains WHERE org_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
            [orgId, before, q.limit + 1],
          )
        ).rows as Row[],
    );
    const p = pageOf(rows as (Row & { id: string })[], q.limit);
    return { items: p.items.map((r) => this.dto(r)), nextCursor: p.nextCursor };
  }
  async row(orgId: string, id: string): Promise<Row> {
    if (!isUuid(id)) throw new ProblemException('not_found');
    const r = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM email.email_domains WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
            [id, orgId],
          )
        ).rows[0],
    )) as Row | undefined;
    if (!r) throw new ProblemException('not_found');
    return r;
  }

  /** The requested records as the adapters declared them (without the checked status), for applying through M07. */
  private declared(r: Row): RequiredDnsRecord[] {
    return ((r.required_records as CheckedRecord[]) ?? []).map(
      ({ status: _s, detail: _d, ...rec }) => rec,
    );
  }

  /**
   * Re-check one domain NOW: optional one-click apply (only when the domain is a Nuzm zone), live DNS on several resolvers, then the provider's own view.
   * An inconclusive DNS answer (every resolver failed) changes nothing and retries sooner; otherwise the next look follows the smallest TTL seen.
   */
  async verify(
    orgId: string,
    actor: string | null,
    id: string,
    opts: { apply?: boolean } = {},
  ): Promise<EmailDomainDto> {
    let row = await this.row(orgId, id);
    const wasVerified = row.verification_state === 'verified';
    if (opts.apply) {
      const zone = await this.linkage.findZone(orgId, row.domain as string);
      if (!zone)
        throw new ProblemException(
          'unsupported_capability',
          'this domain is not served by a Nuzm DNS zone: add the records at your DNS provider',
        );
      await this.linkage.applyRecords(
        orgId,
        row.domain as string,
        this.declared(row),
        'email-verification',
      );
      await this.audit.record({
        action: 'email.domain.records_applied',
        actorUserId: actor ?? undefined,
        actorType: actor ? 'user' : 'system',
        orgId,
        resource: { type: 'email_domain', id },
        outcome: 'success',
        after: { zoneId: zone.zoneId },
      });
    }
    const required = this.declared(row);
    const check = await checkDomain(row.domain as string, required, this.dns());
    const attempts = Number(row.check_attempts) + 1;
    const now = new Date();
    if (check.inconclusive) {
      row = (await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `UPDATE email.email_domains SET last_checked_at = $2, check_attempts = $3, next_check_at = $4 WHERE id = $1 RETURNING *`,
              [id, now, attempts, new Date(now.getTime() + 60_000)],
            )
          ).rows[0],
      )) as Row;
      return this.dto(row);
    }
    let state: 'pending' | 'partial' | 'verified' | 'failed' = check.state;
    // the provider must agree: DNS that looks right but a domain the provider has not verified yet is only `partial`
    if (state === 'verified') {
      for (const [col, svc] of [
        ['tx_provider_id', 'transactional-email'],
        ['mailbox_provider_id', 'mailbox'],
      ] as const) {
        if (!row[col]) continue;
        const p = await this.providers.byId(orgId, row[col] as string, svc);
        if (!p) {
          state = 'partial';
          continue;
        }
        const ctx = this.registry.ctx({ id: p.row.id, config: p.row.config }, 'email-domain-check');
        const a = p.adapter as unknown as EmailAdapters;
        const r =
          svc === 'transactional-email'
            ? await a.checkDomain(ctx, row.tx_provider_ref as string)
            : await a.checkDomain(ctx, row.domain as string);
        if (r.status !== 'succeeded' || r.data?.state !== 'verified') state = 'partial';
      }
    }
    if (state !== 'verified' && attempts >= MAX_ATTEMPTS && check.state === 'pending')
      state = 'failed';
    const delay = Math.min(
      check.minTtl * 1000,
      Math.min(60_000 * 2 ** Math.min(attempts, 6), 3_600_000),
    );
    try {
      row = (await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `UPDATE email.email_domains SET verification_state = $2, required_records = $3, dmarc = $4, verified_at = $5, last_checked_at = $6, check_attempts = $7, next_check_at = $8
              WHERE id = $1 RETURNING *`,
              [
                id,
                state,
                JSON.stringify(check.records),
                JSON.stringify(check.dmarc),
                state === 'verified' ? (row.verified_at ?? now) : null,
                now,
                attempts,
                state === 'verified' || state === 'failed' ? null : new Date(now.getTime() + delay),
              ],
            )
          ).rows[0],
      )) as Row;
    } catch (e) {
      // two organizations cannot both hold a VERIFIED claim on one domain
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException(
          'conflict',
          'this domain is already verified by another account',
        );
      throw e;
    }
    if (state === 'verified' && !wasVerified) {
      await this.db.withOrg(orgId, (c) =>
        c.query(
          `UPDATE email.sender_identities SET state = 'verified', verified_at = now() WHERE domain_id = $1 AND state = 'pending'`,
          [id],
        ),
      );
      await this.audit.record({
        action: 'email.domain.verified',
        actorUserId: actor ?? undefined,
        actorType: actor ? 'user' : 'system',
        orgId,
        resource: { type: 'email_domain', id },
        outcome: 'success',
        after: { domain: row.domain, purposes: row.purposes },
      });
    }
    return this.dto(row);
  }

  /** Domains still waiting for DNS whose time has come (TTL-aware retries). */
  async verifyDue(now: Date): Promise<number> {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, org_id FROM email.email_domains WHERE verification_state IN ('pending','partial') AND deleted_at IS NULL AND next_check_at <= $1 ORDER BY next_check_at LIMIT 50`,
            [now],
          )
        ).rows as Row[],
    );
    let n = 0;
    for (const r of rows) {
      await this.verify(r.org_id as string, null, r.id as string).catch(() => undefined);
      n++;
    }
    return n;
  }
}
