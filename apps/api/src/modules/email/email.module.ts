import { Global, Inject, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { OperationsService, type Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { FieldCipher } from '../../common/field-crypto';
import { SecretStore } from '../../common/secrets';
import { DB } from '../../common/tokens';
import { EntitlementService, PriceBookService } from '../billing';
import { OrderService, QuotePricerRegistry } from '../commerce';
import { ResidencyService } from '../compliance';
import { IdentityModule } from '../identity';
import {
  DATA_CONFIG,
  DataAdapterRegistry,
  DataAlerts,
  DataFlags,
  DataJobs,
  DataOperations,
  DataProviderService,
  DatabaseFlow,
  type DataConfig,
} from '../data';
import { EmailController } from './email.controller';
import { EmailWebhooksController } from './email-webhooks.controller';
import { defaultResolvers, type DnsResolverPort } from './internal/dns';
import { DnsLinkagePort, NoDnsLinkage } from './internal/dns-linkage.port';
import { EmailDomainService } from './internal/domain.service';
import { EmailPricer } from './internal/email-pricer';
import { MailboxService } from './internal/mailbox.service';
import {
  EMAIL_CONFIG,
  MessageService,
  loadEmailConfig,
  type EmailConfig,
} from './internal/message.service';
import { SenderTemplateService } from './internal/sender-template.service';
import { SuppressionService } from './internal/suppression.service';

/** The resolvers used for live DNS verification: public resolvers by default, replaceable (tests inject fixtures). */
export class DnsResolvers {
  private list: DnsResolverPort[] | null = null;
  get(): DnsResolverPort[] {
    return (this.list ??= defaultResolvers());
  }
  set(l: DnsResolverPort[]) {
    this.list = l;
  }
}
const PRICERS = Symbol('EMAIL_PRICERS');

/**
 * Email (M08 S35-S36): domains + DNS verification, business mailboxes and aliases, sender identities, templates, transactional messages, events and suppressions,
 * provider webhooks. No provider is chosen (D-08, D-09 OPEN): every endpoint that needs one answers 422 `unsupported_capability` until a provider is decided, probed,
 * evidenced and enabled through `/v1/admin/data-providers`. Dev-reference (mock) adapters exist for tests only.
 */
@Global()
@Module({
  imports: [IdentityModule],
  controllers: [EmailController, EmailWebhooksController],
  providers: [
    { provide: EMAIL_CONFIG, useFactory: () => loadEmailConfig() },
    { provide: DnsResolvers, useFactory: () => new DnsResolvers() },
    { provide: DnsLinkagePort, useClass: NoDnsLinkage },
    {
      provide: EmailDomainService,
      useFactory: (
        db: Db,
        a: AuditSink,
        p: DataProviderService,
        r: DataAdapterRegistry,
        res: ResidencyService,
        dns: DnsResolvers,
        l: DnsLinkagePort,
      ) => new EmailDomainService(db, a, p, r, res, () => dns.get(), l),
      inject: [
        DB,
        AuditSink,
        DataProviderService,
        DataAdapterRegistry,
        ResidencyService,
        DnsResolvers,
        DnsLinkagePort,
      ],
    },
    {
      provide: SenderTemplateService,
      useFactory: (db: Db, a: AuditSink) => new SenderTemplateService(db, a),
      inject: [DB, AuditSink],
    },
    {
      provide: SuppressionService,
      useFactory: (db: Db, a: AuditSink, c: FieldCipher) => new SuppressionService(db, a, c),
      inject: [DB, AuditSink, FieldCipher],
    },
    {
      provide: MailboxService,
      useFactory: (
        db: Db,
        a: AuditSink,
        o: DataOperations,
        p: DataProviderService,
        r: DataAdapterRegistry,
        ord: OrderService,
        e: EntitlementService,
        res: ResidencyService,
        s: SecretStore,
        f: DatabaseFlow,
        cfg: DataConfig,
        jobs: DataJobs,
      ) => {
        const m = new MailboxService(db, a, o, p, r, ord, e, res, s, f, cfg);
        m.setKicker((org, id) => jobs.kick(org, id));
        return m;
      },
      inject: [
        DB,
        AuditSink,
        DataOperations,
        DataProviderService,
        DataAdapterRegistry,
        OrderService,
        EntitlementService,
        ResidencyService,
        SecretStore,
        DatabaseFlow,
        DATA_CONFIG,
        DataJobs,
      ],
    },
    {
      provide: MessageService,
      useFactory: (
        db: Db,
        a: AuditSink,
        o: DataOperations,
        p: DataProviderService,
        r: DataAdapterRegistry,
        res: ResidencyService,
        c: FieldCipher,
        st: SenderTemplateService,
        su: SuppressionService,
        f: DatabaseFlow,
        al: DataAlerts,
        fl: DataFlags,
        dcfg: DataConfig,
        cfg: EmailConfig,
        jobs: DataJobs,
      ) => {
        const m = new MessageService(db, a, o, p, r, res, c, st, su, f, al, fl, dcfg, cfg);
        m.setKicker((org, id) => jobs.kick(org, id));
        return m;
      },
      inject: [
        DB,
        AuditSink,
        DataOperations,
        DataProviderService,
        DataAdapterRegistry,
        ResidencyService,
        FieldCipher,
        SenderTemplateService,
        SuppressionService,
        DatabaseFlow,
        DataAlerts,
        DataFlags,
        DATA_CONFIG,
        EMAIL_CONFIG,
        DataJobs,
      ],
    },
    {
      provide: PRICERS,
      useFactory: (
        reg: QuotePricerRegistry,
        db: Db,
        prices: PriceBookService,
        p: DataProviderService,
      ) => {
        reg.register(new EmailPricer(db, prices, p));
        return true;
      },
      inject: [QuotePricerRegistry, DB, PriceBookService, DataProviderService],
    },
    {
      provide: 'EMAIL_OPERATIONS_UNUSED',
      useFactory: (o: OperationsService) => o,
      inject: [OperationsService],
    },
  ],
  exports: [
    EmailDomainService,
    MailboxService,
    SenderTemplateService,
    SuppressionService,
    MessageService,
    DnsResolvers,
    DnsLinkagePort,
  ],
})
export class EmailModule implements OnApplicationBootstrap {
  constructor(
    private readonly jobs: DataJobs,
    private readonly domains: EmailDomainService,
    private readonly mailboxes: MailboxService,
    private readonly messages: MessageService,
    @Inject(PRICERS) _pricers: boolean,
  ) {
    void _pricers;
  }
  onApplicationBootstrap() {
    // rows that still wait for an operation: the data jobs tick runs or reconciles them
    this.jobs.addOpSource(
      `SELECT org_id, operation_id FROM email.mailboxes WHERE state IN ('provisioning','deleting','unknown') AND operation_id IS NOT NULL`,
    );
    this.jobs.addOpSource(
      `SELECT org_id, operation_id FROM email.messages WHERE state IN ('queued','sending','unknown') AND operation_id IS NOT NULL`,
    );
    this.jobs.addOpSource(
      `SELECT org_id, operation_id FROM email.aliases WHERE state IN ('provisioning','unknown') AND operation_id IS NOT NULL`,
    );
    this.jobs.addTask({ name: 'email-domain-recheck', run: (n) => this.domains.verifyDue(n) });
    this.jobs.addTask({ name: 'email-body-retention', run: (n) => this.messages.purgeBodies(n) });
    this.jobs.addTask({
      name: 'email-mailbox-usage',
      run: (n) => this.mailboxes.collectDaily(new Date(n.getTime() - 86_400_000)),
    });
  }
}
