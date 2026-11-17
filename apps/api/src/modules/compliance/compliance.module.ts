import {
  Global,
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Db as DbClass, OperationsService, type Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { FieldCipher, KeyringFieldCipher } from '../../common/field-crypto';
import { SecretStore } from '../../common/secrets';
import { DB } from '../../common/tokens';
import { IdentityModule } from '../identity';
import { AdminBreachController } from './admin-breach.controller';
import { AdminControlsController } from './admin-controls.controller';
import { AdminEvidenceController } from './admin-evidence.controller';
import { AdminValidationsController } from './admin-validations.controller';
import { BreachService } from './internal/breach/breach.service';
import { loadBreachConfig, type BreachConfig } from './internal/breach/state';
import { ControlsService } from './internal/controls/controls.service';
import { EvidenceService } from './internal/controls/evidence.service';
import { ValidationService } from './internal/validations.service';
import { DsrController } from './dsr.controller';
import { DataExportsController } from './data-exports.controller';
import { AdminTransferAssessmentsController } from './admin-transfer-assessments.controller';
import { AdminLegalHoldsController } from './admin-legal-holds.controller';
import { AdminRetentionController } from './admin-retention.controller';
import { AdminRopaController } from './admin-ropa.controller';
import { ResidencyPolicyController } from './residency-policy.controller';
import { ConsentsController } from './consents.controller';
import { NotificationService } from '../notifications';
import { BUILTIN_HANDLERS } from './internal/dsr/builtin-handlers';
import { DsrService } from './internal/dsr/dsr.service';
import { DsrRegistry } from './internal/dsr/handlers';
import { LegalHoldGate } from './internal/dsr/legal-gate';
import { loadDsrConfig, type DsrConfig } from './internal/dsr/types';
import { ExportService } from './internal/exports/export.service';
import { ExportSink, LocalExportSink, NoExportSink } from './internal/exports/export-sink';
import { ComplianceJobs } from './internal/jobs';
import { ConsentService } from './internal/consent.service';
import { LegalHoldService } from './internal/legal-hold.service';
import { AssessmentService } from './internal/residency/assessment.service';
import { MockRegionRegistry, type RegionRegistry } from './internal/residency/regions';
import { ResidencyService, type ResidencyOptions } from './internal/residency/residency.service';
import { loadResidencyDefaults } from './internal/residency/defaults';
import { RetentionService } from './internal/retention.service';
import { RopaService } from './internal/ropa.service';
import { loadPurposes, type PurposeCatalog } from './internal/purposes';

/** Compliance (M04). S13a: consents. S13b: the record of processing activities (ROPA). S13c: retention policies, legal holds, dry-run retention preview. Purposes are read from spec/compliance/purposes.yaml at start-up; a bad file stops the process. */
const PURPOSES = Symbol('PURPOSES');
const REGIONS = Symbol('REGIONS');
const RESIDENCY_OPTS = Symbol('RESIDENCY_OPTS');
const DSR_CONFIG = Symbol('DSR_CONFIG');
const WORKER_DB = Symbol('WORKER_DB');
const BREACH_CONFIG = Symbol('BREACH_CONFIG');

@Global()
@Module({
  imports: [IdentityModule],
  controllers: [
    ConsentsController,
    AdminRopaController,
    AdminRetentionController,
    AdminLegalHoldsController,
    ResidencyPolicyController,
    AdminTransferAssessmentsController,
    DsrController,
    DataExportsController,
    AdminControlsController,
    AdminEvidenceController,
    AdminValidationsController,
    AdminBreachController,
  ],
  providers: [
    { provide: PURPOSES, useFactory: () => loadPurposes() },
    // field-level encryption (M04 S13d): master keys by vault reference; fails closed in production without them
    {
      provide: FieldCipher,
      useFactory: (s: SecretStore) => new KeyringFieldCipher(s),
      inject: [SecretStore],
    },
    {
      provide: ConsentService,
      useFactory: (db: Db, a: AuditSink, p: PurposeCatalog) => new ConsentService(db, a, p),
      inject: [DB, AuditSink, PURPOSES],
    },
    {
      provide: RopaService,
      useFactory: (db: Db, a: AuditSink) => new RopaService(db, a),
      inject: [DB, AuditSink],
    },
    {
      provide: RetentionService,
      useFactory: (db: Db, a: AuditSink) => new RetentionService(db, a),
      inject: [DB, AuditSink],
    },
    {
      provide: LegalHoldService,
      useFactory: (db: Db, a: AuditSink) => new LegalHoldService(db, a),
      inject: [DB, AuditSink],
    },
    // the cross-organization claim needs the worker role; without WORKER_DATABASE_URL only request-driven execution runs
    {
      provide: WORKER_DB,
      useFactory: () =>
        process.env.WORKER_DATABASE_URL ? new DbClass(process.env.WORKER_DATABASE_URL) : null,
    },
    { provide: BREACH_CONFIG, useFactory: () => loadBreachConfig() },
    {
      provide: ControlsService,
      useFactory: (db: Db, a: AuditSink) => new ControlsService(db, a),
      inject: [DB, AuditSink],
    },
    {
      provide: EvidenceService,
      useFactory: (db: Db, a: AuditSink) => new EvidenceService(db, a),
      inject: [DB, AuditSink],
    },
    {
      provide: ValidationService,
      useFactory: (db: Db, a: AuditSink) => new ValidationService(db, a),
      inject: [DB, AuditSink],
    },
    {
      provide: BreachService,
      useFactory: (db: Db, a: AuditSink, c: BreachConfig) => new BreachService(db, a, c),
      inject: [DB, AuditSink, BREACH_CONFIG],
    },
    { provide: DSR_CONFIG, useFactory: () => loadDsrConfig() },
    {
      provide: DsrRegistry,
      useFactory: () => {
        const r = new DsrRegistry();
        for (const h of BUILTIN_HANDLERS) r.register(h);
        return r;
      },
    },
    { provide: LegalHoldGate, useFactory: (db: Db) => new LegalHoldGate(db), inject: [DB] },
    // production has no export sink until M08 decides it (D-07): requests answer 422 no_export_sink
    {
      provide: ExportSink,
      useFactory: () =>
        process.env.NODE_ENV === 'production' ? new NoExportSink() : new LocalExportSink(),
    },
    {
      provide: ExportService,
      useFactory: (
        db: Db,
        a: AuditSink,
        s: ExportSink,
        f: FieldCipher,
        c: DsrConfig,
        r: DsrRegistry,
      ) => new ExportService(db, a, s, f, c, () => r.all()),
      inject: [DB, AuditSink, ExportSink, FieldCipher, DSR_CONFIG, DsrRegistry],
    },
    {
      provide: DsrService,
      useFactory: (
        db: Db,
        a: AuditSink,
        r: DsrRegistry,
        o: OperationsService,
        g: LegalHoldGate,
        f: FieldCipher,
        e: ExportService,
        c: DsrConfig,
        n: NotificationService,
      ) =>
        new DsrService(db, a, r, o, g, f, e, c, {
          notifyAdmins: async (orgId, kind, params) => {
            const ids = await db.withOrg(orgId, async (cl) =>
              (
                await cl.query(
                  `SELECT user_id FROM tenancy.memberships WHERE org_id = $1 AND role IN ('owner','admin')`,
                  [orgId],
                )
              ).rows.map((x) => x.user_id as string),
            );
            for (const userId of ids) await n.notify({ orgId, userId, kind, params });
          },
        }),
      inject: [
        DB,
        AuditSink,
        DsrRegistry,
        OperationsService,
        LegalHoldGate,
        FieldCipher,
        ExportService,
        DSR_CONFIG,
        NotificationService,
      ],
    },
    {
      provide: ComplianceJobs,
      useFactory: (o: OperationsService, d: DsrService, e: ExportService, db: Db, w: Db | null) =>
        new ComplianceJobs(o, d, e, db, w ? new OperationsService(w) : null),
      inject: [OperationsService, DsrService, ExportService, DB, WORKER_DB],
    },
    { provide: REGIONS, useFactory: () => new MockRegionRegistry() },
    { provide: RESIDENCY_OPTS, useFactory: () => loadResidencyDefaults() },
    {
      provide: ResidencyService,
      useFactory: (db: Db, a: AuditSink, r: RegionRegistry, o: ResidencyOptions) =>
        new ResidencyService(db, a, r, o),
      inject: [DB, AuditSink, REGIONS, RESIDENCY_OPTS],
    },
    {
      provide: AssessmentService,
      useFactory: (db: Db, a: AuditSink, o: ResidencyOptions) =>
        new AssessmentService(db, a, o.maxAssessmentDays),
      inject: [DB, AuditSink, RESIDENCY_OPTS],
    },
  ],
  exports: [
    ConsentService,
    RopaService,
    RetentionService,
    LegalHoldService,
    FieldCipher,
    ResidencyService,
    AssessmentService,
    DsrService,
    DsrRegistry,
    ExportService,
    ComplianceJobs,
    ControlsService,
    EvidenceService,
    ValidationService,
    BreachService,
  ],
})
export class ComplianceModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly jobs: ComplianceJobs,
    @Inject(WORKER_DB) private readonly workerDb: Db | null,
  ) {}
  /** The periodic tick (requests, exports, SLA sweep) runs only when DSR_SCHEDULER_INTERVAL_SECONDS > 0 (off by default; ADR-017). */
  onApplicationBootstrap() {
    this.jobs.start(ComplianceJobs.intervalFromEnv());
  }
  async onApplicationShutdown() {
    this.jobs.stop();
    await this.workerDb?.close();
  }
}
