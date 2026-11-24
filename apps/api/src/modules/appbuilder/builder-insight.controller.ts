import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { BuilderInsightService } from './internal/changes/builder-insight.service';
import { ContentRead } from '../builder';
import { BuilderToolsProjectScoped } from './internal/changes/builder-tools-flag';
import { Idempotent } from '../../common/idempotency';
import { ProjectsPort } from './internal/ports/m09';

type B = Record<string, unknown>;

/** Review, code search and project memory of a web-app/mobile project. */
@Controller('v1/builder/projects/:projectId')
export class BuilderInsightController extends BuilderToolsProjectScoped {
  constructor(
    projects: ProjectsPort,
    private readonly svc: BuilderInsightService,
  ) {
    super(projects);
  }
  @RequirePermission('builder:read')
  @ContentRead('review')
  @Get('review')
  async review(@Org() orgId: string, @Param('projectId') pid: string) {
    const p = await this.project(orgId, pid);
    return this.svc.review(orgId, p);
  }
  @RequirePermission('builder:read')
  @ContentRead('symbols')
  @Get('symbols')
  async symbols(
    @Org() orgId: string,
    @Param('projectId') pid: string,
    @Query('q') q?: string,
    @Query('kind') kind?: string,
  ) {
    const p = await this.project(orgId, pid);
    return this.svc.symbols(orgId, p, q ?? '', kind);
  }
  @RequirePermission('builder:read')
  @ContentRead('imports')
  @Get('import-analysis')
  async imports(@Org() orgId: string, @Param('projectId') pid: string) {
    const p = await this.project(orgId, pid);
    return this.svc.imports(orgId, p);
  }
  @RequirePermission('builder:read')
  @ContentRead('components')
  @Get('components')
  async components(@Org() orgId: string, @Param('projectId') pid: string) {
    const p = await this.project(orgId, pid);
    return this.svc.components(orgId, p);
  }
  @RequirePermission('builder:read')
  @ContentRead('memory')
  @Get('memory')
  async memory(@Org() orgId: string, @Param('projectId') pid: string) {
    const p = await this.project(orgId, pid);
    return this.svc.memory(orgId, p);
  }
  @RequirePermission('builder:write')
  @Idempotent()
  @Post('memory')
  @HttpCode(201)
  async addMemory(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('projectId') pid: string,
    @Body() body: B,
  ) {
    return this.svc.addMemory(orgId, a.actor.userId, await this.project(orgId, pid), body ?? {});
  }
  @RequirePermission('builder:write')
  @Delete('memory/:entryId')
  async forgetMemory(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('projectId') pid: string,
    @Param('entryId') entryId: string,
  ) {
    return this.svc.forgetMemory(orgId, a.actor.userId, await this.project(orgId, pid), entryId);
  }
}
