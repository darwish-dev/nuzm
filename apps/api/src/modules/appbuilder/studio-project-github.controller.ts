import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { ProjectsPort } from './internal/ports/m09';
import { StudioProjectScoped } from './internal/studio/flag';
import { GitHubService } from './internal/studio/github.service';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};

/** A builder project's GitHub repository: link, status, pull, push, pull requests. */
@Controller('v1/builder/projects/:projectId/github')
export class StudioProjectGithubController extends StudioProjectScoped {
  constructor(
    projects: ProjectsPort,
    private readonly gh: GitHubService,
  ) {
    super(projects);
  }
  @RequirePermission('builder:read')
  @Get()
  async status(@Org() orgId: string, @Param('projectId') pid: string) {
    return this.gh.status(orgId, await this.project(orgId, pid));
  }
  @RequirePermission('builder:write')
  @Post('link')
  @HttpCode(200)
  async link(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('projectId') pid: string,
    @Body() body: Body_,
  ) {
    return this.gh.linkRepo(orgId, a.actor.userId, await this.project(orgId, pid), b(body));
  }
  @RequirePermission('builder:write')
  @Delete('link')
  async unlink(@Org() orgId: string, @Access() a: AccessContext, @Param('projectId') pid: string) {
    return this.gh.unlink(orgId, a.actor.userId, await this.project(orgId, pid));
  }
  @RequirePermission('builder:write')
  @Idempotent()
  @Post('pull')
  @HttpCode(200)
  async pull(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('projectId') pid: string,
    @Body() body: Body_,
  ) {
    return this.gh.pull(orgId, a.actor.userId, await this.project(orgId, pid), b(body));
  }
  @RequirePermission('builder:write')
  @Idempotent()
  @Post('push')
  @HttpCode(200)
  async push(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('projectId') pid: string,
    @Body() body: Body_,
  ) {
    return this.gh.push(orgId, a.actor.userId, await this.project(orgId, pid), b(body));
  }
  @RequirePermission('builder:read')
  @Get('pulls')
  async pulls(@Org() orgId: string, @Param('projectId') pid: string) {
    return this.gh.pullRequests(orgId, await this.project(orgId, pid));
  }
  @RequirePermission('builder:write')
  @Idempotent()
  @Post('pulls')
  async openPull(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('projectId') pid: string,
    @Body() body: Body_,
  ) {
    return this.gh.pullRequest(orgId, a.actor.userId, await this.project(orgId, pid), b(body));
  }
}
