import type { Db } from '@nuzm/platform';
import type { DnsRecord } from '@nuzm/domain';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { UUID, badRequest, type Row } from './common';
import type { DnsService } from './dns.service';
import type { HostingSiteReadPort, HostingSiteView } from './ports';

export interface LinkageProposal {
  site: { id: string; state: string };
  domain: { id: string; name: string };
  zone: { id: string; version: number };
  /** The change-set to apply, as the DNS API takes it (names relative to the apex). */
  changes: { create: unknown[]; update: unknown[]; delete: { name: string; type: string }[] };
  records: { name: string; type: string; value: unknown }[];
  ssl: HostingSiteView['ssl'];
  /** Existing records of the customer that the link replaces (shown in the preview before anything is applied). */
  replaces: { name: string; type: string; value: unknown }[];
}

const TTL = 300;
const ACME = '_acme-challenge';

/**
 * `DnsLinkagePort` (M07 S31 task 1; exported by `domains` for M06 hosting, M08 email, M09 publish). It proposes the records that point a domain at a hosting
 * site (from the site's real targets, read through the M06 `HostingSiteReadPort`: nothing is invented), applies them through the SAME atomic change-set
 * path as customers (writer `linkage`, so the records are platform-managed), and is the ONLY way to write `_acme-challenge` TXT (SSL DNS-01) and records
 * that point at Nuzm hosting targets. Applying needs an approver (the human who confirmed the preview).
 */
export class DnsLinkageService {
  constructor(
    private readonly db: Db,
    private readonly dns: DnsService,
    private readonly sites: HostingSiteReadPort,
    private readonly audit: AuditSink,
  ) {}

  private async zoneFor(orgId: string, domainId: string) {
    if (!UUID.test(domainId)) throw new ProblemException('not_found');
    const row = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT d.id AS domain_id, d.name, d.state, z.id AS zone_id, z.version, z.state AS zone_state FROM domains.domains d LEFT JOIN domains.dns_zones z ON z.domain_id = d.id WHERE d.id = $1`,
            [domainId],
          )
        ).rows[0] as Row | undefined,
    );
    if (!row) throw new ProblemException('not_found');
    if (row.state !== 'active' && row.state !== 'renewal_at_risk')
      throw new ProblemException('conflict', `a ${String(row.state)} domain cannot be linked`);
    if (!row.zone_id)
      throw new ProblemException(
        'unsupported_capability',
        'this domain has no DNS zone here: create one, or point its nameservers and records at the site yourself',
      );
    return row;
  }

  async proposeRecordsForSite(
    orgId: string,
    siteId: string,
    domainId: string,
  ): Promise<LinkageProposal> {
    if (!UUID.test(siteId)) throw badRequest('siteId must be a uuid');
    const site = await this.sites.getSite(orgId, siteId);
    if (!site) throw new ProblemException('not_found', 'hosting site not found');
    if (site.state !== 'active')
      throw new ProblemException('conflict', `a ${site.state} site cannot be linked`);
    const z = await this.zoneFor(orgId, domainId);
    const existing = (await this.dns.records(orgId, z.zone_id as string, {})).items;
    const wanted: { name: string; type: string; value: unknown }[] = [];
    const t = site.targets;
    if (t.ipv4.length === 0 && t.ipv6.length === 0 && !t.cname)
      throw new ProblemException(
        'unsupported_capability',
        'the hosting site publishes no address to point at yet',
      );
    for (const ip of t.ipv4) wanted.push({ name: '@', type: 'A', value: ip });
    for (const ip of t.ipv6) wanted.push({ name: '@', type: 'AAAA', value: ip });
    if (t.cname) wanted.push({ name: 'www', type: 'CNAME', value: t.cname });
    else {
      for (const ip of t.ipv4) wanted.push({ name: 'www', type: 'A', value: ip });
      for (const ip of t.ipv6) wanted.push({ name: 'www', type: 'AAAA', value: ip });
    }
    const key = (r: { name: string; type: string; value: unknown }) =>
      `${r.name}|${r.type}|${JSON.stringify(r.value)}`;
    const have = new Set(existing.map(key));
    const touchedNames = new Set(wanted.map((w) => w.name));
    // the link owns the address records at the names it points: any other A/AAAA/CNAME there is replaced (a CNAME cannot share a name)
    const replaces = existing.filter(
      (e) =>
        touchedNames.has(e.name) &&
        ['A', 'AAAA', 'CNAME'].includes(e.type) &&
        !wanted.some((w) => key(w) === key(e)),
    );
    const replaceKeys = new Set(replaces.map((r) => `${r.name}|${r.type}`));
    const create = wanted
      .filter((w) => !have.has(key(w)))
      .map((w) => ({ name: w.name, type: w.type, ttl: TTL, value: w.value }));
    return {
      site: { id: site.id, state: site.state },
      domain: { id: domainId, name: z.name as string },
      zone: { id: z.zone_id as string, version: z.version as number },
      changes: {
        create,
        update: [],
        delete: [...replaceKeys].map((k) => ({ name: k.split('|')[0]!, type: k.split('|')[1]! })),
      },
      records: wanted,
      ssl: site.ssl,
      replaces: replaces.map((r) => ({ name: r.name, type: r.type, value: r.value })),
    };
  }

  async applyLinkage(
    orgId: string,
    siteId: string,
    domainId: string,
    approvedBy: string,
    traceId = 'linkage',
  ) {
    if (!approvedBy || !UUID.test(approvedBy))
      throw new ProblemException(
        'validation_failed',
        'a linkage must name the person who approved it',
      );
    const p = await this.proposeRecordsForSite(orgId, siteId, domainId);
    if (p.changes.create.length === 0 && p.changes.delete.length === 0)
      return { outcome: 'unchanged' as const, proposal: p, version: p.zone.version };
    const r = await this.dns.applyChangeSet(
      orgId,
      approvedBy,
      p.zone.id,
      p.zone.version,
      p.changes as Record<string, unknown>,
      { writer: 'linkage', traceId },
    );
    await this.audit.record({
      action: 'domain.hosting.linked',
      orgId,
      actorUserId: approvedBy,
      resource: { type: 'domain', id: domainId },
      outcome: 'success',
      detail: { siteId, created: p.changes.create.length, replaced: p.changes.delete.length },
    });
    return { outcome: 'applied' as const, proposal: p, version: r.version };
  }

  /** The platform-managed records of a domain's zone (the current linkage), for the hosting screen. */
  async current(orgId: string, domainId: string) {
    const z = await this.zoneFor(orgId, domainId);
    const all = (await this.dns.records(orgId, z.zone_id as string, {})).items;
    return {
      zone: { id: z.zone_id as string, version: z.version as number },
      records: all.filter((r) => r.managedBy !== 'user'),
    };
  }

  // ---- ACME (SSL DNS-01) --------------------------------------------------------------------------------------------------------
  private async zoneByName(orgId: string, domainName: string) {
    const row = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT z.id, z.version FROM domains.dns_zones z JOIN domains.domains d ON d.id = z.domain_id WHERE d.name = $1 AND z.state = 'active'`,
            [domainName.toLowerCase()],
          )
        ).rows[0] as Row | undefined,
    );
    if (!row) throw new ProblemException('not_found', 'no DNS zone for this domain');
    return row;
  }
  /** Writes ONLY `_acme-challenge` TXT (validation token); anything else is refused. */
  async writeAcmeChallenge(
    orgId: string,
    domainName: string,
    token: string,
    subdomain = '',
  ): Promise<{ version: number }> {
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(token)) throw badRequest('the ACME token is not valid');
    const z = await this.zoneByName(orgId, domainName);
    const name = subdomain ? `${ACME}.${subdomain}` : ACME;
    const r = await this.dns.applyChangeSet(
      orgId,
      null,
      z.id as string,
      z.version as number,
      { create: [{ name, type: 'TXT', ttl: 120, value: token }] },
      { writer: 'linkage' },
    );
    return { version: r.version };
  }
  /** Removes the challenge record after validation (clean-up). Idempotent: a missing record is not an error. */
  async clearAcmeChallenge(
    orgId: string,
    domainName: string,
    token: string,
    subdomain = '',
  ): Promise<void> {
    const z = await this.zoneByName(orgId, domainName);
    const name = subdomain ? `${ACME}.${subdomain}` : ACME;
    const recs = (
      await this.dns.records(orgId, z.id as string, { name, type: 'TXT' })
    ).items.filter((r) => r.value === token);
    if (recs.length === 0) return;
    await this.dns.applyChangeSet(
      orgId,
      null,
      z.id as string,
      (await this.dns.records(orgId, z.id as string, {})).version,
      { delete: [{ name, type: 'TXT' }] },
      { writer: 'linkage' },
    );
  }
}
export type { DnsRecord };
