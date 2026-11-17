import { Global, Module, type OnModuleInit } from '@nestjs/common';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { productionPricing } from '../../common/pricing';
import { ProblemException } from '../../common/errors';
import { DB } from '../../common/tokens';
import {
  EntitlementService,
  PriceBookService,
  SubscriptionService,
  subscriptionPolicyFromEnv,
  type SubscriptionPorts,
} from '../billing';
import { InvoiceService } from '../invoicing';
import { PaymentMethodService, PaymentService } from '../payments';
import { SubscriptionsController } from './subscriptions.controller';

/**
 * Subscriptions (M03 S10b). The service lives with the billing module (it owns `billing.subscriptions`) and talks to invoicing and payments
 * only through the ports below, wired here so billing never imports those modules (no import cycle). Renewal is run by `runDue`; where that
 * is scheduled is decided in S10c together with dunning.
 */
const returnUrl = () => `${PaymentService.allowlistFromEnv()[0]!}/billing/payment-return`;

@Global()
@Module({
  controllers: [SubscriptionsController],
  providers: [
    {
      provide: SubscriptionService,
      useFactory: (
        db: Db,
        a: AuditSink,
        p: PriceBookService,
        e: EntitlementService,
        inv: InvoiceService,
        pay: PaymentService,
        m: PaymentMethodService,
      ) => {
        const ports: SubscriptionPorts = {
          invoices: {
            issueCharge: async (orgId, input, actor, now) => {
              const r = await inv.issueSubscriptionCharge(orgId, input, actor, now);
              return { id: r.invoice.id, status: r.invoice.status };
            },
            status: async (orgId, id) => (await inv.get(orgId, id)).status,
          },
          payments: {
            pay: async (orgId, actor, x, now) => {
              if (!actor) throw new ProblemException('conflict', 'the subscription has no payer');
              const r = await pay.create(
                orgId,
                actor,
                {
                  invoiceId: x.invoiceId,
                  paymentMethodId: x.paymentMethodId,
                  returnUrl: returnUrl(),
                },
                now,
              );
              const s = r.payment.status;
              return {
                status:
                  s === 'succeeded' || s === 'partially_refunded' || s === 'refunded'
                    ? 'succeeded'
                    : s === 'processing'
                      ? 'processing'
                      : s === 'requires_action'
                        ? 'requires_action'
                        : 'failed',
                failureCode: r.payment.failureCode,
              };
            },
          },
          methods: { assertUsable: (orgId, id) => m.assertUsable(orgId, id) },
        };
        return new SubscriptionService(db, a, p, e, ports, {
          ...subscriptionPolicyFromEnv(),
          production: productionPricing,
        });
      },
      inject: [
        DB,
        AuditSink,
        PriceBookService,
        EntitlementService,
        InvoiceService,
        PaymentService,
        PaymentMethodService,
      ],
    },
  ],
  exports: [SubscriptionService],
})
export class SubscriptionsModule implements OnModuleInit {
  constructor(
    private readonly subs: SubscriptionService,
    private readonly methods: PaymentMethodService,
  ) {}
  onModuleInit() {
    // a payment method that a live subscription charges cannot be removed
    this.methods.registerUsageGuard((orgId, id) => this.subs.methodInUse(orgId, id));
  }
}
