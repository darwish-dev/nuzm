import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { ProjectScoped } from './internal/project-scoped';
import { ProjectsPort } from './internal/ports/m09';
import { SandboxService } from './internal/sandbox/sandbox.service';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};

/** Sandboxes of a project (docs/04 §2.9; M10 §6). The terminal WebSocket and the ticket route are NOT exposed (PA-M10-01 needs the owner's approval; the services exist). */
@Controller('v1/builder/projects/:projectId/sandboxes')
export class SandboxesController extends ProjectScoped {
  constructor(
    projects: ProjectsPort,
    private readonly sandboxes: SandboxService,
  ) {
    super(projects);
  }

  /** 202 `{profile, ttlMinutes}` -> the sandbox (ready once its runtime started). 409 `sandbox_quota_exceeded`, 402 `budget_required`, 503 `sandbox_no_capacity`, 403 `residency_denied`. */
  @RequirePermission('sandbox:use')
  @Idempotent()
  @Post()
  @HttpCode(202)
  async create(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('projectId') pid: string,
    @Body() body: Body_,
  ) {
    return this.sandboxes.create(orgId, a.actor.userId, await this.project(orgId, pid), b(body));
  }
  @RequirePermission('sandbox:use')
  @Get()
  async list(@Org() orgId: string, @Param('projectId') pid: string) {
    await this.project(orgId, pid);
    return { items: await this.sandboxes.list(orgId, pid.toLowerCase()) };
  }
  @RequirePermission('sandbox:use')
  @Get(':sid')
  async get(@Org() orgId: string, @Param('projectId') pid: string, @Param('sid') sid: string) {
    await this.project(orgId, pid);
    return this.sandboxes.get(orgId, pid.toLowerCase(), sid.toLowerCase());
  }
  @RequirePermission('sandbox:use')
  @Delete(':sid')
  @HttpCode(202)
  async remove(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('projectId') pid: string,
    @Param('sid') sid: string,
  ) {
    await this.project(orgId, pid);
    return this.sandboxes.terminate(orgId, a.actor.userId, pid.toLowerCase(), sid.toLowerCase());
  }
}
