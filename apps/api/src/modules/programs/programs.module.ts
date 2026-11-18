import { Global, Module, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { ActingOrgPort } from '../../common/acting';
import { FlagReader } from '../../common/feature-flags';
import { DB } from '../../common/tokens';
import { AutomationModule } from '../automation';
import { ResellerPriceRuleService } from '../billing';
import { IdentityModule } from '../identity';
import { InvoiceService, TaxService } from '../invoicing';
import { RatingService } from '../metering';
import { OrgService, TenancyModule } from '../tenancy';
import { AgenciesController } from './agencies.controller';
import { ResellersController } from './resellers.controller';
import { ActingOrgService } from './internal/acting.service';
import { AgencyService } from './internal/agency.service';
import { IssuerModelGate } from './internal/issuer';
import { ResellerService } from './internal/reseller.service';
import { StatementService } from './internal/statement.service';

/** Programs (M11 S54): agencies (delegated access) and resellers (sub-organizations, price rules, statements). Everything default OFF (`agency.enabled`, `reseller.enabled`). */
@Global()
@Module({
  imports: [IdentityModule, AutomationModule, TenancyModule],
  controllers: [AgenciesController, ResellersController],
  providers: [
    { provide: IssuerModelGate, useFactory: () => new IssuerModelGate() },
    {
      provide: AgencyService,
      useFactory: (db: Db, a: AuditSink, o: OrgService, f: FlagReader) =>
        new AgencyService(db, a, o, f),
      inject: [DB, AuditSink, OrgService, FlagReader],
    },
    {
      provide: ActingOrgService,
      useFactory: (db: Db, a: AuditSink, o: OrgService, f: FlagReader) =>
        new ActingOrgService(db, a, o, f),
      inject: [DB, AuditSink, OrgService, FlagReader],
    },
    { provide: ActingOrgPort, useExisting: ActingOrgService },
    {
      provide: ResellerService,
      useFactory: (
        db: Db,
        a: AuditSink,
        o: OrgService,
        f: FlagReader,
        p: ResellerPriceRuleService,
      ) => new ResellerService(db, a, o, f, p),
      inject: [DB, AuditSink, OrgService, FlagReader, ResellerPriceRuleService],
    },
    {
      provide: StatementService,
      useFactory: (
        db: Db,
        a: AuditSink,
        r: ResellerService,
        rt: RatingService,
        t: TaxService,
        i: InvoiceService,
        g: IssuerModelGate,
        f: FlagReader,
      ) => new StatementService(db, a, r, rt, t, i, g, f),
      inject: [
        DB,
        AuditSink,
        ResellerService,
        RatingService,
        TaxService,
        InvoiceService,
        IssuerModelGate,
        FlagReader,
      ],
    },
  ],
  exports: [
    AgencyService,
    ActingOrgService,
    ActingOrgPort,
    ResellerService,
    StatementService,
    IssuerModelGate,
  ],
})
export class ProgramsModule implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly agencies: AgencyService) {}
  onApplicationBootstrap() {
    const s = Number(process.env.PROGRAMS_SWEEP_INTERVAL_SECONDS ?? 0);
    if (s > 0) {
      this.timer = setInterval(
        () => void this.agencies.expireDue().catch(() => undefined),
        s * 1000,
      );
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
