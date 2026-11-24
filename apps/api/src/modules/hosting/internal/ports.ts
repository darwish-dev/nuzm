/**
 * Ports of the hosting module. Everything the module needs from other milestones (M05 compute, M07 domains, M08 databases / object storage,
 * the vault) is a port here with an in-memory or mock implementation; the real implementations plug in later without changing the services
 * (docs/reports/M06-m05-interface-assumptions.md). Nothing in this file asserts what a panel or a provider can do.
 */
import type {
  AccountContext,
  CapabilityState,
  HealthReport,
  OperationResult,
  RawEvidence,
} from './m05-contracts';

/* ───────────── capability vocabulary of a hosting node (our ids; unknown = unsupported) ───────────── */
export const HOSTING_CAPABILITIES = [
  'hosting.site.create',
  'hosting.site.delete',
  'hosting.site.suspend',
  'hosting.site.find-by-token',
  'hosting.domain.bind',
  'hosting.cert.issue',
  'hosting.cert.install-custom',
  'hosting.backup.create',
  'hosting.backup.restore',
  'hosting.quota.apply',
  'hosting.usage.report',
  'hosting.db.binding',
  'hosting.runtime.php',
  'hosting.runtime.nodejs',
  'hosting.runtime.static',
  'hosting.runtime.python',
  'hosting.runtime.reverse-proxy',
] as const;
export type HostingCapabilityId = (typeof HOSTING_CAPABILITIES)[number];
export interface HostingCapabilityReport {
  capabilities: Record<HostingCapabilityId, CapabilityState>;
  /** Runtime ids the node offers, as REPORTED by the probe (never assumed): e.g. `php:8.3`, `nodejs:22`, `static`. */
  runtimes: string[];
  probedAt: string;
  evidence: RawEvidence[];
}
export const RUNTIME_ID =
  /^(php|nodejs|python):[0-9]{1,2}(\.[0-9]{1,2})?$|^static$|^reverse-proxy$/;

/* ───────────── HostingAdapter (docs/09 §3) ───────────── */
export interface NodeRef {
  nodeId: string;
  computeInstanceId: string;
}
export interface NodeState {
  observedAt: string;
  /** the panel software's version (HestiaCP: `v-list-sys-info` HESTIA) */
  panelVersion: string | null;
  /** `hestia` for a real node, `mock` for the test double */
  panelKind: string;
  health: HealthReport;
  capacity: { cpuMillicores: number; memoryMb: number; diskMb: number };
  usage: { loadAvg1: number; memoryUsedMb: number; diskUsedMb: number; sites: number };
  runtimes: string[];
}
export interface SiteLimits {
  diskMb: number;
  inodes: number;
  /** processes / memory per site (cgroup-style limits; applied by the agent on system primitives). */
  maxProcesses: number;
  memoryMb: number;
  bandwidthGbMonth: number;
}
export interface SiteSpec {
  /** The site NAME on the node, derived from the idempotency token: `s-<12..40 lowercase alnum>`. Reconcile-before-retry looks sites up by it. */
  name: string;
  runtime: string;
  /** Primary domain, or the platform-hosted placeholder domain when the customer has not bound one yet. */
  domain: string;
  limits: SiteLimits;
  /** vault reference of the per-site credentials (SFTP/DB); the agent resolves it, never the control plane. */
  credentialsRef: string;
  /** vault reference of the per-site backup encryption key. */
  backupKeyRef: string;
}
export interface SiteRef {
  name: string;
  systemUser: string;
  homePath: string;
}
export interface SiteInfo extends SiteRef {
  runtime: string;
  domains: string[];
  suspended: boolean;
  limits: SiteLimits;
}
export interface CertRef {
  certId: string;
  notAfter: string;
  domains: string[];
}
export interface BackupRef {
  backupId: string;
  sizeBytes: number;
  checksum: string;
  /** where the (already encrypted) archive was stored */
  sinkRef?: string;
  manifest: { path: string; sha256: string; bytes: number }[];
}
export interface SiteUsage {
  observedAt: string;
  diskBytes: number;
  inodes: number;
  /** cumulative bytes served this calendar month (from per-site access logs) */
  bandwidthBytesMonth: number;
  cpuSeconds: number;
  processes: number;
  /** abuse signals measured on the node (egress policy counters, process names): optional, absent = unknown */
  smtpEgressAttempts?: number;
  processNames?: string[];
}
export interface SiteWipeReport {
  site: string;
  filesRemaining: number;
  databasesRemaining: number;
  usersRemaining: number;
  vhostsRemaining: number;
  certificatesRemaining: number;
  cronEntriesRemaining: number;
}

export interface HostingAdapter {
  readonly id: string;
  readonly kind: 'hosting';
  readonly contractVersion: string;
  probe(ctx: AccountContext, node: NodeRef): Promise<HostingCapabilityReport>;
  health(ctx: AccountContext, node: NodeRef): Promise<HealthReport>;
  inventory(ctx: AccountContext, node: NodeRef): Promise<OperationResult<NodeState>>;
  createSite(
    ctx: AccountContext,
    node: NodeRef,
    spec: SiteSpec & { idempotencyToken: string; operationId: string },
  ): Promise<OperationResult<SiteRef>>;
  /** Reconcile-before-retry: look a site up by the name derived from its token. `null` data = provably absent. */
  findByToken(
    ctx: AccountContext,
    node: NodeRef,
    siteName: string,
  ): Promise<OperationResult<SiteInfo | null>>;
  updateSite(
    ctx: AccountContext,
    node: NodeRef,
    siteName: string,
    patch: { limits?: SiteLimits; runtime?: string; domains?: string[] },
    t: { idempotencyToken: string; operationId: string },
  ): Promise<OperationResult<SiteInfo>>;
  suspendSite(
    ctx: AccountContext,
    node: NodeRef,
    siteName: string,
    t: { idempotencyToken: string; operationId: string },
  ): Promise<OperationResult<void>>;
  resumeSite(
    ctx: AccountContext,
    node: NodeRef,
    siteName: string,
    t: { idempotencyToken: string; operationId: string },
  ): Promise<OperationResult<void>>;
  deleteSite(
    ctx: AccountContext,
    node: NodeRef,
    siteName: string,
    t: { idempotencyToken: string; operationId: string },
  ): Promise<OperationResult<SiteWipeReport>>;
  issueCertificate(
    ctx: AccountContext,
    node: NodeRef,
    siteName: string,
    req: { domains: string[]; mode: 'managed' | 'custom'; customCertRef?: string },
    t: { idempotencyToken: string; operationId: string },
  ): Promise<OperationResult<CertRef>>;
  backup(
    ctx: AccountContext,
    node: NodeRef,
    siteName: string,
    t: { idempotencyToken: string; operationId: string; backupId?: string },
  ): Promise<OperationResult<BackupRef>>;
  restore(
    ctx: AccountContext,
    node: NodeRef,
    siteName: string,
    backup: BackupRef,
    t: { idempotencyToken: string; operationId: string },
  ): Promise<OperationResult<{ verified: boolean; checksum: string }>>;
  usage(ctx: AccountContext, node: NodeRef, siteName: string): Promise<OperationResult<SiteUsage>>;
  /** Read-only residual check after a delete (files, DB, user, vhost, certificates, cron entries left on the node). */
  verifyWipe(
    ctx: AccountContext,
    node: NodeRef,
    siteName: string,
  ): Promise<OperationResult<SiteWipeReport>>;
}

/* ───────────── ports for other milestones (mocks now) ───────────── */
/** M05: the platform-owned instance a node runs on. Real implementation = ComputeAdapter/`compute.instances` (assumption A-02). */
export interface ComputeInstanceInfo {
  computeInstanceId: string;
  region: string;
  dataRegion: string;
  vcpu: number;
  memoryMb: number;
  diskGb: number;
  status: 'running' | 'stopped' | 'unknown';
}
export interface ComputeProvisioningPort {
  describe(computeInstanceId: string): Promise<ComputeInstanceInfo | null>;
  provision(req: {
    idempotencyToken: string;
    dataRegion: string;
    vcpu: number;
    memoryMb: number;
    diskGb: number;
  }): Promise<ComputeInstanceInfo>;
}
export const COMPUTE_PROVISIONING = Symbol('COMPUTE_PROVISIONING');

/** M07: proves a customer controls a domain. Mock now; the real one checks the DNS TXT / HTTP challenge. */
export interface DomainChallenge {
  method: 'dns_txt' | 'http';
  record: { name: string; type: 'TXT'; value: string } | { url: string; body: string };
}
export interface DomainOwnershipVerifier {
  challenge(orgId: string, siteId: string, domain: string, token: string): DomainChallenge;
  verify(orgId: string, siteId: string, domain: string, token: string): Promise<boolean>;
}
export const DOMAIN_VERIFIER = Symbol('DOMAIN_VERIFIER');

/** M08: managed databases. Without a provider `enabled()` is false and the API answers 422 unsupported_capability. */
export interface DatabaseBindingProvider {
  enabled(): boolean;
  bind(orgId: string, siteId: string, databaseId: string): Promise<{ bindingId: string }>;
}
export const DATABASE_BINDING_PROVIDER = Symbol('DATABASE_BINDING_PROVIDER');

/** D-07 / P-M06-1: where backup archives go. `node-local-segregated` is for dev/staging only; production has NO sink until the owner decides. */
export interface BackupSinkPut {
  ref: string;
  sizeBytes: number;
  checksum: string;
  region: string;
}
export interface BackupSink {
  readonly kind: 'node-local-segregated' | 'none' | 'production-in-region';
  readonly productionReady: boolean;
  /** `siteName` is the on-node name; the control plane keeps the org/site mapping. Archives are already encrypted with the per-site key. */
  put(region: string, siteName: string, backupId: string, data: Buffer): Promise<BackupSinkPut>;
  get(ref: string): Promise<Buffer | null>;
  delete(ref: string): Promise<boolean>;
  exists(ref: string): Promise<boolean>;
}
export const BACKUP_SINK = Symbol('BACKUP_SINK');

/** The vault as the hosting module needs it (M05 S16 `VaultClient`, assumption A-03). Refs only: a secret never leaves the vault except to the agent. */
export interface VaultPort {
  put(ref: string, secret: Buffer | string): Promise<void>;
  exists(ref: string): Promise<boolean>;
  delete(ref: string): Promise<void>;
}
export const VAULT_PORT = Symbol('VAULT_PORT');

/** ACME client port (certificate issuance). The test implementation talks to a local ACME-style test server; the real one is HG-06-01. */
export interface AcmeResult {
  notAfter: string;
  certificateId: string;
}
export interface AcmeClient {
  issue(domains: string[], account: string): Promise<AcmeResult>;
}
export const ACME_CLIENT = Symbol('ACME_CLIENT');

export interface Clock {
  now(): Date;
}
export const CLOCK = Symbol('HOSTING_CLOCK');
export const systemClock: Clock = { now: () => new Date() };
