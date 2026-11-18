import type {
  AccountContext,
  DataAdapterBase,
  OperationResult,
  ProviderCostRecord,
} from '../upstream';
import type { CacheCapabilityId } from './capabilities';
import type {
  BackupRef,
  InstanceInspection,
  IntegrityReport,
  IssuedSecret,
  Network,
  UsageWindow,
} from './common';

export interface CacheSpec {
  /** Supported major as listed by the provider catalog. */
  version: string;
  providerRegionId: string;
  planRef: string;
  memoryMb: number;
  name: string;
  network: Network;
  /** Only honoured when the account has `cache.persistence`; otherwise the request is `unsupported`. */
  persistence: 'none' | 'rdb' | 'aof';
  evictionPolicy: 'noeviction' | 'allkeys-lru' | 'volatile-lru' | 'allkeys-lfu';
  tags: Record<string, string>;
}
export interface CacheRef {
  providerRef: string;
}
export interface FailoverInfo {
  topology: 'single' | 'primary-replica';
  replicas: number;
  lastFailoverAt: string | null;
}
export interface CacheUsage {
  memoryBytes: number | null;
  runningSeconds: number | null;
}
/** An ACL user: the secret is returned once to the orchestrator. One instance (or verified isolation unit) per org: shared multi-tenant instances are FORBIDDEN (D-06). */
export interface CacheAclRequest {
  role: string;
  /** Redis ACL rule; the orchestrator only passes rules from its own allow-list. */
  acl: string;
  idempotencyToken: string;
}

/** docs/09 §5: `CacheAdapter` (`redis`). */
export interface CacheAdapter extends DataAdapterBase<'cache', CacheCapabilityId> {
  create(
    ctx: AccountContext,
    req: CacheSpec & { idempotencyToken: string },
  ): Promise<OperationResult<CacheRef>>;
  inspect(ctx: AccountContext, ref: string): Promise<OperationResult<InstanceInspection>>;
  findByToken(ctx: AccountContext, token: string): Promise<OperationResult<CacheRef | null>>;
  delete(
    ctx: AccountContext,
    ref: string,
    opts: { idempotencyToken: string },
  ): Promise<OperationResult<void>>;
  resize?(
    ctx: AccountContext,
    ref: string,
    change: { planRef?: string; memoryMb?: number; idempotencyToken: string },
  ): Promise<OperationResult<void>>;
  failoverInfo(ctx: AccountContext, ref: string): Promise<OperationResult<FailoverInfo>>;
  issueCredential(
    ctx: AccountContext,
    ref: string,
    req: CacheAclRequest & { keepPrevious: boolean },
  ): Promise<OperationResult<IssuedSecret>>;
  revokeCredential(
    ctx: AccountContext,
    ref: string,
    req: { credentialId: string; idempotencyToken: string },
  ): Promise<OperationResult<void>>;
  listCredentials(
    ctx: AccountContext,
    ref: string,
  ): Promise<OperationResult<{ credentialId: string; role: string }[]>>;
  /** Only with `cache.persistence` + `cache.backup`. */
  backup?(
    ctx: AccountContext,
    ref: string,
    req: { type: BackupRef['type']; idempotencyToken: string },
  ): Promise<OperationResult<BackupRef>>;
  restoreToNew?(
    ctx: AccountContext,
    req: {
      sourceRef: string;
      backupRef: string;
      target: Omit<CacheSpec, 'version'>;
      idempotencyToken: string;
    },
  ): Promise<OperationResult<CacheRef>>;
  integrityCheck?(
    ctx: AccountContext,
    ref: string,
    opts: { sampleTables: number },
  ): Promise<OperationResult<IntegrityReport>>;
  usage(
    ctx: AccountContext,
    ref: string,
    window: UsageWindow,
  ): Promise<OperationResult<CacheUsage>>;
  fetchBilling?(
    ctx: AccountContext,
    period: { from: string; to: string },
  ): Promise<ProviderCostRecord[]>;
}
