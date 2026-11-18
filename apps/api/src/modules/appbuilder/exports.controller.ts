import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { ProjectScoped } from './internal/project-scoped';
import { ProjectsPort } from './internal/ports/m09';
import { ExportService } from './internal/export/export.service';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};

@Controller('v1/builder/projects/:projectId/exports')
export class ExportsController extends ProjectScoped {
  constructor(
    projects: ProjectsPort,
    private readonly exports: ExportService,
  ) {
    super(projects);
  }
  /** 202 `{versionId?}`. 422 `export_blocked` (secret/canary/lockfile/policy), 403 `approval_required` (vendored third-party code), 403 `residency_denied`. */
  @RequirePermission('builder:export')
  @Idempotent()
  @Post()
  @HttpCode(202)
  async create(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('projectId') pid: string,
    @Body() body: Body_,
  ) {
    return this.exports.create(orgId, a.actor.userId, await this.project(orgId, pid), b(body));
  }
  @RequirePermission('builder:export')
  @Get()
  async list(@Org() orgId: string, @Param('projectId') pid: string) {
    await this.project(orgId, pid);
    return { items: await this.exports.list(orgId, pid.toLowerCase()) };
  }
  /** Returns a freshly signed download URL (valid at most 15 minutes) for a ready export; the issue is audited (`builder.export.downloaded`). */
  @RequirePermission('builder:export')
  @Get(':exportId')
  async get(@Org() orgId: string, @Param('projectId') pid: string, @Param('exportId') id: string) {
    await this.project(orgId, pid);
    return this.exports.get(orgId, pid.toLowerCase(), id.toLowerCase());
  }
}
