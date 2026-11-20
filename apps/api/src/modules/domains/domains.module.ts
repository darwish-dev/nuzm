import { DnsTxtLookup } from './internal/txt-lookup.service';
import { Global, Inject, Module, type OnModuleInit } from '@nestjs/common';
import { OperationsService } from '@nuzm/platform';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { SecretStore } from '../../common/secrets';
import { IdentityModule } from '../identity';
import { DB } from '../../common/tokens';
import { LedgerPostingService } from '../billing';
import { OrderService as CommerceOrders, QuotePricerRegistry } from '../commerce';
import { ConsentService, DsrRegistry } from '../compliance';
import { DomainContactsDsrHandler } from './internal/dsr-handler';
import { FieldCipher } from '../../common/field-crypto';
import { ProviderCostService } from '../metering';
import { NotificationService } from '../notifications';
import { ResidencyService } from '../compliance';
import { AdminDomainsController } from './admin-domains.controller';
import { AdminRegistrarsController } from './admin-registrars.controller';
import { DomainsController } from './domains.controller';
import { DnsController } from './dns.controller';
import { DnsService } from './internal/dns.service';
import { DnsLinkageService } from './internal/linkage.service';
import { DomainAdminReadService } from './internal/admin-read.service';
import { DomainCostReconService } from './internal/cost-recon.service';
import { DomainJobs } from './internal/renewal.service';
import { BillSourceRegistry } from '../finrec';
import { QuoteService } from '../commerce';
import { SpendService } from '../billing';
import { RegistrarWebhooksController } from './registrar-webhooks.controller';
import { DomainService } from './internal/domain.service';
import { DomainOrderService } from './internal/orders.service';
import { DomainReconcilerService } from './internal/reconciler.service';
import { TransferService } from './internal/transfer.service';
import { RegistrarWebhookService } from './internal/webhook.service';
import { DomainsSearchController } from './domains-search.controller';
import { DomainPricer } from './internal/domain-pricer';
import { EligibilityService } from './internal/eligibility.service';
import { productionFactories, UnavailableVault } from './internal/factories';
import { DomainsFlags } from './internal/flags';
import {
  ADAPTER_FACTORIES,
  HOSTING_READ_PORT,
  InMemoryHostingReadPort,
  type HostingSiteReadPort,
  DOMAINS_CONFIG,
  DOMAINS_VAULT,
  domainsConfigFromEnv,
  type DomainsConfig,
  type DomainsVaultClient,
} from './internal/ports';
import { RegistrarAccessService, type AdapterFactory } from './internal/registrar-access.service';
import { RegistrarAdminService } from './internal/registrar-admin.service';
import { SearchService } from './internal/search.service';
import { loadTldPolicy } from './internal/tld-policy';

/**
 * Domains & DNS reseller (M07). Everything vendor-specific enters through `ADAPTER_FACTORIES` and `DOMAINS_VAULT`; M06 through `HOSTING_READ_PORT`. The
 * dev/CI wiring overrides these providers with mock servers and an in-memory vault (labelled NOT VERIFIED, never LIVE-VERIFIED).
 */
@Global()
@Module({
  imports: [IdentityModule],
  controllers: [
    DomainsSearchController,
    DomainsController,
    DnsController,
    AdminRegistrarsController,
    AdminDomainsController,
    RegistrarWebhooksController,
  ],
  providers: [
    { provide: DnsTxtLookup, useFactory: (db: Db) => new DnsTxtLookup(db), inject: [DB] },
    { provide: DOMAINS_CONFIG, useFactory: () => domainsConfigFromEnv() },
    { provide: DOMAINS_VAULT, useFactory: () => new UnavailableVault() },
    {
      provide: ADAPTER_FACTORIES,
      useFactory: (cfg: DomainsConfig) => productionFactories(cfg),
      inject: [DOMAINS_CONFIG],
    },
    { provide: DomainsFlags, useFactory: (db: Db) => new DomainsFlags(db), inject: [DB] },
    {
      provide: RegistrarAccessService,
      useFactory: (
        db: Db,
        f: Record<string, AdapterFactory>,
        v: DomainsVaultClient,
        cfg: DomainsConfig,
      ) =>
        new RegistrarAccessService(db, f, v, undefined, {
          failureThreshold: 5,
          cooldownMs: 30_000,
          burst: cfg.accountBurst,
          perSecond: cfg.accountRatePerSecond,
        }),
      inject: [DB, ADAPTER_FACTORIES, DOMAINS_VAULT, DOMAINS_CONFIG],
    },
    {
      provide: EligibilityService,
      useFactory: (db: Db) => new EligibilityService(db, loadTldPolicy()),
      inject: [DB],
    },
    {
      provide: SearchService,
      useFactory: (
        a: RegistrarAccessService,
        e: EligibilityService,
        au: AuditSink,
        cfg: DomainsConfig,
      ) => new SearchService(a, e, au, cfg),
      inject: [RegistrarAccessService, EligibilityService, AuditSink, DOMAINS_CONFIG],
    },
    {
      provide: RegistrarAdminService,
      useFactory: (
        db: Db,
        a: RegistrarAccessService,
        au: AuditSink,
        cfg: DomainsConfig,
        sec: SecretStore,
      ) => new RegistrarAdminService(db, a, au, cfg, sec),
      inject: [DB, RegistrarAccessService, AuditSink, DOMAINS_CONFIG, SecretStore],
    },
    {
      provide: DomainOrderService,
      useFactory: (
        db: Db,
        au: AuditSink,
        ops: OperationsService,
        a: RegistrarAccessService,
        e: EligibilityService,
        c: CommerceOrders,
        l: LedgerPostingService,
        pc: ProviderCostService,
        cs: ConsentService,
        ci: FieldCipher,
        r: ResidencyService,
        v: DomainsVaultClient,
        cfg: DomainsConfig,
        n: NotificationService,
      ) =>
        new DomainOrderService({
          db,
          audit: au,
          ops,
          access: a,
          eligibility: e,
          commerce: c,
          ledger: l,
          providerCost: pc,
          consents: cs,
          cipher: ci,
          residency: r,
          vault: v,
          cfg,
          notify: async (orgId, kind, params) => {
            const owners = await db.withOrg(
              orgId,
              async (cl) =>
                (
                  await cl.query(
                    `SELECT user_id FROM tenancy.memberships WHERE org_id = $1 AND role IN ('owner','admin')`,
                    [orgId],
                  )
                ).rows as { user_id: string }[],
            );
            for (const o of owners) await n.notify({ orgId, userId: o.user_id, kind, params });
          },
        }),
      inject: [
        DB,
        AuditSink,
        OperationsService,
        RegistrarAccessService,
        EligibilityService,
        CommerceOrders,
        LedgerPostingService,
        ProviderCostService,
        ConsentService,
        FieldCipher,
        ResidencyService,
        DOMAINS_VAULT,
        DOMAINS_CONFIG,
        NotificationService,
      ],
    },
    {
      provide: DomainService,
      useFactory: (
        db: Db,
        au: AuditSink,
        a: RegistrarAccessService,
        e: EligibilityService,
        o: DomainOrderService,
        ops: OperationsService,
        ci: FieldCipher,
        cs: ConsentService,
        r: ResidencyService,
      ) => new DomainService(db, au, a, e, o, ops, ci, cs, r),
      inject: [
        DB,
        AuditSink,
        RegistrarAccessService,
        EligibilityService,
        DomainOrderService,
        OperationsService,
        FieldCipher,
        ConsentService,
        ResidencyService,
      ],
    },
    { provide: TransferService, useFactory: (db: Db) => new TransferService(db), inject: [DB] },
    {
      provide: DomainReconcilerService,
      useFactory: (
        db: Db,
        ops: OperationsService,
        o: DomainOrderService,
        d: DomainService,
        au: AuditSink,
        dns: DnsService,
      ) => new DomainReconcilerService(db, ops, o, d, au, dns),
      inject: [DB, OperationsService, DomainOrderService, DomainService, AuditSink, DnsService],
    },
    {
      provide: RegistrarWebhookService,
      useFactory: (
        db: Db,
        a: RegistrarAccessService,
        o: DomainOrderService,
        v: DomainsVaultClient,
        au: AuditSink,
        cfg: DomainsConfig,
      ) => new RegistrarWebhookService(db, a, o, v, au, cfg),
      inject: [
        DB,
        RegistrarAccessService,
        DomainOrderService,
        DOMAINS_VAULT,
        AuditSink,
        DOMAINS_CONFIG,
      ],
    },
    { provide: HOSTING_READ_PORT, useFactory: () => new InMemoryHostingReadPort() },
    {
      provide: DnsLinkageService,
      useFactory: (db: Db, dns: DnsService, h: HostingSiteReadPort, au: AuditSink) =>
        new DnsLinkageService(db, dns, h, au),
      inject: [DB, DnsService, HOSTING_READ_PORT, AuditSink],
    },
    {
      provide: DomainAdminReadService,
      useFactory: (db: Db, ci: FieldCipher) => new DomainAdminReadService(db, ci),
      inject: [DB, FieldCipher],
    },
    {
      provide: DomainCostReconService,
      useFactory: (db: Db, a: RegistrarAccessService) => new DomainCostReconService(db, a),
      inject: [DB, RegistrarAccessService],
    },
    {
      provide: DomainJobs,
      useFactory: (
        db: Db,
        au: AuditSink,
        q: QuoteService,
        sp: SpendService,
        o: DomainOrderService,
        n: NotificationService,
      ) =>
        new DomainJobs({
          db,
          audit: au,
          quotes: q,
          spend: sp,
          orders: o,
          notify: async (orgId, kind, params) => {
            const rows = await db.withOrg(
              orgId,
              async (cl) =>
                (
                  await cl.query(
                    `SELECT user_id FROM tenancy.memberships WHERE org_id = $1 AND role IN ('owner','admin','billing_admin')`,
                    [orgId],
                  )
                ).rows as { user_id: string }[],
            );
            for (const r of rows) await n.notify({ orgId, userId: r.user_id, kind, params });
          },
        }),
      inject: [DB, AuditSink, QuoteService, SpendService, DomainOrderService, NotificationService],
    },
    {
      provide: DnsService,
      useFactory: (
        db: Db,
        au: AuditSink,
        a: RegistrarAccessService,
        ops: OperationsService,
        cfg: DomainsConfig,
      ) => new DnsService(db, au, a, ops, cfg),
      inject: [DB, AuditSink, RegistrarAccessService, OperationsService, DOMAINS_CONFIG],
    },
    {
      provide: DomainPricer,
      useFactory: (
        db: Db,
        a: RegistrarAccessService,
        e: EligibilityService,
        s: SearchService,
        r: ResidencyService,
        au: AuditSink,
        cfg: DomainsConfig,
      ) => new DomainPricer(db, a, e, s, r, au, cfg),
      inject: [
        DB,
        RegistrarAccessService,
        EligibilityService,
        SearchService,
        ResidencyService,
        AuditSink,
        DOMAINS_CONFIG,
      ],
    },
  ],
  exports: [
    DnsTxtLookup,
    RegistrarAccessService,
    EligibilityService,
    SearchService,
    DomainsFlags,
    DomainPricer,
    DomainOrderService,
    DomainService,
    DomainReconcilerService,
  ],
})
export class DomainsModule implements OnModuleInit {
  constructor(
    @Inject(QuotePricerRegistry) private readonly pricers: QuotePricerRegistry,
    @Inject(DomainPricer) private readonly pricer: DomainPricer,
    @Inject(DsrRegistry) private readonly dsr: DsrRegistry,
    @Inject(FieldCipher) private readonly cipher: FieldCipher,
    @Inject(BillSourceRegistry) private readonly bills: BillSourceRegistry,
    @Inject(DomainCostReconService) private readonly cost: DomainCostReconService,
    @Inject(DomainJobs) private readonly jobs: DomainJobs,
    @Inject(DomainOrderService) private readonly orders: DomainOrderService,
  ) {}
  onModuleInit(): void {
    if (!this.pricers.kinds().includes('domain')) this.pricers.register(this.pricer);
    this.bills.register('domains', (from, to) => this.cost.billLines(from, to));
    if (process.env.DOMAINS_JOBS_ENABLED === 'true') {
      // daily renewals/reminders/zone accrual and the nightly technical sweep (single-process timer; a worker-scheduled run replaces it with M12 ops)
      const t = setInterval(
        () =>
          void this.jobs
            .runDaily()
            .then(() => this.orders.sweep())
            .catch((e) =>
              console.error(JSON.stringify({ domains_job_error: (e as Error).message })),
            ),
        3_600_000,
      );
      t.unref();
    }
    if (!this.dsr.get('domain-contacts'))
      this.dsr.register(new DomainContactsDsrHandler(this.cipher));
  }
}
