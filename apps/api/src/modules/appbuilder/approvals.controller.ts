import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { ApprovalService, type ApprovalDto } from './internal/approvals/approval.service';
import { AppBuilderEnabledGuard } from './internal/flag.guard';

type Body_ = Record<string, unknown> | undefined;

/** PROPOSED ADDITION PA-M10-02 (needs the owner's approval): the approvals inbox (UI-M10-07) and a decision route for approvals that belong to a deployment, an export or a release rather than to a run. */
@UseGuards(AppBuilderEnabledGuard)
@Controller('v1/ai/approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalService) {}
  @RequirePermission('ai:read')
  @Get()
  async list(
    @Org() orgId: string,
    @Query('status') status?: string,
    @Query('subjectType') subjectType?: string,
  ) {
    return {
      items: (await this.approvals.list(orgId, {
        ...(status ? { status } : {}),
        ...(subjectType ? { subjectType } : {}),
      })) satisfies ApprovalDto[],
    };
  }
  @RequirePermission('ai:read')
  @Get(':approvalId')
  async get(@Org() orgId: string, @Param('approvalId') id: string) {
    return this.approvals.get(orgId, id.toLowerCase());
  }
  @RequirePermission('ai:approve')
  @Idempotent()
  @Post(':approvalId/decisions')
  @HttpCode(200)
  async decide(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('approvalId') id: string,
    @Body() body: Body_,
  ) {
    return this.approvals.decide(
      orgId,
      { userId: a.actor.userId, role: a.role, permissions: a.permissions },
      id.toLowerCase(),
      (body ?? {}) as never,
    );
  }
}
