import { v7 as uuidv7 } from 'uuid';
import { createHash } from 'node:crypto';
import {
  idempotencyToken,
  type BucketPolicyDoc,
  type LifecycleRule,
  type ObjectStorageAdapter,
} from '@nuzm/adapter-data';
import type { Db } from '@nuzm/platform';
import type { FastifyRequest } from 'fastify';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';
import type { EntitlementService } from '../../billing';
import type { OrderService } from '../../commerce';
import type { ResidencyService } from '../../compliance';
import { DB_RESOURCE, OP, isUuid, type DataConfig, type Row } from './model';
import type { DataOperations } from './operations-port';
import type { DataProviderService } from './provider.service';
import type { DataAdapterRegistry } from './adapter-registry';
import {
  BUCKET_NAME,
  DEFAULT_POLICY,
  SIGNED_URL_DEFAULT_TTL_SECONDS,
  SIGNED_URL_MAX_TTL_SECONDS,
  SIGNED_URL_METHODS,
  bucketGlobalName,
  parseLifecycle,
  parseObjectKey,
  parsePolicy,
  policyEtag,
} from './storage-policy';

export interface BucketDto {
  id: string;
  name: string;
  /** The globally unique, namespaced name S3 clients use. */
  bucketName: string;
  status: string;
  endpoint: string | null;
  dataRegion: string;
  providerRegionId: string;
  versioning: boolean;
  public: boolean;
  quotaBytes: number | null;
  lifecycle: LifecycleRule[];
  usage: {
    at: string;
    bytesStored: number | null;
    requests: number | null;
    egressBytes: number | null;
    available: { bytes: boolean; requests: boolean; egress: boolean };
  } | null;
  /** Metadata only: the bucket-scoped credential lives in the vault; the secret is never returned (reveal is PA-15). */
  credentialVaultRef: string | null;
  operationId: string | null;
  etag: number;
  createdAt: string;
}
const iso = (v: unknown) => (v ? (v as Date).toISOString() : null);
type Kick = (orgId: string, operationId: string) => void;
/** Proposals (entitlement overrides win): bucket count and total bytes per organization. */
export const DEFAULT_BUCKET_LIMITS = { count: 5, bytes: 100 * 1024 ** 3 };

/**
 * Buckets (docs/04 §2.8, M08 S34). Namespaced names, private by default, tenant-scoped credentials in the vault, deny-by-default policy subset,
 * signed URLs with a TTL cap and method scoping, capability-gated lifecycle. Enumeration of other organizations' names is not possible: every lookup
 * of a bucket that is not yours answers the same 404, and a name collision is the same `name_taken` whoever holds the name.
 */
export class StorageService {
  private kicker: Kick = () => undefined;
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ops: DataOperations,
    private readonly providers: DataProviderService,
    private readonly registry: DataAdapterRegistry,
    private readonly orders: Pick<OrderService, 'createFromQuote'>,
    private readonly entitlements: Pick<EntitlementService, 'resolve'>,
    private readonly residency: Pick<ResidencyService, 'evaluate'>,
    private readonly cfg: DataConfig,
  ) {}
  setKicker(k: Kick) {
    this.kicker = k;
  }

  dto(r: Row): BucketDto {
    return {
      id: r.id as string,
      name: r.name as string,
      bucketName: r.name_global as string,
      status: r.state as string,
      endpoint: (r.endpoint as string | null) ?? null,
      dataRegion: r.data_region as string,
      providerRegionId: r.provider_region_id as string,
      versioning: r.versioning as boolean,
      public: r.public as boolean,
      quotaBytes:
        r.quota_bytes === null || r.quota_bytes === undefined ? null : Number(r.quota_bytes),
      lifecycle: (r.lifecycle as LifecycleRule[]) ?? [],
      usage: (r.usage as BucketDto['usage']) ?? null,
      credentialVaultRef: (r.credential_vault_ref as string | null) ?? null,
      operationId: (r.operation_id as string | null) ?? null,
      etag: r.version_lock as number,
      createdAt: iso(r.created_at)!,
    };
  }
  async limits(orgId: string): Promise<{ count: number; bytes: number }> {
    const e = await this.entitlements.resolve(orgId);
    const lim = (g: string) => {
      const v = e.limits.find((l) => l.meterGroup === g)?.limit;
      return v ? Number(v) : null;
    };
    return {
      count: lim('data_bucket_count') ?? DEFAULT_BUCKET_LIMITS.count,
      bytes: lim('data_bucket_bytes') ?? DEFAULT_BUCKET_LIMITS.bytes,
    };
  }

  /** The enabled object-storage provider and what it supports, or 422 `unsupported_capability`. */
  async provider(orgId: string) {
    const p = await this.providers.resolveEnabled(orgId, 'object-storage');
    const caps = p.row.probe?.capabilities ?? {};
    return {
      ...p,
      caps,
      adapter: p.adapter as ObjectStorageAdapter,
      ctx: this.registry.ctx({ id: p.row.id, config: p.row.config }, 'storage'),
    };
  }

  async create(orgId: string, actor: string, body: Record<string, unknown>): Promise<BucketDto> {
    const name = typeof body.name === 'string' && BUCKET_NAME.test(body.name) ? body.name : null;
    if (!name)
      throw new ProblemException(
        'validation_failed',
        'name must be 3..40 characters: lower-case letters, digits and hyphens, starting and ending with a letter or digit',
      );
    if (!isUuid(body.quoteId))
      throw new ProblemException(
        'validation_failed',
        'quoteId (a quote of kind storage) is required',
      );
    if (body.versioning !== undefined && typeof body.versioning !== 'boolean')
      throw new ProblemException('validation_failed', 'versioning must be a boolean');
    for (const k of ['public', 'access', 'policy', 'orgId'])
      if (k in body)
        throw new ProblemException(
          'validation_failed',
          `${k} cannot be set at creation: buckets are private and belong to the caller's organization`,
        );
    const quote = await this.db.withOrg(orgId, async (c) => {
      const q = (
        await c.query(`SELECT * FROM commerce.quotes WHERE id = $1 AND org_id = $2`, [
          body.quoteId,
          orgId,
        ])
      ).rows[0] as Row | undefined;
      if (!q) throw new ProblemException('not_found', 'quote not found');
      const it = (
        await c.query(
          `SELECT details FROM commerce.quote_items WHERE quote_id = $1 AND meter_id = 'storage.object_gb_months' ORDER BY position LIMIT 1`,
          [body.quoteId],
        )
      ).rows[0] as Row | undefined;
      return { q, details: (it?.details ?? {}) as Record<string, unknown> };
    });
    if (quote.q.kind !== 'storage')
      throw new ProblemException('validation_failed', 'the quote is not a storage quote');
    const p = await this.provider(orgId);
    if (p.caps['object-storage.bucket'] !== 'supported' || !p.row.probe?.passed)
      throw new ProblemException(
        'unsupported_capability',
        'the provider probe does not report buckets as supported',
      );
    const versioning = body.versioning === true;
    if (versioning && p.caps['object-storage.versioning'] !== 'supported')
      throw new ProblemException(
        'unsupported_capability',
        'versioning is not supported by the provider',
      );
    const cat = await p.adapter.catalog(p.ctx);
    const wanted =
      (body.region as string | undefined) ??
      (quote.details.providerRegionId as string | undefined) ??
      (p.row.config.defaultRegion as string | undefined) ??
      cat.regions[0]?.providerRegionId;
    const region = cat.regions.find((r) => r.providerRegionId === wanted);
    if (!region || (region.verifiedAt === null && p.row.environment !== 'local'))
      throw new ProblemException(
        'unsupported_capability',
        'the region is not offered or not verified for this account',
      );
    if (
      quote.details.providerRegionId &&
      quote.details.providerRegionId !== region.providerRegionId
    )
      throw new ProblemException('validation_failed', 'the quote was issued for another region');
    const res = await this.residency.evaluate({
      orgId,
      dataClass: 'customer-content',
      targetRegion: region.providerRegionId,
      purpose: 'object_storage',
      operation: 'write',
      ...(p.row.family.startsWith('provider-') ? { processorId: p.row.providerCode } : {}),
    });
    if (res.decision !== 'allow')
      throw new ProblemException(
        'residency_denied',
        res.reasons.map((r) => r.message.en).join('; ') ||
          'placement is not allowed by the residency policy',
      );
    // quotas (entitlements): bucket count and total quota bytes
    const lim = await this.limits(orgId);
    const used = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT count(*)::int n FROM data.storage_buckets WHERE org_id = $1 AND state <> 'deleted' AND NOT system`,
            [orgId],
          )
        ).rows[0]!.n as number,
    );
    if (used >= lim.count)
      throw new ProblemException(
        'quota_exceeded',
        `the organization already has ${used} of ${lim.count} buckets`,
      );
    const order = await this.orders.createFromQuote(orgId, quote.q.id as string, actor);
    const id = uuidv7();
    const global = bucketGlobalName(orgId, name);
    const map = (p.row.config.regionMap as Record<string, string> | undefined) ?? {};
    try {
      const row = await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `INSERT INTO data.storage_buckets (id, org_id, name, name_global, state, versioning, quota_bytes, data_region, provider_region_id, provider_id, create_token, quote_id, order_id, created_by)
             VALUES ($1,$2,$3,$4,'provisioning',$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
              [
                id,
                orgId,
                name,
                global,
                versioning,
                lim.bytes,
                map[region.providerRegionId] ?? region.providerRegionId,
                region.providerRegionId,
                p.row.id,
                idempotencyToken(orgId, id, 'create'),
                quote.q.id,
                order.id,
                actor,
              ],
            )
          ).rows[0] as Row,
      );
      const op = await this.ops.create(orgId, {
        kind: OP.BUCKET_CREATE,
        resourceKind: 'bucket',
        resourceId: id,
        createdBy: actor,
        maxAttempts: 1,
        input: { bucketId: id },
      });
      const out = await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `UPDATE data.storage_buckets SET operation_id = $2 WHERE id = $1 RETURNING *`,
              [id, op.id],
            )
          ).rows[0] as Row,
      );
      await this.audit.record({
        action: 'data.bucket.created',
        actorUserId: actor,
        orgId,
        resource: { type: 'bucket', id },
        outcome: 'success',
        after: { dataRegion: row.data_region, versioning, public: false, operationId: op.id },
      });
      this.kicker(orgId, op.id);
      return this.dto(out);
    } catch (e) {
      // the same answer whoever holds the name: no way to tell "yours" from "somebody else's" (enumeration)
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException('name_taken', 'this bucket name is not available');
      throw e;
    }
  }

  async list(orgId: string, q: { limit: number; cursor?: string }): Promise<Page<BucketDto>> {
    const before = decodeCursor(q.cursor);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM data.storage_buckets WHERE org_id = $1 AND NOT system AND state <> 'deleted' AND ($2::uuid IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
            [orgId, before, q.limit + 1],
          )
        ).rows as Row[],
    );
    const p = pageOf(
      rows.map((r) => ({ ...r, id: r.id as string })),
      q.limit,
    );
    return { items: p.items.map((r) => this.dto(r)), nextCursor: p.nextCursor };
  }
  async row(orgId: string, id: string): Promise<Row> {
    if (!isUuid(id)) throw new ProblemException('not_found');
    const r = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM data.storage_buckets WHERE id = $1 AND org_id = $2 AND NOT system`,
            [id, orgId],
          )
        ).rows[0],
    )) as Row | undefined;
    if (!r || r.state === 'deleted') throw new ProblemException('not_found');
    return r;
  }
  async get(orgId: string, id: string): Promise<BucketDto> {
    return this.dto(await this.row(orgId, id));
  }

  async patch(
    orgId: string,
    actor: string,
    id: string,
    ifMatch: number,
    body: Record<string, unknown>,
  ): Promise<BucketDto> {
    const cur = await this.row(orgId, id);
    if (cur.version_lock !== ifMatch)
      throw new ProblemException('precondition_failed', 'the bucket changed; fetch it again');
    const keys = Object.keys(body);
    if (keys.length === 0 || keys.some((k) => !['quotaBytes'].includes(k)))
      throw new ProblemException('validation_failed', 'PATCH accepts quotaBytes');
    const lim = await this.limits(orgId);
    const q = body.quotaBytes;
    if (!Number.isInteger(q) || (q as number) < 0 || (q as number) > lim.bytes)
      throw new ProblemException(
        'validation_failed',
        `quotaBytes must be an integer of 0..${lim.bytes} (the entitlement)`,
      );
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE data.storage_buckets SET quota_bytes = $3 WHERE id = $1 AND org_id = $2 AND version_lock = $4 RETURNING *`,
            [id, orgId, q, ifMatch],
          )
        ).rows[0] as Row | undefined,
    );
    if (!r) throw new ProblemException('precondition_failed', 'the bucket changed; fetch it again');
    await this.audit.record({
      action: 'data.bucket.updated',
      actorUserId: actor,
      orgId,
      resource: { type: 'bucket', id },
      outcome: 'success',
      after: { quotaBytes: q },
    });
    return this.dto(r);
  }

  /** DELETE: empty buckets only; `force` (and `confirmName`) deletes the objects too and needs `data:storage:admin` + a recent MFA check. */
  async remove(
    orgId: string,
    actor: string,
    id: string,
    input: { force: boolean; confirmName?: unknown },
    req: FastifyRequest,
    canForce: boolean,
  ): Promise<{ bucket: BucketDto; operationId: string }> {
    const cur = await this.row(orgId, id);
    if (input.confirmName !== cur.name)
      throw new ProblemException('validation_failed', 'confirmName must equal the bucket name');
    if (!['active', 'failed', 'unknown', 'provisioning'].includes(cur.state as string))
      throw new ProblemException(
        'conflict',
        `a bucket in state ${String(cur.state)} cannot be deleted`,
      );
    if (input.force) {
      if (!canForce)
        throw new ProblemException(
          'forbidden',
          'permission data:storage:admin is required to force-delete a bucket',
        );
      assertRecentMfa(req);
    } else if (cur.provider_ref && cur.state === 'active') {
      const p = await this.provider(orgId).catch(() => null);
      const ins = p ? await p.adapter.inspectBucket(p.ctx, cur.provider_ref as string) : null;
      if (ins && ins.status === 'succeeded' && (ins.data?.objectCount ?? 0) > 0)
        throw new ProblemException(
          'conflict',
          'the bucket is not empty: delete the objects first, or delete with force=true',
        );
    }
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE data.storage_buckets SET state = 'deleting' WHERE id = $1 AND org_id = $2 AND state = $3 RETURNING *`,
            [id, orgId, cur.state],
          )
        ).rows[0] as Row | undefined,
    );
    if (!r) throw new ProblemException('conflict', 'the bucket changed state; retry');
    const op = await this.ops.create(orgId, {
      kind: OP.BUCKET_DELETE,
      resourceKind: 'bucket',
      resourceId: id,
      createdBy: actor,
      maxAttempts: 1,
      input: { bucketId: id, force: input.force, priorState: cur.state },
    });
    const out = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE data.storage_buckets SET operation_id = $2 WHERE id = $1 RETURNING *`,
            [id, op.id],
          )
        ).rows[0] as Row,
    );
    await this.audit.record({
      action: 'data.bucket.deleted',
      actorUserId: actor,
      orgId,
      resource: { type: 'bucket', id },
      outcome: 'success',
      after: { force: input.force, operationId: op.id },
    });
    this.kicker(orgId, op.id);
    return { bucket: this.dto(out), operationId: op.id };
  }

  // ---- access policy ---------------------------------------------------------------------------------------------------------
  async getPolicy(
    orgId: string,
    id: string,
  ): Promise<{ policy: BucketPolicyDoc; etag: string; public: boolean }> {
    const b = await this.row(orgId, id);
    const p = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT * FROM data.bucket_policies WHERE bucket_id = $1 AND org_id = $2`, [
            id,
            orgId,
          ])
        ).rows[0],
    )) as Row | undefined;
    const policy = (p?.policy as BucketPolicyDoc | undefined) ?? DEFAULT_POLICY;
    return {
      policy,
      etag: (p?.etag as string | undefined) ?? policyEtag(DEFAULT_POLICY),
      public: b.public as boolean,
    };
  }
  /** PUT: If-Match on the policy ETag; `access=public-read` needs `confirmPublic=true`, is audited as `data.bucket.made_public` and needs a recent MFA check. */
  async putPolicy(
    orgId: string,
    actor: string,
    id: string,
    ifMatch: string,
    body: Record<string, unknown>,
    req: FastifyRequest,
  ): Promise<{ policy: BucketPolicyDoc; etag: string; public: boolean }> {
    const b = await this.row(orgId, id);
    if (b.state !== 'active') throw new ProblemException('conflict', 'the bucket is not active');
    const doc = parsePolicy(body.policy ?? (({ confirmPublic: _c, ...rest }) => rest)(body));
    const cur = await this.getPolicy(orgId, id);
    if (ifMatch !== cur.etag && ifMatch !== `"${cur.etag}"`)
      throw new ProblemException('precondition_failed', 'the policy changed; fetch it again');
    const makingPublic = doc.access === 'public-read' && !(b.public as boolean);
    if (makingPublic) {
      if (body.confirmPublic !== true)
        throw new ProblemException(
          'policy_invalid',
          'a public bucket exposes every object to the internet: send confirmPublic=true to confirm',
        );
      assertRecentMfa(req);
    }
    if (
      doc.access === 'public-read' &&
      (b.public as boolean) === false &&
      Object.keys(body).includes('confirmPublic') === false
    )
      throw new ProblemException('policy_invalid', 'confirmPublic is required');
    const p = await this.provider(orgId);
    if (p.caps['object-storage.policy'] !== 'supported')
      throw new ProblemException(
        'unsupported_capability',
        'the provider does not support bucket policies',
      );
    const r = await p.adapter.putPolicy(p.ctx, b.provider_ref as string, doc);
    if (r.status !== 'succeeded' && r.status !== 'accepted') {
      if (r.status === 'uncertain')
        throw new ProblemException(
          'service_unavailable',
          'the provider did not answer in time; read the policy before retrying',
        );
      throw new ProblemException(
        r.error?.category === 'unsupported' ? 'unsupported_capability' : 'service_unavailable',
        'the provider refused the policy',
      );
    }
    const etag = policyEtag(doc);
    await this.db.withOrg(orgId, async (c) => {
      await c.query(
        `INSERT INTO data.bucket_policies (id, org_id, bucket_id, policy, etag, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (bucket_id) DO UPDATE SET policy = EXCLUDED.policy, etag = EXCLUDED.etag, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [uuidv7(), orgId, id, JSON.stringify(doc), etag, actor],
      );
      const pub = doc.access === 'public-read';
      await c.query(
        `UPDATE data.storage_buckets SET public = $2, public_confirmed_by = $3, public_confirmed_at = $4 WHERE id = $1`,
        [id, pub, pub ? actor : null, pub ? new Date() : null],
      );
    });
    await this.audit.record({
      action: 'data.bucket.policy_changed',
      actorUserId: actor,
      orgId,
      resource: { type: 'bucket', id },
      outcome: 'success',
      after: { access: doc.access, statements: doc.statements.length },
    });
    if (makingPublic)
      await this.audit.record({
        action: 'data.bucket.made_public',
        actorUserId: actor,
        orgId,
        resource: { type: 'bucket', id },
        outcome: 'success',
        after: { confirmed: true },
      });
    return { policy: doc, etag, public: doc.access === 'public-read' };
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------------------------
  async getLifecycle(
    orgId: string,
    id: string,
  ): Promise<{
    rules: LifecycleRule[];
    capabilities: { expiry: boolean; abortMultipart: boolean; transition: boolean };
  }> {
    const b = await this.row(orgId, id);
    const p = await this.provider(orgId).catch(() => null);
    const c = p?.caps ?? {};
    return {
      rules: (b.lifecycle as LifecycleRule[]) ?? [],
      capabilities: {
        expiry: c['object-storage.lifecycle.expiry'] === 'supported',
        abortMultipart: c['object-storage.lifecycle.abort-multipart'] === 'supported',
        transition: c['object-storage.lifecycle.transition'] === 'supported',
      },
    };
  }
  async putLifecycle(
    orgId: string,
    actor: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<{ rules: LifecycleRule[] }> {
    const b = await this.row(orgId, id);
    if (b.state !== 'active') throw new ProblemException('conflict', 'the bucket is not active');
    const rules = parseLifecycle(body);
    const p = await this.provider(orgId);
    for (const r of rules) {
      if (r.expireDays !== undefined && p.caps['object-storage.lifecycle.expiry'] !== 'supported')
        throw new ProblemException(
          'unsupported_capability',
          'expiry rules are not supported by the provider',
        );
      if (
        r.abortIncompleteMultipartDays !== undefined &&
        p.caps['object-storage.lifecycle.abort-multipart'] !== 'supported'
      )
        throw new ProblemException(
          'unsupported_capability',
          'multipart-abort rules are not supported by the provider',
        );
      if (r.transition && p.caps['object-storage.lifecycle.transition'] !== 'supported')
        throw new ProblemException(
          'unsupported_capability',
          'transitions are not supported by the provider',
        );
    }
    const res = await p.adapter.setLifecycle(p.ctx, b.provider_ref as string, rules);
    if (res.status !== 'succeeded' && res.status !== 'accepted')
      throw new ProblemException(
        res.error?.category === 'unsupported' ? 'unsupported_capability' : 'service_unavailable',
        'the provider refused the lifecycle rules',
      );
    await this.db.withOrg(orgId, (c) =>
      c.query(`UPDATE data.storage_buckets SET lifecycle = $2 WHERE id = $1`, [
        id,
        JSON.stringify(rules),
      ]),
    );
    await this.audit.record({
      action: 'data.bucket.lifecycle_changed',
      actorUserId: actor,
      orgId,
      resource: { type: 'bucket', id },
      outcome: 'success',
      after: { rules: rules.length },
    });
    return { rules };
  }

  // ---- signed URLs -------------------------------------------------------------------------------------------------------------
  /** Method-scoped: GET/HEAD need read, PUT/DELETE need write. The URL is returned once and is never logged or audited (a hash of the key is). */
  async signUrl(
    orgId: string,
    actor: string,
    id: string,
    body: Record<string, unknown>,
    perms: ReadonlySet<string>,
  ): Promise<{ url: string; expiresAt: string; method: string }> {
    const b = await this.row(orgId, id);
    if (b.state !== 'active') throw new ProblemException('conflict', 'the bucket is not active');
    const method = body.method;
    if (!(SIGNED_URL_METHODS as readonly unknown[]).includes(method))
      throw new ProblemException(
        'validation_failed',
        `method must be one of ${SIGNED_URL_METHODS.join(', ')}`,
      );
    if ((method === 'PUT' || method === 'DELETE') && !perms.has('data:storage:write'))
      throw new ProblemException(
        'forbidden',
        'permission data:storage:write is required to sign a write URL',
      );
    const key = parseObjectKey(body.key);
    const ttl = body.ttlSeconds === undefined ? SIGNED_URL_DEFAULT_TTL_SECONDS : body.ttlSeconds;
    if (!Number.isInteger(ttl) || (ttl as number) < 1)
      throw new ProblemException('validation_failed', 'ttlSeconds must be a positive integer');
    if ((ttl as number) > SIGNED_URL_MAX_TTL_SECONDS)
      throw new ProblemException(
        'ttl_too_long',
        `ttlSeconds cannot exceed ${SIGNED_URL_MAX_TTL_SECONDS} (7 days)`,
      );
    if (Object.keys(body).some((k) => !['key', 'method', 'ttlSeconds'].includes(k)))
      throw new ProblemException('validation_failed', 'unknown field');
    const p = await this.provider(orgId);
    if (p.caps['object-storage.signed-url'] !== 'supported')
      throw new ProblemException(
        'unsupported_capability',
        'the provider does not support signed URLs',
      );
    const r = await p.adapter.presign(p.ctx, b.provider_ref as string, {
      key,
      method: method as 'GET',
      ttlSeconds: ttl as number,
    });
    if ((r.status !== 'succeeded' && r.status !== 'accepted') || !r.data)
      throw new ProblemException(
        r.error?.category === 'unsupported' ? 'unsupported_capability' : 'service_unavailable',
        'the provider could not sign the URL',
      );
    await this.audit.record({
      action: 'data.signed_url.issued',
      actorUserId: actor,
      orgId,
      resource: { type: 'bucket', id },
      outcome: 'success',
      after: {
        method,
        ttlSeconds: ttl,
        keyHash: createHash('sha256').update(key).digest('hex').slice(0, 16),
      },
    });
    return { url: r.data.url, expiresAt: r.data.expiresAt, method: method as string };
  }
}

/** The same freshness rule as `@StepUp()`, for a branch of a route (force-delete, making a bucket public). */
export function assertRecentMfa(req: FastifyRequest): void {
  const p = (req as unknown as { principal?: { mfaLevel?: string; mfaVerifiedAt?: Date } })
    .principal;
  const max = Number(process.env.STEP_UP_MAX_AGE_SECONDS ?? 300) * 1000;
  if (
    !p ||
    p.mfaLevel === undefined ||
    p.mfaLevel === 'none' ||
    !p.mfaVerifiedAt ||
    Date.now() - p.mfaVerifiedAt.getTime() > max
  )
    throw new ProblemException('step_up_required', 'verify MFA to continue');
}
export { DB_RESOURCE };
