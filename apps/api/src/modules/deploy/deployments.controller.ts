import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { parseLimit } from '../../common/pagination';
import { AiEnabledGuard } from '../ai';
import { DeployService } from './internal/deploy.service';

/** `POST/GET /v1/deployments`, `GET …/{id}`, `GET …/{id}/logs`, `POST …/{id}/rollback` (docs/04 §2.9: the single publish endpoint for websites). Gated by the `ai.enabled` flag. */
@UseGuards(AiEnabledGuard)
@Controller('v1/deployments')
export class DeploymentsController {
  constructor(private readonly deploys: DeployService) {}

  /**
   * Body {projectId, target: hostingSiteId, environment, approvalId?}. First call: 403 `approval_required` + `approvalId` and the cost disclosure; repeat with the approvalId
   * (a NEW Idempotency-Key) to confirm as a human with a write role. 202 + deployment. 422 `unsupported_capability` when no publish path exists.
   */
  @RequirePermission('deploy:write')
  @Idempotent()
  @Post()
  @HttpCode(202)
  create(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Record<string, unknown> | undefined,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!key)
      throw new ProblemException('idempotency_key_required', 'send an Idempotency-Key header');
    return this.deploys.create(orgId, a.actor.userId, key, body ?? {});
  }
  @RequirePermission('deploy:read')
  @Get()
  list(@Org() orgId: string, @Query() q: { limit?: string; cursor?: string; projectId?: string }) {
    return this.deploys.list(orgId, {
      limit: parseLimit(q.limit),
      cursor: q.cursor,
      ...(q.projectId ? { projectId: q.projectId.toLowerCase() } : {}),
    });
  }
  @RequirePermission('deploy:read')
  @Get(':id')
  get(@Org() orgId: string, @Param('id') id: string) {
    return this.deploys.get(orgId, id.toLowerCase());
  }
  @RequirePermission('deploy:read')
  @Get(':id/logs')
  logs(@Org() orgId: string, @Param('id') id: string, @Query() q: { after?: string }) {
    return this.deploys.logs(orgId, id.toLowerCase(), Number(q.after ?? 0) || 0);
  }
  @RequirePermission('deploy:write')
  @Idempotent()
  @Post(':id/rollback')
  @HttpCode(202)
  rollback(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!key)
      throw new ProblemException('idempotency_key_required', 'send an Idempotency-Key header');
    return this.deploys.rollback(orgId, a.actor.userId, id.toLowerCase(), key);
  }
  /** Cancel a queued or running deployment (202; a running one stops at its next checkpoint, before the switch). 409 `invalid_state` once finished. */
  @RequirePermission('deploy:write')
  @Idempotent()
  @Post(':id/cancel')
  @HttpCode(202)
  cancel(@Org() orgId: string, @Access() a: AccessContext, @Param('id') id: string) {
    return this.deploys.cancel(orgId, a.actor.userId, id.toLowerCase());
  }
}
