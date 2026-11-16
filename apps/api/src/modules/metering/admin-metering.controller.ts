import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { RealmOnly } from '../identity';
import { MeterService } from './internal/meter.service';

/** Meter catalogue admin (docs/04: GET/POST /v1/admin/meters). */
@RealmOnly('admin')
@Controller('v1/admin/meters')
export class AdminMeteringController {
  constructor(private readonly meters: MeterService) {}

  @RequirePlatformPermission('admin:billing:read')
  @Get()
  list() {
    return this.meters.list();
  }

  @RequirePlatformPermission('admin:meters:manage')
  @Post()
  @HttpCode(201)
  create(@Platform() who: PlatformContext, @Body() body: Record<string, unknown> | undefined) {
    return this.meters.create(body ?? {}, who.userId);
  }
}
