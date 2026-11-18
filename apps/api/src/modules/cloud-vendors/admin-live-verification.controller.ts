import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { RealmOnly } from '../identity';
import { LiveVerificationService } from './live-verification.service';

/**
 * UI-M05-15. READ plus RECORD only: there is no route that starts a live verification (human-triggered only, M05 §5 LV-1). The record route
 * stores a run's reported result (with the owner's gate evidence) so the console can label rows LIVE-VERIFIED / NOT VERIFIED.
 */
@RealmOnly('admin')
@Controller('v1/admin/live-verification')
export class AdminLiveVerificationController {
  constructor(private readonly lv: LiveVerificationService) {}

  @RequirePlatformPermission('admin:provider:read')
  @Get()
  list() {
    return this.lv.list();
  }

  @RequirePlatformPermission('admin:provider:manage')
  @Post('runs')
  @HttpCode(201)
  record(@Platform() who: PlatformContext, @Body() body: unknown) {
    return this.lv.record(who.userId, body);
  }
}
