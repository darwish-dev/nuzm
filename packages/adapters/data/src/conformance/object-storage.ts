import {
  OBJECT_STORAGE_CAPABILITIES,
  type ObjectStorageCapabilityId,
} from '../contracts/capabilities';
import type { ObjectStorageAdapter } from '../contracts/object-storage';
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

export interface ObjectStorageControls extends CommonControls {
  billableByToken(token: string): number;
  setCapabilities(p: Partial<Record<ObjectStorageCapabilityId, CapabilityState>>): void;
  putObject(ref: string, key: string, bytes: number): void;
  recordEgress(ref: string, bytes: number, requests: number): void;
  authorize(credentialId: string, ref: string, action: 'read' | 'write'): boolean;
  verifyPresigned(url: string): { ok: boolean; reason?: string };
  advance(ms: number): void;
}
export interface ObjectStorageSubject extends CommonSubject<
  ObjectStorageAdapter,
  ObjectStorageControls
> {
  adapter: ObjectStorageAdapter;
  fixture: { providerRegionId: string };
}
const tok = (n: string) => idempotencyToken('org-conformance', `op-${n}`, 'bucket');
const spec = (s: ObjectStorageSubject, name: string, versioning = false) => ({
  bucketName: `nz-conf-${name}`,
  providerRegionId: s.fixture.providerRegionId,
  versioning,
  tags: { 'nuzm-org': 'conformance' },
});
const make = async (s: ObjectStorageSubject, n: string) => {
  const r = expectOk(
    await s.adapter.createBucket(s.ctx, { ...spec(s, n), idempotencyToken: tok(n) }),
    'createBucket',
  );
  return r.providerRef ?? r.data!.providerRef;
};
const win = { from: '2026-11-18T00:00:00Z', to: '2026-11-19T00:00:00Z' };

export const OBJECT_STORAGE_CASES: ConformanceCase<ObjectStorageSubject>[] = [
  ...commonCases<ObjectStorageAdapter, ObjectStorageControls, ObjectStorageSubject>(
    'object-storage',
    OBJECT_STORAGE_CAPABILITIES,
  ),
  {
    id: 'O01',
    title:
      'createBucket is idempotent per token; a name collision is a conflict (not a silent reuse)',
    async run(s) {
      const a = await make(s, 'o01');
      const b = expectOk(
        await s.adapter.createBucket(s.ctx, { ...spec(s, 'o01'), idempotencyToken: tok('o01') }),
        'replay',
      );
      check(
        (b.providerRef ?? b.data?.providerRef) === a && s.controls.billableCount() === 1,
        'one bucket',
      );
      const dup = await s.adapter.createBucket(s.ctx, {
        ...spec(s, 'o01'),
        idempotencyToken: tok('o01-other'),
      });
      check(
        dup.status === 'failed' && dup.error?.category === 'conflict',
        'a taken name is failed/conflict',
      );
    },
  },
  {
    id: 'O02',
    title:
      'timeout after the side effect is uncertain; findBucketByToken reconciles; no second bucket',
    async run(s) {
      s.controls.inject('createBucket', 'timeout_after_side_effect');
      const r = await s.adapter.createBucket(s.ctx, {
        ...spec(s, 'o02'),
        idempotencyToken: tok('o02'),
      });
      check(r.status === 'uncertain', 'uncertain');
      check((await s.adapter.findBucketByToken(s.ctx, tok('o02'))).data?.providerRef, 'found');
      expectOk(
        await s.adapter.createBucket(s.ctx, { ...spec(s, 'o02'), idempotencyToken: tok('o02') }),
        'retry',
      );
      check(s.controls.billableCount() === 1, 'one bucket');
    },
  },
  {
    id: 'O03',
    title: 'a new bucket is private (no public access); a public-read policy is visible on inspect',
    async run(s) {
      const ref = await make(s, 'o03');
      check(
        expectOk(await s.adapter.inspectBucket(s.ctx, ref), 'inspect').data!.publicAccess === false,
        'private by default',
      );
      expectOk(
        await s.adapter.putPolicy(s.ctx, ref, {
          version: 1,
          access: 'public-read',
          statements: [],
        }),
        'putPolicy',
      );
      check(
        expectOk(await s.adapter.inspectBucket(s.ctx, ref), 'inspect').data!.publicAccess === true,
        'public after policy',
      );
    },
  },
  {
    id: 'O04',
    title:
      'lifecycle: expiry and multipart-abort need their capability; transitions only if supported',
    async run(s) {
      const ref = await make(s, 'o04');
      expectOk(
        await s.adapter.setLifecycle(s.ctx, ref, [
          { id: 'r1', prefix: 'tmp/', expireDays: 7, abortIncompleteMultipartDays: 1 },
        ]),
        'lifecycle',
      );
      s.controls.setCapabilities({ 'object-storage.lifecycle.transition': 'unsupported' });
      expectUnsupported(
        await s.adapter.setLifecycle(s.ctx, ref, [
          { id: 'r2', prefix: '', transition: { days: 30, storageClass: 'COLD' } },
        ]),
        'transition',
      );
    },
  },
  {
    id: 'O05',
    title:
      'credentials are scoped to ONE bucket: a credential of bucket A is useless on bucket B; a read credential cannot write; revoked credentials stop working',
    async run(s) {
      const a = await make(s, 'o05a');
      const b = await make(s, 'o05b');
      const ca = expectOk(
        await s.adapter.issueCredential(s.ctx, a, {
          scope: 'readwrite',
          idempotencyToken: tok('o05ca'),
        }),
        'issue',
      ).data!;
      const cr = expectOk(
        await s.adapter.issueCredential(s.ctx, a, {
          scope: 'read',
          idempotencyToken: tok('o05cr'),
        }),
        'issue',
      ).data!;
      check(s.controls.authorize(ca.credentialId, a, 'write'), 'own bucket write');
      check(
        !s.controls.authorize(ca.credentialId, b, 'read') &&
          !s.controls.authorize(ca.credentialId, b, 'write'),
        'another bucket: denied',
      );
      check(
        s.controls.authorize(cr.credentialId, a, 'read') &&
          !s.controls.authorize(cr.credentialId, a, 'write'),
        'read scope cannot write',
      );
      expectOk(
        await s.adapter.revokeCredential(s.ctx, a, {
          credentialId: ca.credentialId,
          idempotencyToken: tok('o05r'),
        }),
        'revoke',
      );
      check(!s.controls.authorize(ca.credentialId, a, 'read'), 'revoked credential rejected');
      const issued = expectOk(
        await s.adapter.issueCredential(s.ctx, a, {
          scope: 'read',
          idempotencyToken: tok('o05cz'),
        }),
        'issue',
      );
      noSecret(issued, Object.values(issued.data!.fields), 'issueCredential');
    },
  },
  {
    id: 'O06',
    title:
      'signed URLs: valid until expiry, method-scoped, a tampered signature or path is rejected, an expired URL is rejected',
    async run(s) {
      const ref = await make(s, 'o06');
      const u = expectOk(
        await s.adapter.presign(s.ctx, ref, { key: 'a/b.txt', method: 'GET', ttlSeconds: 900 }),
        'presign',
      ).data!;
      check(s.controls.verifyPresigned(u.url).ok, 'fresh URL verifies');
      const tampered = u.url.replace('X-Method=GET', 'X-Method=PUT');
      check(!s.controls.verifyPresigned(tampered).ok, 'a method swap must break the signature');
      check(
        !s.controls.verifyPresigned(u.url.replace('a/b.txt', 'a/c.txt')).ok,
        'a path swap must break the signature',
      );
      check(
        !s.controls.verifyPresigned(u.url.replace(/X-Signature=[0-9a-f]{4}/, 'X-Signature=0000'))
          .ok,
        'a forged signature is rejected',
      );
      s.controls.advance(901_000);
      const after = s.controls.verifyPresigned(u.url);
      check(!after.ok && after.reason === 'expired', 'an expired URL is rejected');
    },
  },
  {
    id: 'O07',
    title:
      'usage: bytes counted; requests/egress are null when the provider cannot report them (never estimated)',
    async run(s) {
      const ref = await make(s, 'o07');
      s.controls.putObject(ref, 'x', 1000);
      s.controls.recordEgress(ref, 500, 3);
      const full = expectOk(await s.adapter.usage(s.ctx, ref, win), 'usage').data!;
      check(
        full.bytesStored === 1000 && full.egressBytes === 500 && full.requests === 3,
        'exact usage',
      );
      s.controls.setCapabilities({
        'object-storage.usage.egress': 'unsupported',
        'object-storage.usage.requests': 'unsupported',
      });
      const part = expectOk(await s.adapter.usage(s.ctx, ref, win), 'usage').data!;
      check(
        part.bytesStored === 1000 && part.egressBytes === null && part.requests === null,
        'unreportable meters are null, not estimated',
      );
    },
  },
  {
    id: 'O08',
    title:
      'deleting a non-empty bucket needs force; delete is idempotent; the name becomes free again',
    async run(s) {
      const ref = await make(s, 'o08');
      s.controls.putObject(ref, 'k', 10);
      const r = await s.adapter.deleteBucket(s.ctx, ref, {
        force: false,
        idempotencyToken: tok('o08x'),
      });
      check(
        r.status === 'failed' && r.error?.category === 'conflict',
        'non-empty without force is a conflict',
      );
      expectOk(
        await s.adapter.deleteBucket(s.ctx, ref, { force: true, idempotencyToken: tok('o08y') }),
        'forced delete',
      );
      expectOk(
        await s.adapter.deleteBucket(s.ctx, ref, { force: true, idempotencyToken: tok('o08y') }),
        'delete again',
      );
      expectOk(
        await s.adapter.createBucket(s.ctx, { ...spec(s, 'o08'), idempotencyToken: tok('o08z') }),
        'name reusable after deletion',
      );
    },
  },
  {
    id: 'O09',
    title:
      'compat report lists every operation tested; unsupported capabilities show up as unsupported operations',
    async run(s) {
      check(s.adapter.compat !== undefined, 'compat() is required of an object-storage adapter');
      s.controls.setCapabilities({ 'object-storage.policy': 'unsupported' });
      const c = expectOk(await s.adapter.compat!(s.ctx), 'compat').data!;
      check(
        c.operations.length >= 5 && c.testedAt.length > 0,
        'a list of operations is stored as evidence',
      );
      check(
        c.operations.find((o) => o.operation === 'PutBucketPolicy')?.supported === false,
        'unsupported policy shows as unsupported',
      );
    },
  },
  {
    id: 'O10',
    title:
      'unsupported bucket/policy/signed-url/scoped-credential capabilities are failed/unsupported',
    async run(s) {
      const ref = await make(s, 'o10');
      s.controls.setCapabilities({
        'object-storage.policy': 'unsupported',
        'object-storage.signed-url': 'unsupported',
        'object-storage.scoped-credentials': 'unsupported',
      });
      expectUnsupported(
        await s.adapter.putPolicy(s.ctx, ref, { version: 1, access: 'private', statements: [] }),
        'policy',
      );
      expectUnsupported(
        await s.adapter.presign(s.ctx, ref, { key: 'k', method: 'GET', ttlSeconds: 60 }),
        'presign',
      );
      expectUnsupported(
        await s.adapter.issueCredential(s.ctx, ref, {
          scope: 'read',
          idempotencyToken: tok('o10'),
        }),
        'credential',
      );
    },
  },
];
