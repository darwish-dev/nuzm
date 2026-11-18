import type {
  AccountContext,
  DataAdapterBase,
  OperationResult,
  ProviderCostRecord,
} from '../upstream';
import type { DatabaseCapabilityId } from './capabilities';
import type {
  BackupRef,
  InstanceInspection,
  IntegrityReport,
  IssuedSecret,
  Network,
  UsageWindow,
} from './common';

export type DbEngine = 'postgresql' | 'mysql';

export interface DatabaseSpec {
  engine: DbEngine;
  /** A supported major as listed by the provider's catalog (config, not code). */
  version: string;
  providerRegionId: string;
  planRef: string;
  storageGb: number;
  /** Opaque, org-neutral instance name (never an org name). */
  name: string;
  network: Network;
  /** Opaque org hash and operation id only: never names or PII. */
  tags: Record<string, string>;
}
export interface DatabaseRef {
  providerRef: string;
}
export interface DatabaseUsage {
  /** Provisioned storage and backup bytes at the end of the window; `null` = not reportable. */
  storageBytes: number | null;
  backupBytes: number | null;
  /** Seconds the instance was running inside the window; `null` = not reportable. */
  runningSeconds: number | null;
}
export interface CredentialRequest {
  role: string;
  idempotencyToken: string;
}

/**
 * docs/09 §5. Two families: `provider-*` (vendor-managed, enabled only when probed) and `self-operated-*` (Nuzm-run on verified compute).
 * Every mutating call carries the deterministic `idempotencyToken`; a timeout is `uncertain` and the orchestrator reconciles via `findByToken`/`inspect`.
 * Unsupported actions are `failed` with category `unsupported` (never a silent no-op).
 */
export interface DatabaseAdapter extends DataAdapterBase<'database', DatabaseCapabilityId> {
  create(
    ctx: AccountContext,
    req: DatabaseSpec & { idempotencyToken: string },
  ): Promise<OperationResult<DatabaseRef>>;
  inspect(ctx: AccountContext, ref: string): Promise<OperationResult<InstanceInspection>>;
  findByToken(ctx: AccountContext, token: string): Promise<OperationResult<DatabaseRef | null>>;
  delete(
    ctx: AccountContext,
    ref: string,
    opts: { idempotencyToken: string },
  ): Promise<OperationResult<void>>;
  resize?(
    ctx: AccountContext,
    ref: string,
    change: { planRef?: string; storageGb?: number; idempotencyToken: string },
  ): Promise<OperationResult<void>>;
  backup(
    ctx: AccountContext,
    ref: string,
    req: { type: BackupRef['type']; idempotencyToken: string },
  ): Promise<OperationResult<BackupRef>>;
  listBackups(ctx: AccountContext, ref: string): Promise<OperationResult<BackupRef[]>>;
  findBackupByToken(
    ctx: AccountContext,
    ref: string,
    token: string,
  ): Promise<OperationResult<BackupRef | null>>;
  deleteBackup(ctx: AccountContext, ref: string, backupRef: string): Promise<OperationResult<void>>;
  /** Restore into a NEW instance in the same provider region (the default and only cross-instance path). */
  restoreToNew(
    ctx: AccountContext,
    req: {
      sourceRef: string;
      backupRef: string;
      target: Omit<DatabaseSpec, 'engine' | 'version'>;
      idempotencyToken: string;
    },
  ): Promise<OperationResult<DatabaseRef>>;
  restoreInPlace?(
    ctx: AccountContext,
    ref: string,
    backupRef: string,
    opts: { idempotencyToken: string },
  ): Promise<OperationResult<void>>;
  /** Create (or replace) a database user; the secret is returned ONCE to the orchestrator. `keepPrevious` implements the dual-credential window. */
  issueCredential(
    ctx: AccountContext,
    ref: string,
    req: CredentialRequest & { keepPrevious: boolean },
  ): Promise<OperationResult<IssuedSecret>>;
  revokeCredential(
    ctx: AccountContext,
    ref: string,
    req: { credentialId: string; idempotencyToken: string },
  ): Promise<OperationResult<void>>;
  /** Credentials that currently authenticate (for the rotation tests: a revoked credential must be absent). */
  listCredentials(
    ctx: AccountContext,
    ref: string,
  ): Promise<OperationResult<{ credentialId: string; role: string }[]>>;
  /** Engine-native check plus row-count/checksum of `sample` tables (restore verification, FR-DAT-10). */
  integrityCheck(
    ctx: AccountContext,
    ref: string,
    opts: { sampleTables: number },
  ): Promise<OperationResult<IntegrityReport>>;
  usage(
    ctx: AccountContext,
    ref: string,
    window: UsageWindow,
  ): Promise<OperationResult<DatabaseUsage>>;
  fetchBilling?(
    ctx: AccountContext,
    period: { from: string; to: string },
  ): Promise<ProviderCostRecord[]>;
}
