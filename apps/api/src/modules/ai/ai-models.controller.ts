import { Body, Controller, Get, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { etag, parseIfMatch } from '../../common/etag';
import { AiEnabledGuard } from './internal/ai-enabled.guard';
import { BudgetService } from './internal/budget.service';
import { GatewayService } from './internal/gateway.service';

/** `GET /v1/ai/models` (filtered by the organization's residency policy), `GET /v1/ai/credits`, `GET|PUT /v1/ai/budgets` (docs/04 §2.9). */
@UseGuards(AiEnabledGuard)
@Controller('v1/ai')
export class AiModelsController {
  constructor(
    private readonly gateway: GatewayService,
    private readonly budgets: BudgetService,
  ) {}

  @RequirePermission('ai:read')
  @Get('models')
  models(@Org() orgId: string) {
    return this.gateway.models(orgId);
  }

  @RequirePermission('ai:read')
  @Get('credits')
  credits(@Org() orgId: string) {
    return this.budgets.credits(orgId);
  }

  @RequirePermission('ai:read')
  @Get('budgets')
  async getBudgets(@Org() orgId: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const b = await this.budgets.getBudgets(orgId);
    void reply.header('etag', etag(b.version));
    return b;
  }

  /** Replaces the organization budget and the listed project budgets. Needs `If-Match` (the ETag of the last read). Enabling `autoApplyLowRisk` also needs `ai:write`. */
  @RequirePermission('ai:budgets:write')
  @Put('budgets')
  async putBudgets(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const m = parseIfMatch(req.headers['if-match']);
    if (m === null)
      throw new ProblemException('precondition_required', 'send the current ETag in If-Match');
    const b = body ?? {};
    if (
      (b.org as { autoApplyLowRisk?: unknown } | undefined)?.autoApplyLowRisk === true &&
      !a.permissions.has('ai:write')
    )
      throw new ProblemException(
        'forbidden',
        'enabling auto-apply needs a role that may write AI work (owner, admin, developer)',
      );
    const r = await this.budgets.putBudgets(orgId, a.actor.userId, m, b);
    void reply.header('etag', etag(r.version));
    return r;
  }
}
