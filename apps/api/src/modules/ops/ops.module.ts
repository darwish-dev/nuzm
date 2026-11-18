import { Module } from '@nestjs/common';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { AlertService } from './alerts.service';
import { HealthService } from './health.service';
import { IncidentService } from './incidents.service';
import { MetricsService } from './metrics.service';
import { OpsController } from './ops.controller';
import { ProbeRunner } from './probes.service';
import { ProviderIncidentService } from './provider-incidents.service';
import { RecoveryExerciseService } from './recovery-exercises.service';
import {
  NO_SOURCES,
  TechnicalReconciliationService,
  type TrSources,
} from './technical-reconciliation.service';

export const TR_SOURCES = Symbol('TR_SOURCES');

/** M12 operations: health, incidents, alerts, provider incidents, recovery exercises, synthetic probes, TR-01..04. Feature flag `ops.enabled`: the API stays reachable but nothing here runs a job unless the worker is configured. */
@Module({
  controllers: [OpsController],
  providers: [
    { provide: TR_SOURCES, useValue: NO_SOURCES }, // adapters / fixtures are bound by the environment that holds the credentials
    { provide: MetricsService, useFactory: (db: Db) => new MetricsService(db), inject: [DB] },
    {
      provide: HealthService,
      useFactory: (db: Db, m: MetricsService) => new HealthService(db, m),
      inject: [DB, MetricsService],
    },
    {
      provide: IncidentService,
      useFactory: (db: Db, a: AuditSink) => new IncidentService(db, a),
      inject: [DB, AuditSink],
    },
    {
      provide: AlertService,
      useFactory: (db: Db, a: AuditSink) => new AlertService(db, a),
      inject: [DB, AuditSink],
    },
    {
      provide: ProviderIncidentService,
      useFactory: (db: Db) => new ProviderIncidentService(db),
      inject: [DB],
    },
    {
      provide: RecoveryExerciseService,
      useFactory: (db: Db, a: AuditSink) => new RecoveryExerciseService(db, a),
      inject: [DB, AuditSink],
    },
    { provide: ProbeRunner, useFactory: (db: Db) => new ProbeRunner(db), inject: [DB] },
    {
      provide: TechnicalReconciliationService,
      useFactory: (db: Db, a: AuditSink, s: TrSources) =>
        new TechnicalReconciliationService(db, a, s),
      inject: [DB, AuditSink, TR_SOURCES],
    },
  ],
  exports: [
    AlertService,
    MetricsService,
    HealthService,
    ProbeRunner,
    ProviderIncidentService,
    TechnicalReconciliationService,
    IncidentService,
    RecoveryExerciseService,
  ],
})
export class OpsModule {}
