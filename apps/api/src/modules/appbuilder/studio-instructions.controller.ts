import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { parseIfMatch } from '../../common/etag';
import { ProblemException } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { ProjectsPort } from './internal/ports/m09';
import { StudioProjectScoped } from './internal/studio/flag';
import { InstructionsService } from './internal/studio/instructions.service';
import { ContentRead } from '../builder';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};

/** Project instructions (`CLAUDE.md`) of a builder project (ADR-064 point 3). Behind `ai_studio.enabled`. */
@Controller('v1/builder/projects/:projectId/instructions')
export class StudioInstructionsController extends StudioProjectScoped {
  constructor(
    projects: ProjectsPort,
    private readonly svc: InstructionsService,
  ) {
    super(projects);
  }
  @RequirePermission('builder:read')
  @ContentRead('instructions')
  @Get()
  async get(@Org() orgId: string, @Param('projectId') pid: string) {
    return this.svc.get(orgId, await this.project(orgId, pid));
  }
  /** `If-Match: "<version>"` (0 before the first save). 412 etag_mismatch when someone saved in between. */
  @RequirePermission('builder:write')
  @Put()
  async put(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('projectId') pid: string,
    @Body() body: Body_,
    @Headers('if-match') ifMatch: string | undefined,
  ) {
    return this.svc.put(
      orgId,
      a.actor.userId,
      await this.project(orgId, pid),
      b(body),
      parseIfMatch(ifMatch),
    );
  }
  @RequirePermission('builder:read')
  @ContentRead('instructions')
  @Get('versions')
  async versions(@Org() orgId: string, @Param('projectId') pid: string) {
    return this.svc.versions(orgId, await this.project(orgId, pid));
  }
  @RequirePermission('builder:write')
  @Post('versions/:version/restore')
  @HttpCode(200)
  async restore(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('projectId') pid: string,
    @Param('version') v: string,
  ) {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 1)
      throw new ProblemException('not_found', 'instruction version not found');
    return this.svc.restore(orgId, a.actor.userId, await this.project(orgId, pid), n);
  }
  /** Writes `CLAUDE.md` into the project's files (a normal versioned change). 422 for a website project. */
  @RequirePermission('builder:write')
  @Idempotent()
  @Post('sync')
  @HttpCode(200)
  async sync(@Org() orgId: string, @Access() a: AccessContext, @Param('projectId') pid: string) {
    return this.svc.sync(orgId, a.actor.userId, await this.project(orgId, pid));
  }
}
