import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  OBJECT_STORAGE_CAPABILITIES,
  completeCapabilities,
  type ObjectStorageCapabilityId,
} from '../contracts/capabilities';
import type { IssuedSecret, UsageWindow } from '../contracts/common';
import type {
  BucketInspection,
  BucketPolicyDoc,
  BucketRef,
  BucketSpec,
  BucketUsage,
  LifecycleRule,
  ObjectStorageAdapter,
  S3CompatReport,
  SignedUrl,
  SignedUrlRequest,
} from '../contracts/object-storage';
import type {
  AccountContext,
  DataCatalogSnapshot,
  HealthReport,
  OperationResult,
} from '../upstream';
import { MockCore, sha256, type Clock } from './core';

type Caps = Partial<Record<ObjectStorageCapabilityId, 'supported' | 'unsupported' | 'unknown'>>;
const ALL_SUPPORTED = Object.fromEntries(
  OBJECT_STORAGE_CAPABILITIES.map((c) => [c, 'supported']),
) as Record<ObjectStorageCapabilityId, 'supported'>;

interface Bucket {
  ref: string;
  token: string;
  spec: BucketSpec;
  policy: BucketPolicyDoc | null;
  lifecycle: LifecycleRule[];
  objects: Map<string, number>;
  creds: Map<string, { credentialId: string; scope: 'read' | 'readwrite' }>;
  signingKey: string;
  requests: number;
  egressBytes: number;
  deleted: boolean;
}

/** In-memory `ObjectStorageAdapter` plus a tiny "server side" (credential scoping and presigned-URL verification) so that isolation and tamper tests are real comparisons. NOT VERIFIED (mock). */
export class MockObjectStorageAdapter extends MockCore implements ObjectStorageAdapter {
  readonly id = 'mock-object-storage';
  readonly kind = 'object-storage' as const;
  readonly contractVersion = '1.0.0';
  private readonly buckets = new Map<string, Bucket>();
  private readonly byToken = new Map<string, string>();
  private readonly names = new Map<string, string>();
  private seq = 0;
  constructor(
    clock: Clock,
    private caps: Caps = ALL_SUPPORTED,
  ) {
    super(clock);
  }
  setCapabilities(p: Caps) {
    this.caps = { ...this.caps, ...p };
  }
  private sup(id: ObjectStorageCapabilityId) {
    return this.caps[id] === 'supported';
  }
  billableCount() {
    return [...this.buckets.values()].filter((b) => !b.deleted).length;
  }
  billableByToken(t: string) {
    const r = this.byToken.get(t);
    return r && !this.buckets.get(r)?.deleted ? 1 : 0;
  }
  // ---- test controls ("the provider side") --------------------------------------------------------------------------------
  putObject(ref: string, key: string, bytes: number) {
    this.mustGet(ref).objects.set(key, bytes);
  }
  recordEgress(ref: string, bytes: number, requests: number) {
    const b = this.mustGet(ref);
    b.egressBytes += bytes;
    b.requests += requests;
  }
  /** Would the provider accept an authenticated request made with this credential? Scoping is per bucket. */
  authorize(credentialId: string, ref: string, action: 'read' | 'write'): boolean {
    const b = this.buckets.get(ref);
    const c = b?.creds.get(credentialId);
    if (!b || b.deleted || !c) return false;
    return action === 'read' || c.scope === 'readwrite';
  }
  /** The provider-side check of a presigned URL: signature and expiry. */
  verifyPresigned(url: string): {
    ok: boolean;
    reason?: 'bad_signature' | 'expired' | 'unknown_bucket';
  } {
    const u = new URL(url);
    const b = [...this.buckets.values()].find(
      (x) => `${x.spec.bucketName}.mock.invalid` === u.hostname,
    );
    if (!b || b.deleted) return { ok: false, reason: 'unknown_bucket' };
    const method = u.searchParams.get('X-Method') ?? '';
    const exp = Number(u.searchParams.get('X-Expires'));
    const sig = u.searchParams.get('X-Signature') ?? '';
    const want = createHmac('sha256', b.signingKey)
      .update(`${method}|${decodeURIComponent(u.pathname)}|${exp}`)
      .digest('hex');
    const a = Buffer.from(sig);
    const w = Buffer.from(want);
    if (a.length !== w.length || !timingSafeEqual(a, w))
      return { ok: false, reason: 'bad_signature' };
    if (this.clock.now() >= exp * 1000) return { ok: false, reason: 'expired' };
    return { ok: true };
  }
  private mustGet(ref: string): Bucket {
    const b = this.buckets.get(ref);
    if (!b) throw new Error('no such bucket');
    return b;
  }
  // ---- adapter ------------------------------------------------------------------------------------------------------------
  async probe(_ctx: AccountContext) {
    return {
      capabilities: completeCapabilities(OBJECT_STORAGE_CAPABILITIES, this.caps),
      evidence: [this.ev('probe', 'mock')],
      probedAt: this.iso(),
    };
  }
  async health(_ctx: AccountContext): Promise<HealthReport> {
    return {
      state: 'healthy',
      checkedAt: this.iso(),
      detail: 'mock',
      evidence: [this.ev('health', 'mock')],
    };
  }
  async catalog(_ctx: AccountContext): Promise<DataCatalogSnapshot> {
    return {
      takenAt: this.iso(),
      regions: [
        {
          providerRegionId: 'sa-central',
          countryCode: 'SA',
          verifiedAt: null,
          evidence: [this.ev('catalog', 'mock region, never verified')],
        },
      ],
      plans: [
        {
          planRef: 'mock-standard',
          providerRegionId: 'sa-central',
          attributes: {},
          availability: 'available',
          price: { amountMinor: '20', currency: 'SAR', period: 'month' },
        },
      ],
      evidence: [this.ev('catalog', 'mock catalog')],
    };
  }
  createBucket(
    _ctx: AccountContext,
    req: BucketSpec & { idempotencyToken: string },
  ): Promise<OperationResult<BucketRef>> {
    return this.mutating('createBucket', () => {
      if (!this.sup('object-storage.bucket'))
        return this.fail('createBucket', 'unsupported', 'UNSUPPORTED', 'buckets are not supported');
      if (req.versioning && !this.sup('object-storage.versioning'))
        return this.fail(
          'createBucket',
          'unsupported',
          'UNSUPPORTED',
          'versioning is not supported',
        );
      const existing = this.byToken.get(req.idempotencyToken);
      if (existing)
        return this.ok('createBucket', 'replay', { providerRef: existing }, existing, 'accepted');
      if (this.names.has(req.bucketName))
        return this.fail('createBucket', 'conflict', 'NAME_TAKEN', 'bucket name is taken');
      const ref = `mockbkt-${(++this.seq).toString().padStart(4, '0')}`;
      this.buckets.set(ref, {
        ref,
        token: req.idempotencyToken,
        spec: { ...req },
        policy: null,
        lifecycle: [],
        objects: new Map(),
        creds: new Map(),
        signingKey: sha256(`${ref}|key`),
        requests: 0,
        egressBytes: 0,
        deleted: false,
      });
      this.byToken.set(req.idempotencyToken, ref);
      this.names.set(req.bucketName, ref);
      return this.ok('createBucket', 'created', { providerRef: ref }, ref, 'accepted');
    });
  }
  inspectBucket(_ctx: AccountContext, ref: string): Promise<OperationResult<BucketInspection>> {
    return this.reading('inspectBucket', () => {
      const b = this.buckets.get(ref);
      if (!b || b.deleted)
        return this.fail('inspectBucket', 'not_found', 'NOT_FOUND', 'no such bucket');
      return this.ok(
        'inspectBucket',
        'inspected',
        {
          providerRef: ref,
          bucketName: b.spec.bucketName,
          endpoint: `https://${b.spec.bucketName}.mock.invalid`,
          providerRegionId: b.spec.providerRegionId,
          versioning: b.spec.versioning,
          publicAccess: b.policy?.access === 'public-read',
          objectCount: b.objects.size,
          bytesStored: [...b.objects.values()].reduce((s, n) => s + n, 0),
          observedAt: this.iso(),
        },
        ref,
      );
    });
  }
  findBucketByToken(
    _ctx: AccountContext,
    token: string,
  ): Promise<OperationResult<BucketRef | null>> {
    return this.reading('findBucketByToken', () => {
      const r = this.byToken.get(token);
      const b = r ? this.buckets.get(r) : undefined;
      return this.ok(
        'findBucketByToken',
        b && !b.deleted ? 'found' : 'absent',
        b && !b.deleted ? { providerRef: b.ref } : null,
        b?.ref,
      );
    });
  }
  deleteBucket(
    _ctx: AccountContext,
    ref: string,
    opts: { force: boolean; idempotencyToken: string },
  ): Promise<OperationResult<void>> {
    return this.mutating('deleteBucket', () => {
      const b = this.buckets.get(ref);
      if (!b || b.deleted) return this.ok('deleteBucket', 'already absent');
      if (b.objects.size > 0 && !opts.force)
        return this.fail('deleteBucket', 'conflict', 'NOT_EMPTY', 'bucket is not empty');
      b.objects.clear();
      b.creds.clear();
      b.deleted = true;
      this.names.delete(b.spec.bucketName);
      return this.ok('deleteBucket', 'deleted');
    });
  }
  putPolicy(
    _ctx: AccountContext,
    ref: string,
    policy: BucketPolicyDoc,
  ): Promise<OperationResult<void>> {
    return this.mutating('putPolicy', () => {
      if (!this.sup('object-storage.policy'))
        return this.fail('putPolicy', 'unsupported', 'UNSUPPORTED', 'policies are not supported');
      const b = this.buckets.get(ref);
      if (!b || b.deleted)
        return this.fail('putPolicy', 'not_found', 'NOT_FOUND', 'no such bucket');
      b.policy = JSON.parse(JSON.stringify(policy)) as BucketPolicyDoc;
      return this.ok('putPolicy', 'policy set');
    });
  }
  setLifecycle(
    _ctx: AccountContext,
    ref: string,
    rules: LifecycleRule[],
  ): Promise<OperationResult<void>> {
    return this.mutating('setLifecycle', () => {
      const b = this.buckets.get(ref);
      if (!b || b.deleted)
        return this.fail('setLifecycle', 'not_found', 'NOT_FOUND', 'no such bucket');
      for (const r of rules) {
        if (r.expireDays !== undefined && !this.sup('object-storage.lifecycle.expiry'))
          return this.fail(
            'setLifecycle',
            'unsupported',
            'UNSUPPORTED',
            'expiry rules are not supported',
          );
        if (
          r.abortIncompleteMultipartDays !== undefined &&
          !this.sup('object-storage.lifecycle.abort-multipart')
        )
          return this.fail(
            'setLifecycle',
            'unsupported',
            'UNSUPPORTED',
            'multipart abort rules are not supported',
          );
        if (r.transition && !this.sup('object-storage.lifecycle.transition'))
          return this.fail(
            'setLifecycle',
            'unsupported',
            'UNSUPPORTED',
            'transitions are not supported',
          );
      }
      b.lifecycle = JSON.parse(JSON.stringify(rules)) as LifecycleRule[];
      return this.ok('setLifecycle', 'lifecycle set');
    });
  }
  issueCredential(
    _ctx: AccountContext,
    ref: string,
    req: { scope: 'read' | 'readwrite'; idempotencyToken: string },
  ): Promise<OperationResult<IssuedSecret>> {
    return this.mutating('issueCredential', () => {
      if (!this.sup('object-storage.scoped-credentials'))
        return this.fail(
          'issueCredential',
          'unsupported',
          'UNSUPPORTED',
          'scoped credentials are not supported',
        );
      const b = this.buckets.get(ref);
      if (!b || b.deleted)
        return this.fail('issueCredential', 'not_found', 'NOT_FOUND', 'no such bucket');
      const credentialId = `AKMOCK${sha256(`${ref}|${req.idempotencyToken}`).slice(0, 14).toUpperCase()}`;
      b.creds.set(credentialId, { credentialId, scope: req.scope });
      return this.ok('issueCredential', 'issued', {
        credentialId,
        username: credentialId,
        fields: {
          accessKeyId: credentialId,
          accessKeySecret: `mock-secret-${sha256(credentialId).slice(0, 30)}`,
        },
      });
    });
  }
  revokeCredential(
    _ctx: AccountContext,
    ref: string,
    req: { credentialId: string; idempotencyToken: string },
  ): Promise<OperationResult<void>> {
    return this.mutating('revokeCredential', () => {
      this.buckets.get(ref)?.creds.delete(req.credentialId);
      return this.ok('revokeCredential', 'revoked');
    });
  }
  presign(
    _ctx: AccountContext,
    ref: string,
    req: SignedUrlRequest,
  ): Promise<OperationResult<SignedUrl>> {
    return this.reading('presign', () => {
      if (!this.sup('object-storage.signed-url'))
        return this.fail('presign', 'unsupported', 'UNSUPPORTED', 'signed URLs are not supported');
      const b = this.buckets.get(ref);
      if (!b || b.deleted) return this.fail('presign', 'not_found', 'NOT_FOUND', 'no such bucket');
      const exp = Math.floor(this.clock.now() / 1000) + req.ttlSeconds;
      const path = `/${req.key}`;
      const sig = createHmac('sha256', b.signingKey)
        .update(`${req.method}|${path}|${exp}`)
        .digest('hex');
      const url = `https://${b.spec.bucketName}.mock.invalid${encodeURI(path)}?X-Method=${req.method}&X-Expires=${exp}&X-Signature=${sig}`;
      return this.ok('presign', 'signed', { url, expiresAt: new Date(exp * 1000).toISOString() });
    });
  }
  usage(_ctx: AccountContext, ref: string, _w: UsageWindow): Promise<OperationResult<BucketUsage>> {
    return this.reading('usage', () => {
      const b = this.buckets.get(ref);
      if (!b) return this.fail('usage', 'not_found', 'NOT_FOUND', 'no such bucket');
      return this.ok('usage', 'usage', {
        bytesStored: this.sup('object-storage.usage.bytes')
          ? [...b.objects.values()].reduce((s, n) => s + n, 0)
          : null,
        requests: this.sup('object-storage.usage.requests') ? b.requests : null,
        egressBytes: this.sup('object-storage.usage.egress') ? b.egressBytes : null,
      });
    });
  }
  compat(_ctx: AccountContext): Promise<OperationResult<S3CompatReport>> {
    return this.reading('compat', () => {
      const op = (operation: string, id: ObjectStorageCapabilityId) => ({
        operation,
        supported: this.sup(id),
      });
      return this.ok('compat', 'mock compat run (NOT a real endpoint)', {
        operations: [
          op('CreateBucket', 'object-storage.bucket'),
          op('PutBucketPolicy', 'object-storage.policy'),
          op('PresignedUrl', 'object-storage.signed-url'),
          op('PutBucketLifecycle.expiry', 'object-storage.lifecycle.expiry'),
          op('PutBucketLifecycle.abortMultipart', 'object-storage.lifecycle.abort-multipart'),
          op('PutBucketLifecycle.transition', 'object-storage.lifecycle.transition'),
          op('PutBucketVersioning', 'object-storage.versioning'),
        ],
        signatureVersion: 'v4' as const,
        testedAt: this.iso(),
      });
    });
  }
}
