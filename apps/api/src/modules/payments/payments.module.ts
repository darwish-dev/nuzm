import { Global, Module } from '@nestjs/common';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { LedgerPostingService, WalletTopupService } from '../billing';
import { CreditNoteService, InvoiceService } from '../invoicing';
import { PaymentMethodService } from './internal/method.service';
import { PaymentService } from './internal/payment.service';
import { RefundService } from './internal/refund.service';
import { MockPsp } from './internal/psp/mock-psp';
import { PspRegistry } from './internal/psp/registry';
import { AdminRefundsController } from './admin-refunds.controller';
import { WalletTopupsController } from './wallet-topups.controller';
import { PaymentMethodsController } from './payment-methods.controller';
import { PaymentsController } from './payments.controller';
import { PaymentWebhooksController } from './webhooks.controller';

/**
 * Payments (M03 S09). Only the deterministic sandbox PSP exists (D-10 is open): it is registered outside production and its webhook
 * secret is a dev default. In a production profile NO adapter is registered, so no payment can be made until a real one is
 * (HG-03-02 + D-10).
 */
@Global()
@Module({
  controllers: [
    PaymentMethodsController,
    PaymentsController,
    PaymentWebhooksController,
    WalletTopupsController,
    AdminRefundsController,
  ],
  providers: [
    {
      provide: MockPsp,
      useFactory: () =>
        new MockPsp(process.env.PSP_MOCK_WEBHOOK_SECRET ?? 'dev-only-mock-webhook-secret'),
    },
    {
      provide: PspRegistry,
      useFactory: (mock: MockPsp) => {
        const r = new PspRegistry();
        if (process.env.NODE_ENV !== 'production') r.register(mock);
        return r;
      },
      inject: [MockPsp],
    },
    {
      provide: PaymentMethodService,
      useFactory: (db: Db, a: AuditSink, r: PspRegistry) => new PaymentMethodService(db, a, r),
      inject: [DB, AuditSink, PspRegistry],
    },
    {
      provide: PaymentService,
      useFactory: (
        db: Db,
        a: AuditSink,
        l: LedgerPostingService,
        r: PspRegistry,
        i: InvoiceService,
        t: WalletTopupService,
      ) =>
        new PaymentService(db, a, l, r, i, t, {
          returnUrlAllowlist: PaymentService.allowlistFromEnv(),
        }),
      inject: [
        DB,
        AuditSink,
        LedgerPostingService,
        PspRegistry,
        InvoiceService,
        WalletTopupService,
      ],
    },
    {
      provide: RefundService,
      useFactory: (
        db: Db,
        a: AuditSink,
        l: LedgerPostingService,
        r: PspRegistry,
        i: InvoiceService,
        c: CreditNoteService,
      ) => new RefundService(db, a, l, r, i, c),
      inject: [DB, AuditSink, LedgerPostingService, PspRegistry, InvoiceService, CreditNoteService],
    },
  ],
  exports: [RefundService, PaymentService, PaymentMethodService, PspRegistry, MockPsp],
})
export class PaymentsModule {}
