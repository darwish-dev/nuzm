// Public surface of the compliance module.
export { ComplianceModule } from './compliance.module';
export { ConsentService, selfRef, ORG_SUBJECT } from './internal/consent.service';
export type { ConsentDto, Caller } from './internal/consent.service';
export { loadPurposes, parsePurposes } from './internal/purposes';
export type { Purpose, PurposeCatalog } from './internal/purposes';
export { RopaService, parseRopaInput } from './internal/ropa.service';
export type { RopaDto, RopaInput, Processor } from './internal/ropa.service';
export {
  RetentionService,
  RETENTION_TARGETS,
  parsePolicyInput,
} from './internal/retention.service';
export type { PolicyDto, TargetPreview, RetentionPreview } from './internal/retention.service';
export { LegalHoldService, parseHoldRequest } from './internal/legal-hold.service';
export type { HoldDto } from './internal/legal-hold.service';
export { ResidencyService } from './internal/residency/residency.service';
export type { PolicyView, ResidencyOptions } from './internal/residency/residency.service';
export { AssessmentService } from './internal/residency/assessment.service';
export type { AssessmentDto } from './internal/residency/assessment.service';
export { MockRegionRegistry } from './internal/residency/regions';
export { evaluate as evaluateResidency } from './internal/residency/evaluator';
export { DsrService, DSR_KIND } from './internal/dsr/dsr.service';
export type { DsrDto } from './internal/dsr/dsr.service';
export { DsrRegistry } from './internal/dsr/handlers';
export type { DsrHandler, HandlerCtx, HandlerResult } from './internal/dsr/handlers';
export { ExportService, EXPORT_KIND } from './internal/exports/export.service';
export { ExportSink, MemoryExportSink } from './internal/exports/export-sink';
export { ComplianceJobs } from './internal/jobs';
