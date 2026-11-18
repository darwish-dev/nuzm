import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { OrgService } from '../../tenancy';
import { AGENCY_FLAG, badRequest, isUuid, iso, pgCode, type Row } from './model';
import { validateGrant } from './delegation';

export interface AgencyDto {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  role: 'agency' | 'client';
  consolidatedBilling: boolean;
  etag: number;
  createdAt: string;
}
export interface LinkDto {
  id: string;
  agencyId: string;
  clientOrgId: string;
  status: 'pending' | 'active' | 'revoked' | 'declined';
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}
export interface GrantDto {
  id: string;
  agencyId: string;
  clientOrgId: string;
  scopes: string[];
  expiresAt: string;
  status: 'pending' | 'active' | 'revoked' | 'expired' | 'declined';
  grantedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}
type Perms = ReadonlySet<string>;

/**
 * Agency program (M11 S54): the agency profile, client LINKS and delegated-access GRANTS. The agency proposes; ONLY the client organization accepts (link and grant), and it can revoke
 * at any moment. Both POST endpoints in docs/04 serve both sides: the caller's organization decides which (the agency's own organization proposes, a linked client answers).
 *
 * REVOCATION: the HTTP routes for revoking a grant or a link are SCR-M11-01 (not in docs/04, owner approval pending) and are NOT exposed. `revokeGrant` / `revokeLink` below are the
 * service-level operations those routes will call; until approval a client's levers are the mandatory expiry (at most 365 days) and the admin console suspending the agency organization.
 */
export class AgencyService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly orgs: Pick<OrgService, 'get'>,
    private readonly flags: { enabled(orgId: string | null, key: string): Promise<boolean> },
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async enabled(orgId: string) {
    if (!(await this.flags.enabled(orgId, AGENCY_FLAG)))
      throw new ProblemException(
        'feature_disabled',
        'agency programs are not enabled for this organization',
      );
  }
  private adto(r: Row, role: AgencyDto['role']): AgencyDto {
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      role,
      consolidatedBilling: r.consolidated_billing,
      etag: r.version_lock,
      createdAt: iso(r.created_at)!,
    };
  }
  private ldto(r: Row): LinkDto {
    return {
      id: r.id,
      agencyId: r.agency_id,
      clientOrgId: r.client_org_id,
      status: r.status,
      acceptedAt: iso(r.accepted_at),
      revokedAt: iso(r.revoked_at),
      createdAt: iso(r.created_at)!,
    };
  }
  private gdto(r: Row): GrantDto {
    const expired = r.status === 'active' && (r.expires_at as Date) <= this.now();
    return {
      id: r.id,
      agencyId: r.agency_id,
      clientOrgId: r.client_org_id,
      scopes: r.scopes,
      expiresAt: iso(r.expires_at)!,
      status: expired ? 'expired' : r.status,
      grantedAt: iso(r.granted_at),
      revokedAt: iso(r.revoked_at),
      createdAt: iso(r.created_at)!,
    };
  }

  /** POST /v1/agencies: the profile of the CURRENT organization, which must be of type `agency`. */
  async create(orgId: string, actor: string, body: Record<string, unknown>): Promise<AgencyDto> {
    await this.enabled(orgId);
    for (const k of Object.keys(body))
      if (!['name'].includes(k)) throw badRequest(`unknown field ${k}`);
    const org = await this.orgs.get(orgId);
    if (!org || org.type !== 'agency')
      throw new ProblemException(
        'forbidden',
        'only an organization of type agency can create an agency profile',
      );
    const name = typeof body.name === 'string' ? body.name.trim() : org.name;
    if (name.length < 1 || name.length > 200) throw badRequest('name must be 1..200 characters');
    try {
      const r = (await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `INSERT INTO programs.agencies (id, org_id, name, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
              [uuidv7(), orgId, name, actor],
            )
          ).rows[0],
      )) as Row;
      await this.audit.record({
        action: 'agency.agency.created',
        actorUserId: actor,
        orgId,
        resource: { type: 'agency', id: r.id },
        outcome: 'success',
      });
      return this.adto(r, 'agency');
    } catch (e) {
      if (pgCode(e) === '23505')
        throw new ProblemException('conflict', 'this organization already has an agency profile');
      throw e;
    }
  }

  /** GET /v1/agencies: the agency profile of the organization, plus every agency that holds a link to it (the client's view). */
  async list(orgId: string): Promise<{ items: AgencyDto[]; nextCursor: null }> {
    await this.enabled(orgId);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM programs.agencies ORDER BY created_at DESC LIMIT 100`))
          .rows as Row[],
    );
    return {
      items: rows.map((r) => this.adto(r, r.org_id === orgId ? 'agency' : 'client')),
      nextCursor: null,
    };
  }

  /** Which side is the caller on for this agency? `agency` = its own organization; `client` = a linked client; otherwise 404 (no existence oracle). */
  private async side(
    orgId: string,
    agencyId: string,
  ): Promise<{ side: 'agency' | 'client'; agency: Row }> {
    if (!isUuid(agencyId)) throw new ProblemException('not_found');
    const a = (await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM programs.agencies WHERE id = $1`, [agencyId])).rows[0],
    )) as Row | undefined;
    if (!a) throw new ProblemException('not_found');
    return { side: a.org_id === orgId ? 'agency' : 'client', agency: a };
  }
  private need(perms: Perms, p: string) {
    if (!perms.has(p) && !perms.has('*')) throw new ProblemException('forbidden', `requires ${p}`);
  }

  // ---- clients (links) ----------------------------------------------------------------------------------------------------
  /** POST /v1/agencies/{id}/clients: the agency invites `{clientOrgId}` (→ pending); a linked client answers `{linkId, decision: accept|decline}`. */
  async postClient(
    orgId: string,
    actor: string,
    perms: Perms,
    agencyId: string,
    body: Record<string, unknown>,
  ): Promise<LinkDto> {
    const { side, agency } = await this.side(orgId, agencyId.toLowerCase()); // existence first: a foreign id is 404 whatever the flag says
    await this.enabled(orgId);
    if (side === 'agency') {
      this.need(perms, 'agency:manage');
      for (const k of Object.keys(body))
        if (k !== 'clientOrgId') throw badRequest(`unknown field ${k}`);
      if (!isUuid(body.clientOrgId)) throw badRequest('clientOrgId is required');
      const client = (body.clientOrgId as string).toLowerCase();
      if (client === orgId) throw badRequest('an agency cannot be its own client');
      if (agency.status !== 'active')
        throw new ProblemException('invalid_state', 'the agency is suspended');
      try {
        const r = (await this.db.withOrg(
          orgId,
          async (c) =>
            (
              await c.query(
                `INSERT INTO programs.agency_clients (id, org_id, agency_id, client_org_id, invited_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
                [uuidv7(), orgId, agency.id, client, actor],
              )
            ).rows[0],
        )) as Row;
        await this.audit.record({
          action: 'agency.client.invited',
          actorUserId: actor,
          orgId,
          resource: { type: 'agency_client', id: r.id },
          outcome: 'success',
          detail: { clientOrgId: client },
        });
        return this.ldto(r);
      } catch (e) {
        if (pgCode(e) === '23505')
          throw new ProblemException(
            'conflict',
            'a pending or active link with this organization already exists',
          );
        throw e;
      }
    }
    this.need(perms, 'partners:manage');
    for (const k of Object.keys(body))
      if (!['linkId', 'decision'].includes(k)) throw badRequest(`unknown field ${k}`);
    if (!isUuid(body.linkId) || !['accept', 'decline'].includes(body.decision as string))
      throw badRequest('linkId and decision (accept|decline) are required');
    const accept = body.decision === 'accept';
    const linkId = (body.linkId as string).toLowerCase();
    const r = (await this.db.withOrg(
      orgId,
      async (c) =>
        (accept
          ? await c.query(
              `UPDATE programs.agency_clients SET status = 'active', accepted_by = $3, accepted_at = now() WHERE id = $1 AND agency_id = $2 AND client_org_id = $4 AND status = 'pending' RETURNING *`,
              [linkId, agency.id, actor, orgId],
            )
          : await c.query(
              `UPDATE programs.agency_clients SET status = 'declined' WHERE id = $1 AND agency_id = $2 AND client_org_id = $3 AND status = 'pending' RETURNING *`,
              [linkId, agency.id, orgId],
            )
        ).rows[0],
    )) as Row | undefined;
    if (!r) throw new ProblemException('conflict', 'no pending link with this id');
    await this.audit.record({
      action: accept ? 'agency.client.linked' : 'agency.client.declined',
      actorUserId: actor,
      orgId,
      actingOrgId: agency.org_id,
      resource: { type: 'agency_client', id: r.id },
      outcome: 'success',
    });
    return this.ldto(r);
  }
  /** GET /v1/agencies/{id}/clients: the agency sees all its links; a client sees its own. */
  async listClients(
    orgId: string,
    agencyId: string,
  ): Promise<{ items: LinkDto[]; nextCursor: null }> {
    const { agency } = await this.side(orgId, agencyId.toLowerCase());
    await this.enabled(orgId);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM programs.agency_clients WHERE agency_id = $1 ORDER BY created_at DESC LIMIT 200`,
            [agency.id],
          )
        ).rows as Row[],
    );
    return { items: rows.map((r) => this.ldto(r)), nextCursor: null };
  }

  // ---- delegated access ---------------------------------------------------------------------------------------------------
  /**
   * POST /v1/agencies/{id}/delegated-access: the agency proposes `{clientOrgId, scopes[], expiresAt}` (needs an ACTIVE link; scopes inside the delegable catalogue; `expiresAt` mandatory and
   * at most 365 days away: a missing expiry is 422); the client administrator answers `{grantId, decision: accept|decline}` (a grant never exceeds the scopes the accepting administrator holds).
   */
  async postGrant(
    orgId: string,
    actor: string,
    perms: Perms,
    agencyId: string,
    body: Record<string, unknown>,
  ): Promise<GrantDto> {
    const { side, agency } = await this.side(orgId, agencyId.toLowerCase()); // existence first: a foreign id is 404 whatever the flag says
    await this.enabled(orgId);
    const now = this.now();
    if (side === 'agency') {
      this.need(perms, 'agency:manage');
      for (const k of Object.keys(body))
        if (!['clientOrgId', 'scopes', 'expiresAt'].includes(k))
          throw badRequest(`unknown field ${k}`);
      if (!isUuid(body.clientOrgId)) throw badRequest('clientOrgId is required');
      const client = (body.clientOrgId as string).toLowerCase();
      const v = validateGrant({ scopes: body.scopes, expiresAt: body.expiresAt }, now);
      if (!v.ok)
        throw new ProblemException('validation_failed', v.detail, [
          {
            code: v.code,
            path: v.code.startsWith('expiry') ? 'expiresAt' : 'scopes',
            message: v.detail,
          },
        ]);
      const link = (await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `SELECT 1 FROM programs.agency_clients WHERE agency_id = $1 AND client_org_id = $2 AND status = 'active'`,
              [agency.id, client],
            )
          ).rowCount,
      )) as number;
      if (!link)
        throw new ProblemException(
          'forbidden',
          'there is no active link with this client organization',
        );
      const r = (await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `INSERT INTO programs.delegated_access (id, org_id, agency_id, client_org_id, scopes, expires_at, proposed_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
              [uuidv7(), orgId, agency.id, client, v.scopes, v.expiresAt, actor],
            )
          ).rows[0],
      )) as Row;
      await this.audit.record({
        action: 'delegation.access.proposed',
        actorUserId: actor,
        orgId,
        resource: { type: 'delegated_access', id: r.id },
        outcome: 'success',
        detail: { clientOrgId: client, scopes: v.scopes, expiresAt: v.expiresAt.toISOString() },
      });
      return this.gdto(r);
    }
    this.need(perms, 'partners:manage');
    for (const k of Object.keys(body))
      if (!['grantId', 'decision'].includes(k)) throw badRequest(`unknown field ${k}`);
    if (!isUuid(body.grantId) || !['accept', 'decline'].includes(body.decision as string))
      throw badRequest('grantId and decision (accept|decline) are required');
    const g = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM programs.delegated_access WHERE id = $1 AND agency_id = $2 AND client_org_id = $3`,
            [(body.grantId as string).toLowerCase(), agency.id, orgId],
          )
        ).rows[0],
    )) as Row | undefined;
    if (!g) throw new ProblemException('not_found');
    if (g.status !== 'pending')
      throw new ProblemException('conflict', `the grant is already ${g.status}`);
    if ((g.expires_at as Date) <= now)
      throw new ProblemException('delegation_expired', 'the proposal has expired');
    if (body.decision === 'accept') {
      // never more than the accepting administrator holds themselves
      const v = validateGrant(
        { scopes: g.scopes, expiresAt: g.expires_at.toISOString() },
        new Date(now.getTime() - 3_600_000),
        perms,
      );
      if (!v.ok && v.code !== 'expiry_invalid')
        throw new ProblemException('validation_failed', v.detail, [
          { code: v.code, path: 'scopes', message: v.detail },
        ]);
    }
    const accept = body.decision === 'accept';
    const r = (await this.db.withOrg(
      orgId,
      async (c) =>
        (accept
          ? await c.query(
              `UPDATE programs.delegated_access SET status = 'active', granted_by = $2, granted_at = now() WHERE id = $1 AND status = 'pending' RETURNING *`,
              [g.id, actor],
            )
          : await c.query(
              `UPDATE programs.delegated_access SET status = 'declined' WHERE id = $1 AND status = 'pending' RETURNING *`,
              [g.id],
            )
        ).rows[0],
    )) as Row | undefined;
    if (!r) throw new ProblemException('conflict', 'the grant changed');
    await this.audit.record({
      action: accept ? 'delegation.access.granted' : 'delegation.access.declined',
      actorUserId: actor,
      orgId,
      actingOrgId: agency.org_id,
      resource: { type: 'delegated_access', id: r.id },
      outcome: 'success',
      detail: { scopes: r.scopes, expiresAt: iso(r.expires_at) },
    });
    return this.gdto(r);
  }
  async listGrants(
    orgId: string,
    agencyId: string,
  ): Promise<{ items: GrantDto[]; nextCursor: null }> {
    const { agency } = await this.side(orgId, agencyId.toLowerCase());
    await this.enabled(orgId);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM programs.delegated_access WHERE agency_id = $1 ORDER BY created_at DESC LIMIT 200`,
            [agency.id],
          )
        ).rows as Row[],
    );
    return { items: rows.map((r) => this.gdto(r)), nextCursor: null };
  }

  // ---- revocation (service-level; the HTTP routes are SCR-M11-01) -----------------------------------------------------------
  /** Revoke a grant from either side's organization context. Effective IMMEDIATELY: the access check reads this row on every request (no cache). */
  async revokeGrant(orgId: string, actor: string, grantId: string): Promise<GrantDto> {
    if (!isUuid(grantId)) throw new ProblemException('not_found');
    const r = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE programs.delegated_access SET status = 'revoked', revoked_at = now(), revoked_by = $2 WHERE id = $1 AND status IN ('pending','active') RETURNING *`,
            [grantId, actor],
          )
        ).rows[0],
    )) as Row | undefined;
    if (!r) throw new ProblemException('not_found');
    await this.audit.record({
      action: 'delegation.access.revoked',
      actorUserId: actor,
      orgId,
      actingOrgId: r.org_id === orgId ? undefined : r.org_id,
      resource: { type: 'delegated_access', id: r.id },
      outcome: 'success',
    });
    return this.gdto(r);
  }
  /** Revoke a client link (and, with it, every grant of that agency for that client). */
  async revokeLink(orgId: string, actor: string, linkId: string): Promise<LinkDto> {
    if (!isUuid(linkId)) throw new ProblemException('not_found');
    const r = (await this.db.withOrg(orgId, async (c) => {
      const l = (
        await c.query(
          `UPDATE programs.agency_clients SET status = 'revoked', revoked_at = now(), revoked_by = $2 WHERE id = $1 AND status IN ('pending','active') RETURNING *`,
          [linkId, actor],
        )
      ).rows[0] as Row | undefined;
      if (!l) return undefined;
      await c.query(
        `UPDATE programs.delegated_access SET status = 'revoked', revoked_at = now(), revoked_by = $3 WHERE agency_id = $1 AND client_org_id = $2 AND status IN ('pending','active')`,
        [l.agency_id, l.client_org_id, actor],
      );
      return l;
    })) as Row | undefined;
    if (!r) throw new ProblemException('not_found');
    await this.audit.record({
      action: 'delegation.access.revoked',
      actorUserId: actor,
      orgId,
      resource: { type: 'agency_client', id: r.id },
      outcome: 'success',
      detail: { link: true },
    });
    return this.ldto(r);
  }
  /** Mark grants that passed their expiry as `expired` (display only: the access check never trusts the status column for expiry). */
  async expireDue(): Promise<number> {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, org_id, client_org_id FROM programs.delegated_access WHERE status IN ('pending','active') AND expires_at <= now() LIMIT 500`,
          )
        ).rows as Row[],
    );
    for (const g of rows)
      await this.db
        .withOrg(g.client_org_id, (c) =>
          c.query(
            `UPDATE programs.delegated_access SET status = 'expired' WHERE id = $1 AND status IN ('pending','active')`,
            [g.id],
          ),
        )
        .catch(() => undefined);
    return rows.length;
  }
}
