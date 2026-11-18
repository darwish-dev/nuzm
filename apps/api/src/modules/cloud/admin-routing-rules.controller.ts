import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { RealmOnly } from '../identity';
import { RoutingService } from './internal/routing.service';

/** Routing rules: versioned (every change is a new immutable row) and audited (`routing.rule.changed`). */
@RealmOnly('admin')
@Controller('v1/admin/routing-rules')
export class AdminRoutingRulesController {
  constructor(private readonly routing: RoutingService) {}

  @RequirePlatformPermission('admin:provider:read')
  @Get()
  async list(@Query('history') history?: string) {
    return { items: await this.routing.list(history === 'true') };
  }

  @RequirePlatformPermission('admin:provider:manage')
  @Post()
  @HttpCode(201)
  put(@Platform() who: PlatformContext, @Body() body: unknown) {
    return this.routing.put(who.userId, body);
  }
}
