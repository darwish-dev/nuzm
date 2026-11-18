import { v7 as uuidv7 } from 'uuid';
import { idempotencyToken, orgTag } from '@nuzm/adapter-data';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';
import type { EntitlementService } from '../../billing';
import type { OrderService } from '../../commerce';
import type { DatabaseBindingPort } from './binding.port';
import type { DatabaseCatalog } from './catalog';
import {
  DB_RESOURCE,
  ENGINES,
  OP,
  isUuid,
  serviceOfEngine,
  type DataConfig,
  type Engine,
  type Row,
} from './model';
import type { DataOperations } from './operations-port';

export interface BackupPolicy {
  enabled: boolean;
  retentionDays: number;
  intervalHours: number;
}
export interface DatabaseDto {
  id: string;
  name: string;
  engine: Engine;
  version: string;
  planRef: string;
  status: string;
  endpoint: { host: string; port: number } | null;
  tlsRequired: true;
  network: { access: 'private' | 'allowlist'; allowCidrs?: string[] };
  dataRegion: string;
  providerRegionId: string;
  /** Metadata only: where the connection secret lives. The secret itself is never returned by any endpoint. */
  vaultRef: string | null;
  backupPolicy: BackupPolicy;
  rotation: { state: string; windowEndsAt: string | null } | null;
  operationId: string | null;
  etag: number;
  createdAt: string;
  updatedAt: string;
}
export interface BackupDto {
  id: string;
  databaseId: string;
  type: string;
  state: string;
  size: number | null;
  checksum: string | null;
  expiresAt: string | null;
  dataRegion: string;
  operationId: string | null;
  createdAt: string;
}
type Kick = (orgId: string, operationId: string) => void;

const NAME = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const CIDR = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
const iso = (v: unknown) => (v ? (v as Date).toISOString() : null);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export function parseNetwork(raw: unknown): {
  access: 'private' | 'allowlist';
  allowCidrs?: string[];
} {
  if (raw === undefined) return { access: 'private' };
  const n = raw as { access?: unknown; allowCidrs?: unknown };
  if (
    typeof raw !== 'object' ||
    raw === null ||
    (n.access !== 'private' && n.access !== 'allowlist')
  )
    throw new ProblemException('validation_failed', 'network.access must be private or allowlist');
  if (n.access === 'private') {
    if (n.allowCidrs !== undefined)
      throw new ProblemException(
        'validation_failed',
        'network.allowCidrs is only for access=allowlist',
      );
    return { access: 'private' };
  }
  const l = n.allowCidrs;
  if (
    !Array.isArray(l) ||
    l.length < 1 ||
    l.length > 32 ||
    l.some((c) => typeof c !== 'string' || !CIDR.test(c) || c === '0.0.0.0/0' || c.endsWith('/0'))
  )
    throw new ProblemException(
      'validation_failed',
      'network.allowCidrs must list 1..32 CIDR blocks and never the whole internet',
    );
  return { access: 'allowlist', allowCidrs: l as string[] };
}

/**
 * Managed databases (docs/04 §2.8). Customers see state, endpoint, TLS, region and a vault REFERENCE; the provider, its account and its raw ids never leave
 * the admin side. A create needs a `quoteId` of kind `database` → an order (spend/quota/dunning checks of M02) → a row in `provisioning` + a durable
 * operation (`data.database.create`) that the flow executes. Every mutation is audited.
 */
export class DatabaseService {
  private kicker: Kick = () => undefined;
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ops: DataOperations,
    private readonly catalog: DatabaseCatalog,
    private readonly orders: Pick<OrderService, 'createFromQuote'>,
    private readonly entitlements: Pick<EntitlementService, 'resolve'>,
    private readonly bindings: DatabaseBindingPort,
    private readonly cfg: DataConfig,
  ) {}
  setKicker(k: Kick) {
    this.kicker = k;
  }

  dto(r: Row): DatabaseDto {
    const rot = r.rotation as { state?: string; windowEndsAt?: string } | null;
    return {
      id: r.id as string,
      name: r.name as string,
      engine: r.engine as Engine,
      version: r.version as string,
      planRef: r.plan_ref as string,
      status: r.state as string,
      endpoint: r.host && r.port ? { host: r.host as string, port: Number(r.port) } : null,
      tlsRequired: true,
      network: r.network as DatabaseDto['network'],
      dataRegion: r.data_region as string,
      providerRegionId: r.provider_region_id as string,
      vaultRef: (r.vault_ref as string | null) ?? null,
      backupPolicy: r.backup_policy as BackupPolicy,
      rotation: rot?.state ? { state: rot.state, windowEndsAt: rot.windowEndsAt ?? null } : null,
      operationId: (r.operation_id as string | null) ?? null,
      etag: r.version_lock as number,
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
    };
  }
  backupDto(r: Row): BackupDto {
    return {
      id: r.id as string,
      databaseId: r.instance_id as string,
      type: r.type as string,
      state: r.state as string,
      size: num(r.size_bytes),
      checksum: (r.checksum as string | null) ?? null,
      expiresAt: iso(r.expires_at),
      dataRegion: r.data_region as string,
      operationId: (r.operation_id as string | null) ?? null,
      createdAt: iso(r.created_at)!,
    };
  }

  /** The default backup policy from the organization's entitlements (retention = days granted, frequency = hours between backups), else configuration. */
  async defaultPolicy(orgId: string): Promise<BackupPolicy> {
    const e = await this.entitlements.resolve(orgId);
    const lim = (g: string) => {
      const v = e.limits.find((l) => l.meterGroup === g)?.limit;
      return v ? Number(v) : null;
    };
    return {
      enabled: true,
      retentionDays: lim('data_backup_retention_days') ?? this.cfg.backupRetentionDays,
      intervalHours: lim('data_backup_interval_hours') ?? this.cfg.backupIntervalHours,
    };
  }
  async parsePolicy(orgId: string, raw: unknown, base?: BackupPolicy): Promise<BackupPolicy> {
    const def = base ?? (await this.defaultPolicy(orgId));
    if (raw === undefined) return def;
    const p = raw as Partial<BackupPolicy>;
    if (
      typeof raw !== 'object' ||
      raw === null ||
      Array.isArray(raw) ||
      Object.keys(raw).some((k) => !['enabled', 'retentionDays', 'intervalHours'].includes(k))
    )
      throw new ProblemException(
        'validation_failed',
        'backupPolicy accepts enabled, retentionDays and intervalHours',
      );
    const e = await this.entitlements.resolve(orgId);
    const maxRet = e.limits.find((l) => l.meterGroup === 'data_backup_retention_days')?.limit;
    const minInt = e.limits.find((l) => l.meterGroup === 'data_backup_interval_hours')?.limit;
    const out = { ...def, ...p };
    if (typeof out.enabled !== 'boolean')
      throw new ProblemException('validation_failed', 'backupPolicy.enabled must be a boolean');
    if (
      !Number.isInteger(out.retentionDays) ||
      out.retentionDays < 1 ||
      out.retentionDays > 3650 ||
      (maxRet && out.retentionDays > Number(maxRet))
    )
      throw new ProblemException(
        'validation_failed',
        `backupPolicy.retentionDays must be an integer of 1..${maxRet ?? 3650}`,
      );
    if (
      !Number.isInteger(out.intervalHours) ||
      out.intervalHours < 1 ||
      out.intervalHours > 720 ||
      (minInt && out.intervalHours < Number(minInt))
    )
      throw new ProblemException(
        'validation_failed',
        `backupPolicy.intervalHours must be an integer of ${minInt ?? 1}..720`,
      );
    return out;
  }

  async create(orgId: string, actor: string, body: Record<string, unknown>): Promise<DatabaseDto> {
    const engine = body.engine as Engine;
    if (!(ENGINES as readonly string[]).includes(engine))
      throw new ProblemException(
        'validation_failed',
        `engine must be one of ${ENGINES.join(', ')}`,
      );
    const name = typeof body.name === 'string' && NAME.test(body.name) ? body.name : null;
    if (!name)
      throw new ProblemException(
        'validation_failed',
        'name must be 3..40 characters: lower-case letters, digits and hyphens, starting with a letter',
      );
    if (typeof body.version !== 'string' || !/^\d{1,3}(\.\d{1,3}){0,2}$/.test(body.version))
      throw new ProblemException('validation_failed', 'version must look like 16 or 8.4');
    if (!isUuid(body.quoteId))
      throw new ProblemException(
        'validation_failed',
        'quoteId (a quote of kind database) is required',
      );
    const network = parseNetwork(body.network);
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
          `SELECT * FROM commerce.quote_items WHERE quote_id = $1 AND meter_id IN ('database.instance_hours','cache.instance_hours') ORDER BY position LIMIT 1`,
          [body.quoteId],
        )
      ).rows[0] as Row | undefined;
      return { q, details: (it?.details ?? {}) as Record<string, unknown> };
    });
    if (quote.q.kind !== 'database')
      throw new ProblemException('validation_failed', 'the quote is not a database quote');
    const d = quote.details;
    if (d.engine !== engine || d.version !== body.version)
      throw new ProblemException(
        'validation_failed',
        'the quote was issued for a different engine or version',
      );
    // the offer is re-derived NOW (provider still enabled, plan still available, region still verified): a quote is a price, not an entitlement to stale placement
    const offer = await this.catalog.offer(orgId, engine, {
      version: body.version,
      planRef: String(d.planRef),
      region: String(d.providerRegionId),
    });
    const policy = await this.parsePolicy(orgId, body.backupPolicy);
    // the provider must support the requested network posture
    // (checked by the flow against the stored probe at execution; here the request shape is validated only)
    const order = await this.orders.createFromQuote(orgId, quote.q.id as string, actor);
    const instanceId = uuidv7();
    const token = idempotencyToken(orgId, instanceId, 'create');
    const row = await this.db.withOrg(orgId, async (c) => {
      let inst: Row;
      try {
        inst = (
          await c.query(
            `INSERT INTO data.database_instances (id, org_id, name, engine, version, plan_ref, storage_gb, state, network, data_region, provider_region_id, provider_id, create_token, quote_id, order_id, backup_policy, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$16,'provisioning',$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
            [
              instanceId,
              orgId,
              name,
              engine,
              body.version,
              offer.planRef,
              JSON.stringify(network),
              offer.dataRegion,
              offer.providerRegionId,
              offer.providerId,
              token,
              quote.q.id,
              order.id,
              JSON.stringify(policy),
              actor,
              Number(d.storageGb ?? 0),
            ],
          )
        ).rows[0] as Row;
      } catch (e) {
        if ((e as { code?: string }).code === '23505')
          throw new ProblemException('conflict', 'a database with this name already exists');
        throw e;
      }
      return inst;
    });
    const op = await this.ops.create(orgId, {
      kind: OP.DB_CREATE,
      resourceKind: DB_RESOURCE,
      resourceId: instanceId,
      createdBy: actor,
      maxAttempts: 1,
      input: {
        instanceId,
        providerId: offer.providerId,
        engine,
        version: offer.version,
        planRef: offer.planRef,
        storageGb: Number(d.storageGb ?? 0),
        providerRegionId: offer.providerRegionId,
        dataRegion: offer.dataRegion,
        network,
        name,
        orderId: order.id,
        quoteId: quote.q.id,
      },
    });
    const out = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE data.database_instances SET operation_id = $2 WHERE id = $1 RETURNING *`,
            [instanceId, op.id],
          )
        ).rows[0] as Row,
    );
    await this.audit.record({
      action: 'data.database.created',
      actorUserId: actor,
      orgId,
      resource: { type: 'database', id: instanceId },
      outcome: 'success',
      after: {
        engine,
        version: offer.version,
        planRef: offer.planRef,
        dataRegion: offer.dataRegion,
        state: 'provisioning',
        operationId: op.id,
      },
    });
    this.kicker(orgId, op.id);
    return this.dto({ ...row, ...out });
  }

  async list(
    orgId: string,
    q: { limit: number; cursor?: string; engine?: string; status?: string },
  ): Promise<Page<DatabaseDto>> {
    const before = decodeCursor(q.cursor);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM data.database_instances WHERE org_id = $1 AND state <> 'deleted' AND ($2::uuid IS NULL OR id < $2) AND ($3::text IS NULL OR engine = $3) AND ($4::text IS NULL OR state = $4) ORDER BY id DESC LIMIT $5`,
            [orgId, before, q.engine ?? null, q.status ?? null, q.limit + 1],
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
          await c.query(`SELECT * FROM data.database_instances WHERE id = $1 AND org_id = $2`, [
            id,
            orgId,
          ])
        ).rows[0],
    )) as Row | undefined;
    if (!r || r.state === 'deleted') throw new ProblemException('not_found');
    return r;
  }
  async get(orgId: string, id: string): Promise<DatabaseDto> {
    return this.dto(await this.row(orgId, id));
  }

  async patch(
    orgId: string,
    actor: string,
    id: string,
    ifMatch: number,
    body: Record<string, unknown>,
  ): Promise<DatabaseDto> {
    const cur = await this.row(orgId, id);
    if (cur.version_lock !== ifMatch)
      throw new ProblemException('precondition_failed', 'the database changed; fetch it again');
    const keys = Object.keys(body);
    if (keys.length === 0 || keys.some((k) => !['name', 'backupPolicy', 'plan'].includes(k)))
      throw new ProblemException('validation_failed', 'PATCH accepts name, backupPolicy and plan');
    if (body.plan !== undefined) {
      // resize only when the provider's probe says so; otherwise the action is disabled, never a silent no-op (S33 task 6)
      throw new ProblemException(
        'unsupported_capability',
        'changing the plan is not available: the provider capability is not probed as supported',
      );
    }
    const set: string[] = [];
    const vals: unknown[] = [];
    const after: Record<string, unknown> = {};
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !NAME.test(body.name))
        throw new ProblemException(
          'validation_failed',
          'name must be 3..40 characters: lower-case letters, digits and hyphens',
        );
      vals.push(body.name);
      set.push(`name = $${vals.length + 2}`);
      after.name = body.name;
    }
    if (body.backupPolicy !== undefined) {
      const p = await this.parsePolicy(orgId, body.backupPolicy, cur.backup_policy as BackupPolicy);
      vals.push(JSON.stringify(p));
      set.push(`backup_policy = $${vals.length + 2}`);
      after.backupPolicy = p;
    }
    try {
      const r = await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `UPDATE data.database_instances SET ${set.join(', ')} WHERE id = $1 AND org_id = $2 AND version_lock = ${ifMatch} RETURNING *`,
              [id, orgId, ...vals],
            )
          ).rows[0] as Row | undefined,
      );
      if (!r)
        throw new ProblemException('precondition_failed', 'the database changed; fetch it again');
      await this.audit.record({
        action: 'data.database.updated',
        actorUserId: actor,
        orgId,
        resource: { type: 'database', id },
        outcome: 'success',
        after,
      });
      return this.dto(r);
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException('conflict', 'a database with this name already exists');
      throw e;
    }
  }

  /** DELETE: the typed name must match; a database bound to a site cannot be deleted (409 in_use); the final backup follows the policy. */
  async remove(
    orgId: string,
    actor: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<{ database: DatabaseDto; operationId: string }> {
    const cur = await this.row(orgId, id);
    if (body.confirmName !== cur.name)
      throw new ProblemException('validation_failed', 'confirmName must equal the database name');
    if (!['running', 'failed', 'unknown', 'provisioning'].includes(cur.state as string))
      throw new ProblemException(
        'conflict',
        `a database in state ${String(cur.state)} cannot be deleted`,
      );
    await this.bindings.assertNotInUse(orgId, id);
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE data.database_instances SET state = 'deleting' WHERE id = $1 AND org_id = $2 AND state = $3 RETURNING *`,
            [id, orgId, cur.state],
          )
        ).rows[0] as Row | undefined,
    );
    if (!r) throw new ProblemException('conflict', 'the database changed state; retry');
    const op = await this.ops.create(orgId, {
      kind: OP.DB_DELETE,
      resourceKind: DB_RESOURCE,
      resourceId: id,
      createdBy: actor,
      maxAttempts: 1,
      input: {
        instanceId: id,
        priorState: cur.state,
        takeFinalBackup: (cur.backup_policy as BackupPolicy).enabled && cur.state === 'running',
      },
    });
    const out = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE data.database_instances SET operation_id = $2 WHERE id = $1 RETURNING *`,
            [id, op.id],
          )
        ).rows[0] as Row,
    );
    await this.audit.record({
      action: 'data.database.deleted',
      actorUserId: actor,
      orgId,
      resource: { type: 'database', id },
      outcome: 'success',
      after: { state: 'deleting', operationId: op.id },
    });
    this.kicker(orgId, op.id);
    return { database: this.dto(out), operationId: op.id };
  }

  // ---- backups -------------------------------------------------------------------------------------------------------------
  async createBackup(
    orgId: string,
    actor: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<BackupDto> {
    const inst = await this.row(orgId, id);
    if (body.type !== undefined && body.type !== 'manual')
      throw new ProblemException('validation_failed', 'type must be manual');
    if (inst.state !== 'running')
      throw new ProblemException(
        'conflict',
        'backups can only be taken while the database is running',
      );
    return this.enqueueBackup(orgId, actor, inst, 'manual');
  }
  /** Shared by manual requests, scheduled backups, the pre-restore backup and the final backup. */
  async enqueueBackup(
    orgId: string,
    actor: string | null,
    inst: Row,
    type: 'manual' | 'scheduled' | 'pre_restore' | 'final',
    scheduleKey?: string,
  ): Promise<BackupDto> {
    const backupId = uuidv7();
    const token = scheduleKey
      ? idempotencyToken(orgId, String(inst.id), scheduleKey)
      : idempotencyToken(orgId, backupId, 'backup');
    const days = (inst.backup_policy as BackupPolicy).retentionDays ?? this.cfg.backupRetentionDays;
    try {
      await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `INSERT INTO data.database_backups (id, org_id, instance_id, type, state, idempotency_token, expires_at, data_region, created_by)
             VALUES ($1,$2,$3,$4,'creating',$5, now() + make_interval(days => $6), $7, $8) RETURNING *`,
              [backupId, orgId, inst.id, type, token, days, inst.data_region, actor],
            )
          ).rows[0] as Row,
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505' && scheduleKey) {
        const existing = (await this.db.withOrg(
          orgId,
          async (c) =>
            (
              await c.query(
                `SELECT * FROM data.database_backups WHERE instance_id = $1 AND idempotency_token = $2`,
                [inst.id, token],
              )
            ).rows[0],
        )) as Row;
        return this.backupDto(existing);
      }
      throw e;
    }
    const op = await this.ops.create(orgId, {
      kind: OP.DB_BACKUP,
      resourceKind: DB_RESOURCE,
      resourceId: String(inst.id),
      createdBy: actor ?? undefined,
      maxAttempts: 1,
      input: { instanceId: inst.id, backupId, token, type },
    });
    const out = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE data.database_backups SET operation_id = $2 WHERE id = $1 RETURNING *`,
            [backupId, op.id],
          )
        ).rows[0] as Row,
    );
    await this.audit.record({
      action: 'data.database.backup_requested',
      actorUserId: actor ?? undefined,
      actorType: actor ? 'user' : 'system',
      orgId,
      resource: { type: 'database', id: String(inst.id) },
      outcome: 'success',
      after: { backupId, type },
    });
    this.kicker(orgId, op.id);
    return this.backupDto(out);
  }
  async listBackups(
    orgId: string,
    id: string,
    q: { limit: number; cursor?: string },
  ): Promise<Page<BackupDto>> {
    await this.row(orgId, id);
    const before = decodeCursor(q.cursor);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM data.database_backups WHERE org_id = $1 AND instance_id = $2 AND ($3::uuid IS NULL OR id < $3) ORDER BY id DESC LIMIT $4`,
            [orgId, id, before, q.limit + 1],
          )
        ).rows as Row[],
    );
    const p = pageOf(
      rows.map((r) => ({ ...r, id: r.id as string })),
      q.limit,
    );
    return { items: p.items.map((r) => this.backupDto(r)), nextCursor: p.nextCursor };
  }
}
export { orgTag, serviceOfEngine };
