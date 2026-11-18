import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { RealmOnly, StepUp } from '../identity';
import { MigrationService } from './internal/migration.service';
import { SitesService } from './internal/sites.service';

/** Staff view of sites across organizations (every read is audited as `hosting.admin.cross_org_read`) and suspension/reinstatement (SI-M06-3 / PA-14). */
@RealmOnly('admin')
@Controller('v1/admin/hosting/sites')
export class AdminSitesController {
  constructor(
    private readonly sites: SitesService,
    private readonly migrations: MigrationService,
  ) {}

  @RequirePlatformPermission('admin:hosting:read')
  @Get()
  list(
    @Platform() who: PlatformContext,
    @Query()
    q: {
      orgId?: string;
      nodeId?: string;
      status?: string;
      q?: string;
      limit?: string;
      cursor?: string;
    },
  ) {
    return this.sites.adminList(who.userId, {
      orgId: q.orgId,
      nodeId: q.nodeId,
      status: q.status,
      q: q.q,
      limit: parseLimit(q.limit),
      cursor: q.cursor,
    });
  }

  @RequirePlatformPermission('admin:hosting:read')
  @Get(':id')
  get(@Platform() who: PlatformContext, @Param('id') id: string) {
    return this.sites.adminGet(who.userId, id);
  }

  /** `{status: 'suspended'|'active', reason}`: suspension and reinstatement need admin:hosting:manage, MFA step-up and a reason. */
  @RequirePlatformPermission('admin:hosting:read')
  @StepUp()
  @Patch(':id')
  async patch(
    @Platform() who: PlatformContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    if (!who.permissions.has('admin:hosting:manage'))
      throw new ProblemException('forbidden', 'permission admin:hosting:manage is required');
    const b = body ?? {};
    for (const k of Object.keys(b))
      if (k !== 'status' && k !== 'reason')
        throw new ProblemException('validation_failed', `unknown member ${k}`);
    if (b.status !== 'suspended' && b.status !== 'active')
      throw new ProblemException('validation_failed', "status must be 'suspended' or 'active'");
    if (typeof b.reason !== 'string')
      throw new ProblemException('validation_failed', 'reason is required');
    return this.sites.setSuspended(who.userId, id, b.status === 'suspended', 'admin', b.reason);
  }

  /** Drain/maintenance: moves a site to another node of the SAME data region (backup, restore on the target, verify, switch); the source serves until verified. */
  @RequirePlatformPermission('admin:hosting:read')
  @StepUp()
  @Post(':id/migrations')
  async migrate(
    @Platform() who: PlatformContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
  ) {
    if (!who.permissions.has('admin:hosting:manage'))
      throw new ProblemException('forbidden', 'permission admin:hosting:manage is required');
    const k = req.headers['idempotency-key'];
    if (typeof k !== 'string' || k.length < 1 || k.length > 255)
      throw new ProblemException('idempotency_key_required', 'Send an Idempotency-Key header');
    return this.migrations.request(who.userId, id, body ?? {});
  }

  @RequirePlatformPermission('admin:hosting:read')
  @Get(':id/migrations')
  async migrationsOf(@Param('id') id: string) {
    return { items: await this.migrations.list(id) };
  }
}
