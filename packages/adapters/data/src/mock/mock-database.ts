import { DATABASE_CAPABILITIES, type DatabaseCapabilityId } from '../contracts/capabilities';
import type { BackupRef, IntegrityReport } from '../contracts/common';
import type {
  DatabaseAdapter,
  DatabaseRef,
  DatabaseSpec,
  DatabaseUsage,
} from '../contracts/database';
import type { AccountContext, DataCatalogSnapshot, OperationResult } from '../upstream';
import { MockManaged } from './managed';
import type { Clock } from './core';

export const MOCK_DB_REGION = 'sa-central';
const ALL_SUPPORTED = Object.fromEntries(
  DATABASE_CAPABILITIES.map((c) => [c, 'supported']),
) as Record<DatabaseCapabilityId, 'supported'>;

/** In-memory `DatabaseAdapter` (dev/CI only, `environment=local`, NEVER selectable in staging/production). Evidence kind: `mock`. */
export class MockDatabaseAdapter
  extends MockManaged<'database', DatabaseCapabilityId>
  implements DatabaseAdapter
{
  readonly id = 'mock-database';
  readonly kind = 'database' as const;
  protected readonly capIds = DATABASE_CAPABILITIES;
  protected readonly kindPrefix = 'mockdb';
  constructor(
    clock: Clock,
    caps: Partial<
      Record<DatabaseCapabilityId, 'supported' | 'unsupported' | 'unknown'>
    > = ALL_SUPPORTED,
  ) {
    super(clock, caps);
  }
  async catalog(_ctx: AccountContext): Promise<DataCatalogSnapshot> {
    return {
      takenAt: this.iso(),
      regions: [
        {
          providerRegionId: MOCK_DB_REGION,
          countryCode: 'SA',
          verifiedAt: null,
          evidence: [this.ev('catalog', 'mock region, never verified')],
        },
      ],
      plans: [
        {
          planRef: 'mock-db-s',
          providerRegionId: MOCK_DB_REGION,
          attributes: { vcpu: 1, memoryMb: 2048, engines: 'postgresql,mysql' },
          availability: 'available',
          price: { amountMinor: '100', currency: 'SAR', period: 'hour' },
        },
        {
          planRef: 'mock-db-m',
          providerRegionId: MOCK_DB_REGION,
          attributes: { vcpu: 2, memoryMb: 4096, engines: 'postgresql,mysql' },
          availability: 'available',
          price: { amountMinor: '200', currency: 'SAR', period: 'hour' },
        },
        {
          planRef: 'mock-db-sold-out',
          providerRegionId: MOCK_DB_REGION,
          attributes: { vcpu: 8, memoryMb: 16384 },
          availability: 'sold_out',
        },
      ],
      evidence: [this.ev('catalog', 'mock catalog')],
    };
  }
  create(
    _ctx: AccountContext,
    req: DatabaseSpec & { idempotencyToken: string },
  ): Promise<OperationResult<DatabaseRef>> {
    return this.mutating('create', () => {
      if (!this.supports(`database.engine.${req.engine}` as DatabaseCapabilityId))
        return this.fail(
          'create',
          'unsupported',
          'UNSUPPORTED',
          `engine ${req.engine} is not supported`,
        );
      if (!this.supports('database.provision'))
        return this.fail('create', 'unsupported', 'UNSUPPORTED', 'provisioning is not supported');
      const existing = this.byToken.get(req.idempotencyToken);
      if (existing)
        return this.ok('create', 'replay', { providerRef: existing }, existing, 'accepted');
      if (req.planRef === 'mock-db-sold-out')
        return this.fail('create', 'capacity', 'SOLD_OUT', 'plan is sold out');
      const i = this.createInstance(req.idempotencyToken, { ...req });
      return this.ok('create', 'created', { providerRef: i.ref }, i.ref, 'accepted');
    });
  }
  findByToken(_ctx: AccountContext, token: string) {
    return this.findInstanceByToken(token);
  }
  delete(_ctx: AccountContext, ref: string, _o: { idempotencyToken: string }) {
    return this.deleteInstance(ref);
  }
  resize(
    _ctx: AccountContext,
    ref: string,
    change: { planRef?: string; storageGb?: number; idempotencyToken: string },
  ) {
    return this.mutating<void>('resize', () => {
      if (!this.supports('database.resize'))
        return this.fail('resize', 'unsupported', 'UNSUPPORTED', 'resize is not supported');
      const i = this.instances.get(ref);
      if (!i) return this.fail('resize', 'not_found', 'NOT_FOUND', 'no such instance');
      if (change.planRef) i.planRef = change.planRef;
      if (change.storageGb) i.storageGb = Math.max(i.storageGb, change.storageGb); // storage only grows
      return this.ok('resize', 'resized');
    });
  }
  backup(
    _ctx: AccountContext,
    ref: string,
    req: { type: BackupRef['type']; idempotencyToken: string },
  ) {
    return this.backupOf(ref, req.type, req.idempotencyToken, 'database');
  }
  restoreToNew(
    _ctx: AccountContext,
    req: {
      sourceRef: string;
      backupRef: string;
      target: Omit<DatabaseSpec, 'engine' | 'version'>;
      idempotencyToken: string;
    },
  ) {
    return this.restoreNew(
      req.sourceRef,
      req.backupRef,
      req.idempotencyToken,
      { ...req.target },
      'database',
    );
  }
  restoreInPlace(
    _ctx: AccountContext,
    ref: string,
    backupRef: string,
    _o: { idempotencyToken: string },
  ) {
    return this.mutating<void>('restoreInPlace', () => {
      if (!this.supports('database.restore-in-place'))
        return this.fail(
          'restoreInPlace',
          'unsupported',
          'UNSUPPORTED',
          'in-place restore is not supported',
        );
      const i = this.instances.get(ref);
      const b = i?.backups.get(backupRef);
      if (!i || !b) return this.fail('restoreInPlace', 'not_found', 'NOT_FOUND', 'no such backup');
      i.tables = JSON.parse(JSON.stringify(b.data));
      return this.ok('restoreInPlace', 'restored in place');
    });
  }
  issueCredential(
    _ctx: AccountContext,
    ref: string,
    req: { role: string; idempotencyToken: string; keepPrevious: boolean },
  ) {
    return this.issue(ref, req.role, req.keepPrevious, req.idempotencyToken, 'database');
  }
  revokeCredential(
    _ctx: AccountContext,
    ref: string,
    req: { credentialId: string; idempotencyToken: string },
  ) {
    return this.revoke(ref, req.credentialId);
  }
  listCredentials(_ctx: AccountContext, ref: string) {
    return this.list(ref);
  }
  integrityCheck(
    _ctx: AccountContext,
    ref: string,
    o: { sampleTables: number },
  ): Promise<OperationResult<IntegrityReport>> {
    return this.integrity(ref, o.sampleTables, 'database');
  }
  usage(_ctx: AccountContext, ref: string): Promise<OperationResult<DatabaseUsage>> {
    return this.reading('usage', () => {
      if (!this.supports('database.usage'))
        return this.fail('usage', 'unsupported', 'UNSUPPORTED', 'usage reporting is not supported');
      const i = this.instances.get(ref);
      if (!i) return this.fail('usage', 'not_found', 'NOT_FOUND', 'no such instance');
      const backupBytes = [...i.backups.values()]
        .filter((b) => b.ref.state === 'available')
        .reduce((s, b) => s + b.ref.sizeBytes, 0);
      return this.ok('usage', 'usage', {
        storageBytes: i.storageGb * 1024 ** 3,
        backupBytes,
        runningSeconds: 3600,
      });
    });
  }
}
