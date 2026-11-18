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
