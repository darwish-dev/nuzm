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
