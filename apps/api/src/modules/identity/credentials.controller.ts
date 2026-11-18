import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AnyAuthenticated } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { SlidingWindowLimiter } from '../../common/rate-limit';
import { IDENTITY_CONFIG } from '../../common/tokens';
import {
  CSRF_COOKIE,
  CurrentPrincipal,
  DenyImpersonation,
  Public,
  RealmOnly,
  SESSION_COOKIE,
} from './session.guard';
import type { IdentityConfig } from './internal/config';
import { CredentialsService } from './internal/credentials.service';
import { SessionService, type Principal } from './internal/session.service';
import type { UserRow } from './internal/user.service';

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const authUser = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  emailVerified: u.email_verified,
  displayName: u.display_name,
  locale: u.locale,
});

/** Built-in email + password sign-in (ADR-008). Customer console (web realm) only; staff keep using OIDC with MFA. */
@AnyAuthenticated()
@RealmOnly('web')
@Controller('v1/auth')
export class CredentialsController {
  private readonly limiter = new SlidingWindowLimiter();

  constructor(
    @Inject(IDENTITY_CONFIG) private readonly cfg: IdentityConfig,
    private readonly creds: CredentialsService,
    private readonly sessions: SessionService,
  ) {}

  private limit(req: FastifyRequest, bucket: string, perMinute = this.cfg.loginRatePerMinute) {
    if (!this.limiter.allow(`${bucket}:${req.ip}`, perMinute, 60_000))
      throw new ProblemException('rate_limited');
  }

  private meta(req: FastifyRequest) {
    return { ip: req.ip, traceId: req.traceId };
  }

  private cookieOpts(httpOnly: boolean) {
    return {
      path: '/',
      httpOnly,
      sameSite: 'lax' as const,
      secure: this.cfg.secureCookies,
      maxAge: this.cfg.absoluteSeconds,
    };
  }

  /** New session; a presented session cookie is revoked first (fixation defence), as in the OIDC callback. */
  private async signIn(user: UserRow, req: FastifyRequest, reply: FastifyReply) {
    const jar = (req.cookies ?? {}) as Record<string, string | undefined>;
    const old = jar[SESSION_COOKIE.web];
    if (old) await this.sessions.revokeByToken(old);
    const s = await this.sessions.create(user.id, 'web', {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    void reply.setCookie(SESSION_COOKIE.web, s.token, this.cookieOpts(true));
    void reply.setCookie(CSRF_COOKIE.web, s.csrf, this.cookieOpts(false));
  }

  @Public()
  @Post('register')
  @HttpCode(201)
  async register(
    @Body() body: Json,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.limit(req, 'register', Math.max(3, Math.floor(this.cfg.loginRatePerMinute / 4)));
    const locale = body?.locale === 'en' ? 'en' : body?.locale === 'ar' ? 'ar' : undefined;
    const name = str(body?.displayName).trim();
    if (name.length > 120)
      throw new ProblemException('validation_failed', 'displayName is too long', [
        { field: 'displayName', message: 'displayName is too long' },
      ]);
    const user = await this.creds.register(
      { email: str(body?.email), password: str(body?.password), displayName: name, locale },
      this.meta(req),
    );
    await this.signIn(user, req, reply);
    return authUser(user);
  }

  @Public()
  @Post('password/login')
  @HttpCode(200)
  async login(
    @Body() body: Json,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.limit(req, 'plogin');
    const user = await this.creds.login(str(body?.email), str(body?.password), this.meta(req));
    await this.signIn(user, req, reply);
    return authUser(user);
  }

  @Public()
  @Post('password/forgot')
  @HttpCode(202)
  async forgot(@Body() body: Json, @Req() req: FastifyRequest) {
    this.limit(req, 'forgot', Math.max(3, Math.floor(this.cfg.loginRatePerMinute / 4)));
    await this.creds.requestReset(str(body?.email), this.meta(req));
  }

  @Public()
  @Post('password/reset')
  @HttpCode(204)
  async reset(@Body() body: Json, @Req() req: FastifyRequest) {
    this.limit(req, 'reset');
    await this.creds.resetPassword(str(body?.token), str(body?.newPassword), this.meta(req));
  }

  @DenyImpersonation()
  @Post('password/change')
  @HttpCode(204)
  async change(@Body() body: Json, @CurrentPrincipal() p: Principal, @Req() req: FastifyRequest) {
    this.limit(req, 'change');
    await this.creds.changePassword(
      p.userId,
      p.sessionId,
      str(body?.currentPassword),
      str(body?.newPassword),
      this.meta(req),
    );
  }

  @Public()
  @Post('email/verification')
  @HttpCode(204)
  async verify(@Body() body: Json, @Req() req: FastifyRequest) {
    this.limit(req, 'verify');
    await this.creds.verifyEmail(str(body?.token), this.meta(req));
  }

  @Post('email/verification/resend')
  async resend(
    @CurrentPrincipal() p: Principal,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.limit(req, 'resend', 3);
    const sent = await this.creds.resendVerification(p.userId, this.meta(req));
    void reply.status(sent ? 202 : 204);
  }
}
