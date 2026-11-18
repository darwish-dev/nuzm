/**
 * M08 capability vocabulary (docs/09 §1: unprobed = unknown = unsupported). Our ids; they assert nothing about any vendor.
 * NOTE for integration (assumptions doc U-03): M05's `CapabilityId` is a closed union of compute ids; M08 ids are namespaced by kind and
 * `spec/providers/capabilities.schema.json` must list them as well.
 */
export const DATABASE_CAPABILITIES = [
  'database.engine.postgresql',
  'database.engine.mysql',
  'database.provision',
  'database.inspect',
  'database.delete',
  'database.find-by-token',
  'database.tls',
  'database.private-network',
  'database.backup',
  'database.pitr',
  'database.restore-to-new',
  'database.restore-in-place',
  'database.credential-rotation',
  'database.dual-credentials',
  'database.integrity-check',
  'database.resize',
  'database.usage',
  'database.billing-export',
] as const;
export type DatabaseCapabilityId = (typeof DATABASE_CAPABILITIES)[number];

export const CACHE_CAPABILITIES = [
  'cache.provision',
  'cache.inspect',
  'cache.delete',
  'cache.find-by-token',
  'cache.tls',
  'cache.acl',
  'cache.persistence',
  'cache.failover-info',
  'cache.backup',
  'cache.restore-to-new',
  'cache.credential-rotation',
  'cache.dual-credentials',
  'cache.integrity-check',
  'cache.resize',
  'cache.usage',
] as const;
export type CacheCapabilityId = (typeof CACHE_CAPABILITIES)[number];

export const OBJECT_STORAGE_CAPABILITIES = [
  'object-storage.bucket',
  'object-storage.find-by-token',
  'object-storage.policy',
  'object-storage.signed-url',
  'object-storage.scoped-credentials',
  'object-storage.versioning',
  'object-storage.lifecycle.expiry',
  'object-storage.lifecycle.abort-multipart',
  'object-storage.lifecycle.transition',
  'object-storage.usage.bytes',
  'object-storage.usage.requests',
  'object-storage.usage.egress',
  'object-storage.erasure',
  'object-storage.billing-export',
] as const;
export type ObjectStorageCapabilityId = (typeof OBJECT_STORAGE_CAPABILITIES)[number];

export const TRANSACTIONAL_EMAIL_CAPABILITIES = [
  'email.domain-verification',
  'email.send',
  'email.idempotent-send',
  'email.find-by-token',
  'email.webhooks',
  'email.webhook-signature',
  'email.suppression-sync',
  'email.dedicated-ip',
  'email.usage',
  'email.billing-export',
] as const;
export type TransactionalEmailCapabilityId = (typeof TRANSACTIONAL_EMAIL_CAPABILITIES)[number];

export const MAILBOX_CAPABILITIES = [
  'mailbox.provision',
  'mailbox.find-by-token',
  'mailbox.alias',
  'mailbox.quota',
  'mailbox.delete',
  'mailbox.suspend',
  'mailbox.reset-link',
  'mailbox.one-time-secret',
  'mailbox.dns-requirements',
  'mailbox.usage.storage',
  'mailbox.billing-export',
] as const;
export type MailboxCapabilityId = (typeof MAILBOX_CAPABILITIES)[number];

export type DataCapabilityId =
  | DatabaseCapabilityId
  | CacheCapabilityId
  | ObjectStorageCapabilityId
  | TransactionalEmailCapabilityId
  | MailboxCapabilityId;

export const ALL_DATA_CAPABILITIES: readonly DataCapabilityId[] = [
  ...DATABASE_CAPABILITIES,
  ...CACHE_CAPABILITIES,
  ...OBJECT_STORAGE_CAPABILITIES,
  ...TRANSACTIONAL_EMAIL_CAPABILITIES,
  ...MAILBOX_CAPABILITIES,
];

/** Only an explicit `supported` counts. Missing and `unknown` are unsupported. */
export const isSupported = (
  caps: Partial<Record<string, string>> | undefined,
  id: string,
): boolean => caps?.[id] === 'supported';

/** Every id of a kind with an explicit state; ids the probe did not mention become `unknown`. */
export function completeCapabilities<C extends string>(
  ids: readonly C[],
  partial: Partial<Record<C, 'supported' | 'unsupported' | 'unknown'>>,
): Record<C, 'supported' | 'unsupported' | 'unknown'> {
  const out = {} as Record<C, 'supported' | 'unsupported' | 'unknown'>;
  for (const id of ids) out[id] = partial[id] ?? 'unknown';
  return out;
}

/** The service names of `data.data_providers.service` and the adapter kind each one is served by. */
export const DATA_SERVICES = [
  'database',
  'cache',
  'object-storage',
  'transactional-email',
  'mailbox',
] as const;
export type DataService = (typeof DATA_SERVICES)[number];
/** Provider families (docs/09 §5): vendor-managed or Nuzm-run on verified compute. */
export const FAMILY_PATTERN = /^(provider|self-operated)-[a-z][a-z0-9-]{1,40}$/;

/**
 * What a service needs, at minimum, before a provider can be enabled for it (a probe that does not report all of these as `supported`
 * is not a passing probe). Everything else is optional and individually capability-gated.
 */
export const REQUIRED_CAPABILITIES: Record<DataService, readonly DataCapabilityId[]> = {
  database: [
    'database.provision',
    'database.inspect',
    'database.delete',
    'database.find-by-token',
    'database.tls',
    'database.backup',
    'database.restore-to-new',
  ],
  cache: [
    'cache.provision',
    'cache.inspect',
    'cache.delete',
    'cache.find-by-token',
    'cache.tls',
    'cache.acl',
  ],
  'object-storage': [
    'object-storage.bucket',
    'object-storage.find-by-token',
    'object-storage.policy',
    'object-storage.signed-url',
    'object-storage.scoped-credentials',
  ],
  'transactional-email': [
    'email.domain-verification',
    'email.send',
    'email.find-by-token',
    'email.webhooks',
    'email.webhook-signature',
  ],
  mailbox: [
    'mailbox.provision',
    'mailbox.find-by-token',
    'mailbox.dns-requirements',
    'mailbox.delete',
  ],
};
