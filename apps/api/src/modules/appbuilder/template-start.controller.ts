import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { CustomerTemplateService, KnowledgeCustomerTemplatesGuard } from '../knowledge';
import { AppBuilderEnabledGuard } from './internal/flag.guard';
import { GenerationService } from './internal/studio/generation';
import { TemplateStartService } from './internal/studio/template-start';
import { ContentRead } from '../builder';

const body = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};

/**
 * Starting from a template and recording a generation plan (S-K7, SCR-K-01 §1): tenant realm, `builder:write`, `Idempotency-Key`, 404 while `app_builder.enabled` or
 * `knowledge.customer_templates` is off for the organization. Executing a plan is the run engine's job with a model (S-K6) and is not offered here.
 */
@UseGuards(AppBuilderEnabledGuard, KnowledgeCustomerTemplatesGuard)
@Controller('v1/builder')
export class TemplateStartController {
  constructor(
    private readonly start: TemplateStartService,
    private readonly templates: CustomerTemplateService,
    private readonly gen: GenerationService,
  ) {}

  @RequirePermission('builder:write')
  @Idempotent()
  @Post('projects/from-template')
  @HttpCode(201)
  fromTemplate(@Org() orgId: string, @Access() a: AccessContext, @Body() b: unknown) {
    return this.start.start(orgId, a.actor.userId, body(b));
  }

  @RequirePermission('builder:write')
  @Idempotent()
  @Post('generation-plans')
  @HttpCode(201)
  async createPlan(@Org() orgId: string, @Access() a: AccessContext, @Body() b: unknown) {
    const plan = await this.start.plan(orgId, a.actor.userId, body(b));
    return this.gen.plan(orgId, plan.id);
  }

  @RequirePermission('builder:read')
  @ContentRead('generation_plan', null)
  @Get('generation-plans/:id')
  getPlan(@Org() orgId: string, @Param('id') id: string) {
    return this.gen.plan(orgId, id);
  }
}
