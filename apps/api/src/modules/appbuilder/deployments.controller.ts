import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { AppDeploymentService } from './internal/deploy/deployment.service';
import { AppBuilderEnabledGuard } from './internal/flag.guard';
import { isUuid } from './internal/core';
import { ProjectsPort } from './internal/ports/m09';

type Body_ = Record<string, unknown> | undefined;

/**
 * `/v1/deployments` for WEB-APP projects (docs/04 §2.9). M09 owns the path and the website half; when it lands it dispatches by project type and calls `AppDeploymentService`.
 * 403 `approval_required` carries the approvals to decide; 409 `health_gate_failed` is the end state `failed` with `failureCode` (the previous release was restored).
 */
@UseGuards(AppBuilderEnabledGuard)
@Controller('v1/deployments')
export class DeploymentsController {
  constructor(
    private readonly projects: ProjectsPort,
    private readonly deployments: AppDeploymentService,
  ) {}

  /** `{projectId, versionId?, target: {type: site|instance, id}, env}` -> 202. */
  @RequirePermission('deploy:create')
  @Idempotent()
  @Post()
  @HttpCode(202)
  async create(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Body_,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const x = body ?? {};
    if (!isUuid(x.projectId))
      throw new ProblemException('validation_failed', 'projectId is required');
    const project = await this.projects.get(orgId, x.projectId.toLowerCase());
    if (!project) throw new ProblemException('not_found', 'project not found');
    const r = await this.deployments.create(orgId, a.actor.userId, project, x);
    void reply.status(r.created ? 202 : 200);
    if (r.created && process.env.APPBUILDER_KICK !== 'off')
      setImmediate(
        () =>
          void this.deployments
            .execute(orgId, a.actor.userId, project, r.deployment.id)
            .catch(() => undefined),
      );
    return r.deployment;
  }
  @RequirePermission('deploy:read')
  @Get()
  async list(@Org() orgId: string, @Query('projectId') projectId?: string) {
    return {
      items: await this.deployments.list(
        orgId,
        projectId && isUuid(projectId) ? { projectId: projectId.toLowerCase() } : {},
      ),
    };
  }
  @RequirePermission('deploy:read')
  @Get(':id')
  async get(@Org() orgId: string, @Param('id') id: string) {
    return this.deployments.get(orgId, id.toLowerCase());
  }
  @RequirePermission('deploy:read')
  @Get(':id/logs')
  async logs(@Org() orgId: string, @Param('id') id: string) {
    return { items: await this.deployments.logs(orgId, id.toLowerCase()) };
  }
  /** Idempotent: a repeated rollback returns the same rollback record. */
  @RequirePermission('deploy:rollback')
  @Idempotent()
  @Post(':id/rollback')
  @HttpCode(202)
  async rollback(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const dep = await this.deployments.get(orgId, id.toLowerCase());
    const project = await this.projects.get(orgId, dep.projectId);
    if (!project) throw new ProblemException('not_found', 'project not found');
    const r = await this.deployments.rollback(orgId, a.actor.userId, project, dep.id);
    void reply.status(r.replayed ? 200 : 202);
    return r.deployment;
  }
}
