import { createHash, randomBytes } from 'node:crypto';
import type { AccountContext } from '../m05-contracts';
import type {
  AcmeClient,
  BackupSink,
  BackupSinkPut,
  ComputeInstanceInfo,
  ComputeProvisioningPort,
  DatabaseBindingProvider,
  DomainChallenge,
  DomainOwnershipVerifier,
  VaultPort,
} from '../ports';
import { sinkRefOf } from './mock-cloudpanel';

/** `node-local-segregated` backup sink for dev/staging/tests: one in-memory namespace per region. NEVER production-ready (D-07 / P-M06-1 OPEN). */
export class MemoryBackupSink implements BackupSink {
  readonly kind = 'node-local-segregated' as const;
  readonly productionReady = false;
  readonly store = new Map<string, Buffer>();
  async put(
    region: string,
    siteName: string,
    backupId: string,
    data: Buffer,
  ): Promise<BackupSinkPut> {
    const ref = sinkRefOf(region, siteName, backupId);
    this.store.set(ref, Buffer.from(data));
    return {
      ref,
      sizeBytes: data.length,
      checksum: createHash('sha256').update(data).digest('hex'),
      region,
    };
  }
  async get(ref: string) {
    return this.store.get(ref) ?? null;
  }
  async delete(ref: string) {
    return this.store.delete(ref);
  }
  async exists(ref: string) {
    return this.store.has(ref);
  }
}
/** Production default until the owner decides D-07 / P-M06-1: there is no sink, backups answer 422 `no_backup_sink`. */
export class NoBackupSink implements BackupSink {
  readonly kind = 'none' as const;
  readonly productionReady = false;
  put(): Promise<BackupSinkPut> {
    return Promise.reject(new Error('no backup sink is configured (D-07 / P-M06-1)'));
  }
  async get() {
    return null;
  }
  async delete() {
    return false;
  }
  async exists() {
    return false;
  }
}

export class MemoryVault implements VaultPort {
  readonly secrets = new Map<string, Buffer>();
  async put(ref: string, secret: Buffer | string) {
    this.secrets.set(ref, Buffer.from(secret));
  }
  async exists(ref: string) {
    return this.secrets.has(ref);
  }
  async delete(ref: string) {
    this.secrets.delete(ref);
  }
  /** test helper: create a random 32-byte key under a ref */
  newKey(ref: string): void {
    this.secrets.set(ref, randomBytes(32));
  }
  get = (ref: string) => this.secrets.get(ref);
}

/** Simulated TXT/HTTP challenge: `verifiedDomains` is the set of (org|site|domain) the "DNS" confirms. Real linkage arrives with M07 (assumption A-05). */
export class MockDomainOwnershipVerifier implements DomainOwnershipVerifier {
  readonly confirmed = new Set<string>();
  challenge(_orgId: string, _siteId: string, domain: string, token: string): DomainChallenge {
    return {
      method: 'dns_txt',
      record: {
        name: `_nuzm-challenge.${domain}`,
        type: 'TXT',
        value: `nuzm-site-verification=${token}`,
      },
    };
  }
  async verify(orgId: string, siteId: string, domain: string, token: string) {
    return this.confirmed.has(`${orgId}|${siteId}|${domain}|${token}`);
  }
  confirm(orgId: string, siteId: string, domain: string, token: string) {
    this.confirmed.add(`${orgId}|${siteId}|${domain}|${token}`);
  }
  /** confirm whatever token the service issued: convenience for tests that do not care about the token */
  confirmAll = false;
}
export class AlwaysConfirmingVerifier extends MockDomainOwnershipVerifier {
  override confirmAll = true;
  override async verify() {
    return true;
  }
}

/** M08 databases are not there yet: `enabled()` is false and the API answers `422 unsupported_capability` (M06 §2). */
export class NoDatabaseBindingProvider implements DatabaseBindingProvider {
  enabled() {
    return false;
  }
  async bind(): Promise<{ bindingId: string }> {
    throw new Error('database binding provider is not enabled');
  }
}

/** In-memory ComputeProvisioningPort (assumption A-02): stands in for M05's compute provisioning. */
export class InMemoryComputeProvisioning implements ComputeProvisioningPort {
  readonly instances = new Map<string, ComputeInstanceInfo>();
  readonly byToken = new Map<string, string>();
  async describe(id: string) {
    return this.instances.get(id) ?? null;
  }
  async provision(req: {
    idempotencyToken: string;
    dataRegion: string;
    vcpu: number;
    memoryMb: number;
    diskGb: number;
  }) {
    const existing = this.byToken.get(req.idempotencyToken);
    if (existing) return this.instances.get(existing)!;
    const id = `fake-i-${this.instances.size + 1}`;
    const info: ComputeInstanceInfo = {
      computeInstanceId: id,
      region: req.dataRegion,
      dataRegion: req.dataRegion,
      vcpu: req.vcpu,
      memoryMb: req.memoryMb,
      diskGb: req.diskGb,
      status: 'running',
    };
    this.instances.set(id, info);
    this.byToken.set(req.idempotencyToken, id);
    return info;
  }
  add(info: ComputeInstanceInfo) {
    this.instances.set(info.computeInstanceId, info);
  }
}

export const testCtx = (traceId = 'trace-test'): AccountContext => ({
  providerAccountId: 'platform-hosting',
  credentialRef: 'vault://hosting/test-agent',
  traceId,
  deadlineMs: 5000,
});

export type { AcmeClient };
