import {
  Global,
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { VaultClient } from '@nuzm/adapter-contracts';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { AdminProviderAccountsController } from './admin-provider-accounts.controller';
import { AdminProviderJobsController } from './admin-provider-jobs.controller';
import { AdminProvidersController } from './admin-providers.controller';
import { AdapterRegistry, defaultAdapterRegistry, vaultFromEnv } from './internal/adapter-registry';
import { ProviderAccountService } from './internal/account.service';
import { CatalogService } from './internal/catalog.service';
import { HealthService } from './internal/health.service';
import { ProviderService } from './internal/provider.service';

export const VAULT = 'NUZM_VAULT_CLIENT';

/** Runs the account health sweep every CLOUD_HEALTH_INTERVAL_SECONDS (default 0 = off; otherwise >= 5). */
class CloudScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly health: HealthService) {}
  onApplicationBootstrap() {
    const s = Number(process.env.CLOUD_HEALTH_INTERVAL_SECONDS ?? 0);
    if (!(s >= 5)) return;
    this.timer = setInterval(
      () =>
        void this.health
          .sweep()
          .catch((e) =>
            console.error(JSON.stringify({ cloud_health_error: (e as Error).message })),
          ),
      s * 1000,
    );
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}

/**
 * Cloud / provider framework (M05): provider registry, provider accounts (vault references only), capability matrix, verified regions,
 * plans, catalog syncs, health. Provider adapters are reached only through `AdapterRegistry`. Later milestones (M06 hosting, M07 domains,
 * M08 data) register their adapters there and read verified regions/capabilities through this module's public index.
 */
@Global()
@Module({
  controllers: [
    AdminProvidersController,
    AdminProviderAccountsController,
    AdminProviderJobsController,
  ],
  providers: [
    { provide: AdapterRegistry, useFactory: () => defaultAdapterRegistry() },
    {
      provide: VAULT,
      useFactory: (r: AdapterRegistry) => vaultFromEnv(r.redactor),
      inject: [AdapterRegistry],
    },
    {
      provide: ProviderService,
      useFactory: (db: Db, a: AuditSink, r: AdapterRegistry) => new ProviderService(db, a, r),
      inject: [DB, AuditSink, AdapterRegistry],
    },
    {
      provide: ProviderAccountService,
      useFactory: (db: Db, a: AuditSink, r: AdapterRegistry) =>
        new ProviderAccountService(db, a, r),
      inject: [DB, AuditSink, AdapterRegistry],
    },
    {
      provide: CatalogService,
      useFactory: (db: Db, a: AuditSink, r: AdapterRegistry, v: VaultClient) =>
        new CatalogService(db, a, r, v),
      inject: [DB, AuditSink, AdapterRegistry, VAULT],
    },
    {
      provide: HealthService,
      useFactory: (db: Db, a: AuditSink, r: AdapterRegistry) => new HealthService(db, a, r),
      inject: [DB, AuditSink, AdapterRegistry],
    },
    {
      provide: CloudScheduler,
      useFactory: (h: HealthService) => new CloudScheduler(h),
      inject: [HealthService],
    },
  ],
  exports: [
    AdapterRegistry,
    ProviderService,
    ProviderAccountService,
    CatalogService,
    HealthService,
    VAULT,
  ],
})
export class CloudModule {
  constructor(@Inject(CloudScheduler) _s: CloudScheduler) {} // instantiate the scheduler so its lifecycle hooks run
}
