import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Db } from '@nuzm/platform';
import { AnyAuthenticated } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { DB } from '../../common/tokens';
import { CurrentPrincipal, RealmOnly, UserService, type Principal } from '../identity';
import { PolicyService } from './policy.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@AnyAuthenticated()
@RealmOnly('any')
@Controller('v1')
export class MeController {
  constructor(
    private readonly users: UserService,
    private readonly policy: PolicyService,
    @Inject(DB) private readonly db: Db,
  ) {}

  /**
   * The signed-in principal, their memberships, and (when `X-Nuzm-Org` names an org they belong to) the
   * effective permissions and feature flags in that org. A non-member org header yields empty values,
   * never an error that would confirm the organization exists.
   */
  @Get('me')
  async me(@CurrentPrincipal() p: Principal, @Req() req: FastifyRequest) {
    const u = await this.users.get(p.userId);
    if (!u) throw new ProblemException('unauthenticated');
    const memberships = await this.db.withUser(
      p.userId,
      async (c) =>
        (
          await c.query(
            `SELECT o.id AS org_id, o.name, o.slug, o.type, o.status, m.role FROM tenancy.memberships m
           JOIN tenancy.organizations o ON o.id = m.org_id WHERE m.user_id = $1 AND o.deleted_at IS NULL ORDER BY o.id DESC`,
            [p.userId],
          )
        ).rows,
    );
    const header = req.headers['x-nuzm-org'];
    let permissions: string[] = [];
    let flags: Record<string, unknown> = {};
    if (typeof header === 'string' && UUID.test(header)) {
      const m = await this.policy.membership(p.userId, header.toLowerCase());
      if (m) {
        permissions = [...m.permissions].sort();
        flags = await this.flags(header.toLowerCase());
      }
    } else {
      flags = await this.db.withoutScope(async (c) =>
        Object.fromEntries(
          (
            await c.query(`SELECT key, value FROM platform.feature_flags WHERE org_id IS NULL`)
          ).rows.map((r) => [r.key, r.value]),
        ),
      );
    }
    return {
      id: u.id,
      email: u.email,
      emailVerified: u.email_verified,
      displayName: u.display_name,
      locale: u.locale,
      isPlatformUser: u.is_platform_user,
      mfaLevel: p.mfaLevel,
      impersonation: p.impersonatorUserId
        ? {
            byUserId: p.impersonatorUserId,
            reason: p.impersonationReason ?? '',
            expiresAt: p.absoluteExpiresAt?.toISOString() ?? null,
          }
        : null,
      memberships: memberships.map((r) => ({
        orgId: r.org_id,
        name: r.name,
        slug: r.slug,
        type: r.type,
        status: r.status,
        role: r.role,
      })),
      permissions,
      featureFlags: flags,
    };
  }

  private flags(orgId: string): Promise<Record<string, unknown>> {
    return this.db.withOrg(orgId, async (c) => {
      const rows = (await c.query(`SELECT key, value, org_id FROM platform.feature_flags`)).rows;
      const out: Record<string, unknown> = {};
      for (const r of rows.filter((x) => x.org_id === null)) out[r.key] = r.value;
      for (const r of rows.filter((x) => x.org_id !== null)) out[r.key] = r.value; // org value overrides global
      return out;
    });
  }
}
