import { Controller, Delete, HttpCode, OnModuleDestroy, Param, Post } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { ProjectScoped } from './internal/project-scoped';
import { ProjectsPort } from './internal/ports/m09';
import { WebappLivePreviewService } from './internal/preview/live-preview.service';
import { LivePreviewRegistry } from '../builder';

/** Live preview of a web-app project (ADR-063; flag `app_builder.live_preview`). The running application is served on the isolated preview origin, never here. */
@Controller('v1/builder/projects/:projectId/live-preview')
export class LivePreviewController extends ProjectScoped implements OnModuleDestroy {
  constructor(
    projects: ProjectsPort,
    private readonly previews: WebappLivePreviewService,
    private readonly registry: LivePreviewRegistry,
  ) {
    super(projects);
  }
  @RequirePermission('builder:write')
  @Post()
  @HttpCode(201)
  async start(@Org() orgId: string, @Access() a: AccessContext, @Param('projectId') pid: string) {
    return this.previews.start(orgId, a.actor.userId, (await this.project(orgId, pid)).id);
  }
  @RequirePermission('builder:write')
  @Delete()
  @HttpCode(204)
  async stop(@Org() orgId: string, @Param('projectId') pid: string) {
    this.previews.stop(orgId, (await this.project(orgId, pid)).id);
  }
  /** previews die with the API process */
  onModuleDestroy() {
    this.registry.stopAll();
  }
}
