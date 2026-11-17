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
import { ZatcaOnboardingService } from './internal/zatca/onboarding.service';
import { ZatcaPipelineService } from './internal/zatca/pipeline.service';
import { ZatcaSubmissionService } from './internal/zatca/submission.service';
import { DevFileSecretStore } from './internal/zatca/secrets';
import { DevFileVault } from './internal/zatca/signing';
import { SimulatedZatca } from './internal/zatca/simulated-adapter';
import { AdminZatcaController } from './admin-zatca.controller';
import { CreditNotesController } from './credit-notes.controller';
import { InvoicesController } from './invoices.controller';
import { TaxProfileController } from './tax-profile.controller';
import { LedgerPostingService } from '../billing';
import { RatingService } from '../metering';

/** Invoicing foundations (M03 S08a): tax engine, buyer tax profiles, gapless invoice sequences. Invoices follow in S08b. */
@Global()
@Module({
  controllers: [
    TaxProfileController,
    InvoicesController,
    CreditNotesController,
    AdminZatcaController,
  ],
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
        z: ZatcaSubmissionService,
      ) => new InvoiceService(db, a, l, t, r, s, p, InvoiceService.optsFromEnv(), z),
      inject: [
        DB,
        AuditSink,
        LedgerPostingService,
        TaxService,
        RatingService,
        SequenceService,
        ChromePdfRenderer,
        ZatcaSubmissionService,
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
    // ---- E-invoicing (S11; SYNTHETIC profile, SIMULATED server). ZATCA_MODE defaults to off: nothing runs until it is switched on. ----
    { provide: LocalWormArchive, useFactory: () => new LocalWormArchive() },
    // the development vault and secret store refuse a production profile, so they are built only when e-invoicing is on
    {
      provide: DevFileVault,
      useFactory: () =>
        ZatcaDocumentService.modeFromEnv() === 'off' ? (undefined as never) : new DevFileVault(),
    },
    {
      provide: DevFileSecretStore,
      useFactory: () =>
        ZatcaDocumentService.modeFromEnv() === 'off'
          ? (undefined as never)
          : new DevFileSecretStore(),
    },
    {
      provide: SimulatedZatca,
      useFactory: () =>
        new SimulatedZatca(
          ZatcaDocumentService.modeFromEnv() === 'simulation' ? 'simulation' : 'sandbox',
        ),
    },
    {
      provide: ZatcaDocumentService,
      useFactory: (db: Db, a: AuditSink, archive: LocalWormArchive) =>
        new ZatcaDocumentService(db, a, loadProfile(), archive, ZatcaDocumentService.modeFromEnv()),
      inject: [DB, AuditSink, LocalWormArchive],
    },
    {
      provide: ZatcaSubmissionService,
      useFactory: (
        db: Db,
        a: AuditSink,
        d: ZatcaDocumentService,
        adapter: SimulatedZatca,
        s: DevFileSecretStore,
        archive: LocalWormArchive,
      ) =>
        new ZatcaSubmissionService(
          db,
          a,
          d,
          adapter,
          s,
          archive,
          ZatcaSubmissionService.optsFromEnv(),
        ),
      inject: [
        DB,
        AuditSink,
        ZatcaDocumentService,
        SimulatedZatca,
        DevFileSecretStore,
        LocalWormArchive,
      ],
    },
    {
      provide: ZatcaOnboardingService,
      useFactory: (
        db: Db,
        a: AuditSink,
        d: ZatcaDocumentService,
        adapter: SimulatedZatca,
        v: DevFileVault,
        s: DevFileSecretStore,
      ) => new ZatcaOnboardingService(db, a, d, adapter, v, s),
      inject: [
        DB,
        AuditSink,
        ZatcaDocumentService,
        SimulatedZatca,
        DevFileVault,
        DevFileSecretStore,
      ],
    },
    {
      provide: ZatcaPipelineService,
      useFactory: (db: Db, d: ZatcaDocumentService, s: ZatcaSubmissionService, v: DevFileVault) =>
        new ZatcaPipelineService(db, d, s, v, ZatcaPipelineService.generateFromEnv()),
      inject: [DB, ZatcaDocumentService, ZatcaSubmissionService, DevFileVault],
    },
  ],
  exports: [
    TaxService,
    TaxProfileService,
    SequenceService,
    InvoiceService,
    CreditNoteService,
    ZatcaDocumentService,
    ZatcaSubmissionService,
    ZatcaOnboardingService,
    ZatcaPipelineService,
    SimulatedZatca,
    DevFileVault,
    DevFileSecretStore,
  ],
})
export class InvoicingModule {}
