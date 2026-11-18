import type {
  AccountContext,
  DataAdapterBase,
  OperationResult,
  ProviderCostRecord,
} from '../upstream';
import type { ObjectStorageCapabilityId } from './capabilities';
import type { IssuedSecret, UsageWindow } from './common';

/** The validated policy subset Nuzm accepts (deny-by-default). The adapter translates it; it never passes a raw vendor policy through. */
export interface BucketPolicyDoc {
  version: 1;
  /** `private` = only the bucket's own scoped credentials. `public-read` needs `confirmPublic` at the API and an audit event. */
  access: 'private' | 'public-read';
  statements: {
    effect: 'allow';
    actions: ('read' | 'write' | 'delete' | 'list')[];
    /** Key prefix the statement is limited to (`''` = whole bucket). */
    prefix: string;
    principal: 'bucket-credentials';
  }[];
  cors?: { origins: string[]; methods: ('GET' | 'PUT' | 'HEAD')[]; maxAgeSeconds: number }[];
}
export interface LifecycleRule {
  id: string;
  prefix: string;
  /** Expire objects after N days. */
  expireDays?: number;
  /** Abort incomplete multipart uploads after N days. */
  abortIncompleteMultipartDays?: number;
  /** Transitions exist only with `object-storage.lifecycle.transition`. */
  transition?: { days: number; storageClass: string };
}
export interface BucketSpec {
  /** The globally unique, namespaced bucket name `nz-<orgShort>-<name>`. */
  bucketName: string;
  providerRegionId: string;
  versioning: boolean;
  tags: Record<string, string>;
}
export interface BucketRef {
  providerRef: string;
}
export interface BucketInspection {
  providerRef: string;
  bucketName: string;
  endpoint: string;
  providerRegionId: string;
  versioning: boolean;
  publicAccess: boolean;
  objectCount: number;
  bytesStored: number;
  observedAt: string;
}
export interface BucketUsage {
  bytesStored: number | null;
  /** `null` = the provider cannot report it: the meter is `unavailable`, never estimated (M08 §4 S34 task 4). */
  requests: number | null;
  egressBytes: number | null;
}
export interface SignedUrlRequest {
  key: string;
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  ttlSeconds: number;
}
export interface SignedUrl {
  url: string;
  expiresAt: string;
}
/** Result of the S3-compatibility suite against a real endpoint (AC-M08-13). The list is stored as evidence; unsupported operations disable features. */
export interface S3CompatReport {
  operations: { operation: string; supported: boolean; detail?: string }[];
  signatureVersion: 'v4' | 'v2' | 'unknown';
  testedAt: string;
}

/** docs/09 §5: `ObjectStorageAdapter`, families `provider-s3` and `self-operated-s3`. */
export interface ObjectStorageAdapter extends DataAdapterBase<
  'object-storage',
  ObjectStorageCapabilityId
> {
  createBucket(
    ctx: AccountContext,
    req: BucketSpec & { idempotencyToken: string },
  ): Promise<OperationResult<BucketRef>>;
  inspectBucket(ctx: AccountContext, ref: string): Promise<OperationResult<BucketInspection>>;
  findBucketByToken(ctx: AccountContext, token: string): Promise<OperationResult<BucketRef | null>>;
  /** `force` empties the bucket first; the orchestrator only passes it after the approval step. */
  deleteBucket(
    ctx: AccountContext,
    ref: string,
    opts: { force: boolean; idempotencyToken: string },
  ): Promise<OperationResult<void>>;
  putPolicy(
    ctx: AccountContext,
    ref: string,
    policy: BucketPolicyDoc,
  ): Promise<OperationResult<void>>;
  setLifecycle(
    ctx: AccountContext,
    ref: string,
    rules: LifecycleRule[],
  ): Promise<OperationResult<void>>;
  /** A credential scoped to ONE bucket (or one org prefix): no shared admin key exists at runtime. */
  issueCredential(
    ctx: AccountContext,
    ref: string,
    req: { scope: 'read' | 'readwrite'; idempotencyToken: string },
  ): Promise<OperationResult<IssuedSecret>>;
  revokeCredential(
    ctx: AccountContext,
    ref: string,
    req: { credentialId: string; idempotencyToken: string },
  ): Promise<OperationResult<void>>;
  /** Signs with the bucket-scoped credential; the URL carries the signature and is never logged. */
  presign(
    ctx: AccountContext,
    ref: string,
    req: SignedUrlRequest,
  ): Promise<OperationResult<SignedUrl>>;
  usage(
    ctx: AccountContext,
    ref: string,
    window: UsageWindow,
  ): Promise<OperationResult<BucketUsage>>;
  compat?(ctx: AccountContext): Promise<OperationResult<S3CompatReport>>;
  fetchBilling?(
    ctx: AccountContext,
    period: { from: string; to: string },
  ): Promise<ProviderCostRecord[]>;
}
