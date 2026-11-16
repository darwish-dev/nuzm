import { Global, Module } from '@nestjs/common';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { PriceBookService, QuotaService, SpendService } from '../billing';
import { TaxService } from '../invoicing';
import { OrderService } from './internal/order.service';
import { AiCreditPricer, PlanPricer, QuotePricerRegistry } from './internal/pricers';
import { QuoteService } from './internal/quote.service';
import { QuotesController } from './quotes.controller';

/**
 * Quotes, orders and authorizations (M02). `QuotePricerRegistry` is how the owning milestones (compute M05, hosting M06,
 * domains M07, databases M08, ...) plug in a kind; until then a kind answers `kind_not_available`.
 */
@Global()
@Module({
  controllers: [QuotesController],
  providers: [
    {
      provide: QuotePricerRegistry,
      useFactory: (db: Db, prices: PriceBookService) => {
        const r = new QuotePricerRegistry();
        r.register(new AiCreditPricer(db, prices));
        r.register(new PlanPricer());
        return r;
      },
      inject: [DB, PriceBookService],
    },
    {
      provide: QuoteService,
      useFactory: (
        db: Db,
        a: AuditSink,
        r: QuotePricerRegistry,
        t: TaxService,
        q: QuotaService,
        s: SpendService,
      ) =>
        new QuoteService(db, a, r, t, q, s, {
          ttlMinutes: Number(process.env.QUOTE_TTL_MINUTES ?? 15),
        }),
      inject: [DB, AuditSink, QuotePricerRegistry, TaxService, QuotaService, SpendService],
    },
    {
      provide: OrderService,
      useFactory: (db: Db, a: AuditSink, q: QuotaService, s: SpendService) =>
        new OrderService(db, a, q, s),
      inject: [DB, AuditSink, QuotaService, SpendService],
    },
  ],
  exports: [QuoteService, OrderService, QuotePricerRegistry],
})
export class CommerceModule {}
