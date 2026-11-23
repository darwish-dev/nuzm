import {
  Global,
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { VaultClient } from '@nuzm/adapter-contracts';
import { OperationsService, type Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { SealedVault, ChainedVault } from '../../common/sealed-vault';
import { SecretStore } from '../../common/secrets';
import { DB } from '../../common/tokens';
import { PriceBookService, QuotaService, SpendService } from '../billing';
import { OrderService, QuotePricerRegistry } from '../commerce';
import { MockRegionRegistry, ResidencyService } from '../compliance';
import { IdentityModule } from '../identity';
import { AdminOffersController } from './admin-offers.controller';
import { AdminResourcesController } from './admin-resources.controller';
import { AdminProviderAccountsController } from './admin-provider-accounts.controller';
import { AdminProviderJobsController } from './admin-provider-jobs.controller';
import { AdminProvidersController } from './admin-providers.controller';
import { AdminRoutingRulesController } from './admin-routing-rules.controller';
import { CloudWebhooksController } from './cloud-webhooks.controller';
import { ComputeInstancesController } from './compute-instances.controller';
import { OffersController } from './offers.controller';
import { PublicComputePlansController } from './public-compute-plans.controller';
import { AdapterRegistry, defaultAdapterRegistry, vaultFromEnv } from './internal/adapter-registry';
import { ProviderAccountService } from './internal/account.service';
import { AdminResourceService } from './internal/admin-resource.service';
import { CatalogService } from './internal/catalog.service';
import { ComputeQuotePricer } from './internal/compute-pricer';
import { CloudFlags } from './internal/flags';
import { HealthService } from './internal/health.service';
import { ImageCatalog } from './internal/images';
import { InstanceService } from './internal/instance.service';
import { ComputeMeteringSampler } from './internal/metering-sampler';
import { PriceBookComposer, type OfferPriceComposer } from './internal/offer-price';
import { OfferService } from './internal/offer.service';
import { ProvisioningService } from './internal/provisioning.service';
import { ProviderService } from './internal/provider.service';
import { ComputeQuotaGuard } from './internal/quota-guard';
import { ReconcilerService } from './internal/reconciler.service';
import { RoutingService } from './internal/routing.service';
import { ProviderRegionRegistry } from './internal/provider-region-registry';

export const VAULT = 'NUZM_VAULT_CLIENT';
export const OFFER_PRICE_COMPOSER = 'NUZM_OFFER_PRICE_COMPOSER';

const every = (
  envName: string,
  fn: () => Promise<unknown>,
  label: string,
): NodeJS.Timeout | null => {
  const s = Number(process.env[envName] ?? 0);
  if (!(s >= 5)) return null;
  const t = setInterval(
    () => void fn().catch((e) => console.error(JSON.stringify({ [label]: (e as Error).message }))),
    s * 1000,
  );
  t.unref();
  return t;
};

/**
 * Scheduled jobs (all OFF unless their interval env var is >= 5 seconds): account health, the reconciler sweep (also runs due backoff retries) and
 * the hourly compute metering sampler.
 */
class CloudScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private timers: (NodeJS.Timeout | null)[] = [];
  constructor(
    private readonly health: HealthService,
    private readonly reconciler: ReconcilerService,
    private readonly sampler: ComputeMeteringSampler,
  ) {}
  onApplicationBootstrap() {
    this.timers = [
      every('CLOUD_HEALTH_INTERVAL_SECONDS', () => this.health.sweep(), 'cloud_health_error'),
      every(
        'CLOUD_RECONCILE_INTERVAL_SECONDS',
        () => this.reconciler.sweep(),
        'cloud_reconcile_error',
      ),
      every('CLOUD_METERING_INTERVAL_SECONDS', () => this.sampler.run(), 'cloud_metering_error'),
    ];
  }
  onModuleDestroy() {
    for (const t of this.timers) if (t) clearInterval(t);
  }
}

/**
 * Cloud / provider framework and compute (M05): provider registry, accounts (vault references only), capability matrix, verified regions, plans,
 * offers (only verified inventory), routing, compute quotes, durable provisioning, reconciler, compute API. Provider adapters are reached only through
 * `AdapterRegistry`. Later milestones (M06 hosting, M07 domains, M08 data) register their adapters there and use the offers/routing/reconciler services.
 */
@Global()
@Module({
  imports: [IdentityModule],
  controllers: [
    AdminProvidersController,
    AdminProviderAccountsController,
    AdminProviderJobsController,
    AdminRoutingRulesController,
    AdminResourcesController,
    AdminOffersController,
    OffersController,
    PublicComputePlansController,
    ComputeInstancesController,
    CloudWebhooksController,
  ],
  providers: [
    { provide: AdapterRegistry, useFactory: () => defaultAdapterRegistry() },
    {
      provide: VAULT,
      // typed credentials (sealed store, dev profile) first, then the optional dev vault file (NUZM_DEV_VAULT_FILE)
      useFactory: (r: AdapterRegistry, s: SecretStore) =>
        new ChainedVault([new SealedVault(s, r.redactor), vaultFromEnv(r.redactor)]),
      inject: [AdapterRegistry, SecretStore],
    },
    {
      provide: ProviderService,
      useFactory: (db: Db, a: AuditSink, r: AdapterRegistry) => new ProviderService(db, a, r),
      inject: [DB, AuditSink, AdapterRegistry],
    },
    {
      provide: ProviderAccountService,
      useFactory: (db: Db, a: AuditSink, r: AdapterRegistry, s: SecretStore) =>
        new ProviderAccountService(db, a, r, new SealedVault(s, r.redactor)),
      inject: [DB, AuditSink, AdapterRegistry, SecretStore],
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
    { provide: CloudFlags, useFactory: (db: Db) => new CloudFlags(db), inject: [DB] },
    { provide: ComputeQuotaGuard, useFactory: (db: Db) => new ComputeQuotaGuard(db), inject: [DB] },
    {
      provide: OFFER_PRICE_COMPOSER,
      useFactory: (db: Db, p: PriceBookService) => new PriceBookComposer(db, p),
      inject: [DB, PriceBookService],
    },
    {
      provide: OfferService,
      useFactory: (
        db: Db,
        res: ResidencyService,
        comp: OfferPriceComposer,
        q: QuotaService,
        g: ComputeQuotaGuard,
        r: AdapterRegistry,
      ) =>
        new OfferService(
          db,
          res,
          comp,
          q,
          g,
          { groupOf: (c: string) => new MockRegionRegistry().group(c) },
          () => new Date(r.clock.now()),
        ),
      inject: [
        DB,
        ResidencyService,
        OFFER_PRICE_COMPOSER,
        QuotaService,
        ComputeQuotaGuard,
        AdapterRegistry,
      ],
    },
    {
      provide: RoutingService,
      useFactory: (db: Db, a: AuditSink) => new RoutingService(db, a),
      inject: [DB, AuditSink],
    },
    { provide: ImageCatalog, useFactory: (db: Db) => new ImageCatalog(db), inject: [DB] },
    {
      provide: ProvisioningService,
      useFactory: (
        db: Db,
        a: AuditSink,
        ops: OperationsService,
        r: AdapterRegistry,
        o: OfferService,
        res: ResidencyService,
      ) => new ProvisioningService(db, a, ops, r, o, res),
      inject: [DB, AuditSink, OperationsService, AdapterRegistry, OfferService, ResidencyService],
    },
    {
      provide: ReconcilerService,
      useFactory: (
        db: Db,
        a: AuditSink,
        ops: OperationsService,
        r: AdapterRegistry,
        p: ProvisioningService,
      ) => new ReconcilerService(db, a, ops, r, p),
      inject: [DB, AuditSink, OperationsService, AdapterRegistry, ProvisioningService],
    },
    {
      provide: InstanceService,
      useFactory: (
        db: Db,
        a: AuditSink,
        ops: OperationsService,
        r: AdapterRegistry,
        o: OfferService,
        ord: OrderService,
        sp: SpendService,
        g: ComputeQuotaGuard,
        p: ProvisioningService,
        rec: ReconcilerService,
        f: CloudFlags,
      ) => new InstanceService(db, a, ops, r, o, ord, sp, g, p, rec, f),
      inject: [
        DB,
        AuditSink,
        OperationsService,
        AdapterRegistry,
        OfferService,
        OrderService,
        SpendService,
        ComputeQuotaGuard,
        ProvisioningService,
        ReconcilerService,
        CloudFlags,
      ],
    },
    {
      provide: AdminResourceService,
      useFactory: (db: Db, a: AuditSink, rec: ReconcilerService) =>
        new AdminResourceService(db, a, rec),
      inject: [DB, AuditSink, ReconcilerService],
    },
    {
      provide: ComputeMeteringSampler,
      useFactory: (db: Db, r: AdapterRegistry) => new ComputeMeteringSampler(db, r.clock),
      inject: [DB, AdapterRegistry],
    },
    {
      provide: CloudScheduler,
      useFactory: (h: HealthService, rec: ReconcilerService, s: ComputeMeteringSampler) =>
        new CloudScheduler(h, rec, s),
      inject: [HealthService, ReconcilerService, ComputeMeteringSampler],
    },
  ],
  exports: [
    AdapterRegistry,
    ProviderService,
    ProviderAccountService,
    CatalogService,
    HealthService,
    VAULT,
    OfferService,
    RoutingService,
    ProvisioningService,
    ReconcilerService,
    InstanceService,
    ComputeMeteringSampler,
    CloudFlags,
  ],
})
export class CloudModule implements OnApplicationBootstrap {
  constructor(
    @Inject(CloudScheduler) _scheduler: CloudScheduler, // instantiate the scheduler so its lifecycle hooks run
    @Inject(DB) private readonly db: Db,
    @Inject(QuotePricerRegistry) private readonly pricers: QuotePricerRegistry,
    @Inject(OfferService) private readonly offers: OfferService,
    @Inject(RoutingService) private readonly routing: RoutingService,
    @Inject(ImageCatalog) private readonly images: ImageCatalog,
    @Inject(OFFER_PRICE_COMPOSER) private readonly composer: OfferPriceComposer,
    @Inject(ResidencyService) private readonly residency: ResidencyService,
  ) {}

  onApplicationBootstrap() {
    // compute quotes (M02 quote mechanism, kind `compute`)
    this.pricers.register(
      new ComputeQuotePricer(this.offers, this.routing, this.images, this.composer, this.residency),
    );
    // M04 residency: provider regions resolve from cloud.provider_regions (verified_at + evidence), never from a name or a caller's claim
    this.residency.useRegionRegistry(new ProviderRegionRegistry(this.db, new MockRegionRegistry()));
  }
}
