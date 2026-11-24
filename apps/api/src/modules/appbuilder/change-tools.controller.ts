import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { ChangeToolsService } from './internal/changes/change-tools.service';
import { ProjectsPort } from './internal/ports/m09';
import { BuilderToolsProjectScoped } from './internal/changes/builder-tools-flag';

type B = Record<string, unknown>;

/** Builder tools, priority 1 (S-05): change preview, version diff, rollback, revert of one change. Flag `builder_tools.enabled` (default OFF, 404 when off). */
@Controller('v1/builder/projects/:projectId')
export class ChangeToolsController extends BuilderToolsProjectScoped {
  constructor(
    projects: ProjectsPort,
    private readonly tools: ChangeToolsService,
  ) {
    super(projects);
  }
  @RequirePermission('builder:read')
  @Post('change-previews')
  @HttpCode(200)
  async preview(@Org() orgId: string, @Param('projectId') pid: string, @Body() body: B) {
    return this.tools.preview(orgId, await this.project(orgId, pid), body ?? {});
  }
  @RequirePermission('builder:read')
  @Get('version-diff')
  async diff(
    @Org() orgId: string,
    @Param('projectId') pid: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!from || !to) throw new ProblemException('validation_failed', 'from and to are required');
    return this.tools.diff(orgId, await this.project(orgId, pid), from, to);
  }
  @RequirePermission('builder:write')
  @Idempotent()
  @Post('rollbacks')
  @HttpCode(201)
  async rollback(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('projectId') pid: string,
    @Body() body: B,
  ) {
    return this.tools.rollback(orgId, a.actor.userId, await this.project(orgId, pid), body ?? {});
  }
  @RequirePermission('builder:write')
  @Idempotent()
  @Post('reverts')
  @HttpCode(201)
  async revert(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('projectId') pid: string,
    @Body() body: B,
  ) {
    return this.tools.revert(orgId, a.actor.userId, await this.project(orgId, pid), body ?? {});
  }
}
