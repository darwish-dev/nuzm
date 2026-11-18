import { v7 as uuidv7 } from 'uuid';
import { idempotencyToken, orgTag, type DatabaseAdapter } from '@nuzm/adapter-data';
import type { Operation } from '@nuzm/platform';
import type { FastifyRequest } from 'fastify';
import { ProblemException } from '../../../common/errors';
import type { Page } from '../../../common/pagination';
import type { DataAlerts } from './alerts';
import type { BackupDto, DatabaseService } from './database.service';
import { DatabaseFlow, type Access } from './database-flow';
import { FlowFailure, FlowUncertain, outcomeOf, retryTransient } from './flow-support';
import {
  DB_RESOURCE,
  OP,
  isUuid,
  serviceOfEngine,
  type DataConfig,
  type Engine,
  type Row,
} from './model';
import type { DataOperations } from './operations-port';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';

const NAME = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
/** Body fields that try to point the restore at another organization: refused outright (the org is the caller's, from verified auth). */
const ORG_SELECTORS = [
  'orgId',
  'organizationId',
  'targetOrgId',
  'targetOrganizationId',
  'org_id',
  'targetOrg',
];

export interface RestoreDto {
  id: string;
  databaseId: string;
  backupId: string;
  mode: 'new' | 'inplace' | 'verification';
  state: string;
  targetDatabaseId: string | null;
  verification: unknown;
  failureCode: string | null;
  operationId: string | null;
  createdAt: string;
  finishedAt: string | null;
}
const iso = (v: unknown) => (v ? (v as Date).toISOString() : null);
const dto = (r: Row): RestoreDto => ({
  id: r.id as string,
  databaseId: r.source_instance_id as string,
  backupId: r.source_backup_id as string,
  mode: r.mode as RestoreDto['mode'],
  state: r.state as string,
  targetDatabaseId: (r.target_instance_id as string | null) ?? null,
  verification: r.verification ?? null,
  failureCode: (r.failure_code as string | null) ?? null,
  operationId: (r.operation_id as string | null) ?? null,
  createdAt: iso(r.created_at)!,
  finishedAt: iso(r.finished_at),
});

/**
 * Restores (docs/04, M08 S33). DEFAULT is restore-to-NEW in the same organization and provider region; the restored database shows up as an ordinary
 * `running` database with its own credential. In-place needs `confirmInPlace=true`, the typed database name, a recent MFA check and an automatic
 * pre-restore backup; a provider without `database.restore-in-place` answers 422 `restore_not_supported`. A restore never crosses organizations or
 * regions: org selectors in the body are refused (403), another organization's backup id is invisible (RLS) and answers 404, a region other than the
 * source's is checked against the residency policy and then refused as unsupported (the adapter contract keeps a restore inside its provider region).
 * Every restored database is VERIFIED against the backup manifest; a mismatch fails the restore and raises an alert.
 */
export class RestoreService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ops: DataOperations,
    private readonly dbs: DatabaseService,
    private readonly flow: DatabaseFlow,
    private readonly alerts: DataAlerts,
    private readonly cfg: DataConfig,
  ) {
    flow.register(OP.DB_RESTORE, (o, op, w) => this.run(o, op, w));
  }
  private kicker: (orgId: string, operationId: string) => void = () => undefined;
  setKicker(k: (orgId: string, operationId: string) => void) {
    this.kicker = k;
  }

  assertRecentMfa(req: FastifyRequest): void {
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

  async request(
    orgId: string,
    actor: string,
    databaseId: string,
    body: Record<string, unknown>,
  ): Promise<RestoreDto> {
    for (const k of ORG_SELECTORS)
      if (k in body)
        throw new ProblemException(
          'forbidden',
          'a restore stays inside the organization: another organization cannot be targeted',
        );
    const allowed = new Set([
      'backupId',
      'target',
      'confirmInPlace',
      'confirmName',
      'name',
      'region',
    ]);
    if (Object.keys(body).some((k) => !allowed.has(k)))
      throw new ProblemException('validation_failed', 'unknown field in the restore request');
    if (!isUuid(body.backupId))
      throw new ProblemException('validation_failed', 'backupId is required');
    const target = body.target ?? 'new';
    if (target !== 'new' && target !== 'inplace')
      throw new ProblemException('validation_failed', 'target must be new or inplace');
    const inst = await this.dbs.row(orgId, databaseId);
    const backup = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM data.database_backups WHERE id = $1 AND org_id = $2 AND instance_id = $3`,
            [body.backupId, orgId, databaseId],
          )
        ).rows[0],
    )) as Row | undefined;
    if (!backup) throw new ProblemException('not_found', 'backup not found');
    if (
      backup.state !== 'available' ||
      (backup.expires_at && (backup.expires_at as Date).getTime() < Date.now())
    )
      throw new ProblemException('conflict', 'the backup is not available');
    if (inst.state !== 'running')
      throw new ProblemException('conflict', 'the database must be running');
    const access = await this.flow.access(orgId, inst, 'restore-request').catch(() => null);
    if (!access)
      throw new ProblemException(
        'unsupported_capability',
        'the provider of this database is not available',
      );
    const p = await this.flow.providers.byId(
      orgId,
      String(inst.provider_id),
      serviceOfEngine(inst.engine as Engine),
    );
    const caps = p?.row.probe?.capabilities ?? {};
    if (body.region !== undefined) {
      if (typeof body.region !== 'string')
        throw new ProblemException('validation_failed', 'region must be a string');
      if (body.region !== inst.provider_region_id) {
        const res = await this.flow.residency.evaluate({
          orgId,
          dataClass: 'customer-content',
          targetRegion: body.region,
          purpose: 'database_restore',
          operation: 'write',
          ...(access.family.startsWith('provider-') ? { processorId: access.providerCode } : {}),
        });
        if (res.decision !== 'allow')
          throw new ProblemException(
            'residency_denied',
            'the target region is not allowed by the residency policy',
          );
        throw new ProblemException(
          'restore_not_supported',
          'a restore into another region is not supported: it stays in the region of the source database',
        );
      }
    }
    if (
      (inst.engine === 'redis' ? caps['cache.restore-to-new'] : caps['database.restore-to-new']) !==
      'supported'
    )
      throw new ProblemException(
        'restore_not_supported',
        'the provider does not support restoring this database',
      );
    // residency of the restored copy (same region as the source, but the policy may have changed since the database was created)
    const res = await this.flow.residency.evaluate({
      orgId,
      dataClass: 'customer-content',
      targetRegion: String(inst.provider_region_id),
      purpose: 'database_restore',
      operation: 'write',
      ...(access.family.startsWith('provider-') ? { processorId: access.providerCode } : {}),
    });
    if (res.decision !== 'allow')
      throw new ProblemException(
        'residency_denied',
        'the restore is not allowed by the residency policy',
      );
    if (target === 'inplace') {
      if (body.confirmInPlace !== true)
        throw new ProblemException(
          'validation_failed',
          'an in-place restore overwrites the database: send confirmInPlace=true',
        );
      if (body.confirmName !== inst.name)
        throw new ProblemException('validation_failed', 'confirmName must equal the database name');
      if (caps['database.restore-in-place'] !== 'supported')
        throw new ProblemException(
          'restore_not_supported',
          'the provider does not support restoring in place',
        );
    }
    let name: string | null = null;
    if (target === 'new') {
      name =
        typeof body.name === 'string'
          ? body.name
          : `${String(inst.name).slice(0, 28)}-restore-${uuidv7().slice(-6)}`;
      if (!NAME.test(name))
        throw new ProblemException(
          'validation_failed',
          'name must be 3..40 characters: lower-case letters, digits and hyphens',
        );
    }
    const id = uuidv7();
    try {
      await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `INSERT INTO data.database_restores (id, org_id, source_instance_id, source_backup_id, mode, state, name, confirm_in_place, data_region, created_by)
             VALUES ($1,$2,$3,$4,$5,'requested',$6,$7,$8,$9) RETURNING *`,
              [
                id,
                orgId,
                databaseId,
                body.backupId,
                target,
                name,
                target === 'inplace',
                inst.data_region,
                actor,
              ],
            )
          ).rows[0] as Row,
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException('conflict', 'a database with this name already exists');
      throw e;
    }
    const op = await this.ops.create(orgId, {
      kind: OP.DB_RESTORE,
      resourceKind: DB_RESOURCE,
      resourceId: databaseId,
      createdBy: actor,
      maxAttempts: 1,
      input: { restoreId: id, databaseId, backupId: body.backupId, mode: target },
    });
    const out = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE data.database_restores SET operation_id = $2 WHERE id = $1 RETURNING *`,
            [id, op.id],
          )
        ).rows[0] as Row,
    );
    await this.audit.record({
      action: 'data.database.restore_requested',
      actorUserId: actor,
      orgId,
      resource: { type: 'database', id: databaseId },
      outcome: 'success',
      after: { restoreId: id, mode: target, backupId: body.backupId },
    });
    this.kicker(orgId, op.id);
    return dto(out);
  }

  /** Backups with the restores (and verification drills) made from each: the verification history the console shows. */
  async listBackupsWithRestores(
    orgId: string,
    databaseId: string,
    q: { limit: number; cursor?: string },
  ): Promise<Page<BackupDto & { restores: RestoreDto[]; lastVerification: unknown }>> {
    const page = await this.dbs.listBackups(orgId, databaseId, q);
    const ids = page.items.map((b) => b.id);
    const rs = ids.length
      ? await this.db.withOrg(
          orgId,
          async (c) =>
            (
              await c.query(
                `SELECT * FROM data.database_restores WHERE org_id = $1 AND source_backup_id = ANY($2::uuid[]) ORDER BY id DESC`,
                [orgId, ids],
              )
            ).rows as Row[],
        )
      : [];
    return {
      nextCursor: page.nextCursor,
      items: page.items.map((b) => {
        const mine = rs.filter((r) => r.source_backup_id === b.id).map(dto);
        const v = mine.find((r) => r.verification);
        return { ...b, restores: mine, lastVerification: v?.verification ?? null };
      }),
    };
  }
  async getRestore(orgId: string, id: string): Promise<Row> {
    const r = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT * FROM data.database_restores WHERE id = $1 AND org_id = $2`, [
            id,
            orgId,
          ])
        ).rows[0],
    )) as Row | undefined;
    if (!r) throw new ProblemException('not_found');
    return r;
  }

  // ---- execution ------------------------------------------------------------------------------------------------------------
  private async setRestore(orgId: string, id: string, set: Record<string, unknown>): Promise<Row> {
    const keys = Object.keys(set);
    const vals = keys.map((k) => (k === 'verification' ? JSON.stringify(set[k]) : set[k]));
    return this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE data.database_restores SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} WHERE id = $1 AND org_id = $2 RETURNING *`,
            [id, orgId, ...vals],
          )
        ).rows[0] as Row,
    );
  }
  private async run(orgId: string, op: Operation, worker: string): Promise<void> {
    const input = op.input as { restoreId: string };
    let r = await this.getRestore(orgId, input.restoreId);
    if (r.state === 'succeeded' || r.state === 'failed')
      return void (await this.ops.succeed(orgId, op.id, worker, {
        restoreId: r.id,
        state: r.state,
      }));
    if (r.state === 'requested' || r.state === 'needs_reconcile')
      r = await this.setRestore(orgId, r.id as string, { state: 'running' });
    try {
      if (r.mode === 'inplace') await this.runInPlace(orgId, op, worker, r);
      else await this.runToNew(orgId, op, worker, r);
    } catch (e) {
      if (e instanceof FlowFailure) {
        await this.setRestore(orgId, r.id as string, {
          state: 'failed',
          failure_code: e.code.replace(/[^a-z0-9_]/g, '_').slice(0, 60),
          finished_at: new Date(),
        }).catch(() => undefined);
        await this.alerts.raise(orgId, {
          kind: 'data.restore_failed',
          severity: 'warning',
          resource: { type: 'database', id: String(r.source_instance_id) },
          detail: { restoreId: r.id, mode: r.mode, code: e.code },
        });
      } else if (e instanceof FlowUncertain) {
        await this.setRestore(orgId, r.id as string, { state: 'needs_reconcile' }).catch(
          () => undefined,
        );
      }
      throw e;
    }
  }

  private async runInPlace(orgId: string, op: Operation, worker: string, r: Row): Promise<void> {
    const inst = await this.flow.inst(orgId, r.source_instance_id as string);
    const access = await this.flow.access(orgId, inst, op.trace_id ?? op.id);
    await this.flow.assertResidency(orgId, inst, access, 'database_restore');
    const backup = (await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM data.database_backups WHERE id = $1`, [r.source_backup_id]))
          .rows[0],
    )) as Row;
    // 1. the automatic pre-restore backup: nothing is overwritten without a safety copy
    let pre = r.pre_restore_backup_id as string | null;
    if (!pre) {
      const token = idempotencyToken(orgId, String(r.id), 'pre-restore-backup');
      const b = (await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `INSERT INTO data.database_backups (id, org_id, instance_id, type, state, idempotency_token, expires_at, data_region, operation_id) VALUES (gen_random_uuid(), $1, $2, 'pre_restore', 'creating', $3, now() + make_interval(days => $4), $5, $6) ON CONFLICT (instance_id, idempotency_token) DO UPDATE SET operation_id = EXCLUDED.operation_id RETURNING *`,
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
      try {
        await this.flow.performBackup(orgId, b.id as string, op.trace_id ?? op.id);
      } catch (e) {
        if (e instanceof FlowFailure)
          throw new FlowFailure(
            'pre_restore_backup_failed',
            'the automatic pre-restore backup failed, so nothing was overwritten',
            { cause: e.code },
          );
        throw e;
      }
      pre = b.id as string;
      await this.setRestore(orgId, r.id as string, { pre_restore_backup_id: pre });
    }
    // 2. the in-place restore
    const res = outcomeOf(
      await retryTransient(this.cfg, () =>
        access.adapter.restoreInPlace!(
          access.ctx,
          inst.provider_ref as string,
          backup.provider_backup_ref as string,
          { idempotencyToken: idempotencyToken(orgId, String(r.id), 'restore-in-place') },
        ),
      ),
    );
    if (res.kind === 'uncertain')
      throw new FlowUncertain('the in-place restore timed out: the database state is unknown');
    if (res.kind === 'failed')
      throw new FlowFailure(
        res.unsupported ? 'restore_not_supported' : 'restore_failed',
        res.message,
      );
    const verification = await this.verify(orgId, access, inst, backup);
    if (!verification.passed)
      throw new FlowFailure(
        'verification_mismatch',
        'the restored data does not match the backup',
        { verification },
      );
    await this.setRestore(orgId, r.id as string, {
      state: 'succeeded',
      verification,
      finished_at: new Date(),
    });
    await this.audit.record({
      action: 'data.database.restored',
      actorType: 'system',
      orgId,
      resource: { type: 'database', id: String(inst.id) },
      outcome: 'success',
      after: { restoreId: r.id, mode: 'inplace', backupId: backup.id },
    });
    await this.ops.succeed(orgId, op.id, worker, { restoreId: r.id, state: 'succeeded' });
  }

  /** Restore-to-new, also the engine of the verification drill (`mode=verification`: the scratch copy is destroyed afterwards). */
  async runToNew(orgId: string, op: Operation, worker: string, r: Row): Promise<void> {
    const src = await this.flow.inst(orgId, r.source_instance_id as string);
    const backup = (await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM data.database_backups WHERE id = $1`, [r.source_backup_id]))
          .rows[0],
    )) as Row;
    const access = await this.flow.access(orgId, src, op.trace_id ?? op.id);
    await this.flow.assertResidency(orgId, src, access, 'database_restore');
    const token = idempotencyToken(orgId, String(r.id), 'restore-new');
    // 1. the target instance row (once)
    let target: Row;
    if (r.target_instance_id) target = await this.flow.inst(orgId, r.target_instance_id as string);
    else {
      const tid = uuidv7();
      target = (await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `INSERT INTO data.database_instances (id, org_id, name, engine, version, plan_ref, storage_gb, state, network, data_region, provider_region_id, provider_id, create_token, backup_policy, created_by, operation_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'provisioning',$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
              [
                tid,
                orgId,
                r.name,
                src.engine,
                src.version,
                src.plan_ref,
                src.storage_gb,
                JSON.stringify(src.network),
                src.data_region,
                src.provider_region_id,
                src.provider_id,
                token,
                JSON.stringify(src.backup_policy),
                r.created_by,
                op.id,
              ],
            )
          ).rows[0],
      )) as Row;
      await this.setRestore(orgId, r.id as string, { target_instance_id: target.id });
    }
    try {
      // 2. restore at the provider (reconcile-before-retry on an uncertain answer)
      if (!target.provider_ref) {
        const spec = {
          name: this.flow.providerName(target),
          providerRegionId: src.provider_region_id,
          planRef: src.plan_ref,
          storageGb: src.storage_gb,
          memoryMb: Math.max(Number(src.storage_gb), 1) * 1024,
          network: src.network,
          persistence: 'none',
          evictionPolicy: 'noeviction',
          tags: { 'nuzm-org': orgTag(orgId), 'nuzm-op': op.id },
        };
        const call = () =>
          access.adapter.restoreToNew(access.ctx, {
            sourceRef: src.provider_ref,
            backupRef: backup.provider_backup_ref,
            target: spec,
            idempotencyToken: token,
          });
        let o = outcomeOf(await retryTransient(this.cfg, call));
        if (o.kind === 'uncertain') {
          const f = outcomeOf(await access.adapter.findByToken(access.ctx, token));
          if (f.kind === 'ok' && f.data)
            o = {
              kind: 'ok',
              ref: (f.data as { providerRef: string }).providerRef,
              data: f.data as never,
            };
          else if (f.kind === 'ok') {
            const again = outcomeOf(await call());
            if (again.kind === 'ok') o = again;
            else throw new FlowUncertain('the restore call timed out twice');
          } else throw new FlowUncertain('the restore call timed out and the lookup failed');
        }
        if (o.kind === 'failed')
          throw new FlowFailure(
            o.unsupported ? 'restore_not_supported' : 'restore_failed',
            o.message,
          );
        if (o.kind !== 'ok') throw new FlowUncertain('no provider reference after restore');
        const ref = o.ref ?? (o.data as { providerRef: string } | undefined)?.providerRef;
        if (!ref) throw new FlowUncertain('no provider reference after restore');
        target = await this.flow.setInst(orgId, target.id as string, { provider_ref: ref });
      }
      // 3. running + credential (same steps as a create), then verify against the backup manifest
      target = await this.flow.completeProvision(orgId, op, worker, target, access);
      const verification = await this.verify(orgId, access, target, backup);
      if (!verification.passed)
        throw new FlowFailure(
          'verification_mismatch',
          'the restored data does not match the backup',
          { verification },
        );
      if (r.mode === 'verification') await this.destroyScratch(orgId, access, target, op);
      await this.setRestore(orgId, r.id as string, {
        state: 'succeeded',
        verification,
        finished_at: new Date(),
      });
      await this.audit.record({
        action:
          r.mode === 'verification' ? 'data.database.restore_verified' : 'data.database.restored',
        actorType: 'system',
        orgId,
        resource: { type: 'database', id: String(src.id) },
        outcome: 'success',
        after: {
          restoreId: r.id,
          mode: r.mode,
          targetDatabaseId: r.mode === 'verification' ? null : target.id,
          tables: verification.tables.length,
        },
      });
      await this.ops.succeed(orgId, op.id, worker, {
        restoreId: r.id,
        state: 'succeeded',
        targetDatabaseId: r.mode === 'verification' ? null : target.id,
      });
    } catch (e) {
      if (e instanceof FlowFailure) {
        if (r.mode === 'verification' || e.code === 'verification_mismatch') {
          // a mismatching restored copy must never be handed out: the target is marked failed (the customer can delete it); a scratch copy is destroyed
          if (r.mode === 'verification')
            await this.destroyScratch(orgId, access, target, op).catch(() => undefined);
          else
            await this.flow
              .setInst(orgId, target.id as string, { state: 'failed' })
              .catch(() => undefined);
        } else
          await this.flow
            .setInst(orgId, target.id as string, { state: 'failed' })
            .catch(() => undefined);
        if (e.detail.verification)
          await this.setRestore(orgId, r.id as string, {
            verification: e.detail.verification,
          }).catch(() => undefined);
        if (e.code === 'verification_mismatch')
          await this.alerts.raise(orgId, {
            kind: 'data.restore_verification_failed',
            severity: 'critical',
            resource: { type: 'database', id: String(src.id) },
            detail: { restoreId: r.id, backupId: backup.id, mode: r.mode },
          });
      }
      throw e;
    }
  }

  private async destroyScratch(
    orgId: string,
    access: Access,
    target: Row,
    op: Operation,
  ): Promise<void> {
    if (target.provider_ref)
      await access.adapter.delete(access.ctx, target.provider_ref as string, {
        idempotencyToken: idempotencyToken(orgId, op.id, 'scratch-delete'),
      });
    if (target.vault_ref)
      await this.flow.secrets.delete(target.vault_ref as string).catch(() => undefined);
    const cur = (await this.flow.inst(orgId, target.id as string)).state as string;
    if (cur !== 'failed' && cur !== 'deleting')
      await this.flow.setInst(orgId, target.id as string, { state: 'deleting' });
    await this.flow.setInst(orgId, target.id as string, {
      state: 'deleted',
      deleted_at: new Date(),
    });
  }

  /** Engine-native check plus row count and checksum of the sampled tables, compared with the manifest recorded when the backup was taken. */
  async verify(
    orgId: string,
    access: Access,
    target: Row,
    backup: Row,
  ): Promise<{
    checkedAt: string;
    passed: boolean;
    engineCheck: string;
    tables: {
      table: string;
      rowCount: number;
      checksum: string;
      expected: { rowCount: number; checksum: string } | null;
      match: boolean;
    }[];
  }> {
    const manifest =
      (backup.manifest as { table: string; rowCount: number; checksum: string }[] | null) ?? null;
    const chk = access.adapter.integrityCheck
      ? outcomeOf(
          await access.adapter.integrityCheck(access.ctx, target.provider_ref as string, {
            sampleTables: this.cfg.verificationSampleTables,
          }),
        )
      : null;
    if (!chk || chk.kind !== 'ok' || !chk.data) {
      // no way to verify = the restore is NOT verified (never assumed good)
      return {
        checkedAt: new Date().toISOString(),
        passed: false,
        engineCheck: 'unsupported',
        tables: [],
      };
    }
    const d = chk.data;
    const byTable = new Map((manifest ?? []).map((m) => [m.table, m]));
    const tables = d.tables.map((t) => {
      const exp = byTable.get(t.table) ?? null;
      return {
        table: t.table,
        rowCount: t.rowCount,
        checksum: t.checksum,
        expected: exp ? { rowCount: exp.rowCount, checksum: exp.checksum } : null,
        match: !!exp && exp.rowCount === t.rowCount && exp.checksum === t.checksum,
      };
    });
    const sampled = new Set(tables.map((t) => t.table));
    const missing = (manifest ?? [])
      .slice(0, this.cfg.verificationSampleTables)
      .filter((m) => !sampled.has(m.table));
    return {
      checkedAt: d.checkedAt,
      passed:
        d.engineCheck === 'ok' &&
        manifest !== null &&
        missing.length === 0 &&
        tables.every((t) => t.match),
      engineCheck: d.engineCheck,
      tables,
    };
  }

  /**
   * The restore-verification job (FR-DAT-10): for every running database whose newest available backup has no verification drill within the
   * cadence (proposal: weekly), restore it into a scratch instance, check it and destroy the scratch. Also callable on demand for ONE database.
   * A failed drill raises an `ops` alert and an in-app notification (see `restore()`); a drill that cannot even run is reported, not skipped.
   */
  async verifyDue(now: Date, only?: { orgId: string; databaseId: string }): Promise<number> {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT i.org_id, i.id AS instance_id, b.id AS backup_id FROM data.database_instances i
             JOIN LATERAL (SELECT id FROM data.database_backups WHERE instance_id = i.id AND state = 'available' AND type IN ('scheduled','manual','final') ORDER BY created_at DESC, id DESC LIMIT 1) b ON true
            WHERE i.state = 'running' AND i.engine <> 'redis' AND ($1::uuid IS NULL OR i.id = $1)
              AND ($1::uuid IS NOT NULL OR NOT EXISTS (SELECT 1 FROM data.database_restores r WHERE r.mode = 'verification' AND r.source_backup_id = b.id AND r.created_at > $2))`,
            [
              only?.databaseId ?? null,
              new Date(now.getTime() - this.cfg.verificationIntervalDays * 86_400_000),
            ],
          )
        ).rows as { org_id: string; instance_id: string; backup_id: string }[],
    );
    let n = 0;
    for (const x of rows) {
      const id = uuidv7();
      const r = (await this.db.withOrg(
        x.org_id,
        async (c) =>
          (
            await c.query(
              `INSERT INTO data.database_restores (id, org_id, source_instance_id, source_backup_id, mode, state, name, data_region)
             SELECT $1, $2, $3, $4, 'verification', 'requested', $5, data_region FROM data.database_instances WHERE id = $3 RETURNING *`,
              [id, x.org_id, x.instance_id, x.backup_id, `verify-${id.slice(-12)}`],
            )
          ).rows[0],
      )) as Row;
      const op = await this.ops.create(x.org_id, {
        kind: OP.DB_RESTORE,
        resourceKind: DB_RESOURCE,
        resourceId: x.instance_id,
        maxAttempts: 1,
        input: {
          restoreId: id,
          databaseId: x.instance_id,
          backupId: x.backup_id,
          mode: 'verification',
        },
      });
      await this.setRestore(x.org_id, id, { operation_id: op.id });
      void r;
      await this.flow.runOne(x.org_id, op.id).catch(() => undefined);
      n++;
    }
    return n;
  }
}
export type { DatabaseAdapter };
