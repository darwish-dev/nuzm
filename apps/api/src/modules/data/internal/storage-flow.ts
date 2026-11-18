import { idempotencyToken, orgTag, type ObjectStorageAdapter } from '@nuzm/adapter-data';
import { emitUsage, usageEventId, type Operation, type UsageEvent } from '@nuzm/platform';
import type { DataAlerts } from './alerts';
import type { DatabaseFlow } from './database-flow';
import { FlowFailure, FlowUncertain, outcomeOf, retryTransient } from './flow-support';
import { gibMonthFraction } from './metering';
import { OP, type Row } from './model';
import type { StorageService } from './storage.service';
import { DEFAULT_POLICY, policyEtag } from './storage-policy';

/** The reserved organization that owns the platform's own (system) buckets: backups and their replicas. No tenant can see its rows (RLS). */
export const SYSTEM_ORG = '00000000-0000-0000-0000-000000000001';

/** Exact `n / 1000` (thousand requests) with 8 decimals. */
export const thousands = (n: number): string => {
  const q = (BigInt(n) * 10n ** 8n * 2n + 1000n) / 2000n;
  return `${q / 10n ** 8n}.${(q % 10n ** 8n).toString().padStart(8, '0')}`;
};
/** Exact `bytes / 10^9` (decimal GB) with 8 decimals, half-up. */
export const decimalGb = (bytes: number): string => {
  const q = (BigInt(bytes) * 2n * 10n ** 8n + 10n ** 9n) / (2n * 10n ** 9n);
  return `${q / 10n ** 8n}.${(q % 10n ** 8n).toString().padStart(8, '0')}`;
};
const dayFloor = (d: Date) => new Date(Math.floor(d.getTime() / 86_400_000) * 86_400_000);

/**
 * Bucket operations (create, delete) and the usage collector, on the same durable-operation machinery as the databases: re-entrant steps,
 * deterministic idempotency tokens, `uncertain` → one lookup by token → park for the reconciler, credentials straight into the vault.
 */
export class StorageFlow {
  constructor(
    private readonly flow: DatabaseFlow,
    private readonly storage: StorageService,
    private readonly alerts: DataAlerts,
  ) {
    flow.register(OP.BUCKET_CREATE, (o, op, w) => this.runCreate(o, op, w));
    flow.register(OP.BUCKET_DELETE, (o, op, w) => this.runDelete(o, op, w));
  }

  private async bucket(orgId: string, id: string): Promise<Row> {
    const r = (await this.flow.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT * FROM data.storage_buckets WHERE id = $1 AND org_id = $2`, [
            id,
            orgId,
          ])
        ).rows[0],
    )) as Row | undefined;
    if (!r) throw new FlowFailure('not_found', 'the bucket no longer exists');
    return r;
  }
  private async setBucket(orgId: string, id: string, set: Record<string, unknown>): Promise<Row> {
    const keys = Object.keys(set);
    const vals = keys.map((k) =>
      k === 'usage' || k === 'lifecycle' ? JSON.stringify(set[k]) : set[k],
    );
    return this.flow.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE data.storage_buckets SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} WHERE id = $1 AND org_id = $2 RETURNING *`,
            [id, orgId, ...vals],
          )
        ).rows[0] as Row,
    );
  }
  private async access(orgId: string, b: Row) {
    const p = b.provider_id
      ? await this.flow.providers.byId(orgId, b.provider_id as string, 'object-storage')
      : null;
    if (!p || !p.row.enabled)
      throw new FlowFailure('provider_unavailable', 'the provider is not available');
    return {
      adapter: p.adapter as unknown as ObjectStorageAdapter,
      ctx: this.flow.registry.ctx({ id: p.row.id, config: p.row.config }, 'storage-flow'),
      family: p.row.family,
      providerCode: p.row.providerCode,
      caps: p.row.probe?.capabilities ?? {},
    };
  }

  private async runCreate(orgId: string, op: Operation, worker: string): Promise<void> {
    const input = op.input as { bucketId: string };
    let b = await this.bucket(orgId, input.bucketId);
    if (b.state === 'active')
      return void (await this.flow.ops.succeed(orgId, op.id, worker, {
        bucketId: b.id,
        state: 'active',
      }));
    try {
      const a = await this.access(orgId, b);
      const res = await this.flow.residency.evaluate({
        orgId,
        dataClass: 'customer-content',
        targetRegion: String(b.provider_region_id),
        purpose: 'object_storage',
        operation: 'write',
        ...(a.family.startsWith('provider-') ? { processorId: a.providerCode } : {}),
      });
      if (res.decision !== 'allow')
        throw new FlowFailure(
          'residency_denied',
          'placement is no longer allowed by the residency policy',
          { evidenceRef: res.evidenceRef },
        );
      const token = b.create_token as string;
      const spec = {
        bucketName: b.name_global as string,
        providerRegionId: b.provider_region_id as string,
        versioning: b.versioning as boolean,
        tags: { 'nuzm-org': orgTag(orgId), 'nuzm-op': op.id },
      };
      if (!b.provider_ref) {
        let found: string | undefined;
        if (op.attempts > 1) {
          const f = outcomeOf(await a.adapter.findBucketByToken(a.ctx, token));
          if (f.kind === 'ok' && f.data) found = (f.data as { providerRef: string }).providerRef;
          else if (f.kind !== 'ok')
            throw new FlowUncertain('could not look the bucket up by token');
        }
        if (!found) {
          const o = outcomeOf(
            await retryTransient(this.flow.cfg, () =>
              a.adapter.createBucket(a.ctx, { ...spec, idempotencyToken: token }),
            ),
          );
          if (o.kind === 'ok')
            found = o.ref ?? (o.data as { providerRef: string } | undefined)?.providerRef;
          else if (o.kind === 'uncertain') {
            const f = outcomeOf(await a.adapter.findBucketByToken(a.ctx, token));
            if (f.kind === 'ok' && f.data) found = (f.data as { providerRef: string }).providerRef;
            else if (f.kind === 'ok') {
              const again = outcomeOf(
                await a.adapter.createBucket(a.ctx, { ...spec, idempotencyToken: token }),
              );
              if (again.kind === 'ok')
                found =
                  again.ref ?? (again.data as { providerRef: string } | undefined)?.providerRef;
              else throw new FlowUncertain('the create call timed out twice');
            } else throw new FlowUncertain('the create call timed out and the lookup failed');
          } else
            throw new FlowFailure(
              o.unsupported
                ? 'unsupported_capability'
                : o.code === 'NAME_TAKEN'
                  ? 'name_taken'
                  : 'provider_refused',
              o.message,
            );
        }
        if (!found) throw new FlowUncertain('no provider reference after create');
        b = await this.setBucket(orgId, b.id as string, { provider_ref: found });
      }
      const ins = outcomeOf(await a.adapter.inspectBucket(a.ctx, b.provider_ref as string));
      if (ins.kind === 'failed') throw new FlowFailure('provider_refused', ins.message);
      if (ins.kind !== 'ok' || !ins.data)
        throw new FlowUncertain('the bucket could not be inspected');
      if (ins.data.publicAccess)
        throw new FlowFailure(
          'public_by_default',
          'the provider created a PUBLIC bucket: refusing to hand it out',
        );
      // the bucket-scoped credential goes straight into the vault
      if (!b.credential_vault_ref) {
        const iss = outcomeOf(
          await retryTransient(this.flow.cfg, () =>
            a.adapter.issueCredential(a.ctx, b.provider_ref as string, {
              scope: 'readwrite',
              idempotencyToken: idempotencyToken(orgId, op.id, 'credential'),
            }),
          ),
        );
        if (iss.kind === 'uncertain') throw new FlowUncertain('the credential call timed out');
        if (iss.kind !== 'ok' || !iss.data)
          throw new FlowFailure(
            iss.kind === 'failed' && iss.unsupported
              ? 'unsupported_capability'
              : 'credential_failed',
            iss.kind === 'failed' ? iss.message : 'no credential returned',
          );
        let ref: string;
        try {
          ref = await this.flow.secrets.put(
            `bkt-${String(b.id)}-${iss.data.credentialId.replace(/[^A-Za-z0-9_-]/g, '')}`,
            JSON.stringify({
              ...iss.data.fields,
              endpoint: ins.data.endpoint,
              bucket: b.name_global,
              credentialId: iss.data.credentialId,
            }),
          );
        } catch {
          await a.adapter
            .revokeCredential(a.ctx, b.provider_ref as string, {
              credentialId: iss.data.credentialId,
              idempotencyToken: idempotencyToken(orgId, op.id, 'revoke-after-vault-failure'),
            })
            .catch(() => undefined);
          throw new FlowUncertain('the vault is unavailable');
        }
        b = await this.setBucket(orgId, b.id as string, { credential_vault_ref: ref });
      }
      // explicit deny-by-default: the private policy document is recorded and applied
      if (a.caps['object-storage.policy'] === 'supported') {
        const r = outcomeOf(
          await a.adapter.putPolicy(a.ctx, b.provider_ref as string, DEFAULT_POLICY),
        );
        if (r.kind === 'uncertain') throw new FlowUncertain('the policy call timed out');
      }
      await this.flow.db.withOrg(orgId, (c) =>
        c.query(
          `INSERT INTO data.bucket_policies (id, org_id, bucket_id, policy, etag) VALUES (gen_random_uuid(), $1, $2, $3, $4) ON CONFLICT (bucket_id) DO NOTHING`,
          [orgId, b.id, JSON.stringify(DEFAULT_POLICY), policyEtag(DEFAULT_POLICY)],
        ),
      );
      b = await this.setBucket(orgId, b.id as string, {
        state: 'active',
        endpoint: ins.data.endpoint,
      });
      await this.flow.audit.record({
        action: 'data.bucket.provisioned',
        actorType: 'system',
        orgId,
        resource: { type: 'bucket', id: String(b.id) },
        outcome: 'success',
        after: { dataRegion: b.data_region, public: false },
      });
      await this.flow.ops.succeed(orgId, op.id, worker, { bucketId: b.id, state: 'active' });
    } catch (e) {
      if (e instanceof FlowFailure)
        await this.setBucket(orgId, b.id as string, { state: 'failed' }).catch(() => undefined);
      throw e;
    }
  }

  private async runDelete(orgId: string, op: Operation, worker: string): Promise<void> {
    const input = op.input as { bucketId: string; force: boolean };
    const b = await this.bucket(orgId, input.bucketId);
    if (b.state === 'deleted')
      return void (await this.flow.ops.succeed(orgId, op.id, worker, { deleted: true }));
    if (b.provider_ref) {
      const a = await this.access(orgId, b);
      const d = outcomeOf(
        await retryTransient(this.flow.cfg, () =>
          a.adapter.deleteBucket(a.ctx, b.provider_ref as string, {
            force: input.force,
            idempotencyToken: idempotencyToken(orgId, op.id, 'delete'),
          }),
        ),
      );
      if (d.kind === 'uncertain') {
        const i = outcomeOf(await a.adapter.inspectBucket(a.ctx, b.provider_ref as string));
        if (!(i.kind === 'failed' && !i.retryable))
          throw new FlowUncertain('the delete call timed out');
      } else if (d.kind === 'failed') {
        // a bucket that was not empty stays (and stays active): nothing was destroyed
        await this.setBucket(orgId, b.id as string, { state: 'active' }).catch(() => undefined);
        throw new FlowFailure(d.code === 'NOT_EMPTY' ? 'not_empty' : 'delete_failed', d.message);
      }
    }
    if (b.credential_vault_ref)
      await this.flow.secrets.delete(b.credential_vault_ref as string).catch(() => undefined);
    await this.setBucket(orgId, b.id as string, { state: 'deleted', deleted_at: new Date() });
    await this.flow.audit.record({
      action: 'data.bucket.destroyed',
      actorType: 'system',
      orgId,
      resource: { type: 'bucket', id: String(b.id) },
      outcome: 'success',
      after: { force: input.force },
    });
    await this.flow.ops.succeed(orgId, op.id, worker, { deleted: true });
  }

  /**
   * Daily usage import (M08 §10): bytes → `storage.object_gb_months` (accrual /30), requests → `storage.requests_k`, egress → `storage.egress_gb`.
   * A figure the provider cannot report is `unavailable`: no event is emitted (billing for it is off), it is flagged on the bucket, and it is NEVER estimated.
   * Deterministic event ids make a re-run idempotent.
   */
  async collectUsage(day: Date): Promise<number> {
    const start = dayFloor(day);
    const end = new Date(start.getTime() + 86_400_000);
    const rows = await this.flow.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT * FROM data.storage_buckets WHERE state = 'active' AND NOT system AND created_at < $1 ORDER BY id`,
            [end],
          )
        ).rows as Row[],
    );
    let n = 0;
    for (const b of rows) {
      const orgId = b.org_id as string;
      try {
        const a = await this.access(orgId, b);
        const u = outcomeOf(
          await a.adapter.usage(a.ctx, b.provider_ref as string, {
            from: start.toISOString(),
            to: end.toISOString(),
          }),
        );
        if (u.kind !== 'ok' || !u.data) continue;
        const d = u.data;
        const mk = (
          meterId: string,
          quantity: string,
          unit: string,
          dims: Record<string, string>,
        ): UsageEvent => ({
          eventId: usageEventId({
            orgId,
            meterId,
            resourceId: String(b.id),
            windowStart: start.toISOString(),
          }),
          orgId,
          meterId,
          quantity,
          unit,
          resourceId: String(b.id),
          windowStart: start.toISOString(),
          windowEnd: end.toISOString(),
          occurredAt: end.toISOString(),
          dimensions: dims,
          dataRegion: String(b.data_region),
          source: 'storage@M08',
        });
        const events: UsageEvent[] = [];
        if (d.bytesStored !== null)
          events.push(
            mk('storage.object_gb_months', gibMonthFraction(BigInt(d.bytesStored)), 'gib_month', {
              region: String(b.data_region),
              class: 'standard',
            }),
          );
        if (d.requests !== null)
          events.push(
            mk('storage.requests_k', thousands(d.requests), 'thousand_requests', {
              op_class: 'all',
            }),
          );
        if (d.egressBytes !== null)
          events.push(
            mk('storage.egress_gb', decimalGb(d.egressBytes), 'gb', {
              region: String(b.data_region),
            }),
          );
        await this.flow.db.withOrg(orgId, async (c) => {
          for (const e of events) await emitUsage(c, e);
        });
        n += events.length;
        const overQuota =
          b.quota_bytes !== null && d.bytesStored !== null && d.bytesStored > Number(b.quota_bytes);
        const prev = (b.usage as { overQuota?: boolean } | null)?.overQuota === true;
        await this.setBucket(orgId, b.id as string, {
          usage: {
            at: end.toISOString(),
            bytesStored: d.bytesStored,
            requests: d.requests,
            egressBytes: d.egressBytes,
            available: {
              bytes: d.bytesStored !== null,
              requests: d.requests !== null,
              egress: d.egressBytes !== null,
            },
            overQuota,
          },
        });
        if (overQuota && !prev)
          await this.alerts.raise(orgId, {
            kind: 'data.bucket_over_quota',
            severity: 'warning',
            resource: { type: 'bucket', id: String(b.id) },
            detail: { bytesStored: d.bytesStored, quotaBytes: Number(b.quota_bytes) },
            audiencePermission: 'data:storage:admin',
          });
      } catch {
        /* one bucket's failure never stops the import of the others; the next run covers the same window (idempotent) */
      }
    }
    return n;
  }

  /**
   * The SYSTEM bucket pair (backup + replica) of a data region (M08 S34 task 5): `nz-sys-<region>-backups` and `nz-sys-<region>-replica`, owned by the reserved
   * system organization, created through the enabled object-storage provider in the SAME region. Idempotent. Database backups of a `self-operated-*`
   * family point at the backup bucket (`SelfOperatedConfig.systemBucketFor`).
   */
  async ensureSystemBuckets(
    providerRegionId: string,
  ): Promise<{ backups: string; replica: string }> {
    const p = await this.flow.providers.resolveEnabled(SYSTEM_ORG, 'object-storage');
    const adapter = p.adapter as unknown as ObjectStorageAdapter;
    const ctx = this.flow.registry.ctx({ id: p.row.id, config: p.row.config }, 'system-buckets');
    const out: Record<string, string> = {};
    for (const kind of ['backups', 'replica'] as const) {
      const name = `nz-sys-${providerRegionId}-${kind}`.slice(0, 63);
      const token = idempotencyToken(SYSTEM_ORG, name, 'create');
      const existing = (await this.flow.db.withOrg(
        SYSTEM_ORG,
        async (c) =>
          (
            await c.query(
              `SELECT * FROM data.storage_buckets WHERE name_global = $1 AND state <> 'deleted'`,
              [name],
            )
          ).rows[0],
      )) as Row | undefined;
      if (!existing) {
        const r = outcomeOf(
          await adapter.createBucket(ctx, {
            bucketName: name,
            providerRegionId,
            versioning: false,
            tags: { 'nuzm-system': kind },
            idempotencyToken: token,
          }),
        );
        if (r.kind !== 'ok') throw new FlowUncertain(`system bucket ${kind} could not be created`);
        const ref = r.ref ?? (r.data as { providerRef: string }).providerRef;
        await this.flow.db.withOrg(SYSTEM_ORG, (c) =>
          c.query(
            `INSERT INTO data.storage_buckets (id, org_id, name, name_global, system, state, endpoint, data_region, provider_region_id, provider_id, provider_ref, create_token) VALUES (gen_random_uuid(), $1, $2, $3, true, 'active', $4, $5, $5, $6, $7, $8)`,
            [
              SYSTEM_ORG,
              `sys-${kind}`.slice(0, 38),
              name,
              `https://${name}.invalid`,
              providerRegionId,
              p.row.id,
              ref,
              token,
            ],
          ),
        );
      }
      out[kind] = name;
    }
    return { backups: out.backups!, replica: out.replica! };
  }
}
