import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { AuditSink } from '../../common/audit';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { IDENTITY_CONFIG } from '../../common/tokens';
import { AuditQueryService, parseAuditFilter } from '../audit';
import {
  CSRF_COOKIE,
  RealmOnly,
  SESSION_COOKIE,
  StepUp,
  type IdentityConfigLike,
} from '../identity';
import { NotificationService } from '../notifications';
import { OrgService } from '../tenancy';
import { AdminReadService } from './internal/admin-read.service';
import { FeatureFlagService } from './internal/feature-flag.service';
import { ImpersonationService, type ImpersonationInput } from './internal/impersonation.service';
import { UUID } from '@nuzm/domain';

const uuid = (v: string) => {
  if (!UUID.test(v)) throw new ProblemException('not_found');
  return v.toLowerCase();
};

/** Admin console API. Every route needs an MFA-verified admin-realm session AND a platform permission. */
@RealmOnly('admin')
@Controller('v1/admin')
export class AdminController {
  constructor(
    private readonly read: AdminReadService,
    private readonly flags: FeatureFlagService,
    private readonly impersonation: ImpersonationService,
    private readonly orgs: OrgService,
    private readonly audits: AuditQueryService,
    private readonly audit: AuditSink,
    private readonly notifications: NotificationService,
    @Inject(IDENTITY_CONFIG) private readonly cfg: IdentityConfigLike,
  ) {}

  @RequirePlatformPermission('admin:org:read')
  @Get('organizations')
  listOrganizations(@Query() q: { q?: string; status?: string; limit?: string; cursor?: string }) {
    return this.read.listOrganizations({
      q: q.q,
      status: q.status,
      limit: parseLimit(q.limit),
      cursor: q.cursor,
    });
  }

  /** Suspend or reinstate an organization; reason required to suspend. */
  @RequirePlatformPermission('admin:org:manage')
  @StepUp()
  @Patch('organizations/:id')
  async setOrganizationStatus(
    @Platform() who: PlatformContext,
    @Param('id') rawId: string,
    @Body() body: { status?: unknown; reason?: unknown } | undefined,
    @Req() req: FastifyRequest,
  ) {
    const id = uuid(rawId);
    const status = body?.status;
    if (status !== 'active' && status !== 'suspended')
      throw new ProblemException('validation_failed', 'status must be active or suspended');
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (status === 'suspended' && (reason.length < 5 || reason.length > 500))
      throw new ProblemException(
        'validation_failed',
        'a reason of 5..500 characters is required to suspend',
      );
    const org = await this.read.organization(id);
    if (!org) throw new ProblemException('not_found');
    if (org.status !== status) {
      // the status change, its outbox event AND its audit row commit in one transaction (OrgService.setStatus)
      await this.orgs.setStatus(id, status, status === 'suspended' ? reason : null, {
        before: org.status,
        traceId: req.traceId,
      });
      for (const owner of await this.read.owners(id))
        await this.notifications.notify({
          orgId: id,
          userId: owner,
          kind: status === 'suspended' ? 'security.org_suspended' : 'security.org_reinstated',
          params: {},
        });
    }
    return { id, status, name: org.name };
  }

  @RequirePlatformPermission('admin:user:read')
  @Get('users')
  listUsers(@Query() q: { q?: string; limit?: string; cursor?: string }) {
    return this.read.listUsers({ q: q.q, limit: parseLimit(q.limit), cursor: q.cursor });
  }

  /** Start a time-boxed support impersonation; sets the target's web-realm cookies for the caller's browser. */
  @RequirePlatformPermission('admin:impersonate')
  @StepUp()
  @Post('users/:id/impersonation')
  @HttpCode(201)
  async impersonate(
    @Platform() who: PlatformContext,
    @Param('id') rawId: string,
    @Body() body: ImpersonationInput | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.impersonation.start(who, uuid(rawId), body ?? ({} as ImpersonationInput), {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      traceId: req.traceId,
    });
    const maxAge = Math.max(60, Math.round((Date.parse(r.expiresAt) - Date.now()) / 1000));
    const opts = { path: '/', sameSite: 'lax' as const, secure: this.cfg.secureCookies, maxAge };
    void reply.setCookie(SESSION_COOKIE.web, r.session.token, { ...opts, httpOnly: true });
    void reply.setCookie(CSRF_COOKIE.web, r.session.csrf, { ...opts, httpOnly: false });
    return { sessionId: r.session.id, expiresAt: r.expiresAt, target: r.target };
  }

  @RequirePlatformPermission('admin:flags:manage')
  @Get('feature-flags')
  async listFlags() {
    return { items: await this.flags.list() };
  }

  @RequirePlatformPermission('admin:flags:manage')
  @Put('feature-flags')
  async setFlag(
    @Platform() who: PlatformContext,
    @Body()
    body: { key?: string; scope?: 'global' | 'org'; orgId?: string; value?: unknown } | undefined,
  ) {
    const b = body ?? {};
    if (typeof b.key !== 'string')
      throw new ProblemException('validation_failed', 'key is required');
    if (b.orgId !== undefined && typeof b.orgId !== 'string')
      throw new ProblemException('validation_failed', 'orgId must be a UUID');
    if (b.orgId !== undefined && !UUID.test(b.orgId))
      throw new ProblemException('validation_failed', 'orgId must be a UUID');
    const r = await this.flags.set(
      {
        key: b.key,
        scope: b.scope as 'global' | 'org',
        orgId: b.orgId?.toLowerCase(),
        value: b.value,
      },
      who.userId,
    );
    return r.after;
  }

  /** Cross-org audit. The act of reading it is itself audited (platform chain). */
  @RequirePlatformPermission('admin:audit:read')
  @Get('audit-logs')
  async auditLogs(
    @Platform() who: PlatformContext,
    @Query() q: Record<string, string | undefined>,
    @Req() req: FastifyRequest,
  ) {
    const filter = parseAuditFilter(q);
    await this.audit.record({
      action: 'audit.admin_log.queried',
      actorUserId: who.userId,
      outcome: 'success',
      traceId: req.traceId,
      ip: req.ip,
      detail: {
        filters: Object.fromEntries(
          Object.entries(q).filter(([k]) => !['cursor', 'limit'].includes(k)),
        ),
      },
    });
    return this.audits.listAll(filter);
  }
}
