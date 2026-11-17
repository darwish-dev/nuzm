import { Global, Module } from '@nestjs/common';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { CreditNoteService } from './internal/credit-note.service';
import { InvoiceService } from './internal/invoice.service';
import { ChromePdfRenderer, type PdfRenderer } from './internal/pdf.renderer';
import { SequenceService } from './internal/sequence.service';
import { TaxProfileService } from './internal/tax-profile.service';
import { rulesFromEnv } from './internal/tax-profile.rules';
import { TaxService } from './internal/tax.service';
import { LocalWormArchive } from './internal/zatca/archive';
import { loadProfile } from './internal/zatca/profile';
import { ZatcaDocumentService } from './internal/zatca/zatca-document.service';
import { CreditNotesController } from './credit-notes.controller';
import { InvoicesController } from './invoices.controller';
import { TaxProfileController } from './tax-profile.controller';
import { LedgerPostingService } from '../billing';
import { RatingService } from '../metering';

/** Invoicing foundations (M03 S08a): tax engine, buyer tax profiles, gapless invoice sequences. Invoices follow in S08b. */
@Global()
@Module({
  controllers: [TaxProfileController, InvoicesController, CreditNotesController],
  providers: [
    {
      provide: TaxService,
      useFactory: (db: Db) =>
        new TaxService(db, TaxService.roundingFromEnv(), TaxService.defaultScopeFromEnv()),
      inject: [DB],
    },
    {
      provide: TaxProfileService,
      useFactory: (db: Db, a: AuditSink) => new TaxProfileService(db, a, rulesFromEnv()),
      inject: [DB, AuditSink],
    },
    { provide: SequenceService, useFactory: () => new SequenceService() },
    { provide: ChromePdfRenderer, useFactory: () => new ChromePdfRenderer() },
    {
      provide: InvoiceService,
      useFactory: (
        db: Db,
        a: AuditSink,
        l: LedgerPostingService,
        t: TaxService,
        r: RatingService,
        s: SequenceService,
        p: PdfRenderer,
      ) => new InvoiceService(db, a, l, t, r, s, p, InvoiceService.optsFromEnv()),
      inject: [
        DB,
        AuditSink,
        LedgerPostingService,
        TaxService,
        RatingService,
        SequenceService,
        ChromePdfRenderer,
      ],
    },
    {
      provide: CreditNoteService,
      useFactory: (
        db: Db,
        a: AuditSink,
        l: LedgerPostingService,
        s: SequenceService,
        p: PdfRenderer,
      ) => new CreditNoteService(db, a, l, s, p, TaxService.roundingFromEnv()),
      inject: [DB, AuditSink, LedgerPostingService, SequenceService, ChromePdfRenderer],
    },
    {
      // E-invoice documents (S11a, SYNTHETIC profile). ZATCA_MODE defaults to off: nothing is generated until it is switched on.
      provide: ZatcaDocumentService,
      useFactory: (db: Db, a: AuditSink) =>
        new ZatcaDocumentService(
          db,
          a,
          loadProfile(),
          new LocalWormArchive(),
          ZatcaDocumentService.modeFromEnv(),
        ),
      inject: [DB, AuditSink],
    },
  ],
  exports: [
    TaxService,
    TaxProfileService,
    SequenceService,
    InvoiceService,
    CreditNoteService,
    ZatcaDocumentService,
  ],
})
export class InvoicingModule {}
