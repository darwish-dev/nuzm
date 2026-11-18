import type { AccountContext } from './upstream';
import {
  CACHE_CASES,
  DATABASE_CASES,
  EMAIL_CASES,
  MAILBOX_CASES,
  OBJECT_STORAGE_CASES,
  runConformance,
  type CacheSubject,
  type ConformanceReport,
  type DatabaseSubject,
  type EmailSubject,
  type MailboxSubject,
  type ObjectStorageSubject,
} from './conformance';
import {
  FakeCompute,
  FakeNodeFleet,
  SelfOperatedDatabaseAdapter,
  fleetKey,
  type SelfOperatedConfig,
} from './self-operated';
import {
  ManualClock,
  MockCacheAdapter,
  MockDatabaseAdapter,
  MockMailboxAdapter,
  MockObjectStorageAdapter,
  MockTransactionalEmailAdapter,
} from './mock';

export const ctx: AccountContext = {
  providerAccountId: 'acct-mock',
  credentialRef: 'vault://mock/acct',
  traceId: 'trace-conformance',
  deadlineMs: 5000,
};

export const databaseSubject = (engine: 'postgresql' | 'mysql' = 'postgresql'): DatabaseSubject => {
  const a = new MockDatabaseAdapter(new ManualClock());
  return {
    adapter: a,
    ctx,
    controls: a,
    evidenceKind: 'mock',
    fixture: {
      providerRegionId: 'sa-central',
      planRef: 'mock-db-s',
      engine,
      version: '16',
      otherRegionId: 'mock-other-1',
    },
  };
};
export const cacheSubject = (): CacheSubject => {
  const a = new MockCacheAdapter(new ManualClock());
  return {
    adapter: a,
    ctx,
    controls: a,
    evidenceKind: 'mock',
    fixture: { providerRegionId: 'sa-central', planRef: 'mock-cache-s', version: '7' },
  };
};
export const objectStorageSubject = (): ObjectStorageSubject => {
  const clock = new ManualClock();
  const a = new MockObjectStorageAdapter(clock);
  return {
    adapter: a,
    ctx,
    controls: Object.assign(a, { advance: (ms: number) => clock.advance(ms) }),
    evidenceKind: 'mock',
    fixture: { providerRegionId: 'sa-central' },
  };
};
export const emailSubject = (): EmailSubject => {
  const clock = new ManualClock();
  const a = new MockTransactionalEmailAdapter(clock);
  return {
    adapter: a,
    ctx,
    controls: Object.assign(a, { now: () => new Date(clock.now()) }),
    evidenceKind: 'mock',
    fixture: { domain: 'mail.example.test' },
  };
};
export const mailboxSubject = (): MailboxSubject => {
  const a = new MockMailboxAdapter(new ManualClock());
  return {
    adapter: a,
    ctx,
    controls: a,
    evidenceKind: 'mock',
    fixture: { domain: 'corp.example.test' },
  };
};

export async function runAllMockConformance(): Promise<ConformanceReport[]> {
  return [
    await runConformance(DATABASE_CASES, () => databaseSubject('postgresql')),
    await runConformance(DATABASE_CASES, () => databaseSubject('mysql')),
    await runConformance(CACHE_CASES, cacheSubject),
    await runConformance(OBJECT_STORAGE_CASES, objectStorageSubject),
    await runConformance(EMAIL_CASES, emailSubject),
    await runConformance(MAILBOX_CASES, mailboxSubject),
  ];
}

export const SELF_OPERATED_CONFIG: SelfOperatedConfig = {
  regions: [{ providerRegionId: 'sa-central', countryCode: 'SA', verifiedAt: null }],
  plans: [{ planRef: 'mock-db-s', computePlanRef: 'ecs-small', storageGb: 20 }],
  imageRef: 'img-linux-lts',
  versions: { postgresql: ['16'], mysql: ['8.4'] },
  systemBucketFor: (region) => `nz-sys-${region}-backups`,
  agentKeyRef: 'vault://mock/agent-key',
  capabilities: {
    'database.engine.postgresql': 'supported',
    'database.engine.mysql': 'supported',
    'database.provision': 'supported',
    'database.inspect': 'supported',
    'database.delete': 'supported',
    'database.find-by-token': 'supported',
    'database.tls': 'supported',
    'database.private-network': 'supported',
    'database.backup': 'supported',
    'database.restore-to-new': 'supported',
    'database.restore-in-place': 'supported',
    'database.credential-rotation': 'supported',
    'database.dual-credentials': 'supported',
    'database.integrity-check': 'supported',
    'database.usage': 'supported',
  },
};
export const selfOperatedSubject = (engine: 'postgresql' | 'mysql' = 'postgresql') => {
  const clock = new ManualClock();
  const key = fleetKey();
  const fleet = new FakeNodeFleet(key, clock);
  const compute = new FakeCompute(clock, (ref) => fleet.addNode(ref));
  const vault = {
    resolve: async (ref: string) => ({
      ref,
      fields: { key: Buffer.from(key).toString('hex') },
      version: '1',
    }),
  };
  const adapter = new SelfOperatedDatabaseAdapter(
    compute,
    fleet,
    vault,
    clock,
    SELF_OPERATED_CONFIG,
  );
  const controls = {
    inject: (op: string, kind: Parameters<FakeCompute['inject']>[1], times?: number) =>
      compute.inject(op === 'create' ? 'provision' : op, kind, times),
    billableCount: () => compute.billableCount(),
    billableByToken: (t: string) => compute.billableByToken(t),
    setCapabilities: (p: Parameters<SelfOperatedDatabaseAdapter['setCapabilities']>[0]) =>
      adapter.setCapabilities(p),
    seedTable: (ref: string, table: string, rows: Record<string, unknown>[]) =>
      fleet.seedTable(ref, table, rows),
    corruptBackup: (ref: string, backupRef: string) => fleet.corruptBackup(ref, backupRef),
    authenticates: (ref: string, id: string) => fleet.authenticates(ref, id),
  };
  const subject: DatabaseSubject = {
    adapter,
    ctx,
    controls,
    evidenceKind: 'mock',
    fixture: {
      providerRegionId: 'sa-central',
      planRef: 'mock-db-s',
      engine,
      version: engine === 'mysql' ? '8.4' : '16',
      otherRegionId: 'mock-other-1',
    },
  };
  return { subject, fleet, compute, clock, key, adapter };
};
