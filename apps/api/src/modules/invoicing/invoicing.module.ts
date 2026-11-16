import { Global, Module } from '@nestjs/common';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { SequenceService } from './internal/sequence.service';
import { TaxProfileService } from './internal/tax-profile.service';
import { rulesFromEnv } from './internal/tax-profile.rules';
import { TaxService } from './internal/tax.service';
import { TaxProfileController } from './tax-profile.controller';

/** Invoicing foundations (M03 S08a): tax engine, buyer tax profiles, gapless invoice sequences. Invoices follow in S08b. */
@Global()
@Module({
  controllers: [TaxProfileController],
  providers: [
    {
      provide: TaxService,
      useFactory: (db: Db) => new TaxService(db, TaxService.roundingFromEnv()),
      inject: [DB],
    },
    {
      provide: TaxProfileService,
      useFactory: (db: Db, a: AuditSink) => new TaxProfileService(db, a, rulesFromEnv()),
      inject: [DB, AuditSink],
    },
    { provide: SequenceService, useFactory: () => new SequenceService() },
  ],
  exports: [TaxService, TaxProfileService, SequenceService],
})
export class InvoicingModule {}
