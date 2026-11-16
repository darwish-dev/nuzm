import { Global, Module } from '@nestjs/common';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { AdminBillingController } from './admin-billing.controller';
import { BillingController } from './billing.controller';
import { BillingReadService } from './internal/billing-read.service';
import { EntitlementService } from './internal/entitlement.service';
import { LedgerPostingService } from './internal/ledger.service';
import { PlanService } from './internal/plan.service';

/**
 * Ledger, plans and entitlements (M02). `LedgerPostingService` is the only writer of postings and is exported for the
 * modules that bill (metering rating, quotes/approvals in S06/S07, payments in M03).
 */
@Global()
@Module({
  controllers: [BillingController, AdminBillingController],
  providers: [
    {
      provide: LedgerPostingService,
      useFactory: (db: Db, a: AuditSink) => new LedgerPostingService(db, a),
      inject: [DB, AuditSink],
    },
    {
      provide: PlanService,
      useFactory: (db: Db, a: AuditSink) => new PlanService(db, a),
      inject: [DB, AuditSink],
    },
    {
      provide: EntitlementService,
      useFactory: (db: Db, a: AuditSink) => new EntitlementService(db, a),
      inject: [DB, AuditSink],
    },
    {
      provide: BillingReadService,
      useFactory: (db: Db) => new BillingReadService(db),
      inject: [DB],
    },
  ],
  exports: [LedgerPostingService, EntitlementService, PlanService, BillingReadService],
})
export class BillingModule {}
