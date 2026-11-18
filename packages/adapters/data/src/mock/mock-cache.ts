import { CACHE_CAPABILITIES, type CacheCapabilityId } from '../contracts/capabilities';
import type { BackupRef } from '../contracts/common';
import type {
  CacheAdapter,
  CacheAclRequest,
  CacheRef,
  CacheSpec,
  CacheUsage,
  FailoverInfo,
} from '../contracts/cache';
import type { AccountContext, DataCatalogSnapshot, OperationResult } from '../upstream';
import { MockManaged } from './managed';
import { MOCK_DB_REGION } from './mock-database';
import type { Clock } from './core';

const ALL_SUPPORTED = Object.fromEntries(CACHE_CAPABILITIES.map((c) => [c, 'supported'])) as Record<
  CacheCapabilityId,
  'supported'
>;

/** In-memory `CacheAdapter` (Redis). NOT VERIFIED (mock): no Redis is installed in this environment. */
export class MockCacheAdapter
  extends MockManaged<'cache', CacheCapabilityId>
  implements CacheAdapter
{
  readonly id = 'mock-cache';
  readonly kind = 'cache' as const;
  protected readonly capIds = CACHE_CAPABILITIES;
  protected readonly kindPrefix = 'mockcache';
  constructor(
    clock: Clock,
    caps: Partial<
      Record<CacheCapabilityId, 'supported' | 'unsupported' | 'unknown'>
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
          planRef: 'mock-cache-s',
          providerRegionId: MOCK_DB_REGION,
          attributes: { memoryMb: 1024 },
          availability: 'available',
          price: { amountMinor: '60', currency: 'SAR', period: 'hour' },
        },
      ],
      evidence: [this.ev('catalog', 'mock catalog')],
    };
  }
  create(
    _ctx: AccountContext,
    req: CacheSpec & { idempotencyToken: string },
  ): Promise<OperationResult<CacheRef>> {
    return this.mutating('create', () => {
      if (!this.supports('cache.provision'))
        return this.fail('create', 'unsupported', 'UNSUPPORTED', 'provisioning is not supported');
      if (req.persistence !== 'none' && !this.supports('cache.persistence'))
        return this.fail(
          'create',
          'unsupported',
          'UNSUPPORTED',
          'persistence is not supported by this account',
        );
      const existing = this.byToken.get(req.idempotencyToken);
      if (existing)
        return this.ok('create', 'replay', { providerRef: existing }, existing, 'accepted');
      const i = this.createInstance(req.idempotencyToken, {
        engine: 'redis',
        version: req.version,
        name: req.name,
        providerRegionId: req.providerRegionId,
        planRef: req.planRef,
        storageGb: Math.ceil(req.memoryMb / 1024),
        network: req.network,
        tags: req.tags,
        persistence: req.persistence,
      });
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
    change: { planRef?: string; memoryMb?: number; idempotencyToken: string },
  ) {
    return this.mutating<void>('resize', () => {
      if (!this.supports('cache.resize'))
        return this.fail('resize', 'unsupported', 'UNSUPPORTED', 'resize is not supported');
      const i = this.instances.get(ref);
      if (!i) return this.fail('resize', 'not_found', 'NOT_FOUND', 'no such instance');
      if (change.planRef) i.planRef = change.planRef;
      return this.ok('resize', 'resized');
    });
  }
  failoverInfo(_ctx: AccountContext, ref: string): Promise<OperationResult<FailoverInfo>> {
    return this.reading('failoverInfo', () => {
      if (!this.supports('cache.failover-info'))
        return this.fail(
          'failoverInfo',
          'unsupported',
          'UNSUPPORTED',
          'failover info is not supported',
        );
      if (!this.instances.has(ref))
        return this.fail('failoverInfo', 'not_found', 'NOT_FOUND', 'no such instance');
      return this.ok('failoverInfo', 'info', {
        topology: 'primary-replica' as const,
        replicas: 1,
        lastFailoverAt: null,
      });
    });
  }
  issueCredential(
    _ctx: AccountContext,
    ref: string,
    req: CacheAclRequest & { keepPrevious: boolean },
  ) {
    if (!this.supports('cache.acl'))
      return Promise.resolve(
        this.fail<never>(
          'issueCredential',
          'unsupported',
          'UNSUPPORTED',
          'ACL users are not supported',
        ),
      );
    return this.issue(ref, req.role, req.keepPrevious, req.idempotencyToken, 'cache');
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
  backup(
    _ctx: AccountContext,
    ref: string,
    req: { type: BackupRef['type']; idempotencyToken: string },
  ) {
    const i = this.instances.get(ref);
    if (i && i.persistence === 'none')
      return Promise.resolve(
        this.fail<BackupRef>(
          'backup',
          'unsupported',
          'NO_PERSISTENCE',
          'the instance has no persistence',
        ),
      );
    return this.backupOf(ref, req.type, req.idempotencyToken, 'cache');
  }
  restoreToNew(
    _ctx: AccountContext,
    req: {
      sourceRef: string;
      backupRef: string;
      target: Omit<CacheSpec, 'version'>;
      idempotencyToken: string;
    },
  ) {
    return this.restoreNew(
      req.sourceRef,
      req.backupRef,
      req.idempotencyToken,
      {
        name: req.target.name,
        providerRegionId: req.target.providerRegionId,
        planRef: req.target.planRef,
        storageGb: Math.ceil(req.target.memoryMb / 1024),
        network: req.target.network,
        tags: req.target.tags,
      },
      'cache',
    );
  }
  integrityCheck(_ctx: AccountContext, ref: string, o: { sampleTables: number }) {
    return this.integrity(ref, o.sampleTables, 'cache');
  }
  usage(_ctx: AccountContext, ref: string): Promise<OperationResult<CacheUsage>> {
    return this.reading('usage', () => {
      if (!this.supports('cache.usage'))
        return this.fail('usage', 'unsupported', 'UNSUPPORTED', 'usage reporting is not supported');
      const i = this.instances.get(ref);
      if (!i) return this.fail('usage', 'not_found', 'NOT_FOUND', 'no such instance');
      return this.ok('usage', 'usage', {
        memoryBytes: i.storageGb * 1024 ** 3,
        runningSeconds: 3600,
      });
    });
  }
}
