import { Body, Controller, Delete, Get, HttpCode, Param, Put } from '@nestjs/common';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { RealmOnly } from '../identity';
import { NetworkSettingsService } from './network-settings.service';

/** Provisioning network details (vSwitch, VPC, subnet, security group, project id) per provider and region. Identifiers only: never credentials. Audited. */
@RealmOnly('admin')
@Controller('v1/admin/provider-network')
export class AdminProviderNetworkController {
  constructor(private readonly network: NetworkSettingsService) {}

  @RequirePlatformPermission('admin:provider:read')
  @Get()
  async list() {
    return { items: await this.network.list() };
  }

  @RequirePlatformPermission('admin:provider:manage')
  @Put(':providerKey/:regionId')
  save(
    @Platform() who: PlatformContext,
    @Param('providerKey') providerKey: string,
    @Param('regionId') regionId: string,
    @Body() body: unknown,
  ) {
    return this.network.save(who.userId, providerKey, regionId, body);
  }

  @RequirePlatformPermission('admin:provider:manage')
  @Delete(':providerKey/:regionId')
  @HttpCode(204)
  async remove(
    @Platform() who: PlatformContext,
    @Param('providerKey') providerKey: string,
    @Param('regionId') regionId: string,
  ) {
    await this.network.remove(who.userId, providerKey, regionId);
  }
}
