import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { RealmOnly } from '../identity';
import { ProviderService } from './internal/provider.service';

/** Provider registry (docs/04 §2.5): which providers exist, their adapter, whether an adapter implementation is available in this deployment. */
@RealmOnly('admin')
@Controller('v1/admin/providers')
export class AdminProvidersController {
  constructor(private readonly providers: ProviderService) {}

  @RequirePlatformPermission('admin:provider:read')
  @Get()
  async list() {
    return { items: await this.providers.list() };
  }

  @RequirePlatformPermission('admin:provider:manage')
  @Post()
  @HttpCode(201)
  create(@Platform() who: PlatformContext, @Body() body: unknown) {
    return this.providers.create(who.userId, body);
  }

  @RequirePlatformPermission('admin:provider:read')
  @Get(':id')
  get(@Param('id') id: string) {
    return this.providers.get(id);
  }
}
