import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { ProjectScoped } from './internal/project-scoped';
import { ProjectsPort } from './internal/ports/m09';
import { TestRunService } from './internal/tests/test-run.service';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};

@Controller('v1/builder/projects/:projectId/test-runs')
export class TestRunsController extends ProjectScoped {
  constructor(
    projects: ProjectsPort,
    private readonly tests: TestRunService,
  ) {
    super(projects);
  }
  /** 202 `{suite: unit|typecheck|build|e2e|all, versionId?}`; the run executes in a sandbox. 422 `test_suite_unavailable`. */
  @RequirePermission('builder:test')
  @Idempotent()
  @Post()
  @HttpCode(202)
  async create(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('projectId') pid: string,
    @Body() body: Body_,
  ) {
    const project = await this.project(orgId, pid);
    const run = await this.tests.create(orgId, a.actor.userId, project, b(body));
    if (process.env.APPBUILDER_KICK !== 'off')
      setImmediate(
        () =>
          void this.tests.execute(orgId, a.actor.userId, project, run.id).catch(() => undefined),
      );
    return run;
  }
  @RequirePermission('builder:read')
  @Get()
  async list(@Org() orgId: string, @Param('projectId') pid: string) {
    await this.project(orgId, pid);
    return { items: await this.tests.list(orgId, pid.toLowerCase()) };
  }
  @RequirePermission('builder:read')
  @Get(':testRunId')
  async get(@Org() orgId: string, @Param('projectId') pid: string, @Param('testRunId') id: string) {
    await this.project(orgId, pid);
    return this.tests.get(orgId, pid.toLowerCase(), id.toLowerCase());
  }
}
