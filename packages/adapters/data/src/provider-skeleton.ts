import {
  ALL_DATA_CAPABILITIES,
  CACHE_CAPABILITIES,
  DATABASE_CAPABILITIES,
  MAILBOX_CAPABILITIES,
  OBJECT_STORAGE_CAPABILITIES,
  TRANSACTIONAL_EMAIL_CAPABILITIES,
  completeCapabilities,
} from './contracts/capabilities';
import type { CacheAdapter } from './contracts/cache';
import type { DatabaseAdapter } from './contracts/database';
import type { MailboxAdapter } from './contracts/mailbox';
import type { ObjectStorageAdapter } from './contracts/object-storage';
import type { TransactionalEmailAdapter } from './contracts/transactional-email';
import {
  CONTRACT_VERSION,
  normalizedError,
  type AccountContext,
  type OperationResult,
} from './upstream';

/**
 * `provider-*` family SKELETONS (M08 S32 task 4). A provider-managed adapter may only be implemented against OFFICIAL vendor documentation cited in
 * `docs/adapters/<provider>.md`. No vendor has been selected (D-05..D-09 OPEN) and no documentation has been cited, so every skeleton declares EVERY
 * capability `unknown` (= unsupported), returns `failed/unsupported` for every call and makes NO network call. Implementing a vendor means replacing
 * the relevant methods and citing the documentation: the conformance suites then decide what passes.
 */
const now = () => new Date().toISOString();
const unsupported = <T>(op: string): Promise<OperationResult<T>> =>
  Promise.resolve({
    status: 'failed',
    error: normalizedError(
      'unsupported',
      'SKELETON',
      `${op}: no vendor documentation is cited for this adapter, so the capability is unsupported`,
    ),
    raw: { kind: 'mock', capturedAt: now(), operation: op, summary: 'skeleton: not implemented' },
  });
const base = <K extends string, C extends string>(id: string, kind: K, ids: readonly C[]) => ({
  id,
  kind,
  contractVersion: CONTRACT_VERSION,
  async probe(_ctx: AccountContext) {
    return {
      capabilities: completeCapabilities(ids, {}),
      evidence: [
        {
          kind: 'mock' as const,
          capturedAt: now(),
          operation: 'probe',
          summary: 'skeleton: nothing is probed, every capability is unknown',
        },
      ],
      probedAt: now(),
    };
  },
  async health(_ctx: AccountContext) {
    return { state: 'unknown' as const, checkedAt: now(), detail: 'skeleton' };
  },
  async catalog(_ctx: AccountContext) {
    return { takenAt: now(), regions: [], plans: [], evidence: [] };
  },
});
const u =
  <T>(op: string) =>
  () =>
    unsupported<T>(op);

export const providerDatabaseSkeleton = (id = 'provider-database-skeleton'): DatabaseAdapter => ({
  ...base(id, 'database' as const, DATABASE_CAPABILITIES),
  create: u('create'),
  inspect: u('inspect'),
  findByToken: u('findByToken'),
  delete: u('delete'),
  backup: u('backup'),
  listBackups: u('listBackups'),
  findBackupByToken: u('findBackupByToken'),
  deleteBackup: u('deleteBackup'),
  restoreToNew: u('restoreToNew'),
  issueCredential: u('issueCredential'),
  revokeCredential: u('revokeCredential'),
  listCredentials: u('listCredentials'),
  integrityCheck: u('integrityCheck'),
  usage: u('usage'),
});
export const providerCacheSkeleton = (id = 'provider-cache-skeleton'): CacheAdapter => ({
  ...base(id, 'cache' as const, CACHE_CAPABILITIES),
  create: u('create'),
  inspect: u('inspect'),
  findByToken: u('findByToken'),
  delete: u('delete'),
  failoverInfo: u('failoverInfo'),
  issueCredential: u('issueCredential'),
  revokeCredential: u('revokeCredential'),
  listCredentials: u('listCredentials'),
  usage: u('usage'),
});
export const providerObjectStorageSkeleton = (
  id = 'provider-s3-skeleton',
): ObjectStorageAdapter => ({
  ...base(id, 'object-storage' as const, OBJECT_STORAGE_CAPABILITIES),
  createBucket: u('createBucket'),
  inspectBucket: u('inspectBucket'),
  findBucketByToken: u('findBucketByToken'),
  deleteBucket: u('deleteBucket'),
  putPolicy: u('putPolicy'),
  setLifecycle: u('setLifecycle'),
  issueCredential: u('issueCredential'),
  revokeCredential: u('revokeCredential'),
  presign: u('presign'),
  usage: u('usage'),
  compat: u('compat'),
});
export const providerTransactionalEmailSkeleton = (
  id = 'provider-email-skeleton',
): TransactionalEmailAdapter => ({
  ...base(id, 'transactional-email' as const, TRANSACTIONAL_EMAIL_CAPABILITIES),
  verifyDomain: u('verifyDomain'),
  checkDomain: u('checkDomain'),
  send: u('send'),
  findByToken: u('findByToken'),
  listSuppressions: u('listSuppressions'),
  usage: u('usage'),
  parseWebhook() {
    throw new Error(
      'skeleton: no vendor webhook format is documented, so no webhook can be verified',
    );
  },
});
export const providerMailboxSkeleton = (id = 'provider-mailbox-skeleton'): MailboxAdapter => ({
  ...base(id, 'mailbox' as const, MAILBOX_CAPABILITIES),
  dnsRequirements: u('dnsRequirements'),
  checkDomain: u('checkDomain'),
  provisionMailbox: u('provisionMailbox'),
  findByToken: u('findByToken'),
  inspectMailbox: u('inspectMailbox'),
  addAlias: u('addAlias'),
  removeAlias: u('removeAlias'),
  setQuota: u('setQuota'),
  deleteMailbox: u('deleteMailbox'),
  usage: u('usage'),
});
export const SKELETON_CAPABILITY_COUNT = ALL_DATA_CAPABILITIES.length;
