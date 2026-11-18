import { Controller, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { HostingEnabledGuard } from './internal/hosting-flag.guard';
import { Org, RequirePermission } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { DATABASE_BINDING_PROVIDER, type DatabaseBindingProvider } from './internal/ports';
import { SitesService } from './internal/sites.service';

/** Database bindings (M08): `422 unsupported_capability` until a provider is enabled; never a silent no-op (docs/09 §1 rule 7). */
@UseGuards(HostingEnabledGuard)
@Controller('v1/hosting/sites')
export class SiteDatabasesController {
  constructor(
    private readonly sites: SitesService,
    @Inject(DATABASE_BINDING_PROVIDER) private readonly provider: DatabaseBindingProvider,
  ) {}

  @RequirePermission('hosting:database:manage')
  @Idempotent()
  @Post(':id/databases')
  async bind(@Org() orgId: string, @Param('id') id: string) {
    await this.sites.row(orgId, id);
    if (!this.provider.enabled())
      throw new ProblemException(
        'unsupported_capability',
        'managed databases are not available yet (M08): no database provider is enabled',
      );
    throw new ProblemException(
      'unsupported_capability',
      'binding is not implemented by the enabled provider',
    );
  }

  @RequirePermission('hosting:site:read')
  @Get(':id/databases')
  async list(@Org() orgId: string, @Param('id') id: string) {
    await this.sites.row(orgId, id);
    return { items: [], available: this.provider.enabled() };
  }
}
