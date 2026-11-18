import { createHash, randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import { isValidTimeZone, nextCronRun, parseCron, validateWorkflowDefinition, type WorkflowDefinition } from '@nuzm/domain';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';
import type { SecretStore } from '../../../common/secrets';
import { DEFAULT_DATA_REGION, badRequest, isAllowedTopic, isUuid, iso, pgCode, tenantSecretId, type Row, type Trigger } from './model';

export interface WorkflowDto {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'paused' | 'disabled';
  activeVersionId: string | null;
  activeVersion: number | null;
  triggers: Trigger[];
  lastRunAt: string | null;
  nextRunAt: string | null;
  pausedReason: string | null;
  pausedByAdmin: boolean;
  sourceListingVersionId: string | null;
  definition?: WorkflowDefinition;
  versions?: { id: string; version: number; createdAt: string; notes: string | null }[];
  /** Shown ONCE at creation (and rotation) when the workflow has a webhook trigger. */
  webhook?: { path: string; secret: string };
  etag: number;
  createdAt: string;
}
export interface VersionDto {
  id: string;
  workflowId: string;
  version: number;
  definitionHash: string;
  notes: string | null;
  validation: { warnings: unknown[]; connectorIds: string[]; stepCount: number };
  unchanged: boolean;
  createdAt: string;
}

const STATUSES = ['draft', 'active', 'paused', 'disabled'] as const;
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

/** Workflow definitions, immutable versions, triggers and the webhook trigger secret. Definitions are validated here (schema, DAG, expressions, connectors). */
export class WorkflowService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly secrets: SecretStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  dto(r: Row, extra: { version?: number | null; definition?: WorkflowDefinition; versions?: WorkflowDto['versions'] } = {}): WorkflowDto {
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      activeVersionId: r.active_version_id ?? null,
      activeVersion: extra.version ?? null,
      triggers: r.triggers,
      lastRunAt: iso(r.last_run_at),
      nextRunAt: iso(r.next_run_at),
      pausedReason: r.paused_reason ?? null,
      pausedByAdmin: r.paused_by_admin === true,
      sourceListingVersionId: r.source_listing_version_id ?? null,
      ...(extra.definition ? { definition: extra.definition } : {}),
      ...(extra.versions ? { versions: extra.versions } : {}),
      etag: r.version_lock,
      createdAt: iso(r.created_at)!,
    };
  }

  /** Normalizes and validates `triggers[]`. The webhook trigger carries no secret in the definition: it is generated here. */
  validateTriggers(t: unknown): Trigger[] {
    if (t === undefined) return [{ type: 'manual' }];
    if (!Array.isArray(t) || t.length < 1 || t.length > 5) throw badRequest('triggers must be a list of 1..5 triggers');
    const out: Trigger[] = [];
    let hooks = 0;
    for (const [i, x] of t.entries()) {
      if (!x || typeof x !== 'object') throw badRequest(`triggers[${i}] must be an object`);
      const o = x as Record<string, unknown>;
      switch (o.type) {
        case 'manual':
          out.push({ type: 'manual' });
          break;
        case 'webhook':
          if (++hooks > 1) throw badRequest('a workflow has at most one webhook trigger');
          out.push({ type: 'webhook' });
          break;
        case 'platform_event':
          if (!isAllowedTopic(o.topic)) throw badRequest(`triggers[${i}].topic is not an allowed event topic`);
          out.push({ type: 'platform_event', topic: o.topic });
          break;
        case 'schedule': {
          const tz = o.timezone === undefined ? 'UTC' : o.timezone;
          if (typeof o.cron !== 'string' || typeof tz !== 'string' || !isValidTimeZone(tz)) throw badRequest(`triggers[${i}] needs a cron expression and a valid IANA timezone`);
          try {
            const spec = parseCron(o.cron);
            // the minimum interval is one minute by construction (minute resolution); an expression that never fires is refused
            if (!nextCronRun(spec, this.now(), tz)) throw new Error('never fires');
          } catch (e) {
            throw badRequest(`triggers[${i}].cron: ${(e as Error).message}`);
          }
          out.push({ type: 'schedule', cron: o.cron.trim(), timezone: tz });
          break;
        }
        default:
          throw badRequest(`triggers[${i}].type must be schedule, webhook, platform_event or manual`);
      }
    }
    return out;
  }

  /** Schema + graph + expressions + connector authorization. Throws 422 `validation_failed` with the report's errors. */
  async validate(orgId: string, definition: unknown): Promise<{ definition: WorkflowDefinition; hash: string; report: ReturnType<typeof validateWorkflowDefinition> }> {
    const report = validateWorkflowDefinition(definition);
    const errors: { code: string; path: string; message: string }[] = [...report.errors];
    if (report.ok && report.connectorIds.length > 0) {
      const found = await this.db.withOrg(orgId, async (c) =>
        (
          await c.query(
            `SELECT c.id FROM automation.connectors c WHERE c.org_id = $1 AND c.id = ANY($2::uuid[]) AND c.status = 'active'
               AND EXISTS (SELECT 1 FROM automation.connector_authorizations a WHERE a.connector_id = c.id AND a.status = 'active' AND (a.expires_at IS NULL OR a.expires_at > now()))`,
            [orgId, report.connectorIds],
          )
        ).rows.map((r) => r.id as string),
      );
      for (const id of report.connectorIds)
        if (!found.includes(id)) errors.push({ code: 'connector_not_authorized', path: '$', message: `connector ${id} is not authorized in this organization` });
    }
    if (errors.length > 0) throw new ProblemException('validation_failed', 'the workflow definition is not valid', errors);
    return { definition: definition as WorkflowDefinition, hash: createHash('sha256').update(canonical(definition)).digest('hex'), report };
  }

  private nextRun(triggers: Trigger[]): Date | null {
    const t = triggers.find((x) => x.type === 'schedule');
    return t ? nextCronRun(t.cron!, this.now(), t.timezone ?? 'UTC') : null;
  }

  async create(orgId: string, actor: string, body: Record<string, unknown>): Promise<WorkflowDto> {
    for (const k of Object.keys(body)) if (!['name', 'definition', 'triggers'].includes(k)) throw badRequest(`unknown field ${k}`);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > 120) throw badRequest('name must be 1..120 characters');
    const triggers = this.validateTriggers(body.triggers);
    const v = await this.validate(orgId, body.definition);
    const id = uuidv7();
    const vid = uuidv7();
    let webhook: WorkflowDto['webhook'];
    let tokenHash: string | null = null;
    let secretRef: string | null = null;
    if (triggers.some((t) => t.type === 'webhook')) {
      const token = randomBytes(32).toString('base64url');
      const secret = randomBytes(32).toString('hex');
      tokenHash = createHash('sha256').update(token).digest('hex');
      secretRef = await this.secrets.put(tenantSecretId(orgId, 'wfhook', id), secret);
      webhook = { path: `/v1/webhooks/workflows/${token}`, secret };
    }
    const row = (await this.db.withOrg(orgId, async (c) => {
      const w = (
        await c.query(
          `INSERT INTO automation.workflows (id, org_id, name, status, triggers, webhook_token_hash, webhook_secret_ref, data_region, owner_user_id) VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8) RETURNING *`,
          [id, orgId, name, JSON.stringify(triggers), tokenHash, secretRef, DEFAULT_DATA_REGION, actor],
        )
      ).rows[0] as Row;
      await c.query(`INSERT INTO automation.workflow_versions (id, org_id, workflow_id, version, definition, definition_hash, validation, created_by) VALUES ($1,$2,$3,1,$4,$5,$6,$7)`, [
        vid, orgId, id, JSON.stringify(v.definition), v.hash, JSON.stringify({ warnings: v.report.warnings, connectorIds: v.report.connectorIds, stepCount: v.report.stepCount }), actor,
      ]);
      return (await c.query(`UPDATE automation.workflows SET active_version_id = $2 WHERE id = $1 RETURNING *`, [id, vid])).rows[0] as Row;
      void w;
    })) as Row;
    await this.audit.record({ action: 'workflow.version.created', actorUserId: actor, orgId, resource: { type: 'workflow', id }, outcome: 'success', after: { version: 1, hash: v.hash, steps: v.report.stepCount } });
    return { ...this.dto(row, { version: 1, definition: v.definition }), ...(webhook ? { webhook } : {}) };
  }

  async list(orgId: string, q: { limit: number; cursor?: string; status?: string }): Promise<Page<WorkflowDto>> {
    if (q.status !== undefined && !STATUSES.includes(q.status as never)) throw new ProblemException('invalid_filter', 'status must be draft, active, paused or disabled');
    const before = decodeCursor(q.cursor);
    const rows = await this.db.withOrg(orgId, async (c) =>
      (
        await c.query(
          `SELECT w.*, (SELECT version FROM automation.workflow_versions v WHERE v.id = w.active_version_id) AS av
             FROM automation.workflows w WHERE w.org_id = $1 AND ($2::uuid IS NULL OR w.id < $2) AND ($3::text IS NULL OR w.status = $3) ORDER BY w.id DESC LIMIT $4`,
          [orgId, before, q.status ?? null, q.limit + 1],
        )
      ).rows as Row[],
    );
    const p = pageOf(rows as (Row & { id: string })[], q.limit);
    return { items: p.items.map((r) => this.dto(r, { version: r.av ?? null })), nextCursor: p.nextCursor };
  }

  async get(orgId: string, id: string): Promise<WorkflowDto> {
    if (!isUuid(id)) throw new ProblemException('not_found');
    const x = await this.db.withOrg(orgId, async (c) => {
      const w = (await c.query(`SELECT * FROM automation.workflows WHERE id = $1 AND org_id = $2`, [id, orgId])).rows[0] as Row | undefined;
      if (!w) return null;
      const vs = (await c.query(`SELECT id, version, created_at, notes, definition FROM automation.workflow_versions WHERE workflow_id = $1 ORDER BY version DESC LIMIT 50`, [id])).rows as Row[];
      return { w, vs };
    });
    if (!x) throw new ProblemException('not_found');
    const active = x.vs.find((v) => v.id === x.w.active_version_id);
    return this.dto(x.w, {
      version: active?.version ?? null,
      definition: active?.definition,
      versions: x.vs.map((v) => ({ id: v.id, version: v.version, createdAt: iso(v.created_at)!, notes: v.notes ?? null })),
    });
  }

  async version(orgId: string, versionId: string): Promise<Row> {
    const r = (await this.db.withOrg(orgId, async (c) => (await c.query(`SELECT * FROM automation.workflow_versions WHERE id = $1 AND org_id = $2`, [versionId, orgId])).rows[0])) as Row | undefined;
    if (!r) throw new ProblemException('not_found');
    return r;
  }

  /** PATCH: name and status only (the definition changes through versions). Optimistic lock via ETag. */
  async patch(orgId: string, actor: string, id: string, ifMatch: number, body: Record<string, unknown>, opts: { admin?: boolean } = {}): Promise<WorkflowDto> {
    for (const k of Object.keys(body)) if (!['name', 'status'].includes(k)) throw badRequest(`${k} cannot be changed here (a definition changes through POST /v1/workflows/{id}/versions)`);
    if (body.name === undefined && body.status === undefined) throw badRequest('nothing to change');
    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.trim().length > 120)) throw badRequest('name must be 1..120 characters');
    if (body.status !== undefined && !STATUSES.includes(body.status as never)) throw badRequest(`status must be one of ${STATUSES.join(', ')}`);
    const w = await this.get(orgId, id);
    if (w.etag !== ifMatch) throw new ProblemException('etag_mismatch');
    const next = body.status as WorkflowDto['status'] | undefined;
    if (next !== undefined && next !== w.status) {
      if (w.pausedByAdmin && !opts.admin) throw new ProblemException('forbidden', 'the workflow was paused by an administrator');
      if (next === 'active' && !w.activeVersionId) throw new ProblemException('invalid_state', 'publish a version before activating');
      if (w.status === 'disabled') throw new ProblemException('invalid_state', 'a disabled workflow cannot be re-enabled; create a new one');
      if (next === 'draft') throw new ProblemException('invalid_state', 'a workflow cannot go back to draft');
    }
    const row = (await this.db.withOrg(orgId, async (c) => {
      const sets: string[] = [];
      const params: unknown[] = [id, ifMatch];
      if (body.name !== undefined) {
        params.push((body.name as string).trim());
        sets.push(`name = $${params.length}`);
      }
      if (next !== undefined) {
        params.push(next);
        sets.push(`status = $${params.length}`);
        if (next === 'active') {
          params.push(this.nextRun(w.triggers));
          sets.push(`next_run_at = $${params.length}`, `paused_reason = NULL`, `paused_at = NULL`);
        } else {
          sets.push(`next_run_at = NULL`);
          if (next === 'paused') sets.push(`paused_at = now()`, `paused_reason = 'paused by the organization'`);
        }
      }
      const r = await c.query(`UPDATE automation.workflows SET ${sets.join(', ')} WHERE id = $1 AND version_lock = $2 RETURNING *`, params);
      if (!r.rows[0]) throw new ProblemException('etag_mismatch');
      return r.rows[0] as Row;
    })) as Row;
    await this.audit.record({ action: 'workflow.workflow.updated', actorUserId: actor, orgId, resource: { type: 'workflow', id }, outcome: 'success', before: { name: w.name, status: w.status }, after: { name: row.name, status: row.status } });
    return this.dto(row, { version: w.activeVersion });
  }

  /** POST …/versions: validate, then insert the next immutable version and make it the active one. An identical definition returns the current version unchanged. */
  async createVersion(orgId: string, actor: string, id: string, body: Record<string, unknown>): Promise<VersionDto> {
    for (const k of Object.keys(body)) if (!['definition', 'notes'].includes(k)) throw badRequest(`unknown field ${k}`);
    if (body.notes !== undefined && (typeof body.notes !== 'string' || body.notes.length > 2000)) throw badRequest('notes must be at most 2000 characters');
    if (!isUuid(id)) throw new ProblemException('not_found');
    const exists = await this.db.withOrg(orgId, async (c) => (await c.query(`SELECT 1 FROM automation.workflows WHERE id = $1 AND org_id = $2`, [id, orgId])).rowCount);
    if (!exists) throw new ProblemException('not_found');
    const v = await this.validate(orgId, body.definition);
    const vdto = (r: Row, unchanged: boolean): VersionDto => ({
      id: r.id, workflowId: r.workflow_id, version: r.version, definitionHash: r.definition_hash, notes: r.notes ?? null,
      validation: { warnings: r.validation.warnings ?? [], connectorIds: r.validation.connectorIds ?? [], stepCount: r.validation.stepCount ?? 0 }, unchanged, createdAt: iso(r.created_at)!,
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const out = await this.db.withOrg(orgId, async (c) => {
          const last = (await c.query(`SELECT * FROM automation.workflow_versions WHERE workflow_id = $1 ORDER BY version DESC LIMIT 1`, [id])).rows[0] as Row | undefined;
          if (last && last.definition_hash === v.hash) return { row: last, unchanged: true };
          const row = (
            await c.query(
              `INSERT INTO automation.workflow_versions (id, org_id, workflow_id, version, definition, definition_hash, notes, validation, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
              [uuidv7(), orgId, id, (last?.version ?? 0) + 1, JSON.stringify(v.definition), v.hash, (body.notes as string | undefined) ?? null,
               JSON.stringify({ warnings: v.report.warnings, connectorIds: v.report.connectorIds, stepCount: v.report.stepCount }), actor],
            )
          ).rows[0] as Row;
          await c.query(`UPDATE automation.workflows SET active_version_id = $2 WHERE id = $1`, [id, row.id]);
          return { row, unchanged: false };
        });
        if (!out.unchanged)
          await this.audit.record({ action: 'workflow.version.created', actorUserId: actor, orgId, resource: { type: 'workflow', id }, outcome: 'success', after: { version: out.row.version, hash: v.hash, steps: v.report.stepCount } });
        return vdto(out.row, out.unchanged);
      } catch (e) {
        if (pgCode(e) === '23505' && attempt < 4) continue; // a parallel publish took the version number: take the next one
        throw e;
      }
    }
    throw new ProblemException('conflict', 'could not allocate a version number');
  }

  /** Admin kill switch (service-level; the admin route is SCR-M11-05): pause with a reason an organization cannot lift. */
  async adminPause(workflowId: string, orgId: string, reason: string, adminUserId: string): Promise<void> {
    await this.db.withPlatformScope(async (c) => {
      const r = await c.query(`UPDATE automation.workflows SET status = 'paused', paused_by_admin = true, paused_reason = $2, paused_at = now(), next_run_at = NULL WHERE id = $1 AND org_id = $3 AND status <> 'disabled'`, [workflowId, reason.slice(0, 500), orgId]);
      if (!r.rowCount) throw new ProblemException('not_found');
    });
    await this.audit.record({ action: 'workflow.workflow.admin_paused', actorUserId: adminUserId, orgId, resource: { type: 'workflow', id: workflowId }, outcome: 'success', detail: { reason } });
  }

  /** Installs a copy of a template definition as a NEW workflow of the buyer (marketplace S53). */
  async createFromTemplate(orgId: string, actor: string, name: string, definition: unknown, source: { listingVersionId: string }): Promise<{ workflowId: string }> {
    const v = await this.validate(orgId, definition);
    const id = uuidv7();
    const vid = uuidv7();
    await this.db.withOrg(orgId, async (c) => {
      await c.query(`INSERT INTO automation.workflows (id, org_id, name, status, triggers, data_region, owner_user_id, source_listing_version_id) VALUES ($1,$2,$3,'draft','[{"type":"manual"}]',$4,$5,$6)`, [id, orgId, name.slice(0, 120), DEFAULT_DATA_REGION, actor, source.listingVersionId]);
      await c.query(`INSERT INTO automation.workflow_versions (id, org_id, workflow_id, version, definition, definition_hash, validation, created_by) VALUES ($1,$2,$3,1,$4,$5,$6,$7)`, [vid, orgId, id, JSON.stringify(v.definition), v.hash, JSON.stringify({ warnings: v.report.warnings, connectorIds: v.report.connectorIds, stepCount: v.report.stepCount }), actor]);
      await c.query(`UPDATE automation.workflows SET active_version_id = $2 WHERE id = $1`, [id, vid]);
    });
    await this.audit.record({ action: 'workflow.version.created', actorUserId: actor, orgId, resource: { type: 'workflow', id }, outcome: 'success', after: { version: 1, hash: v.hash, installedFrom: source.listingVersionId } });
    return { workflowId: id };
  }
}
