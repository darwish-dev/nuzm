import type {
  CacheAdapter,
  DatabaseAdapter,
  AccountContext,
  DataService,
} from '@nuzm/adapter-data';
import { idempotencyToken, orgTag } from '@nuzm/adapter-data';
import { ResidencyDenied } from '@nuzm/domain';
import type { Db, Operation } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import type { SecretStore } from '../../../common/secrets';
import type { ResidencyService } from '../../compliance';
import type { DataAdapterRegistry } from './adapter-registry';
import type { DatabaseCatalog } from './catalog';
import { FlowFailure, FlowUncertain, outcomeOf, retryTransient } from './flow-support';
import { DB_RESOURCE, OP, serviceOfEngine, type DataConfig, type Engine, type Row } from './model';
import type { DataOperations } from './operations-port';
import type { DataProviderService } from './provider.service';

export type DbAdapter = DatabaseAdapter & Partial<Pick<CacheAdapter, never>>;
/** The calls database and cache adapters share, with the request shapes that differ passed as loose objects (the engine decides which). */
export interface LooseManaged {
  create(
    ctx: AccountContext,
    req: Record<string, unknown> & { idempotencyToken: string },
  ): ReturnType<DatabaseAdapter['create']>;
  inspect: DatabaseAdapter['inspect'];
  findByToken: DatabaseAdapter['findByToken'];
  delete: DatabaseAdapter['delete'];
  issueCredential(
    ctx: AccountContext,
    ref: string,
    req: Record<string, unknown>,
  ): ReturnType<DatabaseAdapter['issueCredential']>;
  revokeCredential: DatabaseAdapter['revokeCredential'];
  listCredentials: DatabaseAdapter['listCredentials'];
  backup: DatabaseAdapter['backup'];
  findBackupByToken: DatabaseAdapter['findBackupByToken'];
  restoreToNew(
    ctx: AccountContext,
    req: Record<string, unknown>,
  ): ReturnType<DatabaseAdapter['restoreToNew']>;
  restoreInPlace?: DatabaseAdapter['restoreInPlace'];
  integrityCheck?: DatabaseAdapter['integrityCheck'];
  usage: DatabaseAdapter['usage'];
}
export interface Access {
  adapter: LooseManaged;
  ctx: AccountContext;
  service: DataService;
  providerCode: string;
  family: string;
}
export type Handler = (orgId: string, op: Operation, worker: string) => Promise<void>;

/** The ONLY ACL rule Nuzm gives a tenant's Redis user: its own keyspace, no admin/dangerous commands (allow-listed, never taken from a request). */
export const REDIS_APP_ACL = '~* +@all -@dangerous -@admin';

/** Fields of `data.database_instances` a flow may change. */
const SETTABLE = new Set([
  'state',
  'host',
  'port',
  'vault_ref',
  'provider_ref',
  'rotation',
  'network',
  'deleted_at',
  'resource_id',
]);

/**
 * Executes the durable operations of the data module (`platform.operations`, ADR-017: in the API process, kicked after the request, plus a sweep).
 * Every flow is RE-ENTRANT: it reads what already happened (provider_ref, vault_ref, backup state) and continues, so a crash, a lease expiry or a
 * reconcile resumes instead of repeating. Rules enforced here: deterministic idempotency tokens on every mutating provider call; `uncertain` is
 * parked (`needs_reconcile`) after ONE lookup-by-token — never retried blind; a definitive failure compensates and fails the operation permanently;
 * credentials go to the vault immediately and only a reference is stored; provider identity never appears in operation results or errors.
 */
export class DatabaseFlow {
  private readonly handlers = new Map<string, Handler>();
  readonly worker = `api-data-${process.pid}`;
  constructor(
    readonly db: Db,
    readonly audit: AuditSink,
    readonly ops: DataOperations,
    readonly providers: DataProviderService,
    readonly registry: DataAdapterRegistry,
    readonly secrets: SecretStore,
    readonly residency: Pick<ResidencyService, 'evaluate'>,
    readonly catalog: DatabaseCatalog,
    readonly cfg: DataConfig,
  ) {
    this.handlers.set(OP.DB_CREATE, (o, op, w) => this.runCreate(o, op, w));
    this.handlers.set(OP.DB_DELETE, (o, op, w) => this.runDelete(o, op, w));
    this.handlers.set(OP.DB_BACKUP, (o, op, w) => this.runBackup(o, op, w));
  }
  register(kind: string, h: Handler) {
    this.handlers.set(kind, h);
  }
  handles(kind: string) {
    return this.handlers.has(kind);
  }

  // ---- helpers ------------------------------------------------------------------------------------------------------------
  async inst(orgId: string, id: string): Promise<Row> {
    const r = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT * FROM data.database_instances WHERE id = $1 AND org_id = $2`, [
            id,
            orgId,
          ])
        ).rows[0],
    )) as Row | undefined;
    if (!r) throw new FlowFailure('not_found', 'the database no longer exists');
    return r;
  }
  async setInst(orgId: string, id: string, set: Record<string, unknown>): Promise<Row> {
    const keys = Object.keys(set);
    if (keys.some((k) => !SETTABLE.has(k))) throw new Error(`not settable: ${keys.join(',')}`);
    const vals = keys.map((k) =>
      k === 'rotation' || k === 'network' ? JSON.stringify(set[k]) : set[k],
    );
    return this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE data.database_instances SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} WHERE id = $1 AND org_id = $2 RETURNING *`,
            [id, orgId, ...vals],
          )
        ).rows[0] as Row,
    );
  }
  async access(orgId: string, inst: Row, trace: string): Promise<Access> {
    const service = serviceOfEngine(inst.engine as Engine);
    const p = inst.provider_id
      ? await this.providers.byId(orgId, inst.provider_id as string, service)
      : null;
    if (!p || !p.row.enabled)
      throw new FlowFailure('provider_unavailable', 'the provider is not available');
    return {
      adapter: p.adapter as unknown as LooseManaged,
      ctx: this.registry.ctx({ id: p.row.id, config: p.row.config }, trace),
      service,
      providerCode: p.row.providerCode,
      family: p.row.family,
    };
  }
  /** TOCTOU re-check at execution time: the placement must STILL be allowed (fail-closed). */
  async assertResidency(orgId: string, inst: Row, access: Access, purpose: string): Promise<void> {
    const res = await this.residency.evaluate({
      orgId,
      dataClass: 'customer-content',
      targetRegion: String(inst.provider_region_id),
      purpose,
      operation: 'write',
      ...(access.family.startsWith('provider-') ? { processorId: access.providerCode } : {}),
    });
    if (res.decision !== 'allow')
      throw new FlowFailure(
        'residency_denied',
        'placement is no longer allowed by the residency policy',
        { evidenceRef: res.evidenceRef },
      );
  }
  providerName(inst: Row) {
    return `nz-${String(inst.id).slice(-12)}`;
  }

  // ---- dispatch -----------------------------------------------------------------------------------------------------------
  /** Claim and run one operation (what the API does right after answering 202). */
  async runOne(orgId: string, operationId: string): Promise<boolean> {
    const claimed = await this.ops.claimById(orgId, operationId, this.worker);
    if (!claimed) return false;
    const op = await this.ops.get(orgId, operationId);
    if (!op) return false;
    await this.execute(orgId, op);
    return true;
  }
  async execute(orgId: string, op: Operation): Promise<void> {
    const h = this.handlers.get(op.kind);
    if (!h) return;
    try {
      await h(orgId, op, this.worker);
    } catch (e) {
      await this.settleError(orgId, op, e);
    }
  }
  /** Maps a thrown flow signal onto the operation state. Unknown errors park the operation: after a provider call "it failed" is never assumed. */
  async settleError(orgId: string, op: Operation, e: unknown): Promise<void> {
    if (e instanceof FlowFailure) {
      await this.audit.record({
        action: 'data.database.operation_failed',
        actorType: 'system',
        orgId,
        resource: { type: 'database', id: op.resource_id ?? undefined },
        outcome: 'failure',
        detail: { kind: op.kind, code: e.code, ...e.detail },
      });
      await this.ops
        .failPermanently(orgId, op.id, this.worker, { code: e.code, message: e.message })
        .catch(() => undefined);
      return;
    }
    const reason = e instanceof FlowUncertain ? e.reason : `unexpected: ${(e as Error).message}`;
    await this.ops
      .markNeedsReconcile(orgId, op.id, this.worker, reason.slice(0, 300))
      .catch(() => undefined);
  }

  // ---- create -------------------------------------------------------------------------------------------------------------
  private async runCreate(orgId: string, op: Operation, worker: string): Promise<void> {
    const input = op.input as {
      instanceId: string;
      storageGb: number;
      network: { access: 'private' | 'allowlist'; allowCidrs?: string[] };
      orderId?: string;
    };
    let inst = await this.inst(orgId, input.instanceId);
    if (inst.state === 'running')
      return void (await this.ops.succeed(orgId, op.id, worker, {
        instanceId: inst.id,
        state: 'running',
      }));
    const compensate = async (code: string) => {
      await this.setInst(orgId, inst.id as string, { state: 'failed' }).catch(() => undefined);
      await this.audit.record({
        action: 'data.database.failed',
        actorType: 'system',
        orgId,
        resource: { type: 'database', id: String(inst.id) },
        outcome: 'failure',
        detail: { code },
      });
    };
    try {
      const access = await this.access(orgId, inst, op.trace_id ?? op.id);
      await this.assertResidency(orgId, inst, access, 'managed_database');
      const engine = inst.engine as Engine;
      const tags = { 'nuzm-org': orgTag(orgId), 'nuzm-op': op.id };
      const spec: Record<string, unknown> =
        engine === 'redis'
          ? {
              version: inst.version,
              providerRegionId: inst.provider_region_id,
              planRef: inst.plan_ref,
              memoryMb: Math.max(input.storageGb, 1) * 1024,
              name: this.providerName(inst),
              network: input.network,
              persistence: 'none',
              evictionPolicy: 'noeviction',
              tags,
            }
          : {
              engine,
              version: inst.version,
              providerRegionId: inst.provider_region_id,
              planRef: inst.plan_ref,
              storageGb: input.storageGb,
              name: this.providerName(inst),
              network: input.network,
              tags,
            };
      // 1. the provider resource (reconcile-before-retry: look up by token first on any re-entry)
      if (!inst.provider_ref) {
        let found: string | undefined;
        // a re-entry (a retry or a reconcile) looks the instance up by token BEFORE creating: reconcile-before-retry
        if (op.attempts > 1) {
          const f = outcomeOf(
            await access.adapter.findByToken(access.ctx, inst.create_token as string),
          );
          if (f.kind === 'ok' && f.data) found = (f.data as { providerRef: string }).providerRef;
          else if (f.kind !== 'ok')
            throw new FlowUncertain('could not look the instance up by token');
        }
        if (!found) {
          const o = outcomeOf(
            await retryTransient(this.cfg, () =>
              access.adapter.create(access.ctx, {
                ...spec,
                idempotencyToken: inst.create_token as string,
              }),
            ),
          );
          if (o.kind === 'ok')
            found = o.ref ?? (o.data as { providerRef: string } | undefined)?.providerRef;
          else if (o.kind === 'uncertain') {
            // ONE lookup: present → continue; provably absent → ONE retry with the same token; anything else → park
            const f = outcomeOf(
              await access.adapter.findByToken(access.ctx, inst.create_token as string),
            );
            if (f.kind === 'ok' && f.data) found = (f.data as { providerRef: string }).providerRef;
            else if (f.kind === 'ok') {
              const again = outcomeOf(
                await access.adapter.create(access.ctx, {
                  ...spec,
                  idempotencyToken: inst.create_token as string,
                }),
              );
              if (again.kind === 'ok')
                found =
                  again.ref ?? (again.data as { providerRef: string } | undefined)?.providerRef;
              else throw new FlowUncertain('the create call timed out twice');
            } else throw new FlowUncertain('the create call timed out and the lookup failed');
          } else
            throw new FlowFailure(
              o.unsupported ? 'unsupported_capability' : 'provider_refused',
              o.message,
            );
        }
        if (!found) throw new FlowUncertain('no provider reference after create');
        inst = await this.setInst(orgId, inst.id as string, { provider_ref: found });
      }
      inst = await this.completeProvision(orgId, op, worker, inst, access);
      await this.audit.record({
        action: 'data.database.provisioned',
        actorType: 'system',
        orgId,
        resource: { type: 'database', id: String(inst.id) },
        outcome: 'success',
        after: { state: 'running', dataRegion: inst.data_region },
      });
      await this.ops.succeed(orgId, op.id, worker, { instanceId: inst.id, state: 'running' });
    } catch (e) {
      if (e instanceof FlowFailure) await compensate(e.code);
      throw e;
    }
  }

  /**
   * Steps 2-4 of a provision, shared by create, restore-to-new and the verification drill: wait for `running`, refuse an instance that does not
   * require TLS, issue the connection credential INTO THE VAULT (only the reference is stored), then mark the instance running. Re-entrant.
   */
  async completeProvision(
    orgId: string,
    op: Operation,
    worker: string,
    inst0: Row,
    access: Access,
  ): Promise<Row> {
    let inst = inst0;
    const engine = inst.engine as Engine;
    // 2. wait until it runs (bounded; a slow provider parks the operation, it does not fail it)
    let ins: Awaited<ReturnType<DatabaseAdapter['inspect']>>['data'];
    for (let i = 0; i < this.cfg.provisionPollAttempts; i++) {
      const r = outcomeOf(await access.adapter.inspect(access.ctx, inst.provider_ref as string));
      if (r.kind === 'ok' && r.data) {
        ins = r.data;
        if (ins.status === 'running' && ins.endpoint) break;
        if (ins.status === 'error')
          throw new FlowFailure('provider_error', 'the provider reports the instance in error');
        if (ins.status === 'deleted' || ins.status === 'deleting')
          throw new FlowFailure('provider_deleted', 'the instance disappeared at the provider');
      } else if (r.kind === 'failed' && !r.retryable)
        throw new FlowFailure('provider_refused', r.message);
      if (i < this.cfg.provisionPollAttempts - 1 && this.cfg.provisionPollDelayMs > 0) {
        await this.ops.heartbeat(orgId, op.id, worker).catch(() => undefined);
        await new Promise((res) => setTimeout(res, this.cfg.provisionPollDelayMs));
      }
    }
    if (!ins || ins.status !== 'running' || !ins.endpoint)
      throw new FlowUncertain('the instance is not running yet');
    if (!ins.tlsRequired)
      throw new FlowFailure(
        'tls_not_enforced',
        'the provider instance does not require TLS: refusing to hand it out',
      );
    // 3. connection credential → vault (only the reference is stored)
    if (!inst.vault_ref) {
      const iss = outcomeOf(
        await retryTransient(this.cfg, () =>
          access.adapter.issueCredential(access.ctx, inst.provider_ref as string, {
            role: 'app',
            ...(engine === 'redis' ? { acl: REDIS_APP_ACL } : {}),
            idempotencyToken: idempotencyToken(orgId, op.id, 'credential'),
            keepPrevious: false,
          }),
        ),
      );
      if (iss.kind === 'uncertain') throw new FlowUncertain('the credential call timed out');
      if (iss.kind !== 'ok' || !iss.data)
        throw new FlowFailure(
          iss.kind === 'failed' && iss.unsupported ? 'unsupported_capability' : 'credential_failed',
          iss.kind === 'failed' ? iss.message : 'no credential returned',
        );
      const secret = iss.data;
      let ref: string;
      try {
        ref = await this.secrets.put(
          `db-${String(inst.id)}-${secret.credentialId.replace(/[^A-Za-z0-9_-]/g, '')}`,
          JSON.stringify({
            username: secret.username,
            ...secret.fields,
            host: ins.endpoint.host,
            port: ins.endpoint.port,
            engine,
            tls: true,
            credentialId: secret.credentialId,
          }),
        );
      } catch {
        // vault unavailable: the credential exists at the provider but nobody holds it. Revoke it (best effort) and park; the replay issues it again (same token → same id).
        await access.adapter
          .revokeCredential(access.ctx, inst.provider_ref as string, {
            credentialId: secret.credentialId,
            idempotencyToken: idempotencyToken(orgId, op.id, 'revoke-after-vault-failure'),
          })
          .catch(() => undefined);
        throw new FlowUncertain('the vault is unavailable');
      }
      inst = await this.setInst(orgId, inst.id as string, { vault_ref: ref });
    }
    // 4. running
    inst = await this.setInst(orgId, inst.id as string, {
      state: 'running',
      host: ins.endpoint.host,
      port: ins.endpoint.port,
    });
    return inst;
  }

  // ---- backup -------------------------------------------------------------------------------------------------------------
  /** Runs the provider backup for a `creating` backup row (also used inline by delete for the final backup). Returns the finished row. */
  async performBackup(orgId: string, backupId: string, trace: string): Promise<Row> {
    const b = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT * FROM data.database_backups WHERE id = $1 AND org_id = $2`, [
            backupId,
            orgId,
          ])
        ).rows[0],
    )) as Row | undefined;
    if (!b) throw new FlowFailure('not_found', 'the backup row is missing');
    if (b.state === 'available') return b;
    const inst = await this.inst(orgId, b.instance_id as string);
    const fail = async (code: string, msg: string): Promise<never> => {
      await this.db.withOrg(orgId, (c) =>
        c.query(`UPDATE data.database_backups SET state = 'failed' WHERE id = $1`, [backupId]),
      );
      throw new FlowFailure(code, msg, { backupId });
    };
    if (!inst.provider_ref) return fail('not_provisioned', 'the database has no provider instance');
    const access = await this.access(orgId, inst, trace);
    try {
      await this.assertResidency(orgId, inst, access, 'database_backup');
    } catch (e) {
      if (e instanceof FlowFailure) return fail(e.code, e.message);
      throw e;
    }
    const token = b.idempotency_token as string;
    let res = outcomeOf(
      await retryTransient(this.cfg, () =>
        access.adapter.backup(access.ctx, inst.provider_ref as string, {
          type: b.type as 'manual',
          idempotencyToken: token,
        }),
      ),
    );
    if (res.kind === 'uncertain') {
      const f = outcomeOf(
        await access.adapter.findBackupByToken(access.ctx, inst.provider_ref as string, token),
      );
      if (f.kind === 'ok' && f.data) res = { kind: 'ok', ref: undefined, data: f.data };
      else if (f.kind === 'ok') {
        const again = outcomeOf(
          await access.adapter.backup(access.ctx, inst.provider_ref as string, {
            type: b.type as 'manual',
            idempotencyToken: token,
          }),
        );
        if (again.kind === 'ok') res = again;
        else throw new FlowUncertain('the backup call timed out twice');
      } else throw new FlowUncertain('the backup call timed out and the lookup failed');
    }
    if (res.kind === 'failed')
      return fail(res.unsupported ? 'unsupported_capability' : 'backup_failed', res.message);
    if (res.kind !== 'ok' || !res.data) throw new FlowUncertain('no backup returned');
    const d = res.data;
    const done = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE data.database_backups SET state='available', size_bytes=$2, storage_ref=$3, checksum=$4, manifest=$5, provider_backup_ref=$6 WHERE id = $1 RETURNING *`,
            [
              backupId,
              d.sizeBytes,
              d.storageRef,
              d.checksum,
              d.manifest ? JSON.stringify(d.manifest) : null,
              d.backupRef,
            ],
          )
        ).rows[0],
    )) as Row;
    await this.audit.record({
      action: 'data.database.backup_completed',
      actorType: 'system',
      orgId,
      resource: { type: 'database', id: String(inst.id) },
      outcome: 'success',
      after: { backupId, type: b.type, sizeBytes: d.sizeBytes, dataRegion: b.data_region },
    });
    return done;
  }
  private async runBackup(orgId: string, op: Operation, worker: string): Promise<void> {
    const input = op.input as { backupId: string };
    const row = await this.performBackup(orgId, input.backupId, op.trace_id ?? op.id);
    await this.ops.succeed(orgId, op.id, worker, { backupId: row.id, state: row.state });
  }

  // ---- delete -------------------------------------------------------------------------------------------------------------
  private async runDelete(orgId: string, op: Operation, worker: string): Promise<void> {
    const input = op.input as { instanceId: string; priorState: string; takeFinalBackup: boolean };
    const inst = await this.inst(orgId, input.instanceId);
    if (inst.state === 'deleted')
      return void (await this.ops.succeed(orgId, op.id, worker, { deleted: true }));
    const access = inst.provider_ref ? await this.access(orgId, inst, op.trace_id ?? op.id) : null;
    // 1. final backup per policy (a failed final backup STOPS the deletion: nothing is destroyed without the safety copy the policy promised)
    if (input.takeFinalBackup && inst.provider_ref) {
      const token = idempotencyToken(orgId, String(inst.id), `final-backup-${op.id}`);
      let b = (await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `SELECT * FROM data.database_backups WHERE instance_id = $1 AND idempotency_token = $2`,
              [inst.id, token],
            )
          ).rows[0],
      )) as Row | undefined;
      if (!b) {
        b = (await this.db.withOrg(
          orgId,
          async (c) =>
            (
              await c.query(
                `INSERT INTO data.database_backups (id, org_id, instance_id, type, state, idempotency_token, expires_at, data_region, operation_id) VALUES (gen_random_uuid(), $1, $2, 'final', 'creating', $3, now() + make_interval(days => $4), $5, $6) RETURNING *`,
                [
                  orgId,
                  inst.id,
                  token,
                  (inst.backup_policy as { retentionDays?: number }).retentionDays ??
                    this.cfg.backupRetentionDays,
                  inst.data_region,
                  op.id,
                ],
              )
            ).rows[0],
        )) as Row;
      }
      try {
        await this.performBackup(orgId, b.id as string, op.trace_id ?? op.id);
      } catch (e) {
        if (e instanceof FlowFailure) {
          await this.setInst(orgId, inst.id as string, { state: 'running' }).catch(() => undefined); // the database is intact: deletion did not happen
          throw new FlowFailure(
            'final_backup_failed',
            'the final backup failed, so the database was not deleted',
            { cause: e.code },
          );
        }
        throw e;
      }
    }
    // 2. destroy at the provider (idempotent), then drop the vault entry
    if (access && inst.provider_ref) {
      const d = outcomeOf(
        await retryTransient(this.cfg, () =>
          access.adapter.delete(access.ctx, inst.provider_ref as string, {
            idempotencyToken: idempotencyToken(orgId, op.id, 'delete'),
          }),
        ),
      );
      if (d.kind === 'uncertain') {
        const i = outcomeOf(await access.adapter.inspect(access.ctx, inst.provider_ref as string));
        if (
          !(
            i.kind === 'ok' &&
            i.data &&
            (i.data.status === 'deleted' || i.data.status === 'deleting')
          ) &&
          !(i.kind === 'failed' && !i.retryable)
        )
          throw new FlowUncertain('the delete call timed out');
      } else if (d.kind === 'failed') throw new FlowFailure('delete_failed', d.message);
    }
    if (inst.vault_ref) await this.secrets.delete(inst.vault_ref as string).catch(() => undefined);
    await this.setInst(orgId, inst.id as string, { state: 'deleted', deleted_at: new Date() });
    await this.audit.record({
      action: 'data.database.destroyed',
      actorType: 'system',
      orgId,
      resource: { type: 'database', id: String(inst.id) },
      outcome: 'success',
    });
    await this.ops.succeed(orgId, op.id, worker, { deleted: true });
  }

  // ---- reconcile ----------------------------------------------------------------------------------------------------------
  /**
   * The ONLY thing that moves a parked (`needs_reconcile`) data operation: claim it, look at what exists at the provider, and either re-enter the
   * (re-entrant) flow or leave it parked for the next cycle. Safe to call concurrently with itself: the lease arbitrates.
   */
  async reconcile(
    orgId: string,
    operationId: string,
  ): Promise<'resumed' | 'parked' | 'not_claimable'> {
    const w = `data-reconciler-${process.pid}`;
    if (!(await this.ops.claimReconcile(orgId, operationId, w))) return 'not_claimable';
    const op = await this.ops.get(orgId, operationId);
    if (!op || !this.handles(op.kind)) {
      await this.ops.releaseLease(orgId, operationId, w);
      return 'parked';
    }
    try {
      await this.ops.resumeFromReconcile(orgId, operationId, w);
      const resumed = (await this.ops.get(orgId, operationId))!;
      try {
        await this.handlers.get(op.kind)!(
          orgId,
          { ...resumed, attempts: Math.max(resumed.attempts, 2) },
          w,
        );
      } catch (e) {
        // same mapping as a first run, under the reconciler's lease
        if (e instanceof FlowFailure) {
          await this.audit.record({
            action: 'data.database.operation_failed',
            actorType: 'system',
            orgId,
            resource: { type: 'database', id: op.resource_id ?? undefined },
            outcome: 'failure',
            detail: { kind: op.kind, code: e.code },
          });
          await this.ops
            .failPermanently(orgId, operationId, w, { code: e.code, message: e.message })
            .catch(() => undefined);
        } else {
          const reason =
            e instanceof FlowUncertain ? e.reason : `unexpected: ${(e as Error).message}`;
          await this.ops
            .markNeedsReconcile(orgId, operationId, w, reason.slice(0, 300))
            .catch(() => undefined);
          return 'parked';
        }
      }
      return 'resumed';
    } catch {
      await this.ops.releaseLease(orgId, operationId, w).catch(() => undefined);
      return 'parked';
    }
  }
  /** Reconcile every parked data operation of an organization (what the sweep calls). */
  async reconcileAll(orgId: string): Promise<number> {
    const ids = await this.db.withOrg(orgId, async (c) =>
      (
        await c.query(
          `SELECT id FROM platform.operations WHERE state = 'needs_reconcile' AND kind LIKE 'data.%' AND resource_kind = $1 ORDER BY created_at LIMIT 50`,
          [DB_RESOURCE],
        )
      ).rows.map((r) => r.id as string),
    );
    let n = 0;
    for (const id of ids) if ((await this.reconcile(orgId, id)) === 'resumed') n++;
    return n;
  }
}
export { ResidencyDenied };
