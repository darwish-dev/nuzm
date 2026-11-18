import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { ProjectScoped } from './internal/project-scoped';
import { ProjectsPort } from './internal/ports/m09';
import { ChangeService } from './internal/changes/change.service';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};

/** `POST …/changes`: the M10 (web-app / mobile) half of the safe-diff endpoint. M09 owns the path and dispatches website projects to its editor operations. */
@Controller('v1/builder/projects/:projectId/changes')
export class ChangesController extends ProjectScoped {
  constructor(
    projects: ProjectsPort,
    private readonly changes: ChangeService,
  ) {
    super(projects);
  }
  /** `{baseVersion, patches[{op,path,content?,from?,expectedHash?}], source?, message?}` -> `{versionId, commit, branch, diff, risks}`. 409 `base_mismatch`, 422 `change_rejected` / `dependency_blocked`. */
  @RequirePermission('builder:write')
  @Idempotent()
  @Post()
  @HttpCode(201)
  async apply(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('projectId') pid: string,
    @Body() body: Body_,
  ) {
    return this.changes.apply(orgId, a.actor.userId, await this.project(orgId, pid), b(body));
  }
}
