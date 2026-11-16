import { Global, Module } from '@nestjs/common';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { LedgerPostingService, PriceBookService, QuotaService } from '../billing';
import { AdminMeteringController } from './admin-metering.controller';
import { InternalMeteringController } from './internal-metering.controller';
import { UsageController } from './usage.controller';
import { MeteringIngestService } from './internal/ingest.service';
import { MeterService } from './internal/meter.service';
import { ProducerAuthenticator, loadProducerKeys } from './internal/producer-auth';
import { ProviderCostService } from './internal/provider-cost.service';
import { RatingService } from './internal/rating.service';
import { UsageService } from './internal/usage.service';

/** The one metering pipeline: ingest, aggregation, rating, provider cost. Producers never write usage tables directly. */
@Global()
@Module({
  controllers: [InternalMeteringController, AdminMeteringController, UsageController],
  providers: [
    {
      provide: ProducerAuthenticator,
      useFactory: () => new ProducerAuthenticator(loadProducerKeys()),
    },
    {
      provide: MeteringIngestService,
      // after aggregation the touched organizations' quotas are re-evaluated (announces 80/100 % once, never fails the ingest)
      useFactory: (db: Db, q: QuotaService) =>
        new MeteringIngestService(db, async (orgId) => {
          try {
            await q.evaluate(orgId);
          } catch (e) {
            process.stderr.write(
              JSON.stringify({
                metering: 'quota_evaluation_failed',
                orgId,
                error: (e as Error).message,
              }) + '\n',
            );
          }
        }),
      inject: [DB, QuotaService],
    },
    { provide: UsageService, useFactory: (db: Db) => new UsageService(db), inject: [DB] },
    {
      provide: MeterService,
      useFactory: (db: Db, a: AuditSink) => new MeterService(db, a),
      inject: [DB, AuditSink],
    },
    {
      provide: RatingService,
      useFactory: (db: Db, p: PriceBookService, a: AuditSink) => new RatingService(db, p, a),
      inject: [DB, PriceBookService, AuditSink],
    },
    {
      provide: ProviderCostService,
      useFactory: (db: Db, l: LedgerPostingService, a: AuditSink) =>
        new ProviderCostService(db, l, a),
      inject: [DB, LedgerPostingService, AuditSink],
    },
  ],
  exports: [UsageService, MeteringIngestService, RatingService, MeterService, ProviderCostService],
})
export class MeteringModule {}
