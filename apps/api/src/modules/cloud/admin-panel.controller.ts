import { Body, Controller, Delete, Get, HttpCode, Param, Put, Query } from '@nestjs/common';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { RealmOnly, StepUp } from '../identity';
import { PanelImageService } from './internal/hestia-vps/panel-images.service';
import { PanelInstallService } from './internal/hestia-vps/panel-install.service';

/** Admin: which provider images are verified for HestiaCP, and the monitor of panel installs (stuck or needing attention first). */
@RealmOnly('admin')
@Controller('v1/admin/compute')
export class AdminPanelController {
  constructor(
    private readonly images: PanelImageService,
    private readonly installs: PanelInstallService,
  ) {}

  @RequirePlatformPermission('admin:provider:read')
  @Get('panel-images')
  async listImages(@Query('accountId') accountId?: string, @Query('regionId') regionId?: string) {
    return {
      items: await this.images.list({
        ...(accountId ? { accountId } : {}),
        ...(regionId ? { regionId } : {}),
      }),
    };
  }

  /** Approves one image for the configured Hestia version. Needs a recent MFA check: it decides what customers can buy. */
  @RequirePlatformPermission('admin:provider:manage')
  @StepUp()
  @Put('panel-images/:imageId')
  @HttpCode(200)
  approve(
    @Platform() who: PlatformContext,
    @Param('imageId') imageId: string,
    @Body() body: unknown,
  ) {
    return this.images.approve(who.userId, imageId, body);
  }

  @RequirePlatformPermission('admin:provider:manage')
  @StepUp()
  @Delete('panel-image-approvals/:approvalId')
  @HttpCode(204)
  async revoke(@Platform() who: PlatformContext, @Param('approvalId') approvalId: string) {
    await this.images.revoke(who.userId, approvalId);
  }

  @RequirePlatformPermission('admin:provider:read')
  @Get('panel-installs')
  async listInstalls(@Query('stage') stage?: string, @Query('limit') limit?: string) {
    return {
      items: await this.installs.adminList({
        ...(stage ? { stage } : {}),
        ...(limit ? { limit: Number(limit) || 50 } : {}),
      }),
    };
  }
}
