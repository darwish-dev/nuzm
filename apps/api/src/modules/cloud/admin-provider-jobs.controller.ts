import { Controller, Get, Param } from '@nestjs/common';
import { RequirePlatformPermission } from '../../common/access';
import { RealmOnly } from '../identity';
import { ProviderAccountService } from './internal/account.service';

/** Status of a platform provider job (the `operationId` returned by verification and catalog-sync requests). */
@RealmOnly('admin')
@Controller('v1/admin/provider-jobs')
export class AdminProviderJobsController {
  constructor(private readonly accounts: ProviderAccountService) {}

  @RequirePlatformPermission('admin:provider:read')
  @Get(':id')
  get(@Param('id') id: string) {
    return this.accounts.getJob(id);
  }
}
