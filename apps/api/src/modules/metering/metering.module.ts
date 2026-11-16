import { Global, Module } from '@nestjs/common';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { LedgerPostingService, PriceBookService } from '../billing';
import { AdminMeteringController } from './admin-metering.controller';
import { InternalMeteringController } from './internal-metering.controller';
import { MeteringIngestService } from './internal/ingest.service';
import { MeterService } from './internal/meter.service';
import { ProducerAuthenticator, loadProducerKeys } from './internal/producer-auth';
import { ProviderCostService } from './internal/provider-cost.service';
import { RatingService } from './internal/rating.service';

/** The one metering pipeline: ingest, aggregation, rating, provider cost. Producers never write usage tables directly. */
@Global()
@Module({
  controllers: [InternalMeteringController, AdminMeteringController],
  providers: [
    {
      provide: ProducerAuthenticator,
      useFactory: () => new ProducerAuthenticator(loadProducerKeys()),
    },
    {
      provide: MeteringIngestService,
      useFactory: (db: Db) => new MeteringIngestService(db),
      inject: [DB],
    },
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
  exports: [MeteringIngestService, RatingService, MeterService, ProviderCostService],
})
export class MeteringModule {}
