import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { iso, type Row } from './model';

export interface PublisherDto {
  id: string;
  status: 'unverified' | 'verified' | 'suspended';
  verifiedAt: string | null;
}

/** Publisher accounts. Verification is a HUMAN/OPS step (the procedure is PENDING): `verify` is service-level and called by the admin console tooling once that exists (SCR-M11-05). */
export class PublisherService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  private dto(r: Row): PublisherDto {
    return { id: r.id, status: r.status, verifiedAt: iso(r.verified_at) };
  }

  /** The organization's account, creating an UNVERIFIED one the first time (registers interest: ops sees it in the verification queue). */
  async ensure(orgId: string): Promise<Row> {
    return this.db.withOrg(orgId, async (c) => {
      const have = (await c.query(`SELECT * FROM marketplace.publisher_accounts WHERE org_id = $1`, [orgId])).rows[0] as Row | undefined;
      if (have) return have;
      return (await c.query(`INSERT INTO marketplace.publisher_accounts (id, org_id) VALUES ($1,$2) ON CONFLICT (org_id) DO UPDATE SET org_id = EXCLUDED.org_id RETURNING *`, [uuidv7(), orgId])).rows[0] as Row;
    });
  }
  async get(orgId: string): Promise<PublisherDto | null> {
    const r = (await this.db.withOrg(orgId, async (c) => (await c.query(`SELECT * FROM marketplace.publisher_accounts WHERE org_id = $1`, [orgId])).rows[0])) as Row | undefined;
    return r ? this.dto(r) : null;
  }
  /** 403 `publisher_not_verified` unless the account is verified (and registers an unverified account for ops to find). */
  async requireVerified(orgId: string): Promise<Row> {
    const r = await this.ensure(orgId);
    if (r.status !== 'verified') throw new ProblemException('publisher_not_verified', r.status === 'suspended' ? 'the publisher account is suspended' : 'the publisher account has not been verified yet');
    return r;
  }
  async verify(adminUserId: string, orgId: string): Promise<PublisherDto> {
    await this.ensure(orgId);
    const r = (await this.db.withPlatformScope(async (c) => (await c.query(`UPDATE marketplace.publisher_accounts SET status = 'verified', verified_by = $2, verified_at = now() WHERE org_id = $1 RETURNING *`, [orgId, adminUserId])).rows[0])) as Row;
    await this.audit.record({ action: 'marketplace.publisher.verified', actorUserId: adminUserId, orgId, resource: { type: 'publisher_account', id: r.id }, outcome: 'success' });
    return this.dto(r);
  }
  async suspend(adminUserId: string, orgId: string, reason: string): Promise<void> {
    const r = (await this.db.withPlatformScope(async (c) => (await c.query(`UPDATE marketplace.publisher_accounts SET status = 'suspended' WHERE org_id = $1 RETURNING id`, [orgId])).rows[0])) as Row | undefined;
    if (!r) throw new ProblemException('not_found');
    await this.audit.record({ action: 'marketplace.publisher.suspended', actorUserId: adminUserId, orgId, resource: { type: 'publisher_account', id: r.id }, outcome: 'success', detail: { reason } });
  }
}
