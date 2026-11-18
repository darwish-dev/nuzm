import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Db, OperationsService } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { DomainOwnershipVerifier } from './ports';
import { KIND, type Caller, type SitesService } from './sites.service';

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);
type Row = Record<string, unknown>;

export interface BindingDto {
  id: string;
  domain: string;
  state: 'pending' | 'verified' | 'active' | 'removed';
  primary: boolean;
  verifiedAt: string | null;
  verification: { method: string; record: unknown } | null;
  createdAt: string;
}

/**
 * Domain bindings (M06 §4 task 8). Ownership is verified through the `DomainOwnershipVerifier` port (mock now, M07 later); an UNVERIFIED binding never reaches
 * the node (no vhost). A domain is unique among verified/active bindings across all organizations (database index): the cross-organization hijack is impossible,
 * and a pending binding reserves nothing, so a domain cannot be squatted by someone who cannot prove it.
 */
export class DomainsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ops: OperationsService,
    private readonly sites: SitesService,
    private readonly verifier: DomainOwnershipVerifier,
    private readonly kick: (orgId: string, operationId: string) => void = () => undefined,
  ) {}

  private dto(r: Row, orgId: string): BindingDto {
    const verifiable = r.state === 'pending';
    return {
      id: r.id as string,
      domain: r.domain as string,
      state: r.state as BindingDto['state'],
      primary: r.is_primary as boolean,
      verifiedAt: iso(r.verified_at),
      verification: verifiable
        ? {
            method: r.verification_method as string,
            record: this.verifier.challenge(
              orgId,
              r.site_id as string,
              r.domain as string,
              r.verification_token as string,
            ).record,
          }
        : null,
      createdAt: iso(r.created_at)!,
    };
  }

  async list(orgId: string, siteId: string): Promise<{ items: BindingDto[] }> {
    await this.sites.row(orgId, siteId);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM hosting.site_domain_bindings WHERE site_id = $1 AND org_id = $2 AND state <> 'removed' ORDER BY created_at`,
            [siteId, orgId],
          )
        ).rows,
    );
    return { items: rows.map((r) => this.dto(r, orgId)) };
  }

  /**
   * First call for a domain creates a pending binding and returns the challenge (201). A later call re-checks: verified → the vhost operation starts (202),
   * still unverified → 422 ownership_unverified carrying the challenge again.
   */
  async add(
    orgId: string,
    actor: Caller,
    siteId: string,
    body: Record<string, unknown>,
  ): Promise<{ binding: BindingDto; operationId: string | null; created: boolean }> {
    const allowed = new Set(['domain', 'primary']);
    for (const k of Object.keys(body))
      if (!allowed.has(k)) throw new ProblemException('validation_failed', `unknown member ${k}`);
    const domain = typeof body.domain === 'string' ? body.domain.toLowerCase().trim() : '';
    if (!DOMAIN.test(domain))
      throw new ProblemException('validation_failed', 'domain must be a valid domain name', [
        { field: 'domain', message: 'invalid' },
      ]);
    if (body.primary !== undefined && typeof body.primary !== 'boolean')
      throw new ProblemException('validation_failed', 'primary must be a boolean');
    const site = await this.sites.row(orgId, siteId);
    if (site.status !== 'active')
      throw new ProblemException('site_not_active', 'domains can be bound to an active site');
    // global uniqueness among verified/active bindings (other organizations are invisible to RLS: check under the platform scope)
    const taken = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT site_id FROM hosting.site_domain_bindings WHERE domain = $1 AND state IN ('verified','active') AND site_id <> $2 LIMIT 1`,
            [domain, siteId],
          )
        ).rows[0],
    );
    if (taken) throw new ProblemException('domain_in_use', 'this domain is already in use');
    let row = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM hosting.site_domain_bindings WHERE site_id = $1 AND domain = $2 AND state <> 'removed'`,
            [siteId, domain],
          )
        ).rows[0],
    );
    let created = false;
    if (!row) {
      const id = uuidv7();
      row = await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `INSERT INTO hosting.site_domain_bindings (id, site_id, org_id, domain, is_primary, verification_token) VALUES ($1,$2,$3,$4,false,$5) RETURNING *`,
              [id, siteId, orgId, domain, randomBytes(16).toString('hex')],
            )
          ).rows[0]!,
      );
      created = true;
      await this.audit.record({
        action: 'hosting.site.domain.requested',
        actorUserId: actor.userId,
        actorType: 'user',
        orgId,
        resource: { type: 'hosting_site', id: siteId },
        outcome: 'success',
      });
    }
    if (row.state !== 'pending')
      return {
        binding: this.dto(row, orgId),
        operationId: (row.operation_id as string | null) ?? null,
        created: false,
      };
    const ok = await this.verifier.verify(orgId, siteId, domain, row.verification_token as string);
    await this.db.withOrg(orgId, (c) =>
      c.query(`UPDATE hosting.site_domain_bindings SET last_checked_at = now() WHERE id = $1`, [
        row!.id,
      ]),
    );
    if (!ok) {
      if (created) return { binding: this.dto(row, orgId), operationId: null, created: true };
      const challenge = this.dto(row, orgId).verification;
      throw new ProblemException(
        'ownership_unverified',
        'the domain ownership challenge was not found; publish the record and try again',
        undefined,
        { verification: challenge },
      );
    }
    // verified: the unique index decides a race between two organizations proving the same domain
    try {
      const wantPrimary = body.primary === true || !site.domain_primary;
      await this.db.withPlatformScope(async (c) => {
        if (wantPrimary)
          await c.query(
            `UPDATE hosting.site_domain_bindings SET is_primary = false WHERE site_id = $1 AND is_primary`,
            [siteId],
          );
        await c.query(
          `UPDATE hosting.site_domain_bindings SET state = 'verified', verified_at = now(), is_primary = $2, updated_at = now() WHERE id = $1`,
          [row!.id, wantPrimary],
        );
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException('domain_in_use', 'this domain is already in use');
      throw e;
    }
    const op = await this.ops.create(orgId, {
      kind: KIND.domain,
      input: { siteId, bindingId: row.id as string },
      resourceKind: 'hosting_site',
      resourceId: siteId,
      createdBy: actor.userId,
      maxAttempts: 5,
    });
    await this.db.withOrg(orgId, (c) =>
      c.query(`UPDATE hosting.site_domain_bindings SET operation_id = $2 WHERE id = $1`, [
        row!.id,
        op.id,
      ]),
    );
    await this.audit.record({
      action: 'hosting.site.domain.verified',
      actorUserId: actor.userId,
      actorType: 'user',
      orgId,
      resource: { type: 'hosting_site', id: siteId },
      outcome: 'success',
    });
    this.kick(orgId, op.id);
    const fresh = await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM hosting.site_domain_bindings WHERE id = $1`, [row!.id]))
          .rows[0]!,
    );
    return { binding: this.dto(fresh, orgId), operationId: op.id, created };
  }
}
