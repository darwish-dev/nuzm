import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuditSink } from '../../common/audit';
import { ProblemException } from '../../common/errors';
import { SlidingWindowLimiter } from '../../common/rate-limit';
import { AnyAuthenticated } from '../../common/access';
import { IDENTITY_CONFIG } from '../../common/tokens';
import {
  AllowPreMfa,
  DenyImpersonation,
  CSRF_COOKIE,
  CurrentPrincipal,
  Public,
  RealmOnly,
  SESSION_COOKIE,
  StepUp,
} from './session.guard';
import { MfaService } from './internal/mfa.service';
import type { IdentityConfig } from './internal/config';
import { OidcClient } from './internal/oidc';
import { safeReturnTo } from './internal/return-to';
import { openLoginState, sealLoginState } from './internal/seal';
import { SessionService, type Principal } from './internal/session.service';
import { UserService } from './internal/user.service';

const LOGIN_COOKIE = 'nuzm_oidc';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@AnyAuthenticated()
@RealmOnly('any')
@Controller('v1')
export class IdentityController {
  private readonly limiter = new SlidingWindowLimiter();

  constructor(
    @Inject(IDENTITY_CONFIG) private readonly cfg: IdentityConfig,
    private readonly oidc: OidcClient,
    private readonly sessions: SessionService,
    private readonly users: UserService,
    private readonly audit: AuditSink,
    private readonly mfa: MfaService,
  ) {}

  private cookieOpts(httpOnly: boolean, maxAge: number) {
    return {
      path: '/',
      httpOnly,
      sameSite: 'lax' as const,
      secure: this.cfg.secureCookies,
      maxAge,
    };
  }

  private limit(req: FastifyRequest) {
    if (!this.limiter.allow(`auth:${req.ip}`, this.cfg.loginRatePerMinute, 60_000))
      throw new ProblemException('rate_limited');
  }

  @Public()
  @Get('auth/oidc/login')
  async login(
    @Query('returnTo') returnTo: string | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    this.limit(req);
    const dest = safeReturnTo(returnTo, this.cfg.returnToOrigins, this.cfg.defaultReturnTo);
    if (!dest) {
      await this.audit.record({
        action: 'auth.login.rejected',
        outcome: 'failure',
        traceId: req.traceId,
        ip: req.ip,
        detail: { reason: 'invalid_return_to' },
      });
      throw new ProblemException('invalid_return_to');
    }
    const { url, login } = await this.oidc.authorizationRequest(dest);
    void reply.setCookie(
      LOGIN_COOKIE,
      await sealLoginState(login, this.cfg.sealKey),
      this.cookieOpts(true, 600),
    );
    return reply.status(302).header('location', url).send();
  }

  @Public()
  @Get('auth/oidc/callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') idpError: string | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    this.limit(req);
    const fail = async (reason: string, e: ProblemException) => {
      await this.audit.record({
        action: 'auth.login.failed',
        outcome: 'failure',
        traceId: req.traceId,
        ip: req.ip,
        detail: { reason },
      });
      void reply.clearCookie(LOGIN_COOKIE, { path: '/' });
      throw e;
    };
    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
    const sealed = cookies[LOGIN_COOKIE];
    const ctx = sealed ? await openLoginState(sealed, this.cfg.sealKey) : null;
    if (!ctx || !state || ctx.state !== state)
      return fail('state_mismatch', new ProblemException('oidc_state_mismatch'));
    if (idpError || !code)
      return fail(
        'idp_error',
        new ProblemException('oidc_token_invalid', 'identity provider returned an error'),
      );

    let claims;
    try {
      claims = await this.oidc.exchange(code, ctx.verifier, ctx.nonce);
    } catch (e) {
      if (e instanceof ProblemException) return fail(e.code, e);
      throw e;
    }
    const user = await this.users.upsertFromClaims(this.cfg.issuer, claims);
    if (user.status !== 'active')
      return fail('user_disabled', new ProblemException('idp_user_disabled'));

    // Session fixation defence: a pre-existing session cookie is revoked; login always mints new tokens.
    const old = cookies[SESSION_COOKIE.web];
    if (old) await this.sessions.revokeByToken(old);
    const s = await this.sessions.create(user.id, 'web', {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    void reply.clearCookie(LOGIN_COOKIE, { path: '/' });
    void reply.setCookie(
      SESSION_COOKIE.web,
      s.token,
      this.cookieOpts(true, this.cfg.absoluteSeconds),
    );
    void reply.setCookie(CSRF_COOKIE.web, s.csrf, this.cookieOpts(false, this.cfg.absoluteSeconds));
    await this.audit.record({
      action: 'auth.login.succeeded',
      actorUserId: user.id,
      outcome: 'success',
      traceId: req.traceId,
      ip: req.ip,
    });
    return reply.status(302).header('location', ctx.returnTo).send();
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(
    @CurrentPrincipal() p: Principal,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.sessions.revoke(p.userId, p.sessionId);
    void reply.clearCookie(SESSION_COOKIE[p.realm], { path: '/' });
    void reply.clearCookie(CSRF_COOKIE[p.realm], { path: '/' });
    await this.audit.record({
      action: 'auth.session.logout',
      actorUserId: p.userId,
      outcome: 'success',
      traceId: req.traceId,
      ip: req.ip,
    });
  }

  @Get('auth/sessions')
  async listSessions(@CurrentPrincipal() p: Principal) {
    const items = await this.sessions.list(p.userId);
    return { items: items.map((s) => ({ ...s, current: s.id === p.sessionId })), nextCursor: null };
  }

  @Delete('auth/sessions/:id')
  @HttpCode(204)
  async revokeSession(
    @Param('id') id: string,
    @CurrentPrincipal() p: Principal,
    @Req() req: FastifyRequest,
  ) {
    if (!UUID.test(id) || !(await this.sessions.revoke(p.userId, id)))
      throw new ProblemException('not_found');
    await this.audit.record({
      action: 'auth.session.revoked',
      actorUserId: p.userId,
      resource: { type: 'session', id },
      outcome: 'success',
      traceId: req.traceId,
      ip: req.ip,
    });
  }

  // ---- MFA ---------------------------------------------------------------------------------

  @DenyImpersonation()
  @AllowPreMfa()
  @Post('auth/mfa/factors')
  @HttpCode(201)
  async enrollFactor(
    @Body() body: { type?: string },
    @CurrentPrincipal() p: Principal,
    @Req() req: FastifyRequest,
  ) {
    if (body?.type !== 'totp')
      throw new ProblemException('validation_failed', 'type must be "totp"');
    const r = await this.mfa.enroll({ id: p.userId, email: p.email });
    await this.audit.record({
      action: 'auth.mfa.enrol_started',
      actorUserId: p.userId,
      outcome: 'success',
      traceId: req.traceId,
      ip: req.ip,
    });
    return {
      id: r.factorId,
      type: 'totp',
      status: 'pending',
      otpauthUri: r.otpauthUri,
      secret: r.secret,
    };
  }

  /** Verifies a TOTP `code` (activating a pending factor) or a single-use `recoveryCode`; elevates and rotates the session. */
  @DenyImpersonation()
  @AllowPreMfa()
  @Post('auth/mfa/factors/:id/verification')
  @HttpCode(200)
  async verifyFactor(
    @Param('id') id: string,
    @Body() body: { code?: string; recoveryCode?: string },
    @CurrentPrincipal() p: Principal,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    let level: 'totp' | 'recovery';
    let activated = false;
    try {
      if (typeof body?.recoveryCode === 'string') {
        await this.mfa.verifyRecoveryCode(p.userId, body.recoveryCode);
        level = 'recovery';
      } else if (typeof body?.code === 'string') {
        ({ activated } = await this.mfa.verifyTotp(
          { id: p.userId, email: p.email },
          id,
          body.code,
        ));
        level = 'totp';
      } else {
        throw new ProblemException('validation_failed', 'send code or recoveryCode');
      }
    } catch (e) {
      await this.audit.record({
        action: 'auth.mfa.verify_failed',
        actorUserId: p.userId,
        outcome: 'failure',
        traceId: req.traceId,
        ip: req.ip,
        detail: { code: e instanceof ProblemException ? e.code : 'error' },
      });
      throw e;
    }
    await this.mfa.elevateSession(p.sessionId, level);
    const fresh = await this.sessions.rotate(p.sessionId); // privilege change → new tokens (fixation defence)
    if (fresh) {
      void reply.setCookie(
        SESSION_COOKIE[p.realm],
        fresh.token,
        this.cookieOpts(true, this.cfg.absoluteSeconds),
      );
      void reply.setCookie(
        CSRF_COOKIE[p.realm],
        fresh.csrf,
        this.cookieOpts(false, this.cfg.absoluteSeconds),
      );
    }
    await this.audit.record({
      action:
        level === 'recovery'
          ? 'auth.mfa.recovery_used'
          : activated
            ? 'auth.mfa.activated'
            : 'auth.mfa.verified',
      actorUserId: p.userId,
      outcome: 'success',
      traceId: req.traceId,
      ip: req.ip,
    });
    return { mfaLevel: level, activated };
  }

  @DenyImpersonation()
  @StepUp()
  @Delete('auth/mfa/factors/:id')
  @HttpCode(204)
  async removeFactor(
    @Param('id') id: string,
    @CurrentPrincipal() p: Principal,
    @Req() req: FastifyRequest,
  ) {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    const u = await this.users.get(p.userId);
    await this.mfa.removeFactor({ id: p.userId, isPlatformUser: u?.is_platform_user ?? false }, id);
    await this.audit.record({
      action: 'auth.mfa.factor_removed',
      actorUserId: p.userId,
      resource: { type: 'mfa_factor', id },
      outcome: 'success',
      traceId: req.traceId,
      ip: req.ip,
    });
  }

  @DenyImpersonation()
  @StepUp()
  @Post('auth/mfa/recovery-codes')
  @HttpCode(201)
  async recoveryCodes(@CurrentPrincipal() p: Principal, @Req() req: FastifyRequest) {
    if (!(await this.mfa.hasActiveFactor(p.userId)))
      throw new ProblemException('conflict', 'enrol an MFA factor first');
    const codes = await this.mfa.regenerateRecoveryCodes(p.userId);
    await this.audit.record({
      action: 'auth.mfa.recovery_codes_generated',
      actorUserId: p.userId,
      outcome: 'success',
      traceId: req.traceId,
      ip: req.ip,
    });
    return { codes };
  }
}
