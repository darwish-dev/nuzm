import {
  Global,
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { FlagReader } from '../../common/feature-flags';
import { DB } from '../../common/tokens';
import { AutomationModule, WorkflowService } from '../automation';
import { LedgerPostingService } from '../billing';
import { OrderService, QuotePricerRegistry, QuoteService } from '../commerce';
import { ResidencyService } from '../compliance';
import { IdentityModule } from '../identity';
import { InvoiceService, TaxService } from '../invoicing';
import { AdminMarketplaceController } from './admin-marketplace.controller';
import { MarketplaceController } from './marketplace.controller';
import { InstallService } from './internal/install.service';
import { ListingService } from './internal/listing.service';
import { ModerationService } from './internal/moderation.service';
import {
  MARKETPLACE_CONFIG,
  MARKETPLACE_FLAG,
  loadMarketplaceConfig,
  type MarketplaceConfig,
} from './internal/model';
import { MarketplacePricer } from './internal/pricer';
import {
  ArtifactStore,
  ProjectInstallPort,
  UnavailableArtifactStore,
  UnavailableProjectInstallPort,
} from './internal/ports';
import { PublisherService } from './internal/publisher.service';
import { PurchaseService } from './internal/purchase.service';

const PRICERS = Symbol('MARKETPLACE_PRICERS');

/** Background reconciliation of open purchases (payment webhooks only update the invoice; refunds show as credit notes). Off unless `MARKETPLACE_SYNC_INTERVAL_SECONDS` > 0. */
export class MarketplaceJobs {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly purchases: PurchaseService) {}
  start(seconds: number) {
    if (this.timer || seconds <= 0) return;
    this.timer = setInterval(
      () =>
        void this.purchases
          .syncOpen()
          .catch((e) =>
            process.stderr.write(
              JSON.stringify({ marketplace_sync_error: (e as Error).message }) + '\n',
            ),
          ),
      seconds * 1000,
    );
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  tick() {
    return this.purchases.syncOpen();
  }
}

/**
 * Marketplace (M11 S53): publishers, listings and immutable versions, scans and human moderation, purchases through M03, entitlements, installs, and the publisher revenue ACCRUAL.
 * Default OFF (`marketplace.enabled`). NO payout path exists (D-26 / HG-11-01). The artifact store and the website/app installer are ports (M08/M09/M10): NOT VERIFIED.
 */
@Global()
@Module({
  imports: [IdentityModule, AutomationModule],
  controllers: [MarketplaceController, AdminMarketplaceController],
  providers: [
    { provide: MARKETPLACE_CONFIG, useFactory: () => loadMarketplaceConfig() },
    { provide: ArtifactStore, useClass: UnavailableArtifactStore },
    { provide: ProjectInstallPort, useClass: UnavailableProjectInstallPort },
    {
      provide: PublisherService,
      useFactory: (db: Db, a: AuditSink) => new PublisherService(db, a),
      inject: [DB, AuditSink],
    },
    {
      provide: ListingService,
      useFactory: (
        db: Db,
        a: AuditSink,
        p: PublisherService,
        s: ArtifactStore,
        t: TaxService,
        c: MarketplaceConfig,
      ) => new ListingService(db, a, p, s, t, c),
      inject: [DB, AuditSink, PublisherService, ArtifactStore, TaxService, MARKETPLACE_CONFIG],
    },
    {
      provide: ModerationService,
      useFactory: (db: Db, a: AuditSink) => new ModerationService(db, a),
      inject: [DB, AuditSink],
    },
    {
      provide: PurchaseService,
      useFactory: (
        db: Db,
        a: AuditSink,
        q: QuoteService,
        o: OrderService,
        i: InvoiceService,
        l: LedgerPostingService,
        f: FlagReader,
        c: MarketplaceConfig,
      ) => new PurchaseService(db, a, q, o, i, l, f, c),
      inject: [
        DB,
        AuditSink,
        QuoteService,
        OrderService,
        InvoiceService,
        LedgerPostingService,
        FlagReader,
        MARKETPLACE_CONFIG,
      ],
    },
    {
      provide: InstallService,
      useFactory: (
        db: Db,
        a: AuditSink,
        s: ArtifactStore,
        pj: ProjectInstallPort,
        w: WorkflowService,
        r: ResidencyService,
        f: FlagReader,
      ) => new InstallService(db, a, s, pj, w, r, f),
      inject: [
        DB,
        AuditSink,
        ArtifactStore,
        ProjectInstallPort,
        WorkflowService,
        ResidencyService,
        FlagReader,
      ],
    },
    {
      provide: PRICERS,
      useFactory: (reg: QuotePricerRegistry, db: Db, r: ResidencyService, f: FlagReader) => {
        reg.register(new MarketplacePricer(db, r, (orgId) => f.enabled(orgId, MARKETPLACE_FLAG)));
        return true;
      },
      inject: [QuotePricerRegistry, DB, ResidencyService, FlagReader],
    },
    {
      provide: MarketplaceJobs,
      useFactory: (p: PurchaseService) => new MarketplaceJobs(p),
      inject: [PurchaseService],
    },
  ],
  exports: [
    PublisherService,
    ListingService,
    ModerationService,
    PurchaseService,
    InstallService,
    ArtifactStore,
    ProjectInstallPort,
    MarketplaceJobs,
  ],
})
export class MarketplaceModule implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(
    private readonly jobs: MarketplaceJobs,
    @Inject(PRICERS) _pricers: boolean,
  ) {}
  onApplicationBootstrap() {
    this.jobs.start(Number(process.env.MARKETPLACE_SYNC_INTERVAL_SECONDS ?? 0));
  }
  onModuleDestroy() {
    this.jobs.stop();
  }
}
