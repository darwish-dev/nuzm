import { Body, Controller, Delete, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { StudioEnabledGuard } from './internal/studio/flag';
import { GitHubService } from './internal/studio/github.service';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};

/** The organization's GitHub connection (D-39). */
@UseGuards(StudioEnabledGuard)
@Controller('v1/builder/github')
export class StudioGithubConnectionController {
  constructor(private readonly gh: GitHubService) {}
  @RequirePermission('builder:read')
  @Get()
  get(@Org() orgId: string, @Access() a: AccessContext) {
    return this.gh.connection(orgId, a.actor.userId);
  }
  /** The installation callback: `{installationId, state}` (state was issued with the install URL to this user in this organization). */
  @RequirePermission('builder:write')
  @Post('connect')
  @HttpCode(200)
  connect(@Org() orgId: string, @Access() a: AccessContext, @Body() body: Body_) {
    return this.gh.connect(orgId, a.actor.userId, b(body));
  }
  @RequirePermission('builder:write')
  @Delete()
  disconnect(@Org() orgId: string, @Access() a: AccessContext) {
    return this.gh.disconnect(orgId, a.actor.userId);
  }
  @RequirePermission('builder:read')
  @Get('repositories')
  repos(@Org() orgId: string) {
    return this.gh.repositories(orgId);
  }
}
