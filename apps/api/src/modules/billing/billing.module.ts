import { Global, Module } from '@nestjs/common';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { AdminBillingController } from './admin-billing.controller';
import { AdminAdjustmentsController } from './admin-adjustments.controller';
import { AdminPriceBooksController } from './admin-price-books.controller';
import { BillingSpendController } from './billing-spend.controller';
import { QuotasController } from './quotas.controller';
import { BillingController } from './billing.controller';
import { AdjustmentService } from './internal/adjustment.service';
import { BillingReadService } from './internal/billing-read.service';
import { EntitlementService } from './internal/entitlement.service';
import { ResellerPriceRuleService } from './internal/reseller-price-rules.service';
import { LedgerPostingService } from './internal/ledger.service';
import { PlanService } from './internal/plan.service';
import { PriceBookService } from './internal/price-book.service';
import { QuotaService } from './internal/quota.service';
import { SpendService } from './internal/spend.service';
import { WalletTopupService } from './internal/wallet-topup.service';
import { DunningService } from './internal/dunning.service';
import { loadDunningPolicy } from './internal/dunning-policy';
import { SubscriptionService } from './internal/subscription.service';
import { AdminDunningController } from './admin-dunning.controller';
import { NotificationService } from '../notifications';
import { billingManagerIds as approverIds } from '../../common/billing-managers';

/**
 * Ledger, plans and entitlements (M02). `LedgerPostingService` is the only writer of postings and is exported for the
 * modules that bill (metering rating, quotes/approvals in S06/S07, payments in M03).
 */
@Global()
@Module({
  controllers: [
    BillingController,
    AdminBillingController,
    AdminPriceBooksController,
    AdminAdjustmentsController,
    BillingSpendController,
    QuotasController,
    AdminDunningController,
  ],
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
      provide: PriceBookService,
      useFactory: (db: Db, a: AuditSink) => new PriceBookService(db, a),
      inject: [DB, AuditSink],
    },
    {
      provide: AdjustmentService,
      useFactory: (db: Db, l: LedgerPostingService, a: AuditSink) =>
        new AdjustmentService(db, l, a),
      inject: [DB, LedgerPostingService, AuditSink],
    },
    {
      provide: QuotaService,
      useFactory: (db: Db, a: AuditSink, n: NotificationService) =>
        new QuotaService(db, a, async (x) => {
          const recipients = await approverIds(db, x.orgId);
          for (const userId of recipients)
            await n.notify({
              orgId: x.orgId,
              userId,
              kind: 'billing.quota_threshold',
              params: { meterGroup: x.meterGroup, threshold: x.threshold, state: x.state },
            });
        }),
      inject: [DB, AuditSink, NotificationService],
    },
    {
      provide: SpendService,
      useFactory: (db: Db, a: AuditSink, n: NotificationService) =>
        new SpendService(
          db,
          a,
          async (x) => {
            for (const userId of x.recipients)
              await n.notify({
                orgId: x.orgId,
                userId,
                kind:
                  x.kind === 'requested'
                    ? 'billing.spend_approval_requested'
                    : 'billing.spend_approval_decided',
                params: x.params,
              });
          },
          { approvalTtlHours: Number(process.env.SPEND_APPROVAL_TTL_HOURS ?? 24) },
        ),
      inject: [DB, AuditSink, NotificationService],
    },
    {
      // SubscriptionService is provided by the subscriptions module (it needs invoicing and payments); billing reaches it by token only
      provide: DunningService,
      useFactory: (db: Db, a: AuditSink, subs: SubscriptionService, n: NotificationService) =>
        new DunningService(db, a, subs, loadDunningPolicy(), async (orgId, kind, params) => {
          for (const userId of await approverIds(db, orgId))
            await n.notify({ orgId, userId, kind, params });
        }),
      inject: [DB, AuditSink, SubscriptionService, NotificationService],
    },
    {
      provide: WalletTopupService,
      useFactory: (db: Db, a: AuditSink, l: LedgerPostingService) =>
        new WalletTopupService(db, a, l),
      inject: [DB, AuditSink, LedgerPostingService],
    },
    {
      provide: BillingReadService,
      useFactory: (db: Db) => new BillingReadService(db),
      inject: [DB],
    },
    // M11 S54 (appended)
    {
      provide: ResellerPriceRuleService,
      useFactory: (db: Db, a: AuditSink) => new ResellerPriceRuleService(db, a),
      inject: [DB, AuditSink],
    },
  ],
  exports: [
    LedgerPostingService,
    EntitlementService,
    PlanService,
    PriceBookService,
    BillingReadService,
    QuotaService,
    SpendService,
    AdjustmentService,
    WalletTopupService,
    DunningService,
    ResellerPriceRuleService, // M11 S54 (appended)
  ],
})
export class BillingModule {}
