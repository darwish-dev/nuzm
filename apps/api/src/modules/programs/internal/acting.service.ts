import { SlidingWindowLimiter } from '../../../common/rate-limit';
import type { AccessContext } from '../../../common/access';
import { ActingOrgPort, type ActingInput } from '../../../common/acting';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { Db } from '@nuzm/platform';
import type { OrgService } from '../../tenancy';
import { effectivePermissions, permitted } from './delegation';
import { AGENCY_FLAG, isUuid, type Row } from './model';

/**
 * Per-request validation of `X-Nuzm-Acting-Org` (M11 S54.2). DENY BY DEFAULT and re-validated on EVERY request (nothing is cached: a revoked or expired grant is gone on the very next call, well inside
 * the 60 s ceiling): the agency is an active `agency` organization with an active profile, the client organization is active, the link is ACTIVE, a grant is ACTIVE and UNEXPIRED and covers the needed
 * permission, and the effective permissions are the INTERSECTION of the agency member's role and the grant scopes. Every outcome other than allow is the same 403 (an unknown client, no link, a link
 * to another client's grant: indistinguishable), except an expired grant which says so (`delegation_expired`). Rate limits apply per agency AND per client. The audit event records the agency as the
 * actor organization and the client as the organization acted in. There is no way to act as a client USER: the returned access context carries the caller's own user id and the role `delegate`.
 */
export class ActingOrgService extends ActingOrgPort {
  private readonly limiter = new SlidingWindowLimiter();
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly orgs: Pick<OrgService, 'get'>,
    private readonly flags: { enabled(orgId: string | null, key: string): Promise<boolean> },
    private readonly opts: { perAgencyPerMinute: number; perClientPerMinute: number; now: () => Date } = {
      perAgencyPerMinute: Number(process.env.AGENCY_RATE_PER_MINUTE ?? 600),
      perClientPerMinute: Number(process.env.AGENCY_CLIENT_RATE_PER_MINUTE ?? 300),
      now: () => new Date(),
    },
  ) {
    super();
  }

  private deny(why = 'delegated access is not allowed for this request'): never {
    throw new ProblemException('forbidden', why);
  }

  async authorize(i: ActingInput): Promise<AccessContext> {
    if (!isUuid(i.clientOrgId) || !isUuid(i.agencyOrgId)) this.deny();
    const client = i.clientOrgId.toLowerCase();
    const agencyOrg = i.agencyOrgId.toLowerCase();
    if (client === agencyOrg || i.agencyOrgStatus !== 'active') this.deny();
    if (!(await this.flags.enabled(agencyOrg, AGENCY_FLAG))) this.deny('agency programs are not enabled');
    const now = this.opts.now();

    // rate limits first: cheap, and they bound what a compromised agency account can do to ANY client
    if (!this.limiter.allow(`agency:${agencyOrg}`, this.opts.perAgencyPerMinute, 60_000, now.getTime()) || !this.limiter.allow(`client:${client}`, this.opts.perClientPerMinute, 60_000, now.getTime()))
      throw new ProblemException('rate_limited', 'too many delegated requests');

    const agencyOrgRow = await this.orgs.get(agencyOrg);
    if (!agencyOrgRow || agencyOrgRow.type !== 'agency' || agencyOrgRow.status !== 'active') this.deny();
    const clientOrgRow = await this.orgs.get(client);
    if (!clientOrgRow || clientOrgRow.status !== 'active') this.deny();

    const found = await this.db.withOrg(agencyOrg, async (c) => {
      const profile = (await c.query(`SELECT id, status FROM programs.agencies WHERE org_id = $1`, [agencyOrg])).rows[0] as Row | undefined;
      if (!profile || profile.status !== 'active') return null;
      const link = (await c.query(`SELECT 1 FROM programs.agency_clients WHERE agency_id = $1 AND client_org_id = $2 AND status = 'active'`, [profile.id, client])).rowCount;
      if (!link) return null;
      return (await c.query(`SELECT * FROM programs.delegated_access WHERE agency_id = $1 AND client_org_id = $2 AND status = 'active' ORDER BY expires_at DESC`, [profile.id, client])).rows as Row[];
    });
    if (!found) this.deny();
    const live = found!.filter((g) => (g.expires_at as Date) > now);
    if (live.length === 0) {
      if (found!.length > 0) throw new ProblemException('delegation_expired', 'the delegated access has expired');
      this.deny();
    }
    // the first live grant that covers the permission AND whose scopes meet the member's own role
    const grant = live.find((g) => permitted(effectivePermissions(i.agencyMemberPermissions, g.scopes), i.needed));
    if (!grant) this.deny();
    const effective = effectivePermissions(i.agencyMemberPermissions, grant!.scopes);
    await this.audit.record({
      action: 'delegation.access.used',
      actorUserId: i.userId,
      orgId: client,
      actingOrgId: agencyOrg,
      resource: { type: 'delegated_access', id: grant!.id },
      outcome: 'success',
      detail: { permission: i.needed },
    });
    return { orgId: client, role: 'delegate', permissions: effective, actor: { kind: 'session', userId: i.userId }, acting: { agencyOrgId: agencyOrg, clientOrgId: client, grantId: grant!.id } };
  }
}
