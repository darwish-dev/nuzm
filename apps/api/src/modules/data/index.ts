// Public surface of the data module (managed databases, Redis, object storage).
export { DataModule } from './data.module';
export { DatabaseBindingPort, MemoryBindings, NoBindings } from './internal/binding.port';
export type { DatabaseBinding, RotationNotice } from './internal/binding.port';
export { DataAdapterRegistry, StaticDataAdapterRegistry } from './internal/adapter-registry';
export { DataProviderService } from './internal/provider.service';
export { DatabaseService } from './internal/database.service';
export { DatabaseFlow } from './internal/database-flow';
export { RestoreService } from './internal/restore.service';
export { RotationService } from './internal/rotation.service';
export { DataJobs } from './internal/jobs';
export { DataMetering } from './internal/metering';
export { DataAlerts } from './internal/alerts';
export { DataOperations } from './internal/operations-port';
export { StorageService } from './internal/storage.service';
export { StorageFlow, SYSTEM_ORG } from './internal/storage-flow';
// building blocks the email module (and later M06/M09/M10) reuse
export { OP, DATA_CONFIG, isUuid, loadDataConfig } from './internal/model';
export type { DataConfig, Row as DataRow } from './internal/model';
export { FlowFailure, FlowUncertain, outcomeOf, retryTransient } from './internal/flow-support';
export type { Outcome } from './internal/flow-support';
export { DataFlags } from './internal/flags';
export { gibMonthFraction, gibMonthFractionOfGb } from './internal/metering';
export { priceLines } from './internal/pricers';
export type { PriceLine } from './internal/pricers';
export type { DataAlert } from './internal/alerts';
export type { ProviderDto } from './internal/provider.service';
export { assertRecentMfa } from './internal/storage.service';
