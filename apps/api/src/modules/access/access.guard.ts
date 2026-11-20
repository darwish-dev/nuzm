import { CanActivate, ExecutionContext, Injectable, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import {
  ANY_AUTHENTICATED,
  DELEGABLE,
  REQUIRE_PERMISSION,
  REQUIRE_PLATFORM_PERMISSION,
} from '../../common/access';
import { ActingOrgPort } from '../../common/acting';
import { ProblemException } from '../../common/errors';
import { ApiKeyService, PUBLIC, SessionAuthenticator, permissionCovers } from '../identity';
import { PolicyService } from './policy.service';
import { UUID } from '@nuzm/domain';

/**
 * The single global guard: authenticate (session or API key), resolve the active organization from a
 * verified membership, and enforce the route's declared permission. Deny by default.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionAuthenticator,
    private readonly apiKeys: ApiKeyService,
    private readonly policy: PolicyService,
    /** M11 S54: present when the programs module is loaded. */
    @Optional() private readonly acting?: ActingOrgPort,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;
    const needed = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRE_PERMISSION,
      targets,
    );
    const anyAuth = this.reflector.getAllAndOverride<boolean>(ANY_AUTHENTICATED, targets);
    const platformNeeded = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRE_PLATFORM_PERMISSION,
      targets,
    );
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();

    // M11 S54 delegated access: `X-Nuzm-Acting-Org` is honoured ONLY on routes marked @Delegable(), for cookie sessions (never API keys, never admin routes), and every such request is
    // re-validated against an active, unexpired grant (ActingOrgService). Everywhere else the header is refused, never trusted.
    const actingHeader = req.headers['x-nuzm-acting-org'];
    if (actingHeader !== undefined) {
      const bearer =
        typeof req.headers.authorization === 'string' &&
        /^Bearer\s+/i.test(req.headers.authorization);
      if (
        !this.acting ||
        bearer ||
        platformNeeded ||
        !needed ||
        typeof actingHeader !== 'string' ||
        !this.reflector.getAllAndOverride<boolean>(DELEGABLE, targets)
      )
        throw new ProblemException(
          'forbidden',
          'delegated access is not available for this request',
        );
    }

    const auth = req.headers.authorization;
    if (platformNeeded) {
      // Admin console: never reachable with API keys, and never with a web-realm session.
      if (typeof auth === 'string' && /^Bearer\s+/i.test(auth))
        throw new ProblemException('unauthenticated');
      const principal = await this.sessions.authenticate(ctx);
      if (principal.realm !== 'admin' || principal.impersonatorUserId)
        throw new ProblemException('forbidden', 'admin console requires an admin-realm session');
      const pa = await this.policy.platformAccess(principal.userId);
      if (!pa || !permissionCovers(pa.permissions, platformNeeded))
        throw new ProblemException('forbidden');
      req.platform = { userId: principal.userId, roles: pa.roles, permissions: pa.permissions };
      return true;
    }
    if (typeof auth === 'string' && /^Bearer\s+nzk_/i.test(auth)) {
      if (!needed) throw new ProblemException('unauthenticated'); // API keys only reach org-scoped routes
      const key = await this.apiKeys.authenticate(auth.replace(/^Bearer\s+/i, '').trim(), req.ip);
      if (!key) throw new ProblemException('unauthenticated');
      const access = await this.policy.apiKeyAccess(key);
      if (!access) throw new ProblemException('unauthenticated');
      // A path orgId that is not the key's own org is another organization: existence-hiding 404.
      const pathOrg = (req.params as Record<string, string | undefined> | undefined)?.orgId;
      if (pathOrg !== undefined && pathOrg.toLowerCase() !== key.orgId)
        throw new ProblemException('not_found');
      if (access.orgStatus !== 'active') throw new ProblemException('org_suspended');
      if (!permissionCovers(access.permissions, needed)) throw new ProblemException('forbidden');
      req.access = {
        orgId: key.orgId,
        role: access.role,
        permissions: access.permissions,
        actor: { kind: 'api_key', keyId: key.keyId, userId: key.createdBy },
      };
      req.orgId = key.orgId;
      return true;
    }

    const principal = await this.sessions.authenticate(ctx);
    if (typeof actingHeader === 'string') {
      const agencyRaw = req.headers['x-nuzm-org'];
      if (typeof agencyRaw !== 'string' || !UUID.test(agencyRaw))
        throw new ProblemException(
          'forbidden',
          'delegated access is not available for this request',
        );
      const am = await this.policy.membership(principal.userId, agencyRaw.toLowerCase());
      if (!am)
        throw new ProblemException(
          'forbidden',
          'delegated access is not available for this request',
        ); // never "not found": no oracle for agency membership either
      req.access = await this.acting!.authorize({
        userId: principal.userId,
        agencyOrgId: agencyRaw.toLowerCase(),
        agencyOrgStatus: am.orgStatus,
        agencyMemberPermissions: am.permissions,
        clientOrgId: actingHeader.toLowerCase(),
        needed: needed!,
      });
      req.orgId = req.access.orgId;
      return true;
    }
    if (!needed && !anyAuth)
      throw new ProblemException('forbidden', 'route has no access declaration'); // deny by default
    if (!needed) return true;

    const raw =
      (req.params as Record<string, string | undefined> | undefined)?.orgId ??
      req.headers['x-nuzm-org'];
    if (typeof raw !== 'string' || raw === '')
      throw new ProblemException(
        'validation_failed',
        'X-Nuzm-Org header is required for this route',
      );
    if (!UUID.test(raw)) throw new ProblemException('not_found');
    const m = await this.policy.membership(principal.userId, raw.toLowerCase());
    if (!m) throw new ProblemException('not_found'); // existence hiding: not a member == no such organization
    if (m.orgStatus !== 'active') throw new ProblemException('org_suspended');
    if (!permissionCovers(m.permissions, needed)) throw new ProblemException('forbidden');
    req.access = {
      orgId: raw.toLowerCase(),
      role: m.role,
      permissions: m.permissions,
      actor: { kind: 'session', userId: principal.userId },
    };
    req.orgId = raw.toLowerCase();
    return true;
  }
}
