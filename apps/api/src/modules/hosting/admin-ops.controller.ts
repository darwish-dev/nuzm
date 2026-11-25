import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { RealmOnly, StepUp } from '../identity';
import type { Db } from '@nuzm/platform';
import { DB } from '../../common/tokens';
import { MonitorService } from './internal/monitor.service';
import { renderPackage, renderAccessProfile } from './internal/hestia/packages';
import { RestoreDrillService } from './internal/restore-drill.service';

const need = (who: PlatformContext, p: string) => {
  if (!who.permissions.has(p))
    throw new ProblemException('forbidden', `permission ${p} is required`);
};
const idemKey = (req: FastifyRequest) => {
  const k = req.headers['idempotency-key'];
  if (typeof k !== 'string' || k.length < 1 || k.length > 255)
    throw new ProblemException('idempotency_key_required', 'Send an Idempotency-Key header');
  return k;
};

/** Operations of the hosting layer for platform staff: alerts, restore drills, and the Hestia packages/access profile a node is set up with (docs/runbooks/node-onboarding.md). */
@RealmOnly('admin')
@Controller('v1/admin/hosting')
export class AdminHostingOpsController {
  constructor(
    private readonly monitor: MonitorService,
    private readonly drills: RestoreDrillService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @RequirePlatformPermission('admin:hosting:read')
  @Get('alerts')
  alerts(@Query('state') state?: string, @Query('limit') limit?: string) {
    return this.monitor.list(
      (state as 'open' | 'resolved' | 'all' | undefined) ?? 'open',
      parseLimit(limit),
    );
  }

  /** Runs the monitoring sweep now (it also runs on the hosting scheduler). */
  @RequirePlatformPermission('admin:hosting:read')
  @Post('monitor-runs')
  @HttpCode(200)
  async run(@Platform() who: PlatformContext, @Req() req: FastifyRequest) {
    need(who, 'admin:hosting:manage');
    idemKey(req);
    return this.monitor.sweep();
  }

  @RequirePlatformPermission('admin:hosting:read')
  @Get('restore-drills')
  list(@Query('limit') limit?: string) {
    return this.drills.list(parseLimit(limit));
  }

  @RequirePlatformPermission('admin:hosting:read')
  @Get('restore-drills/:id')
  one(@Param('id') id: string) {
    return this.drills.get(id);
  }

  /** Restores a real backup onto an isolated drill node and records the duration and result. Customer data is read: step-up, and the drill node must be in the backup's own region. */
  @RequirePlatformPermission('admin:hosting:read')
  @StepUp()
  @Post('restore-drills')
  @HttpCode(202)
  async start(
    @Platform() who: PlatformContext,
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
  ) {
    need(who, 'admin:hosting:manage');
    idemKey(req);
    for (const k of Object.keys(body ?? {}))
      if (k !== 'backupId' && k !== 'nodeId')
        throw new ProblemException('validation_failed', `unknown member ${k}`);
    return this.drills.request(
      who.userId,
      String(body?.backupId ?? ''),
      String(body?.nodeId ?? ''),
    );
  }

  /** The Hestia package of every plan (the node setup creates them with `v-add-user-package`) and the REST access-key profile that matches the adapter's allow-list. */
  @RequirePlatformPermission('admin:hosting:read')
  @Get('node-packages')
  async packages() {
    const plans = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT key, quotas FROM hosting.plan_definitions WHERE status <> 'retired' ORDER BY key`,
          )
        ).rows,
    );
    return {
      packages: plans.map((p) =>
        renderPackage({ key: p.key as string, quotas: p.quotas as never }),
      ),
      accessProfile: renderAccessProfile(),
    };
  }
}
