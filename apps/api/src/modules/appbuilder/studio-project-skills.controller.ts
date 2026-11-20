import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { isUuid } from './internal/core';
import { ProjectsPort } from './internal/ports/m09';
import { StudioProjectScoped } from './internal/studio/flag';
import { SkillsService } from './internal/studio/skills.service';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};
const id = (x: string) => {
  if (!isUuid(x)) throw new ProblemException('not_found', 'not found');
  return x.toLowerCase();
};

/** Skills of a builder project (ADR-064 point 2): what is installed, what fits, install/uninstall. */
@Controller('v1/builder/projects/:projectId/skills')
export class StudioProjectSkillsController extends StudioProjectScoped {
  constructor(
    projects: ProjectsPort,
    private readonly svc: SkillsService,
  ) {
    super(projects);
  }
  @RequirePermission('builder:read')
  @Get()
  async installed(@Org() orgId: string, @Param('projectId') pid: string) {
    return this.svc.installed(orgId, await this.project(orgId, pid));
  }
  @RequirePermission('builder:read')
  @Get('recommendations')
  async recommend(
    @Org() orgId: string,
    @Param('projectId') pid: string,
    @Query('industry') industry?: string,
    @Query('requested') requested?: string,
  ) {
    const req = (requested ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 30);
    return this.svc.recommend(orgId, await this.project(orgId, pid), req, industry || undefined);
  }
  /** `{skills: [slug…]}` or `{auto: true, industry?}`; dependencies are added; `overwrite` replaces skill files the customer changed. */
  @RequirePermission('builder:write')
  @Idempotent()
  @Post()
  @HttpCode(200)
  async install(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('projectId') pid: string,
    @Body() body: Body_,
  ) {
    return this.svc.install(orgId, a.actor.userId, await this.project(orgId, pid), b(body));
  }
  @RequirePermission('builder:write')
  @Delete(':skillId')
  async uninstall(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('projectId') pid: string,
    @Param('skillId') sid: string,
    @Query('overwrite') overwrite?: string,
  ) {
    return this.svc.uninstall(
      orgId,
      a.actor.userId,
      await this.project(orgId, pid),
      id(sid),
      overwrite === 'true',
    );
  }
}
