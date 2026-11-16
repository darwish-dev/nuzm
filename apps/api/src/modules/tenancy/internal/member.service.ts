import { AuditSink } from '../../../common/audit';
import { enqueue, type Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, parseLimit, type Page } from './pagination';

export interface Member {
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  role: string;
  joinedAt: string;
  version: number;
}

export const ORG_ROLES = ['owner', 'admin', 'billing_admin', 'developer', 'viewer'] as const;

export class MemberService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  async list(orgId: string, q: { limit?: unknown; cursor?: unknown }): Promise<Page<Member>> {
    const limit = parseLimit(q.limit);
    const cursor = decodeCursor(q.cursor);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT m.id, m.user_id, u.email, u.display_name, m.role, m.created_at, m.version
           FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id
          WHERE ($2::uuid IS NULL OR m.id < $2) ORDER BY m.id DESC LIMIT $1`,
            [limit + 1, cursor],
          )
        ).rows,
    );
    return pageOf(
      rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        email: r.email,
        displayName: r.display_name,
        role: r.role,
        joinedAt: r.created_at.toISOString(),
        version: r.version,
      })),
      limit,
    );
  }

  /**
   * Change a member's role. Rules: only an owner may grant or remove `owner`; the last owner can never
   * be demoted (409); optimistic concurrency via the membership version (If-Match).
   */
  async changeRole(
    orgId: string,
    actor: { userId: string; role: string },
    targetUserId: string,
    newRole: string,
    expectedVersion: number,
  ): Promise<Member> {
    if (!(ORG_ROLES as readonly string[]).includes(newRole))
      throw new ProblemException('validation_failed', 'unknown role');
    return this.db.withOrg(orgId, async (c) => {
      const owners = await c.query<{ user_id: string }>(
        `SELECT user_id FROM tenancy.memberships WHERE role='owner' FOR UPDATE`,
      );
      const { rows } = await c.query(
        `SELECT id, role, version FROM tenancy.memberships WHERE user_id = $1 FOR UPDATE`,
        [targetUserId],
      );
      const t = rows[0];
      if (!t) throw new ProblemException('not_found');
      if (t.version !== expectedVersion) throw new ProblemException('precondition_failed');
      if ((newRole === 'owner' || t.role === 'owner') && actor.role !== 'owner')
        throw new ProblemException('forbidden', 'only an owner can grant or change the owner role');
      if (t.role === 'owner' && newRole !== 'owner' && owners.rowCount === 1)
        throw new ProblemException('conflict', 'cannot demote the last owner');
      await c.query(
        `UPDATE tenancy.memberships SET role=$2, updated_at=now(), version=version+1 WHERE id=$1`,
        [t.id, newRole],
      );
      await enqueue(c, orgId, 'member.role_changed', {
        userId: targetUserId,
        from: t.role,
        to: newRole,
      });
      await this.audit.record({
        action: 'tenancy.member.role_changed',
        orgId,
        resource: { type: 'member', id: targetUserId },
        outcome: 'success',
        before: { role: t.role },
        after: { role: newRole },
      });
      const m = (
        await c.query(
          `SELECT m.id, m.user_id, u.email, u.display_name, m.role, m.created_at, m.version FROM tenancy.memberships m JOIN identity.users u ON u.id=m.user_id WHERE m.id=$1`,
          [t.id],
        )
      ).rows[0];
      return {
        id: m.id,
        userId: m.user_id,
        email: m.email,
        displayName: m.display_name,
        role: m.role,
        joinedAt: m.created_at.toISOString(),
        version: m.version,
      };
    });
  }

  /** Remove a member (or leave). Owners can only be removed by owners; the last owner cannot go. */
  async remove(
    orgId: string,
    actor: { userId: string; role: string },
    targetUserId: string,
  ): Promise<void> {
    await this.db.withOrg(orgId, async (c) => {
      const owners = await c.query(
        `SELECT user_id FROM tenancy.memberships WHERE role='owner' FOR UPDATE`,
      );
      const t = (
        await c.query(`SELECT id, role FROM tenancy.memberships WHERE user_id=$1 FOR UPDATE`, [
          targetUserId,
        ])
      ).rows[0];
      if (!t) throw new ProblemException('not_found');
      if (t.role === 'owner' && actor.role !== 'owner')
        throw new ProblemException('forbidden', 'only an owner can remove an owner');
      if (t.role === 'owner' && owners.rowCount === 1)
        throw new ProblemException('conflict', 'cannot remove the last owner');
      await c.query('DELETE FROM tenancy.memberships WHERE id=$1', [t.id]);
      await enqueue(c, orgId, 'member.removed', { userId: targetUserId, by: actor.userId });
      await this.audit.record({
        action: 'tenancy.member.removed',
        orgId,
        resource: { type: 'member', id: targetUserId },
        outcome: 'success',
        before: { role: t.role },
      });
    });
  }
}
