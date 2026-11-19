import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { BuildService } from './internal/builds/build.service';
import { MobileBuilderEnabledGuard } from './internal/flag.guard';

type B = Record<string, unknown> | undefined;

/** `/v1/mobile/builds` (docs/04 §2.10). Flag `mobile_builder.enabled`. 422 `signing_not_authorized`, 503 `no_macos_capacity` / `signing_unavailable` / `build_runner_unavailable`. */
@UseGuards(MobileBuilderEnabledGuard)
@Controller('v1/mobile/builds')
export class BuildsController {
  constructor(private readonly builds: BuildService) {}

  @RequirePermission('mobile:build')
  @Idempotent()
  @Post()
  @HttpCode(202)
  async create(@Org() orgId: string, @Access() a: AccessContext, @Body() body: B) {
    const b = await this.builds.create(orgId, a.actor.userId, body ?? {});
    if (process.env.MOBILE_KICK !== 'off')
      setImmediate(() => void this.builds.execute(orgId, b.id).catch(() => undefined));
    return b;
  }
  @RequirePermission('mobile:build')
  @Get()
  async list(@Org() orgId: string, @Query() q: { projectId?: string }) {
    return { items: await this.builds.list(orgId, q.projectId ? { projectId: q.projectId } : {}) };
  }
  @RequirePermission('mobile:build')
  @Get(':id')
  get(@Org() orgId: string, @Param('id') id: string) {
    return this.builds.get(orgId, id);
  }
  @RequirePermission('mobile:build')
  @Get(':id/artifacts')
  async artifacts(@Org() orgId: string, @Param('id') id: string) {
    return { items: await this.builds.artifacts(orgId, id) };
  }
}
