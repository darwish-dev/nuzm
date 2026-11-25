import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Org, RequirePermission } from '../../common/access';
import { BuilderInsightService } from './internal/changes/builder-insight.service';
import { BuilderToolsEnabledGuard } from './internal/changes/builder-tools-flag';

type B = Record<string, unknown>;

/** Requirement planning (no project needed). Flag `builder_tools.enabled`, default OFF. Pure and local: the text is never sent to a model or a vendor. */
@UseGuards(BuilderToolsEnabledGuard)
@Controller('v1/builder/plan-previews')
export class BuilderPlanController {
  constructor(private readonly svc: BuilderInsightService) {}
  @RequirePermission('builder:read')
  @Post()
  @HttpCode(200)
  plan(@Org() orgId: string, @Body() body: B) {
    return this.svc.plan(orgId, body ?? {});
  }
}
