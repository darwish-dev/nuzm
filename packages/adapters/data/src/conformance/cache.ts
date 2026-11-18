import { CACHE_CAPABILITIES, type CacheCapabilityId } from '../contracts/capabilities';
import type { CacheAdapter } from '../contracts/cache';
import { idempotencyToken, type CapabilityState } from '../upstream';
import {
  check,
  commonCases,
  expectOk,
  expectUnsupported,
  noSecret,
  type CommonControls,
  type CommonSubject,
  type ConformanceCase,
} from './kit';

export interface CacheControls extends CommonControls {
  billableByToken(token: string): number;
  setCapabilities(p: Partial<Record<CacheCapabilityId, CapabilityState>>): void;
  seedTable(ref: string, table: string, rows: Record<string, unknown>[]): void;
  authenticates(ref: string, credentialId: string): boolean;
}
export interface CacheSubject extends CommonSubject<CacheAdapter, CacheControls> {
  adapter: CacheAdapter;
  fixture: { providerRegionId: string; planRef: string; version: string };
}
const tok = (n: string) => idempotencyToken('org-conformance', `op-${n}`, 'create');
const spec = (
  s: CacheSubject,
  name = 'conf-cache',
  persistence: 'none' | 'rdb' | 'aof' = 'none',
) => ({
  version: s.fixture.version,
  providerRegionId: s.fixture.providerRegionId,
  planRef: s.fixture.planRef,
  memoryMb: 1024,
  name,
  network: { access: 'private' as const },
  persistence,
  evictionPolicy: 'noeviction' as const,
  tags: { 'nuzm-org': 'conformance' },
});
const make = async (s: CacheSubject, n: string, persistence: 'none' | 'rdb' | 'aof' = 'none') => {
  const r = expectOk(
    await s.adapter.create(s.ctx, { ...spec(s, n, persistence), idempotencyToken: tok(n) }),
    'create',
  );
  return r.providerRef ?? r.data!.providerRef;
};

export const CACHE_CASES: ConformanceCase<CacheSubject>[] = [
  ...commonCases<CacheAdapter, CacheControls, CacheSubject>('cache', CACHE_CAPABILITIES),
  {
    id: 'R01',
    title: 'create is idempotent per token; a timeout is uncertain and reconciled via findByToken',
    async run(s) {
      s.controls.inject('create', 'timeout_after_side_effect');
      const r = await s.adapter.create(s.ctx, { ...spec(s, 'r01'), idempotencyToken: tok('r01') });
      check(r.status === 'uncertain', 'expected uncertain');
      check(
        (await s.adapter.findByToken(s.ctx, tok('r01'))).data?.providerRef,
        'findByToken must find it',
      );
      expectOk(
        await s.adapter.create(s.ctx, { ...spec(s, 'r01'), idempotencyToken: tok('r01') }),
        'retry',
      );
      check(
        s.controls.billableCount() === 1 && s.controls.billableByToken(tok('r01')) === 1,
        'exactly one instance',
      );
    },
  },
  {
    id: 'R02',
    title: 'TLS required, private network by default, engine redis',
    async run(s) {
      const ref = await make(s, 'r02');
      const i = expectOk(await s.adapter.inspect(s.ctx, ref), 'inspect').data!;
      check(
        i.tlsRequired && i.network.access === 'private' && i.engine === 'redis',
        'TLS, private, redis',
      );
    },
  },
  {
    id: 'R03',
    title:
      'persistence is honoured only when the account supports it, otherwise failed/unsupported',
    async run(s) {
      s.controls.setCapabilities({ 'cache.persistence': 'unsupported' });
      expectUnsupported(
        await s.adapter.create(s.ctx, { ...spec(s, 'r03', 'rdb'), idempotencyToken: tok('r03') }),
        'persistent create',
      );
      check(s.controls.billableCount() === 0, 'nothing created');
      await make(s, 'r03b', 'none');
    },
  },
  {
    id: 'R04',
    title:
      'ACL users: issue, dual window, revoke; the old credential is rejected; ACL unsupported is failed/unsupported; secrets stay out of evidence',
    async run(s) {
      const ref = await make(s, 'r04');
      const a = expectOk(
        await s.adapter.issueCredential(s.ctx, ref, {
          role: 'app',
          acl: '~app:* +@all -@dangerous',
          idempotencyToken: tok('r04a'),
          keepPrevious: false,
        }),
        'issue',
      );
      const b = expectOk(
        await s.adapter.issueCredential(s.ctx, ref, {
          role: 'app',
          acl: '~app:* +@all -@dangerous',
          idempotencyToken: tok('r04b'),
          keepPrevious: true,
        }),
        'rotate',
      );
      noSecret(a, Object.values(a.data!.fields), 'issue');
      check(
        s.controls.authenticates(ref, a.data!.credentialId) &&
          s.controls.authenticates(ref, b.data!.credentialId),
        'both work in the window',
      );
      expectOk(
        await s.adapter.revokeCredential(s.ctx, ref, {
          credentialId: a.data!.credentialId,
          idempotencyToken: tok('r04r'),
        }),
        'revoke',
      );
      check(
        !s.controls.authenticates(ref, a.data!.credentialId) &&
          s.controls.authenticates(ref, b.data!.credentialId),
        'old rejected, new works',
      );
      s.controls.setCapabilities({ 'cache.acl': 'unsupported' });
      expectUnsupported(
        await s.adapter.issueCredential(s.ctx, ref, {
          role: 'x',
          acl: '~* +get',
          idempotencyToken: tok('r04c'),
          keepPrevious: false,
        }),
        'acl',
      );
    },
  },
  {
    id: 'R05',
    title: 'failover info reports topology; unsupported when the account cannot report it',
    async run(s) {
      const ref = await make(s, 'r05');
      const f = expectOk(await s.adapter.failoverInfo(s.ctx, ref), 'failover').data!;
      check(f.topology === 'single' || f.topology === 'primary-replica', 'topology');
      s.controls.setCapabilities({ 'cache.failover-info': 'unsupported' });
      expectUnsupported(await s.adapter.failoverInfo(s.ctx, ref), 'failover');
    },
  },
  {
    id: 'R06',
    title:
      'a non-persistent instance cannot be backed up (failed/unsupported); a persistent one restores to a NEW instance with equal data',
    async run(s) {
      const none = await make(s, 'r06a', 'none');
      expectUnsupported(
        await s.adapter.backup!(s.ctx, none, { type: 'manual', idempotencyToken: tok('r06x') }),
        'backup without persistence',
      );
      const ref = await make(s, 'r06b', 'rdb');
      s.controls.seedTable(ref, 'keys', [
        { k: 'a', v: 1 },
        { k: 'b', v: 2 },
      ]);
      const bk = expectOk(
        await s.adapter.backup!(s.ctx, ref, { type: 'manual', idempotencyToken: tok('r06b') }),
        'backup',
      ).data!;
      const { version: _v, ...target } = spec(s, 'r06-restored', 'rdb');
      const r = expectOk(
        await s.adapter.restoreToNew!(s.ctx, {
          sourceRef: ref,
          backupRef: bk.backupRef,
          target,
          idempotencyToken: tok('r06r'),
        }),
        'restore',
      );
      const newRef = r.providerRef ?? r.data!.providerRef;
      const a = expectOk(
        await s.adapter.integrityCheck!(s.ctx, ref, { sampleTables: 10 }),
        'src',
      ).data!;
      const b = expectOk(
        await s.adapter.integrityCheck!(s.ctx, newRef, { sampleTables: 10 }),
        'dst',
      ).data!;
      check(
        newRef !== ref && JSON.stringify(a.tables) === JSON.stringify(b.tables),
        'restored data equals the source',
      );
    },
  },
  {
    id: 'R07',
    title: 'delete is idempotent; usage reports integers or null',
    async run(s) {
      const ref = await make(s, 'r07');
      const u = expectOk(
        await s.adapter.usage(s.ctx, ref, {
          from: '2026-11-18T00:00:00Z',
          to: '2026-11-18T01:00:00Z',
        }),
        'usage',
      ).data!;
      for (const v of [u.memoryBytes, u.runningSeconds])
        check(v === null || Number.isInteger(v), 'integer or null');
      expectOk(await s.adapter.delete(s.ctx, ref, { idempotencyToken: tok('r07x') }), 'delete');
      expectOk(
        await s.adapter.delete(s.ctx, ref, { idempotencyToken: tok('r07x') }),
        'delete again',
      );
      check(s.controls.billableCount() === 0, 'none remain');
    },
  },
];
