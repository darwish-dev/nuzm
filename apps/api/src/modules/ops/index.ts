// Public surface of the ops module (M12).
export { OpsModule, TR_SOURCES } from './ops.module';
export { AlertService } from './alerts.service';
export { MetricsService } from './metrics.service';
export { HealthService } from './health.service';
export { ProbeRunner, httpProbe } from './probes.service';
export type { Probe } from './probes.service';
export { ProviderIncidentService } from './provider-incidents.service';
export { IncidentService } from './incidents.service';
export { RecoveryExerciseService } from './recovery-exercises.service';
export { TechnicalReconciliationService, NO_SOURCES } from './technical-reconciliation.service';
export type { TrSources, TrResult, Finding } from './technical-reconciliation.service';
