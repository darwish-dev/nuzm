import {
  Global,
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Db as DbClass, OperationsService, type Db } from '@nuzm/platform';
import type { ResidencyEvaluator } from '@nuzm/domain';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { EntitlementService, PriceBookService } from '../billing';
import { OrderService, QuotePricerRegistry } from '../commerce';
import { ResidencyService } from '../compliance';
import { IdentityModule } from '../identity';
import { AdminAgentsController } from './admin-agents.controller';
import { AdminNodesController } from './admin-nodes.controller';
import { AdminSitesController } from './admin-sites.controller';
import { HostingPlansController } from './hosting-plans.controller';
import { PublicPlansController } from './public-plans.controller';
import { AdminAbuseController } from './admin-abuse.controller';
import { SiteAbuseController } from './site-abuse.controller';
import { BackupDownloadsController } from './backup-downloads.controller';
import { SiteBackupsController } from './site-backups.controller';
import { SiteDatabasesController } from './site-databases.controller';
import { SiteDomainsController } from './site-domains.controller';
import { SiteSslController } from './site-ssl.controller';
import { SitesController } from './sites.controller';
import { CloudPanelHostingAdapter } from './internal/cloudpanel-adapter';
import { loadHostingConfig, type HostingConfig } from './internal/config';
import { BackupService } from './internal/backups.service';
import { DomainsService } from './internal/domains.service';
import { AbuseService } from './internal/abuse.service';
import { DunningHook } from './internal/dunning-hook';
import { HostingMetering } from './internal/hosting-metering';
import { MigrationService } from './internal/migration.service';
import { UsageService } from './internal/usage.service';
import { NotificationService } from '../notifications';
import { HostingJobs } from './internal/hosting-jobs';
import { HostingQuotePricer } from './internal/hosting-pricer';
import {
  InMemoryComputeProvisioning,
  MemoryBackupSink,
  MemoryVault,
  MockDomainOwnershipVerifier,
  NoBackupSink,
  NoDatabaseBindingProvider,
} from './internal/mock/mocks';
import { NodesService } from './internal/nodes.service';
import { PlansService } from './internal/plans.service';
import {
  BACKUP_SINK,
  COMPUTE_PROVISIONING,
  DATABASE_BINDING_PROVIDER,
  DOMAIN_VERIFIER,
  VAULT_PORT,
  type BackupSink,
  type CloudPanelTransport,
  type ComputeProvisioningPort,
  type DomainOwnershipVerifier,
  type HostingAdapter,
  type VaultPort,
} from './internal/ports';
import { SiteWorkflow } from './internal/site-workflow';
import { KIND, SitesService } from './internal/sites.service';
import { SslService } from './internal/ssl.service';
import {
  HOSTING_ADAPTER,
  HOSTING_CONFIG,
  HOSTING_KICK,
  HOSTING_WORKER_DB,
} from './internal/tokens';

/** Until a real node agent channel exists (HG-06-01) the transport refuses: nothing is simulated inside a running API. */
class UnavailableTransport implements CloudPanelTransport {
  readonly mode = 'node-agent' as const;
  async send() {
    return {
      status: 'failed' as const,
      reason: 'unsupported',
      result: 'the node agent channel is not configured',
      rawSummary: 'no agent channel',
    };
  }
}
const prod = () => process.env.NODE_ENV === 'production';
/** Production has no secret store until D-12/HG-01-02 is decided (M05 S16 posture): the vault port refuses instead of keeping secrets in memory. */
class BlockedVault implements VaultPort {
  private no(): never {
    throw new Error('no vault is configured (D-12): hosting cannot hold site secrets');
  }
  async put(): Promise<void> {
    this.no();
  }
  async exists(): Promise<boolean> {
    return this.no();
  }
  async delete(): Promise<void> {
    this.no();
  }
}
/** M07 is not integrated: in production nothing can be verified, so no domain is ever bound (the safe direction). */
class UnverifiedDomains extends MockDomainOwnershipVerifier {
  override async verify() {
    return false;
  }
}

/**
 * Shared hosting (M06). Everything M05/M07/M08 will provide is a PORT with a mock default (docs/reports/M06-m05-interface-assumptions.md); tests replace
 * ports through `overrideProvider`. Production wiring of the real ports is a one-line change per provider.
 */
@Global()
@Module({
  imports: [IdentityModule],
  controllers: [
    AdminNodesController,
    AdminAgentsController,
    AdminSitesController,
    HostingPlansController,
    PublicPlansController,
    SitesController,
    SiteDomainsController,
    SiteSslController,
    SiteDatabasesController,
    SiteBackupsController,
    BackupDownloadsController,
    AdminAbuseController,
    SiteAbuseController,
  ],
  providers: [
    { provide: HOSTING_CONFIG, useFactory: () => loadHostingConfig() },
    {
      provide: HOSTING_KICK,
      useFactory: () => ({
        handler: null as null | ((orgId: string, operationId: string) => void),
      }),
    },
    {
      provide: HOSTING_ADAPTER,
      useFactory: () => new CloudPanelHostingAdapter(new UnavailableTransport()),
    },
    { provide: COMPUTE_PROVISIONING, useFactory: () => new InMemoryComputeProvisioning() },
    { provide: VAULT_PORT, useFactory: () => (prod() ? new BlockedVault() : new MemoryVault()) },
    {
      provide: DOMAIN_VERIFIER,
      useFactory: () => (prod() ? new UnverifiedDomains() : new MockDomainOwnershipVerifier()),
    },
    { provide: DATABASE_BINDING_PROVIDER, useFactory: () => new NoDatabaseBindingProvider() },
    {
      provide: BACKUP_SINK,
      useFactory: () => (prod() ? new NoBackupSink() : new MemoryBackupSink()),
    },
    {
      provide: HOSTING_WORKER_DB,
      useFactory: () =>
        process.env.WORKER_DATABASE_URL ? new DbClass(process.env.WORKER_DATABASE_URL) : null,
    },
    {
      provide: NodesService,
      useFactory: (
        db: Db,
        a: AuditSink,
        ad: HostingAdapter,
        cp: ComputeProvisioningPort,
        cfg: HostingConfig,
      ) => new NodesService(db, a, ad, cp, cfg),
      inject: [DB, AuditSink, HOSTING_ADAPTER, COMPUTE_PROVISIONING, HOSTING_CONFIG],
    },
    {
      provide: PlansService,
      useFactory: (db: Db, r: ResidencyEvaluator) => new PlansService(db, r),
      inject: [DB, ResidencyService],
    },
    {
      provide: SitesService,
      useFactory: (
        db: Db,
        a: AuditSink,
        o: OperationsService,
        ord: OrderService,
        e: EntitlementService,
        p: PlansService,
        r: ResidencyEvaluator,
        ad: HostingAdapter,
        cfg: HostingConfig,
        k: { handler: ((o: string, i: string) => void) | null },
      ) =>
        new SitesService(
          db,
          a,
          o,
          ord,
          e,
          p,
          r,
          ad,
          cfg,
          () => new Date(),
          (org, id) => k.handler?.(org, id),
        ),
      inject: [
        DB,
        AuditSink,
        OperationsService,
        OrderService,
        EntitlementService,
        PlansService,
        ResidencyService,
        HOSTING_ADAPTER,
        HOSTING_CONFIG,
        HOSTING_KICK,
      ],
    },
    {
      provide: DomainsService,
      useFactory: (
        db: Db,
        a: AuditSink,
        o: OperationsService,
        s: SitesService,
        v: DomainOwnershipVerifier,
        k: { handler: ((o: string, i: string) => void) | null },
      ) => new DomainsService(db, a, o, s, v, (org, id) => k.handler?.(org, id)),
      inject: [DB, AuditSink, OperationsService, SitesService, DOMAIN_VERIFIER, HOSTING_KICK],
    },
    {
      provide: SslService,
      useFactory: (
        db: Db,
        a: AuditSink,
        o: OperationsService,
        s: SitesService,
        ad: HostingAdapter,
        v: VaultPort,
        cfg: HostingConfig,
        k: { handler: ((o: string, i: string) => void) | null },
      ) =>
        new SslService(
          db,
          a,
          o,
          s,
          ad,
          v,
          cfg,
          () => new Date(),
          (org, id) => k.handler?.(org, id),
        ),
      inject: [
        DB,
        AuditSink,
        OperationsService,
        SitesService,
        HOSTING_ADAPTER,
        VAULT_PORT,
        HOSTING_CONFIG,
        HOSTING_KICK,
      ],
    },
    {
      provide: SiteWorkflow,
      useFactory: (
        db: Db,
        a: AuditSink,
        o: OperationsService,
        s: SitesService,
        ad: HostingAdapter,
        v: VaultPort,
        ssl: SslService,
        cfg: HostingConfig,
      ) => new SiteWorkflow(db, a, o, s, s.capacity, ad, v, ssl, cfg),
      inject: [
        DB,
        AuditSink,
        OperationsService,
        SitesService,
        HOSTING_ADAPTER,
        VAULT_PORT,
        SslService,
        HOSTING_CONFIG,
      ],
    },
    {
      provide: BackupService,
      useFactory: (
        db: Db,
        a: AuditSink,
        o: OperationsService,
        s: SitesService,
        ad: HostingAdapter,
        sink: BackupSink,
        r: ResidencyEvaluator,
        cfg: HostingConfig,
        k: { handler: ((o: string, i: string) => void) | null },
      ) =>
        new BackupService(
          db,
          a,
          o,
          s,
          ad,
          sink,
          r,
          cfg,
          () => new Date(),
          (org, id) => k.handler?.(org, id),
        ),
      inject: [
        DB,
        AuditSink,
        OperationsService,
        SitesService,
        HOSTING_ADAPTER,
        BACKUP_SINK,
        ResidencyService,
        HOSTING_CONFIG,
        HOSTING_KICK,
      ],
    },
    {
      provide: UsageService,
      useFactory: (
        db: Db,
        a: AuditSink,
        s: SitesService,
        ad: HostingAdapter,
        cfg: HostingConfig,
        n: NotificationService,
      ) =>
        new UsageService(db, a, s, ad, cfg, async (orgId, kind, params) => {
          const ids = await db.withOrg(orgId, async (c) =>
            (
              await c.query(
                `SELECT user_id FROM tenancy.memberships WHERE org_id = $1 AND role IN ('owner','admin')`,
                [orgId],
              )
            ).rows.map((x) => x.user_id as string),
          );
          for (const userId of ids) await n.notify({ orgId, userId, kind, params });
        }),
      inject: [DB, AuditSink, SitesService, HOSTING_ADAPTER, HOSTING_CONFIG, NotificationService],
    },
    {
      provide: AbuseService,
      useFactory: (
        db: Db,
        a: AuditSink,
        s: SitesService,
        ad: HostingAdapter,
        n: NotificationService,
      ) =>
        new AbuseService(db, a, s, ad, async (orgId, kind, params) => {
          const ids = await db.withOrg(orgId, async (c) =>
            (
              await c.query(
                `SELECT user_id FROM tenancy.memberships WHERE org_id = $1 AND role IN ('owner','admin')`,
                [orgId],
              )
            ).rows.map((x) => x.user_id as string),
          );
          for (const userId of ids) await n.notify({ orgId, userId, kind, params });
        }),
      inject: [DB, AuditSink, SitesService, HOSTING_ADAPTER, NotificationService],
    },
    { provide: HostingMetering, useFactory: (db: Db) => new HostingMetering(db), inject: [DB] },
    {
      provide: DunningHook,
      useFactory: (db: Db, s: SitesService) => new DunningHook(db, s),
      inject: [DB, SitesService],
    },
    {
      provide: MigrationService,
      useFactory: (
        db: Db,
        a: AuditSink,
        o: OperationsService,
        s: SitesService,
        b: BackupService,
        ad: HostingAdapter,
        k: { handler: ((o: string, i: string) => void) | null },
      ) => new MigrationService(db, a, o, s, s.capacity, b, ad, (org, id) => k.handler?.(org, id)),
      inject: [
        DB,
        AuditSink,
        OperationsService,
        SitesService,
        BackupService,
        HOSTING_ADAPTER,
        HOSTING_KICK,
      ],
    },
    {
      provide: HostingJobs,
      useFactory: (
        o: OperationsService,
        db: Db,
        w: SiteWorkflow,
        ssl: SslService,
        wdb: Db | null,
        k: { handler: ((o: string, i: string) => void) | null },
        b: BackupService,
        m: MigrationService,
        u: UsageService,
        ab: AbuseService,
        mt: HostingMetering,
        dh: DunningHook,
      ) => {
        const j = new HostingJobs(o, db, w, ssl, wdb ? new OperationsService(wdb) : null);
        j.register(KIND.backup, (op) => b.execute(op));
        j.register(KIND.restore, (op) => b.executeRestore(op));
        j.register(KIND.migrate, (op) => m.execute(op));
        u.afterReport.push(
          (id) => mt.bandwidth(id),
          (id, d) => ab.scan(id, d),
        );
        j.registerSweep('usage', () => u.collectAll());
        j.registerSweep('metering', () => mt.accrue());
        j.registerSweep('dunning', () => dh.reconcile());
        j.registerSweep('retention', () => b.sweepRetention());
        j.registerSweep('bandwidth-period', () => u.newPeriodReinstate());
        k.handler = (org, id) => j.kick(org, id);
        return j;
      },
      inject: [
        OperationsService,
        DB,
        SiteWorkflow,
        SslService,
        HOSTING_WORKER_DB,
        HOSTING_KICK,
        BackupService,
        MigrationService,
        UsageService,
        AbuseService,
        HostingMetering,
        DunningHook,
      ],
    },
    {
      provide: 'HOSTING_QUOTE_PRICER',
      useFactory: (r: QuotePricerRegistry, db: Db, p: PriceBookService) => {
        r.register(new HostingQuotePricer(db, p));
        return true;
      },
      inject: [QuotePricerRegistry, DB, PriceBookService],
    },
  ],
  exports: [
    AbuseService,
    HostingMetering,
    DunningHook,
    NodesService,
    SitesService,
    PlansService,
    DomainsService,
    SslService,
    SiteWorkflow,
    HostingJobs,
    HOSTING_ADAPTER,
    HOSTING_CONFIG,
    COMPUTE_PROVISIONING,
    VAULT_PORT,
    BACKUP_SINK,
    DOMAIN_VERIFIER,
  ],
})
export class HostingModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly jobs: HostingJobs,
    @Inject(HOSTING_WORKER_DB) private readonly workerDb: Db | null,
  ) {}
  onApplicationBootstrap() {
    this.jobs.start(HostingJobs.intervalFromEnv());
  }
  async onApplicationShutdown() {
    this.jobs.stop();
    await this.workerDb?.close();
  }
}
