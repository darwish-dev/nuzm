import {
  Body,
  Controller,
  Get,
  HttpCode,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Org, RequirePermission, Access, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { KnowledgeGenerationGuard } from '../knowledge';
import { AppBuilderEnabledGuard } from './internal/flag.guard';
import { GenerationService } from './internal/studio/generation';

/**
 * Adapting a copied template (S-K6, SCR-K-09): the workspace compared with its template copy, the context preview (exactly what a model would receive) and the run that adapts the copy.
 * Tenant realm; 404 while `knowledge.generation` is off for the organization (default off); starting a run also needs `app_builder.enabled` and the AI permission, and is audited.
 */
@UseGuards(KnowledgeGenerationGuard)
@Controller('v1/builder')
export class GenerationController {
  constructor(private readonly gen: GenerationService) {}

  @RequirePermission('builder:read')
  @Get('projects/:id/template-workspace')
  workspace(@Org() orgId: string, @Param('id') id: string) {
    return this.gen.workspace(orgId, id);
  }

  @RequirePermission('builder:read')
  @Get('generation-plans/:id/context')
  context(@Org() orgId: string, @Param('id') id: string, @Query('budget') budget?: string) {
    const n = budget === undefined ? undefined : Number(budget);
    return this.gen.context(orgId, id, n !== undefined && Number.isInteger(n) ? n : undefined);
  }

  @UseGuards(AppBuilderEnabledGuard)
  @RequirePermission('ai:write')
  @Idempotent()
  @Post('generation-plans/:id/runs')
  @HttpCode(201)
  start(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    const b =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as { budget?: unknown })
        : {};
    return this.gen.start(orgId, a.actor.userId, id, key, b);
  }
}
