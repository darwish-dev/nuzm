import type { Db } from '@nuzm/platform';
import { permissionCovers, type ApiKeyPrincipal } from '../identity';

export interface OrgAccess {
  role: string;
  orgStatus: 'active' | 'suspended';
  permissions: ReadonlySet<string>;
}

/**
 * Resolves what a caller may do in an organization from the database (never from request input).
 * Deny by default: an unknown membership, an unknown role or a missing permission all mean "no".
 */
export class PolicyService {
  private roleCache?: { at: number; map: Map<string, Set<string>> };

  constructor(
    private readonly db: Db,
    private readonly cacheMs = 30_000,
  ) {}

  private async rolePermissions(): Promise<Map<string, Set<string>>> {
    if (this.roleCache && Date.now() - this.roleCache.at < this.cacheMs) return this.roleCache.map;
    const rows = await this.db.withoutScope(
      async (c) =>
        (
          await c.query<{ role: string; permission: string }>(
            'SELECT role, permission FROM tenancy.role_permissions',
          )
        ).rows,
    );
    const map = new Map<string, Set<string>>();
    for (const r of rows)
      (map.get(r.role) ?? map.set(r.role, new Set()).get(r.role)!).add(r.permission);
    this.roleCache = { at: Date.now(), map };
    return map;
  }

  /** Membership of `userId` in `orgId`, or null (also null for soft-deleted orgs). */
  async membership(userId: string, orgId: string): Promise<OrgAccess | null> {
    const row = await this.db.withUser(
      userId,
      async (c) =>
        (
          await c.query<{ role: string; status: 'active' | 'suspended' }>(
            `SELECT m.role, o.status FROM tenancy.memberships m JOIN tenancy.organizations o ON o.id = m.org_id
          WHERE m.org_id = $1 AND m.user_id = $2 AND o.deleted_at IS NULL`,
            [orgId, userId],
          )
        ).rows[0],
    );
    if (!row) return null;
    const perms = (await this.rolePermissions()).get(row.role) ?? new Set<string>();
    return { role: row.role, orgStatus: row.status, permissions: perms };
  }

  /**
   * API key authority at USE time = key scopes ∩ the creator's current permissions. If the creator
   * lost the role or left the org, the key silently loses those powers.
   */
  async apiKeyAccess(key: ApiKeyPrincipal): Promise<OrgAccess | null> {
    const creator = await this.membership(key.createdBy, key.orgId);
    if (!creator) return null;
    const effective = new Set(key.scopes.filter((s) => permissionCovers(creator.permissions, s)));
    return {
      role: `api_key:${creator.role}`,
      orgStatus: creator.orgStatus,
      permissions: effective,
    };
  }

  /** Permissions currently held by a user in an org (used to bound API key scopes at creation). */
  async userPermissions(userId: string, orgId: string): Promise<ReadonlySet<string>> {
    return (await this.membership(userId, orgId))?.permissions ?? new Set();
  }
}
