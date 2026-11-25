import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { KnowledgeCustomerTemplatesGuard } from './internal/flag';
import { CustomerTemplateService } from './internal/customer-templates.service';
import type { Row } from './internal/model';

const body = (x: unknown): Row =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Row) : {};

/**
 * The template gallery for customers (S-K7, SCR-K-01 §1, SCR-K-08): the published templates of the platform library, one template, and the recommendation engine answered for a
 * customer. Tenant realm, `builder:read`, 404 while `knowledge.customer_templates` is off. A customer receives metadata, compatibility facts, a design summary and capability names:
 * never file contents, paths, object keys or anything about a resource it may not see.
 */
@UseGuards(KnowledgeCustomerTemplatesGuard)
@Controller('v1/builder')
export class CustomerTemplatesController {
  constructor(private readonly templates: CustomerTemplateService) {}

  @RequirePermission('builder:read')
  @Get('templates')
  list(
    @Org() orgId: string,
    @Query('q') q?: string,
    @Query('type') type?: string,
    @Query('platform') platform?: string,
    @Query('framework') framework?: string,
    @Query('category') category?: string,
    @Query('tag') tag?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.templates.list(
      orgId,
      { q, type, platform, framework, category, tag },
      limit,
      cursor,
    );
  }

  @RequirePermission('builder:read')
  @Get('templates/:id')
  get(@Org() orgId: string, @Param('id') id: string) {
    return this.templates.get(orgId, id);
  }

  /** A computation: it ranks and explains; what is written is the customer's own usage event for the top results and an audit record of the decision and its reasons. */
  @RequirePermission('builder:read')
  @Post('template-recommendations')
  @HttpCode(200)
  recommend(@Org() orgId: string, @Access() a: AccessContext, @Body() b: unknown) {
    return this.templates.recommend(orgId, body(b), a.actor.userId);
  }
}
