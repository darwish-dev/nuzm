import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf } from '../../../common/pagination';

/** Cross-organization READS for the admin console (RLS platform scope; callers verified a platform permission). */
export class AdminReadService {
  constructor(private readonly db: Db) {}

  listOrganizations(o: { q?: string; status?: string; limit: number; cursor?: string | null }) {
    if (o.status !== undefined && o.status !== 'active' && o.status !== 'suspended')
      throw new ProblemException('validation_failed', 'status must be active or suspended');
    const cur = decodeCursor(o.cursor);
    return this.db
      .withPlatformScope(
        async (c) =>
          (
            await c.query(
              `SELECT o.id, o.name, o.slug, o.type, o.country, o.status, o.suspended_reason, o.created_at,
                      (SELECT count(*)::int FROM tenancy.memberships m WHERE m.org_id = o.id) AS member_count
                 FROM tenancy.organizations o
                WHERE o.deleted_at IS NULL
                  AND ($1::text IS NULL OR o.name ILIKE '%' || $1 || '%' OR o.slug ILIKE '%' || $1 || '%')
                  AND ($2::text IS NULL OR o.status = $2) AND ($3::uuid IS NULL OR o.id < $3)
                ORDER BY o.id DESC LIMIT $4`,
              [o.q ? o.q.replace(/[%_\\]/g, '\\$&') : null, o.status ?? null, cur, o.limit + 1],
            )
          ).rows,
      )
      .then((rows) =>
        pageOf(
          rows.map((r) => ({
            id: r.id as string,
            name: r.name as string,
            slug: r.slug as string,
            type: r.type as string,
            country: r.country as string,
            status: r.status as string,
            suspendedReason: r.suspended_reason as string | null,
            memberCount: r.member_count as number,
            createdAt: (r.created_at as Date).toISOString(),
          })),
          o.limit,
        ),
      );
  }

  /** Existence check for a target organization; null when unknown or deleted. */
  async organization(id: string) {
    return this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, name, status FROM tenancy.organizations WHERE id = $1 AND deleted_at IS NULL`,
            [id],
          )
        ).rows[0] as { id: string; name: string; status: 'active' | 'suspended' } | undefined,
    );
  }

  /** One account by email (case-insensitive), for the admin "create organization" owner lookup. */
  async userByEmail(email: string) {
    return this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, email, status, is_platform_user FROM identity.users WHERE lower(email) = lower($1) ORDER BY created_at LIMIT 1`,
            [email],
          )
        ).rows[0] as
          { id: string; email: string; status: string; is_platform_user: boolean } | undefined,
    );
  }

  /** Owners of an organization (recipients for security notices). */
  async owners(orgId: string): Promise<string[]> {
    return this.db.withPlatformScope(async (c) =>
      (
        await c.query(
          `SELECT user_id FROM tenancy.memberships WHERE org_id = $1 AND role = 'owner'`,
          [orgId],
        )
      ).rows.map((r) => r.user_id as string),
    );
  }

  listUsers(o: { q?: string; limit: number; cursor?: string | null }) {
    const cur = decodeCursor(o.cursor);
    return this.db
      .withPlatformScope(
        async (c) =>
          (
            await c.query(
              `SELECT u.id, u.email, u.email_verified, u.display_name, u.status, u.is_platform_user, u.created_at, u.last_login_at,
                      EXISTS (SELECT 1 FROM identity.mfa_factors f WHERE f.user_id = u.id AND f.status = 'active') AS mfa_enrolled,
                      (SELECT count(*)::int FROM identity.sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL
                          AND s.idle_expires_at > now() AND s.absolute_expires_at > now()) AS active_sessions,
                      (SELECT count(*)::int FROM tenancy.memberships m WHERE m.user_id = u.id) AS org_count
                 FROM identity.users u
                WHERE ($1::text IS NULL OR u.email ILIKE '%' || $1 || '%' OR u.display_name ILIKE '%' || $1 || '%')
                  AND ($2::uuid IS NULL OR u.id < $2)
                ORDER BY u.id DESC LIMIT $3`,
              [o.q ? o.q.replace(/[%_\\]/g, '\\$&') : null, cur, o.limit + 1],
            )
          ).rows,
      )
      .then((rows) =>
        pageOf(
          rows.map((r) => ({
            id: r.id as string,
            email: r.email as string,
            emailVerified: r.email_verified as boolean,
            displayName: r.display_name as string | null,
            status: r.status as string,
            isPlatformUser: r.is_platform_user as boolean,
            mfaEnrolled: r.mfa_enrolled as boolean,
            activeSessions: r.active_sessions as number,
            orgCount: r.org_count as number,
            createdAt: (r.created_at as Date).toISOString(),
            lastLoginAt: r.last_login_at ? (r.last_login_at as Date).toISOString() : null,
          })),
          o.limit,
        ),
      );
  }

  /** Target for impersonation, with the organizations they belong to. */
  async userWithOrgs(id: string) {
    return this.db.withPlatformScope(async (c) => {
      const u = (
        await c.query(
          `SELECT id, email, status, is_platform_user FROM identity.users WHERE id = $1`,
          [id],
        )
      ).rows[0] as
        { id: string; email: string; status: string; is_platform_user: boolean } | undefined;
      if (!u) return null;
      const orgs = (
        await c.query(
          `SELECT o.id, o.name FROM tenancy.memberships m JOIN tenancy.organizations o ON o.id = m.org_id
            WHERE m.user_id = $1 AND o.deleted_at IS NULL ORDER BY o.id`,
          [id],
        )
      ).rows as { id: string; name: string }[];
      return { ...u, orgs };
    });
  }
}
