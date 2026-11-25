import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { ProjectsPort } from './internal/ports/m09';
import { ClaudeCodeService } from './internal/studio/claude-code.service';
import { StudioProjectScoped } from './internal/studio/flag';
import { ContentRead } from '../builder';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};

/** Claude Code in a project sandbox — proof of concept (D-38). `ai.claude_code_sandbox` default OFF; production refuses until the compliance review. */
@Controller('v1/builder/projects/:projectId/claude-code')
export class StudioClaudeCodeController extends StudioProjectScoped {
  constructor(
    projects: ProjectsPort,
    private readonly cc: ClaudeCodeService,
  ) {
    super(projects);
  }
  @RequirePermission('builder:read')
  @ContentRead('claude_code')
  @Get()
  async status(@Org() orgId: string, @Param('projectId') pid: string) {
    return this.cc.status(orgId, await this.project(orgId, pid));
  }
  @RequirePermission('sandbox:use')
  @Post('sessions')
  @HttpCode(200)
  async start(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('projectId') pid: string,
    @Body() body: Body_,
  ) {
    return this.cc.start(orgId, a.actor.userId, await this.project(orgId, pid), b(body));
  }
  @RequirePermission('sandbox:use')
  @Delete('sessions')
  async stop(@Org() orgId: string, @Access() a: AccessContext, @Param('projectId') pid: string) {
    return this.cc.stop(orgId, a.actor.userId, await this.project(orgId, pid));
  }
}
