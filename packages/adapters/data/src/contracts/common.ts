import type { RawEvidence } from '../upstream';

/** A DNS record an adapter says must exist, declaratively (consumed by M07's DNS linkage or shown as manual instructions). */
export interface RequiredDnsRecord {
  type: 'TXT' | 'MX' | 'CNAME';
  /** Fully qualified record name. */
  name: string;
  value: string;
  ttl?: number;
  priority?: number;
  purpose: 'ownership' | 'mx' | 'spf' | 'dkim' | 'dmarc' | 'return-path';
  /** A record the account must have for the service to work (false = recommended). */
  required: boolean;
}

/** A freshly issued secret. Handed to the orchestrator, which stores it in the vault and drops it. NEVER logged or put into evidence. */
export interface IssuedSecret {
  /** Opaque id the provider (or the agent) gave this credential, so that it can be revoked later. */
  credentialId: string;
  username: string;
  /** Named secret fields (`password`, `accessKeySecret`, ...). */
  fields: Record<string, string>;
}

/** What an adapter reports for the usage meters (docs/12 §M08). `null` = the provider cannot report it: the meter is `unavailable`, never estimated. */
export interface UsageWindow {
  from: string;
  to: string;
}

export interface BackupRef {
  backupRef: string;
  type: 'manual' | 'scheduled' | 'pre_restore' | 'final';
  sizeBytes: number;
  checksum: string;
  /** Where the artifact lives (a system bucket key in the same `dataRegion`). Opaque to callers. */
  storageRef: string;
  takenAt: string;
  state: 'available' | 'creating' | 'failed' | 'deleted';
  /** Row-count/checksum of the sampled tables at backup time (only with `*.integrity-check`): what a restore must reproduce. */
  manifest?: TableCheck[];
}

export interface TableCheck {
  table: string;
  rowCount: number;
  checksum: string;
}
export interface IntegrityReport {
  engineCheck: 'ok' | 'failed' | 'unsupported';
  engineDetail?: string;
  tables: TableCheck[];
  checkedAt: string;
}

export interface Network {
  access: 'private' | 'allowlist';
  allowCidrs?: string[];
}

/** Common result of `inspect` for a managed instance (database or cache). */
export interface InstanceInspection {
  providerRef: string;
  status: 'provisioning' | 'running' | 'stopped' | 'deleting' | 'deleted' | 'error';
  engine: string;
  version: string;
  endpoint: { host: string; port: number } | null;
  tlsRequired: boolean;
  providerRegionId: string;
  planRef: string;
  storageGb: number;
  network: Network;
  tags: Record<string, string>;
  observedAt: string;
}

export const rawEvidence = (
  kind: RawEvidence['kind'],
  at: string,
  operation: string,
  summary: string,
): RawEvidence => ({ kind, capturedAt: at, operation, summary });
