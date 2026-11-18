import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * Access-control decorators. Every authenticated route MUST declare one of:
 *  - @RequirePermission('x:y')  org-scoped; caller must hold the permission in the active org
 *  - @AnyAuthenticated()        any signed-in session (me, org discovery/creation, invitation acceptance, catalogues)
 * Routes with neither are refused (deny by default). @Public() opts out of authentication entirely.
 */
export const REQUIRE_PERMISSION = 'nuzm:require-permission';
export const ANY_AUTHENTICATED = 'nuzm:any-authenticated';
export const RequirePermission = (permission: string) =>
  SetMetadata(REQUIRE_PERMISSION, permission);
export const AnyAuthenticated = () => SetMetadata(ANY_AUTHENTICATED, true);
/**
 * Admin-console routes: the caller must hold this PLATFORM permission through a platform role
 * (tenancy.platform_roles), be flagged as a platform user, and use an MFA-verified admin-realm session.
 */
export const REQUIRE_PLATFORM_PERMISSION = 'nuzm:require-platform-permission';
export const RequirePlatformPermission = (permission: string) =>
  SetMetadata(REQUIRE_PLATFORM_PERMISSION, permission);

export interface PlatformContext {
  userId: string;
  roles: readonly string[];
  permissions: ReadonlySet<string>;
}

export interface AccessContext {
  orgId: string;
  role: string;
  permissions: ReadonlySet<string>;
  actor: { kind: 'session'; userId: string } | { kind: 'api_key'; keyId: string; userId: string };
  /** Present only for delegated (agency) requests: `orgId` is then the CLIENT organization. */
  acting?: { agencyOrgId: string; clientOrgId: string; grantId: string };
}

declare module 'fastify' {
  interface FastifyRequest {
    access?: AccessContext;
    platform?: PlatformContext;
  }
}

/** Verified active-org id (set by the access guard from a membership/API key; never from input). */
export const Org = createParamDecorator((_d: unknown, ctx: ExecutionContext): string => {
  return ctx.switchToHttp().getRequest<FastifyRequest>().access!.orgId;
});
export const Access = createParamDecorator((_d: unknown, ctx: ExecutionContext): AccessContext => {
  return ctx.switchToHttp().getRequest<FastifyRequest>().access!;
});
export const Platform = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): PlatformContext => {
    return ctx.switchToHttp().getRequest<FastifyRequest>().platform!;
  },
);

// ---- M11 S54 (appended): delegated access -------------------------------------------------------------------------------------------------
/**
 * Marks a route (or controller) as usable with `X-Nuzm-Acting-Org` (agency acting for a client). DENY BY DEFAULT: on every other route the header is refused. A delegable route still
 * needs its `@RequirePermission`, and the permission must be inside the grant AND the agency member's own role (the intersection).
 */
export const DELEGABLE = 'nuzm:delegable';
export const Delegable = () => SetMetadata(DELEGABLE, true);

/** Set on `req.access` when an agency acts for a client: the audit sink records the agency as the ACTOR organization and the client as the ACTING-FOR organization. */
export interface ActingContext {
  agencyOrgId: string;
  clientOrgId: string;
  grantId: string;
}
