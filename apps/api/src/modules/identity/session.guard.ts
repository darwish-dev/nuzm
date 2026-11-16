import {
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { IDENTITY_CONFIG } from '../../common/tokens';
import { ProblemException } from '../../common/errors';
import type { IdentityConfig } from './internal/config';
import { SessionService, type Principal, type Realm } from './internal/session.service';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export const PUBLIC = 'nuzm:public';
export const REALM = 'nuzm:realm';
export const STEP_UP = 'nuzm:stepup';
export const PRE_MFA = 'nuzm:premfa';
export const NO_IMPERSONATION = 'nuzm:no-impersonation';
/** Opt a route out of authentication (login, callback, health). Everything else is deny-by-default. */
export const Public = () => SetMetadata(PUBLIC, true);
/** Route realm; default `web`. Admin-console routes must declare `@RealmOnly('admin')`. */
export const RealmOnly = (realm: Realm | 'any') => SetMetadata(REALM, realm);
/** Require a recent MFA verification (default window from config; proposal 5 min). */
export const StepUp = (maxAgeSeconds?: number) => SetMetadata(STEP_UP, maxAgeSeconds ?? true);
/** Routes usable before MFA is completed (enrol/verify). Admin-realm sessions are otherwise MFA-gated. */
export const AllowPreMfa = () => SetMetadata(PRE_MFA, true);
/** Refuse impersonated sessions (credential/MFA/API-key management must never be done as someone else). */
export const DenyImpersonation = () => SetMetadata(NO_IMPERSONATION, true);
export const CurrentPrincipal = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): Principal => {
    return ctx.switchToHttp().getRequest<FastifyRequest>().principal!;
  },
);

export const SESSION_COOKIE: Record<Realm, string> = {
  web: 'nuzm_session',
  admin: 'nuzm_admin_session',
};
export const CSRF_COOKIE: Record<Realm, string> = { web: 'nuzm_csrf', admin: 'nuzm_admin_csrf' };
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class SessionAuthenticator {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    @Inject(IDENTITY_CONFIG) private readonly cfg: IdentityConfig,
  ) {}

  /** Authenticates a session request and sets `req.principal`; throws a ProblemException otherwise. */
  async authenticate(ctx: ExecutionContext): Promise<Principal> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const routeRealm = this.reflector.getAllAndOverride<Realm | 'any'>(REALM, targets) ?? 'web';
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const jar = (req.cookies ?? {}) as Record<string, string | undefined>;

    // `any` routes (MFA enrol/verify, sessions, logout, /me) accept whichever realm's cookie is present.
    const candidates: Realm[] = routeRealm === 'any' ? ['admin', 'web'] : [routeRealm];
    let p: Awaited<ReturnType<SessionService['authenticate']>> = null;
    for (const r of candidates) {
      const token = jar[SESSION_COOKIE[r]];
      if (token) {
        p = await this.sessions.authenticate(token, r);
        if (p) break;
      }
    }
    if (!p) throw new ProblemException('unauthenticated');

    // Double-submit CSRF: cookie-authenticated unsafe methods must echo the CSRF token in a header.
    if (
      !SAFE.has(req.method) &&
      !this.sessions.csrfValid(p.csrfHash, req.headers['x-csrf-token'] as string | undefined)
    ) {
      throw new ProblemException('csrf_failed');
    }
    const { csrfHash: _omit, ...principal } = p;
    // Admin realm: MFA is mandatory; only enrol/verify routes are reachable before it is completed.
    if (
      principal.realm === 'admin' &&
      principal.mfaLevel === 'none' &&
      !this.reflector.getAllAndOverride<boolean>(PRE_MFA, targets)
    ) {
      throw new ProblemException('mfa_required', 'admin sessions require MFA');
    }
    if (
      principal.impersonatorUserId &&
      this.reflector.getAllAndOverride<boolean>(NO_IMPERSONATION, targets)
    )
      throw new ProblemException('forbidden', 'not available while impersonating');
    const stepUp = this.reflector.getAllAndOverride<number | boolean | undefined>(STEP_UP, targets);
    if (stepUp) {
      const maxAge = (typeof stepUp === 'number' ? stepUp : this.cfg.stepUpMaxAgeSeconds) * 1000;
      const at = principal.mfaVerifiedAt?.getTime();
      if (principal.mfaLevel === 'none' || at === undefined || Date.now() - at > maxAge) {
        throw new ProblemException('step_up_required', 'verify MFA to continue');
      }
    }
    req.principal = principal;
    return principal;
  }
}
