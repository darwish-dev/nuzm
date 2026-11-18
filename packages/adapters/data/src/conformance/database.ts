import { DATABASE_CAPABILITIES, type DatabaseCapabilityId } from '../contracts/capabilities';
import type { DatabaseAdapter } from '../contracts/database';
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

export interface DatabaseControls extends CommonControls {
  billableByToken(token: string): number;
  setCapabilities(p: Partial<Record<DatabaseCapabilityId, CapabilityState>>): void;
  seedTable(ref: string, table: string, rows: Record<string, unknown>[]): void;
  corruptBackup(ref: string, backupRef: string): void;
  authenticates(ref: string, credentialId: string): boolean;
}
export interface DatabaseSubject extends CommonSubject<DatabaseAdapter, DatabaseControls> {
  adapter: DatabaseAdapter;
  fixture: {
    providerRegionId: string;
    planRef: string;
    engine: 'postgresql' | 'mysql';
    version: string;
    otherRegionId?: string;
  };
}
const tok = (n: string) => idempotencyToken('org-conformance', `op-${n}`, 'create');
const spec = (s: DatabaseSubject, name = 'conf-db') => ({
  engine: s.fixture.engine,
  version: s.fixture.version,
  providerRegionId: s.fixture.providerRegionId,
  planRef: s.fixture.planRef,
  storageGb: 20,
  name,
  network: { access: 'private' as const },
  tags: { 'nuzm-org': 'conformance' },
});
const make = async (s: DatabaseSubject, n: string) => {
  const r = expectOk(
    await s.adapter.create(s.ctx, { ...spec(s, n), idempotencyToken: tok(n) }),
    'create',
  );
  return r.providerRef ?? r.data!.providerRef;
};
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, v: `row-${i + 1}` }));

export const DATABASE_CASES: ConformanceCase<DatabaseSubject>[] = [
  ...commonCases<DatabaseAdapter, DatabaseControls, DatabaseSubject>(
    'database',
    DATABASE_CAPABILITIES,
  ),
  {
    id: 'D01',
    title: 'create is idempotent per token: a replay never creates a second billable instance',
    async run(s) {
      const a = await make(s, 'd01');
      const b = expectOk(
        await s.adapter.create(s.ctx, { ...spec(s, 'd01'), idempotencyToken: tok('d01') }),
        'replay',
      );
      check((b.providerRef ?? b.data?.providerRef) === a, 'a replay must return the same instance');
      check(
        s.controls.billableByToken(tok('d01')) === 1 && s.controls.billableCount() === 1,
        'exactly one billable instance',
      );
    },
  },
  {
    id: 'D02',
    title:
      'timeout AFTER the side effect is `uncertain`; findByToken then proves presence and a retry creates nothing new',
    async run(s) {
      s.controls.inject('create', 'timeout_after_side_effect');
      const r = await s.adapter.create(s.ctx, { ...spec(s, 'd02'), idempotencyToken: tok('d02') });
      check(r.status === 'uncertain', `expected uncertain, got ${r.status}`);
      const f = await s.adapter.findByToken(s.ctx, tok('d02'));
      check(f.data?.providerRef, 'findByToken must find the instance the timed-out call created');
      expectOk(
        await s.adapter.create(s.ctx, { ...spec(s, 'd02'), idempotencyToken: tok('d02') }),
        'retry',
      );
      check(
        s.controls.billableCount() === 1,
        'reconcile-before-retry must leave exactly one instance',
      );
    },
  },
  {
    id: 'D03',
    title:
      'timeout BEFORE the side effect is `uncertain`; findByToken proves absence; the retry creates exactly one',
    async run(s) {
      s.controls.inject('create', 'timeout_before_side_effect');
      const r = await s.adapter.create(s.ctx, { ...spec(s, 'd03'), idempotencyToken: tok('d03') });
      check(r.status === 'uncertain', `expected uncertain, got ${r.status}`);
      const f = await s.adapter.findByToken(s.ctx, tok('d03'));
      check(f.status === 'succeeded' && f.data === null, 'findByToken must prove absence');
      await make(s, 'd03');
      check(s.controls.billableCount() === 1, 'one instance after the retry');
    },
  },
  {
    id: 'D04',
    title: 'an outage or rate limit is a definitive, retryable failure and creates nothing',
    async run(s) {
      s.controls.inject('create', 'outage');
      s.controls.inject('create', 'rate_limit');
      const a = await s.adapter.create(s.ctx, { ...spec(s, 'd04'), idempotencyToken: tok('d04') });
      const b = await s.adapter.create(s.ctx, { ...spec(s, 'd04'), idempotencyToken: tok('d04') });
      check(
        a.status === 'failed' && a.error?.category === 'provider_outage' && a.error.retryable,
        'outage must be failed/provider_outage/retryable',
      );
      check(
        b.status === 'failed' && b.error?.category === 'rate_limit' && b.error.retryable,
        'rate limit must be failed/rate_limit/retryable',
      );
      check(s.controls.billableCount() === 0, 'nothing may have been created');
    },
  },
  {
    id: 'D05',
    title: 'an engine the account does not support is failed/unsupported, never a silent no-op',
    async run(s) {
      s.controls.setCapabilities({
        [`database.engine.${s.fixture.engine}`]: 'unsupported',
      } as Partial<Record<DatabaseCapabilityId, CapabilityState>>);
      expectUnsupported(
        await s.adapter.create(s.ctx, { ...spec(s, 'd05'), idempotencyToken: tok('d05') }),
        'create',
      );
      check(s.controls.billableCount() === 0, 'nothing may have been created');
    },
  },
  {
    id: 'D06',
    title:
      'inspect: private network by default, TLS required, an endpoint only while the instance exists',
    async run(s) {
      const ref = await make(s, 'd06');
      const i = expectOk(await s.adapter.inspect(s.ctx, ref), 'inspect').data!;
      check(i.tlsRequired === true, 'TLS must be required');
      check(i.network.access === 'private', 'no public listener by default');
      check(i.status === 'running' && i.endpoint !== null, 'running with an endpoint');
      expectOk(await s.adapter.delete(s.ctx, ref, { idempotencyToken: tok('d06x') }), 'delete');
      const gone = (await s.adapter.inspect(s.ctx, ref)).data;
      check(!gone || gone.status === 'deleted', 'deleted instance');
    },
  },
  {
    id: 'D07',
    title: 'delete is idempotent and findByToken no longer reports the instance',
    async run(s) {
      const ref = await make(s, 'd07');
      expectOk(await s.adapter.delete(s.ctx, ref, { idempotencyToken: tok('d07x') }), 'delete');
      expectOk(
        await s.adapter.delete(s.ctx, ref, { idempotencyToken: tok('d07x') }),
        'delete again',
      );
      const f = await s.adapter.findByToken(s.ctx, tok('d07'));
      check(f.data === null, 'a deleted instance must not be found');
      check(s.controls.billableCount() === 0, 'no billable instance remains');
    },
  },
  {
    id: 'D08',
    title:
      'backup is idempotent per token and carries size, checksum, storage reference and a manifest',
    async run(s) {
      const ref = await make(s, 'd08');
      s.controls.seedTable(ref, 'accounts', rows(5));
      const a = expectOk(
        await s.adapter.backup(s.ctx, ref, { type: 'manual', idempotencyToken: tok('d08b') }),
        'backup',
      ).data!;
      const b = expectOk(
        await s.adapter.backup(s.ctx, ref, { type: 'manual', idempotencyToken: tok('d08b') }),
        'backup replay',
      ).data!;
      check(a.backupRef === b.backupRef, 'same token → same backup');
      check(
        a.sizeBytes > 0 && /^[0-9a-f]{64}$/.test(a.checksum) && a.storageRef.length > 0,
        'size, sha256 checksum and storage ref required',
      );
      const list = expectOk(await s.adapter.listBackups(s.ctx, ref), 'list').data!;
      check(list.length === 1, 'one backup');
      const f = (await s.adapter.findBackupByToken(s.ctx, ref, tok('d08b'))).data;
      check(f?.backupRef === a.backupRef, 'findBackupByToken');
    },
  },
  {
    id: 'D09',
    title:
      'restore-to-new reproduces the source: row counts and checksums equal, a different instance, same region',
    async run(s) {
      const ref = await make(s, 'd09');
      s.controls.seedTable(ref, 'accounts', rows(7));
      s.controls.seedTable(ref, 'orders', rows(3));
      const bk = expectOk(
        await s.adapter.backup(s.ctx, ref, { type: 'manual', idempotencyToken: tok('d09b') }),
        'backup',
      ).data!;
      const r = expectOk(
        await s.adapter.restoreToNew(s.ctx, {
          sourceRef: ref,
          backupRef: bk.backupRef,
          target: { ...spec(s, 'd09-restored') },
          idempotencyToken: tok('d09r'),
        }),
        'restore',
      );
      const newRef = r.providerRef ?? r.data!.providerRef;
      check(newRef !== ref, 'restore must create a NEW instance');
      const src = expectOk(
        await s.adapter.integrityCheck(s.ctx, ref, { sampleTables: 100 }),
        'integrity(source)',
      ).data!;
      const dst = expectOk(
        await s.adapter.integrityCheck(s.ctx, newRef, { sampleTables: 100 }),
        'integrity(restored)',
      ).data!;
      check(
        JSON.stringify(src.tables) === JSON.stringify(dst.tables),
        'restored tables must match the source (row counts and checksums)',
      );
      check(
        JSON.stringify(bk.manifest) === JSON.stringify(dst.tables),
        'restored tables must match the backup manifest',
      );
      check(dst.engineCheck === 'ok', 'engine check ok');
    },
  },
  {
    id: 'D10',
    title: 'restore is idempotent per token and never crosses provider regions',
    async run(s) {
      const ref = await make(s, 'd10');
      s.controls.seedTable(ref, 't', rows(2));
      const bk = expectOk(
        await s.adapter.backup(s.ctx, ref, { type: 'manual', idempotencyToken: tok('d10b') }),
        'backup',
      ).data!;
      const a = expectOk(
        await s.adapter.restoreToNew(s.ctx, {
          sourceRef: ref,
          backupRef: bk.backupRef,
          target: spec(s, 'd10r'),
          idempotencyToken: tok('d10r'),
        }),
        'restore',
      );
      const b = expectOk(
        await s.adapter.restoreToNew(s.ctx, {
          sourceRef: ref,
          backupRef: bk.backupRef,
          target: spec(s, 'd10r'),
          idempotencyToken: tok('d10r'),
        }),
        'restore replay',
      );
      check(
        (a.providerRef ?? a.data?.providerRef) === (b.providerRef ?? b.data?.providerRef),
        'a replay returns the same restored instance',
      );
      check(s.controls.billableCount() === 2, 'source plus ONE restored instance');
      const cross = await s.adapter.restoreToNew(s.ctx, {
        sourceRef: ref,
        backupRef: bk.backupRef,
        target: { ...spec(s, 'd10x'), providerRegionId: s.fixture.otherRegionId ?? 'elsewhere-1' },
        idempotencyToken: tok('d10x'),
      });
      check(
        cross.status === 'failed' && cross.error?.category === 'validation',
        'cross-region restore must be refused',
      );
    },
  },
  {
    id: 'D11',
    title:
      'injected backup corruption is detectable: the restored data no longer matches the backup manifest',
    async run(s) {
      const ref = await make(s, 'd11');
      s.controls.seedTable(ref, 'accounts', rows(4));
      const bk = expectOk(
        await s.adapter.backup(s.ctx, ref, { type: 'manual', idempotencyToken: tok('d11b') }),
        'backup',
      ).data!;
      s.controls.corruptBackup(ref, bk.backupRef);
      const r = expectOk(
        await s.adapter.restoreToNew(s.ctx, {
          sourceRef: ref,
          backupRef: bk.backupRef,
          target: spec(s, 'd11r'),
          idempotencyToken: tok('d11r'),
        }),
        'restore',
      );
      const dst = expectOk(
        await s.adapter.integrityCheck(s.ctx, r.providerRef ?? r.data!.providerRef, {
          sampleTables: 100,
        }),
        'integrity',
      ).data!;
      check(
        JSON.stringify(bk.manifest) !== JSON.stringify(dst.tables),
        'corruption must change the table checksums',
      );
    },
  },
  {
    id: 'D12',
    title:
      'credential rotation: dual-credential window, the old credential stops authenticating once revoked, the new one works',
    async run(s) {
      const ref = await make(s, 'd12');
      const first = expectOk(
        await s.adapter.issueCredential(s.ctx, ref, {
          role: 'app',
          idempotencyToken: tok('d12a'),
          keepPrevious: false,
        }),
        'issue',
      ).data!;
      const second = expectOk(
        await s.adapter.issueCredential(s.ctx, ref, {
          role: 'app',
          idempotencyToken: tok('d12b'),
          keepPrevious: true,
        }),
        'rotate',
      ).data!;
      check(first.credentialId !== second.credentialId, 'a rotation issues a new credential');
      check(
        s.controls.authenticates(ref, first.credentialId) &&
          s.controls.authenticates(ref, second.credentialId),
        'both credentials work during the window',
      );
      expectOk(
        await s.adapter.revokeCredential(s.ctx, ref, {
          credentialId: first.credentialId,
          idempotencyToken: tok('d12r'),
        }),
        'revoke',
      );
      check(
        !s.controls.authenticates(ref, first.credentialId),
        'the old credential must be rejected after revocation',
      );
      check(
        s.controls.authenticates(ref, second.credentialId),
        'the new credential must keep working',
      );
      expectOk(
        await s.adapter.revokeCredential(s.ctx, ref, {
          credentialId: first.credentialId,
          idempotencyToken: tok('d12r'),
        }),
        'revoke again (idempotent)',
      );
      const l = expectOk(await s.adapter.listCredentials(s.ctx, ref), 'list').data!;
      check(
        l.length === 1 && l[0]!.credentialId === second.credentialId,
        'only the new credential remains',
      );
    },
  },
  {
    id: 'D13',
    title:
      'issuing is idempotent per token; without dual-credential support a window is failed/unsupported',
    async run(s) {
      const ref = await make(s, 'd13');
      const a = expectOk(
        await s.adapter.issueCredential(s.ctx, ref, {
          role: 'app',
          idempotencyToken: tok('d13'),
          keepPrevious: false,
        }),
        'issue',
      ).data!;
      const b = expectOk(
        await s.adapter.issueCredential(s.ctx, ref, {
          role: 'app',
          idempotencyToken: tok('d13'),
          keepPrevious: false,
        }),
        'replay',
      ).data!;
      check(a.credentialId === b.credentialId, 'same token → same credential');
      s.controls.setCapabilities({ 'database.dual-credentials': 'unsupported' });
      expectUnsupported(
        await s.adapter.issueCredential(s.ctx, ref, {
          role: 'app',
          idempotencyToken: tok('d13b'),
          keepPrevious: true,
        }),
        'dual window',
      );
    },
  },
  {
    id: 'D14',
    title: 'issued secrets never appear in evidence',
    async run(s) {
      const ref = await make(s, 'd14');
      const r = expectOk(
        await s.adapter.issueCredential(s.ctx, ref, {
          role: 'app',
          idempotencyToken: tok('d14'),
          keepPrevious: false,
        }),
        'issue',
      );
      noSecret(r, Object.values(r.data!.fields), 'issueCredential');
    },
  },
  {
    id: 'D15',
    title:
      'unsupported backup/restore/in-place/resize/usage are failed/unsupported (capability gating)',
    async run(s) {
      const ref = await make(s, 'd15');
      s.controls.setCapabilities({
        'database.backup': 'unsupported',
        'database.restore-in-place': 'unsupported',
        'database.resize': 'unsupported',
        'database.usage': 'unsupported',
      });
      expectUnsupported(
        await s.adapter.backup(s.ctx, ref, { type: 'manual', idempotencyToken: tok('d15') }),
        'backup',
      );
      if (s.adapter.restoreInPlace)
        expectUnsupported(
          await s.adapter.restoreInPlace(s.ctx, ref, 'bk-none', { idempotencyToken: tok('d15r') }),
          'in-place',
        );
      if (s.adapter.resize)
        expectUnsupported(
          await s.adapter.resize(s.ctx, ref, { storageGb: 40, idempotencyToken: tok('d15z') }),
          'resize',
        );
      expectUnsupported(
        await s.adapter.usage(s.ctx, ref, {
          from: '2026-11-18T00:00:00Z',
          to: '2026-11-18T01:00:00Z',
        }),
        'usage',
      );
    },
  },
  {
    id: 'D16',
    title: 'usage reports numbers (or null when not reportable), never estimates',
    async run(s) {
      const ref = await make(s, 'd16');
      s.controls.seedTable(ref, 't', rows(3));
      expectOk(
        await s.adapter.backup(s.ctx, ref, { type: 'manual', idempotencyToken: tok('d16') }),
        'backup',
      );
      const u = expectOk(
        await s.adapter.usage(s.ctx, ref, {
          from: '2026-11-18T00:00:00Z',
          to: '2026-11-18T01:00:00Z',
        }),
        'usage',
      ).data!;
      for (const v of [u.storageBytes, u.backupBytes, u.runningSeconds])
        check(v === null || (Number.isInteger(v) && v >= 0), 'integer or null');
      check((u.backupBytes ?? 1) > 0, 'a backup exists, so backup bytes are positive');
    },
  },
];
