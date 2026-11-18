import { Global, Module } from '@nestjs/common';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { ZatcaDocumentService } from '../invoicing';
import { PspRegistry } from '../payments';
import { AdminReconciliationsController } from './admin-reconciliations.controller';
import { FinrecService, finrecOptsFromEnv } from './internal/finrec.service';
import { ReportService } from './internal/reports.service';
import { AdminRevenueReportsController } from './admin-revenue-reports.controller';
import type { Sources } from './internal/reconcilers';
import { BillSourceRegistry } from './internal/bill-sources';

/**
 * Financial reconciliation (M03 S12). Sources: PSP settlement reports from every adapter that has one (RC-01) and provider bills (RC-04), which
 * do not exist until the M05 adapters: that comparison is reported as skipped, never faked.
 */
@Global()
@Module({
  controllers: [AdminReconciliationsController, AdminRevenueReportsController],
  providers: [
    { provide: BillSourceRegistry, useFactory: () => new BillSourceRegistry() },
    {
      provide: FinrecService,
      useFactory: (
        db: Db,
        a: AuditSink,
        psp: PspRegistry,
        z: ZatcaDocumentService,
        bills: BillSourceRegistry,
      ) => {
        const sources: Sources = {
          settlements: async (from, to) => {
            const adapters = psp.all().filter((x) => typeof x.listSettlements === 'function');
            if (!adapters.length) return null;
            return (await Promise.all(adapters.map((x) => x.listSettlements!(from, to)))).flat();
          },
          bills: (from, to) => bills.collect(from, to),
        };
        const from = process.env.ZATCA_GENERATE_FROM
          ? new Date(process.env.ZATCA_GENERATE_FROM)
          : null;
        return new FinrecService(
          db,
          a,
          sources,
          { mode: z.mode, generateFrom: from, profile: z.profile },
          finrecOptsFromEnv(),
        );
      },
      inject: [DB, AuditSink, PspRegistry, ZatcaDocumentService, BillSourceRegistry],
    },
    {
      provide: ReportService,
      useFactory: (db: Db, a: AuditSink) => new ReportService(db, a),
      inject: [DB, AuditSink],
    },
  ],
  exports: [FinrecService, ReportService, BillSourceRegistry],
})
export class FinrecModule {}
