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
import { NodesService } from '../hosting';
import { IdentityModule } from '../identity';
import { AdminOffersController } from './admin-offers.controller';
import { AdminResourcesController } from './admin-resources.controller';
import { AdminProviderAccountsController } from './admin-provider-accounts.controller';
import { AdminProviderJobsController } from './admin-provider-jobs.controller';
import { AdminProvidersController } from './admin-providers.controller';
import { AdminRoutingRulesController } from './admin-routing-rules.controller';
import { AdminPanelController } from './admin-panel.controller';
import { PanelBootstrapController } from './panel-bootstrap.controller';
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
import { PanelImageService } from './internal/hestia-vps/panel-images.service';
import { PanelInstallService } from './internal/hestia-vps/panel-install.service';
import {
  UnconfiguredPanelDns,
  type PanelDnsPort,
  type PanelNodePort,
} from './internal/hestia-vps/ports';
import { envConfigSource } from './internal/hestia-vps/policy';
import { ReconcilerService } from './internal/reconciler.service';
import { RoutingService } from './internal/routing.service';
import { ProviderRegionRegistry } from './internal/provider-region-registry';

export const VAULT = 'NUZM_VAULT_CLIENT';
export const OFFER_PRICE_COMPOSER = 'NUZM_OFFER_PRICE_COMPOSER';
export const PANEL_NODES = 'NUZM_PANEL_NODES';
export const PANEL_DNS = 'NUZM_PANEL_DNS';

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
    private readonly panel: PanelInstallService,
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
      every('CLOUD_PANEL_INTERVAL_SECONDS', () => this.panel.sweep(), 'cloud_panel_error'),
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
    PanelBootstrapController,
    AdminPanelController,
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
      provide: PANEL_NODES,
      // the hosting module's public surface registers and checks the customer's panel node (cloud never touches hosting tables)
      useFactory: (n: NodesService): PanelNodePort => ({
        registerNode: (a) => n.registerCustomerVps(a),
        retire: (id) => n.retireCustomerVps(id),
        check: (id) => n.checkCustomerVps(id),
      }),
      inject: [NodesService],
    },
    { provide: PANEL_DNS, useFactory: (): PanelDnsPort => new UnconfiguredPanelDns() },
    {
      provide: PanelInstallService,
      useFactory: (
        db: Db,
        a: AuditSink,
        r: AdapterRegistry,
        p: ProvisioningService,
        f: CloudFlags,
        s: SecretStore,
        nodes: PanelNodePort,
        dns: PanelDnsPort,
      ) =>
        new PanelInstallService({
          db,
          audit: a,
          adapters: r,
          prov: p,
          flags: f,
          config: envConfigSource,
          // production has no secret store until D-12: the Hestia VPS product is then not available (never a fallback to something weaker)
          vault: process.env.NODE_ENV === 'production' ? null : new SealedVault(s, r.redactor),
          nodes,
          dns,
        }),
      inject: [
        DB,
        AuditSink,
        AdapterRegistry,
        ProvisioningService,
        CloudFlags,
        SecretStore,
        PANEL_NODES,
        PANEL_DNS,
      ],
    },
    {
      provide: PanelImageService,
      useFactory: (db: Db, a: AuditSink) => new PanelImageService(db, a, envConfigSource),
      inject: [DB, AuditSink],
    },
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
        panel: PanelInstallService,
      ) => new InstanceService(db, a, ops, r, o, ord, sp, g, p, rec, f, panel),
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
        PanelInstallService,
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
      useFactory: (
        h: HealthService,
        rec: ReconcilerService,
        s: ComputeMeteringSampler,
        p: PanelInstallService,
      ) => new CloudScheduler(h, rec, s, p),
      inject: [HealthService, ReconcilerService, ComputeMeteringSampler, PanelInstallService],
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
    PanelInstallService,
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
    @Inject(PanelInstallService) private readonly panel: PanelInstallService,
    @Inject(ProvisioningService) private readonly prov: ProvisioningService,
  ) {}

  onApplicationBootstrap() {
    // compute quotes (M02 quote mechanism, kind `compute`)
    this.pricers.register(
      new ComputeQuotePricer(
        this.offers,
        this.routing,
        this.images,
        this.composer,
        this.residency,
        this.panel,
      ),
    );
    // S04: the provisioning workflow reaches the Hestia install only through these hooks
    this.prov.panel = {
      userDataFor: (o, i, k) => this.panel.userDataFor(o, i, k),
      stillValid: (o, i) => this.panel.stillValid(o, i),
      markServerCreated: (c, i, ref, ips, at) => this.panel.markServerCreated(c, i, ref, ips, at),
      markHeld: (o, i) => this.panel.markHeld(o, i),
      holdRetryMinutes: () => this.panel.holdRetryMinutes(),
      onDeleted: (o, i) => this.panel.onDeleted(o, i),
    };
    // M04 residency: provider regions resolve from cloud.provider_regions (verified_at + evidence), never from a name or a caller's claim
    this.residency.useRegionRegistry(new ProviderRegionRegistry(this.db, new MockRegionRegistry()));
  }
}
