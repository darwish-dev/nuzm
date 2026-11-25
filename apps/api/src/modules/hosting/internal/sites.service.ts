import { v7 as uuidv7 } from 'uuid';
import type { PoolClient } from 'pg';
import type { Db, OperationsService } from '@nuzm/platform';
import type { ResidencyEvaluator } from '@nuzm/domain';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeTimeCursor, encodeTimeCursor } from '../../../common/pagination';
import type { EntitlementService } from '../../billing';
import type { OrderService } from '../../commerce';
import { CapacityService } from './capacity.service';
import type { HostingConfig } from './config';
import { siteNameFor, tokenFor } from './hosting-names';
import {
  PlansService,
  planLimits,
  planNeed,
  planOffersRuntime,
  type PlanRow,
} from './plans.service';
import { RUNTIME_ID, type HostingAdapter } from './ports';
import type { AccountContext } from './m05-contracts';
import { UUID } from '@nuzm/domain';

type Row = Record<string, unknown>;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);

/** `platform.operations.kind` values of this module. */
export const KIND = {
  wordpress: 'hosting.wordpress.install',
  drill: 'hosting.restore.drill',
  create: 'hosting.site.create',
  delete: 'hosting.site.delete',
  domain: 'hosting.domain.bind',
  ssl: 'hosting.ssl.issue',
  backup: 'hosting.backup.create',
  restore: 'hosting.backup.restore',
  migrate: 'hosting.site.migrate',
} as const;
export const HOSTING_OP_KINDS: string[] = Object.values(KIND);

export interface SiteDto {
  id: string;
  name: string;
  status: string;
  plan: { id: string; key: string; name: { ar: string; en: string } };
  dataRegion: string;
  runtime: string;
  /** `wordpress` when the plan installs Managed WordPress; its state is `GET …/wordpress` */
  app: 'none' | 'wordpress';
  primaryDomain: string | null;
  domains: { id: string; domain: string; state: string; primary: boolean }[];
  quotas: { dim: string; limit: number; soft: number }[];
  usageSummary: { diskMb: number; inodes: number } | null;
  suspension: { reason: string | null; by: string } | null;
  failureReason: string | null;
  operationId: string | null;
  settings: Record<string, unknown>;
  version: number;
  createdAt: string;
  /** staff only */
  orgId?: string;
  nodeId?: string | null;
  nodeName?: string | null;
}

export interface Caller {
  userId: string;
}

const STAFF_SELECT = `SELECT s.*, (SELECT n.name FROM hosting.nodes n WHERE n.id = s.node_id) AS node_name_label,
      p.key AS plan_key, p.name_ar AS plan_name_ar, p.name_en AS plan_name_en,
      (SELECT u.disk_bytes FROM hosting.site_usage_reports u WHERE u.site_id = s.id ORDER BY u.period_start DESC LIMIT 1) AS usage_disk_bytes,
      (SELECT u.inodes FROM hosting.site_usage_reports u WHERE u.site_id = s.id ORDER BY u.period_start DESC LIMIT 1) AS usage_inodes
    FROM hosting.sites s JOIN hosting.plan_definitions p ON p.id = s.plan_id`;
const SELECT = `SELECT s.*, p.key AS plan_key, p.name_ar AS plan_name_ar, p.name_en AS plan_name_en,
      (SELECT u.disk_bytes FROM hosting.site_usage_reports u WHERE u.site_id = s.id ORDER BY u.period_start DESC LIMIT 1) AS usage_disk_bytes,
      (SELECT u.inodes FROM hosting.site_usage_reports u WHERE u.site_id = s.id ORDER BY u.period_start DESC LIMIT 1) AS usage_inodes
    FROM hosting.sites s JOIN hosting.plan_definitions p ON p.id = s.plan_id`;

export class SitesService {
  readonly capacity: CapacityService;
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ops: OperationsService,
    private readonly orders: Pick<OrderService, 'createFromQuote'>,
    private readonly entitlements: Pick<EntitlementService, 'resolve'>,
    readonly plans: PlansService,
    private readonly residency: ResidencyEvaluator,
    private readonly adapter: HostingAdapter,
    private readonly cfg: HostingConfig,
    private readonly clock: () => Date = () => new Date(),
    private readonly kick: (orgId: string, operationId: string) => void = () => undefined,
  ) {
    void this.residency; // placement is decided through PlansService.eligibleRegions (M04 hook m06-node-selection); kept for the explicit evaluate below
    this.capacity = new CapacityService(cfg);
  }

  ctx(traceId: string): AccountContext {
    return {
      providerAccountId: 'platform-hosting',
      credentialRef: 'vault://hosting/panel-access',
      traceId,
      deadlineMs: 60_000,
    };
  }
  private static dto(r: Row, domains: Row[], quotas: Row[], staff = false): SiteDto {
    const d: SiteDto = {
      id: r.id as string,
      name: r.name as string,
      status: r.status as string,
      plan: {
        id: r.plan_id as string,
        key: r.plan_key as string,
        name: { ar: r.plan_name_ar as string, en: r.plan_name_en as string },
      },
      dataRegion: r.data_region as string,
      runtime: r.runtime as string,
      app: ((r.app_kind as string | undefined) ?? 'none') as 'none' | 'wordpress',
      primaryDomain: (r.domain_primary as string | null) ?? null,
      domains: domains.map((x) => ({
        id: x.id as string,
        domain: x.domain as string,
        state: x.state as string,
        primary: x.is_primary as boolean,
      })),
      quotas: quotas.map((q) => ({
        dim: q.dim as string,
        limit: Number(q.limit_value),
        soft: Number(q.soft_limit),
      })),
      usageSummary:
        r.usage_disk_bytes === undefined || r.usage_disk_bytes === null
          ? null
          : {
              diskMb: Math.ceil(Number(r.usage_disk_bytes) / 1_048_576),
              inodes: Number(r.usage_inodes),
            },
      suspension:
        r.status === 'suspended'
          ? { reason: (r.suspension_reason as string | null) ?? null, by: r.suspended_by as string }
          : null,
      failureReason: (r.failure_reason as string | null) ?? null,
      operationId: (r.operation_id as string | null) ?? null,
      settings: (r.settings as Record<string, unknown>) ?? {},
      version: r.version as number,
      createdAt: iso(r.created_at)!,
    };
    if (staff) {
      d.orgId = r.org_id as string;
      d.nodeId = (r.node_id as string | null) ?? null;
      d.nodeName = (r.node_name_label as string | null) ?? null;
    }
    return d;
  }
  private async decorate(c: PoolClient, rows: Row[], staff = false): Promise<SiteDto[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id as string);
    const doms = (
      await c.query(
        `SELECT id, site_id, domain, state, is_primary FROM hosting.site_domain_bindings WHERE site_id = ANY($1::uuid[]) AND state <> 'removed' ORDER BY created_at`,
        [ids],
      )
    ).rows;
    const quotas = (
      await c.query(
        `SELECT site_id, dim, limit_value, soft_limit FROM hosting.site_quotas WHERE site_id = ANY($1::uuid[]) ORDER BY dim`,
        [ids],
      )
    ).rows;
    return rows.map((r) =>
      SitesService.dto(
        r,
        doms.filter((d) => d.site_id === r.id),
        quotas.filter((q) => q.site_id === r.id),
        staff,
      ),
    );
  }

  /* ───────────── create ───────────── */
  async create(
    orgId: string,
    actor: Caller,
    body: Record<string, unknown>,
  ): Promise<{ site: SiteDto; operationId: string; replay: boolean }> {
    const errors: { field: string; message: string }[] = [];
    const bad = (field: string, message: string) => errors.push({ field, message });
    const allowed = new Set([
      'quoteId',
      'planId',
      'name',
      'projectId',
      'environmentId',
      'runtime',
      'primaryDomain',
    ]);
    for (const k of Object.keys(body)) if (!allowed.has(k)) bad(k, 'unknown member');
    const { quoteId, planId, name, projectId, runtime } = body;
    const environmentId = body.environmentId ?? null;
    const primaryDomain =
      typeof body.primaryDomain === 'string'
        ? body.primaryDomain.toLowerCase()
        : body.primaryDomain;
    if (typeof quoteId !== 'string' || !UUID.test(quoteId)) bad('quoteId', 'must be a quote id');
    if (typeof planId !== 'string' || !UUID.test(planId)) bad('planId', 'must be a plan id');
    if (typeof name !== 'string' || !NAME.test(name))
      bad('name', 'must be 1..63 letters, digits, space, dot, dash or underscore');
    if (typeof projectId !== 'string' || !UUID.test(projectId))
      bad('projectId', 'must be a project id');
    if (environmentId !== null && (typeof environmentId !== 'string' || !UUID.test(environmentId)))
      bad('environmentId', 'must be an environment id');
    if (typeof runtime !== 'string' || !RUNTIME_ID.test(runtime))
      bad('runtime', 'must be a runtime id such as php:8.3, nodejs:22 or static');
    if (
      primaryDomain !== undefined &&
      (typeof primaryDomain !== 'string' || !DOMAIN.test(primaryDomain))
    )
      bad('primaryDomain', 'must be a domain name');
    if (errors.length)
      throw new ProblemException('validation_failed', 'invalid site request', errors);
    const q = (quoteId as string).toLowerCase(),
      rt = runtime as string,
      pid = (planId as string).toLowerCase();

    // replay: a quote creates at most ONE site; a second request returns it
    const prior = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT id, operation_id FROM hosting.sites WHERE org_id = $1 AND quote_id = $2`,
            [orgId, q],
          )
        ).rows[0],
    );
    if (prior)
      return {
        site: await this.get(orgId, prior.id as string),
        operationId: prior.operation_id as string,
        replay: true,
      };

    const plan = await this.plans.load(pid);
    if (!plan || plan.status !== 'active')
      throw new ProblemException('not_found', 'hosting plan not found');
    if (!planOffersRuntime(plan, rt))
      throw new ProblemException('unsupported_runtime', 'this plan does not offer that runtime');
    const project = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT 1 FROM tenancy.projects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
            [projectId, orgId],
          )
        ).rowCount,
    );
    if (!project) throw new ProblemException('not_found', 'project not found');
    let dataRegionOfEnv: string | null = null;
    if (environmentId) {
      const env = await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `SELECT data_region FROM tenancy.environments WHERE id = $1 AND org_id = $2 AND project_id = $3 AND deleted_at IS NULL`,
              [environmentId, orgId, projectId],
            )
          ).rows[0],
      );
      if (!env) throw new ProblemException('not_found', 'environment not found');
      dataRegionOfEnv = (env.data_region as string | null) ?? null;
    }

    // entitlement `hosting.sites.max` (M02): the count of live sites may not reach a hard limit
    const ent = await this.entitlements.resolve(orgId);
    const max = ent.limits.find((l) => l.meterGroup === 'hosting.sites.max');
    if (max && max.limit !== null && max.mode === 'hard') {
      const live = await this.db.withOrg(orgId, async (c) =>
        Number(
          (
            await c.query(
              `SELECT count(*)::int AS n FROM hosting.sites WHERE org_id = $1 AND status NOT IN ('deleted','failed')`,
              [orgId],
            )
          ).rows[0]!.n,
        ),
      );
      if (live >= Number(max.limit))
        throw new ProblemException(
          'quota_exceeded',
          `the hosting.sites.max limit (${max.limit}) is reached`,
        );
    }

    // quote: kind hosting, not expired, for THIS plan; then the order/authorization (spend cap, quotas, dunning), reused when it exists already
    const quote = await this.db.withOrg(orgId, async (c) => {
      const row = (
        await c.query(
          `SELECT id, kind, expires_at FROM commerce.quotes WHERE id = $1 AND org_id = $2`,
          [q, orgId],
        )
      ).rows[0];
      if (!row) return null;
      const item = (
        await c.query(
          `SELECT details FROM commerce.quote_items WHERE quote_id = $1 ORDER BY position LIMIT 1`,
          [q],
        )
      ).rows[0];
      const order = (
        await c.query(`SELECT id FROM commerce.orders WHERE org_id = $1 AND quote_id = $2`, [
          orgId,
          q,
        ])
      ).rows[0];
      return {
        kind: row.kind as string,
        expiresAt: row.expires_at as Date,
        details: (item?.details ?? {}) as { planId?: string; runtime?: string },
        hasOrder: !!order,
      };
    });
    if (!quote) throw new ProblemException('not_found', 'quote not found');
    if (quote.kind !== 'hosting')
      throw new ProblemException('validation_failed', 'the quote is not a hosting quote');
    if (quote.expiresAt.getTime() <= this.clock().getTime())
      throw new ProblemException('quote_expired', 'the quote has expired; request a new one');
    if (quote.details.planId !== pid || quote.details.runtime !== rt)
      throw new ProblemException(
        'validation_failed',
        'the quote was issued for another plan or runtime',
      );
    if (!quote.hasOrder) {
      try {
        await this.orders.createFromQuote(orgId, q, actor.userId, this.clock());
      } catch (e) {
        if (e instanceof ProblemException && e.code === 'gone')
          throw new ProblemException('quote_expired', 'the quote has expired; request a new one');
        if (!(e instanceof ProblemException && e.code === 'conflict')) throw e; // conflict = a parallel request just ordered it: fine
      }
    }

    // residency (M04 hook m06-node-selection): only regions the organization's policy allows
    const el = await this.plans.eligibleRegions(orgId, rt);
    if (el.candidateRegions.length === 0)
      throw new ProblemException('unsupported_runtime', 'no active node offers that runtime');
    if (el.residencyDenied)
      throw new ProblemException(
        'residency_denied',
        'the data residency policy does not allow hosting in any available region',
      );
    const regions = dataRegionOfEnv ? el.regions.filter((r) => r === dataRegionOfEnv) : el.regions;
    if (dataRegionOfEnv && regions.length === 0)
      throw new ProblemException(
        'residency_denied',
        'the environment region is not available for hosting',
      );

    const siteId = uuidv7();
    const token = tokenFor(orgId, siteId, 'create_site');
    const nodeName = siteNameFor(token);
    const need = planNeed(plan);
    await this.db.withPlatformScope(async (c) => {
      try {
        await c.query(
          `INSERT INTO hosting.sites (id, org_id, project_id, environment_id, name, token, node_name, plan_id, runtime, status, data_region, quote_id, created_by, credentials_ref, backup_key_ref, app_kind)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'creating','pending',$10,$11,$12,$13,$14)`,
          [
            siteId,
            orgId,
            projectId,
            environmentId,
            name,
            token,
            nodeName,
            pid,
            rt,
            q,
            actor.userId,
            `vault://hosting/org/${orgId}/site/${siteId}/credentials`,
            `vault://hosting/org/${orgId}/site/${siteId}/backup-key`,
            plan.appKind,
          ],
        );
      } catch (e) {
        if ((e as { code?: string }).code === '23505')
          throw new ProblemException('conflict', 'a site with this name already exists');
        throw e;
      }
      const { nodeId } = await this.capacity.allocate(c, siteId, { regions, runtime: rt, need });
      const node = (await c.query(`SELECT data_region FROM hosting.nodes WHERE id = $1`, [nodeId]))
        .rows[0]!;
      await c.query(`UPDATE hosting.sites SET node_id = $2, data_region = $3 WHERE id = $1`, [
        siteId,
        nodeId,
        node.data_region,
      ]);
    });
    const op = await this.ops.create(orgId, {
      kind: KIND.create,
      input: { siteId, primaryDomain: primaryDomain ?? null },
      resourceKind: 'hosting_site',
      resourceId: siteId,
      createdBy: actor.userId,
      maxAttempts: 5,
    });
    await this.db.withPlatformScope((c) =>
      c.query(`UPDATE hosting.sites SET operation_id = $2 WHERE id = $1`, [siteId, op.id]),
    );
    await this.audit.record({
      action: 'hosting.site.create.requested',
      actorUserId: actor.userId,
      actorType: 'user',
      orgId,
      resource: { type: 'hosting_site', id: siteId },
      outcome: 'success',
      detail: { planKey: plan.key, runtime: rt },
    });
    this.kick(orgId, op.id);
    return { site: await this.get(orgId, siteId), operationId: op.id, replay: false };
  }

  /* ───────────── reads ───────────── */
  async list(
    orgId: string,
    q: { limit: number; cursor?: string; status?: string },
  ): Promise<{ items: SiteDto[]; nextCursor: string | null }> {
    const cur = decodeTimeCursor(q.cursor);
    return this.db.withOrg(orgId, async (c) => {
      const rows = (
        await c.query(
          `${SELECT} WHERE s.org_id = $1 AND s.status <> 'deleted' AND ($2::text IS NULL OR s.status = $2)
             AND ($3::timestamptz IS NULL OR (s.created_at, s.id) < ($3::timestamptz, $4::uuid)) ORDER BY s.created_at DESC, s.id DESC LIMIT $5`,
          [orgId, q.status ?? null, cur?.t ?? null, cur?.id ?? null, q.limit + 1],
        )
      ).rows;
      const page = rows.slice(0, q.limit);
      const items = await this.decorate(c, page);
      const last = page[page.length - 1];
      return {
        items,
        nextCursor:
          rows.length > q.limit && last
            ? encodeTimeCursor(last.created_at as Date, last.id as string)
            : null,
      };
    });
  }
  /** Another organization's id is a 404 (RLS hides the row): never 403. The node is never exposed to a customer. */
  async get(orgId: string, id: string): Promise<SiteDto> {
    if (!UUID.test(id)) throw new ProblemException('not_found', 'site not found');
    return this.db.withOrg(orgId, async (c) => {
      const r = (await c.query(`${SELECT} WHERE s.id = $1 AND s.org_id = $2`, [id, orgId])).rows[0];
      if (!r) throw new ProblemException('not_found', 'site not found');
      return (await this.decorate(c, [r]))[0]!;
    });
  }
  /** Raw site row for the other services (org scoped; 404 for another organization). */
  async row(orgId: string, id: string): Promise<Row> {
    if (!UUID.test(id)) throw new ProblemException('not_found', 'site not found');
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM hosting.sites WHERE id = $1 AND org_id = $2`, [id, orgId]))
          .rows[0],
    );
    if (!r) throw new ProblemException('not_found', 'site not found');
    return r;
  }

  /* ───────────── update ───────────── */
  async patch(
    orgId: string,
    actor: Caller,
    id: string,
    ifMatch: number,
    body: Record<string, unknown>,
  ): Promise<SiteDto> {
    await this.row(orgId, id); // the site first: another organization's id is a 404 whatever the body says
    const allowed = new Set(['name', 'planId', 'runtime', 'settings']);
    for (const k of Object.keys(body))
      if (!allowed.has(k)) throw new ProblemException('validation_failed', `unknown member ${k}`);
    if (Object.keys(body).length === 0)
      throw new ProblemException('validation_failed', 'nothing to change');
    const site = await this.row(orgId, id);
    if (site.version !== ifMatch)
      throw new ProblemException('precondition_failed', 'the site changed since you read it');
    if (site.status !== 'active')
      throw new ProblemException('site_not_active', 'only an active site can be changed');
    const set: string[] = [];
    const params: unknown[] = [];
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !NAME.test(body.name))
        throw new ProblemException('validation_failed', 'invalid name');
      set.push(`name = $${params.push(body.name)}`);
    }
    if (body.settings !== undefined) {
      const s = body.settings;
      if (
        typeof s !== 'object' ||
        s === null ||
        Array.isArray(s) ||
        JSON.stringify(s).length > 4000
      )
        throw new ProblemException(
          'validation_failed',
          'settings must be an object of at most 4000 characters',
        );
      set.push(`settings = $${params.push(JSON.stringify(s))}`);
    }
    const nodeId = site.node_id as string;
    let plan: PlanRow | null = null;
    let newRuntime = site.runtime as string;
    if (body.planId !== undefined || body.runtime !== undefined) {
      if (body.planId !== undefined && (typeof body.planId !== 'string' || !UUID.test(body.planId)))
        throw new ProblemException('validation_failed', 'planId must be a plan id');
      plan = await this.plans.load((body.planId as string | undefined) ?? (site.plan_id as string));
      if (!plan || plan.status !== 'active')
        throw new ProblemException('not_found', 'hosting plan not found');
      if (body.runtime !== undefined) {
        if (typeof body.runtime !== 'string' || !RUNTIME_ID.test(body.runtime))
          throw new ProblemException('validation_failed', 'invalid runtime');
        newRuntime = body.runtime;
      }
      if (!planOffersRuntime(plan, newRuntime))
        throw new ProblemException('unsupported_runtime', 'the plan does not offer that runtime');
    }
    const oldPlan = await this.plans.load(site.plan_id as string);
    let resized = false;
    if (plan && plan.id !== site.plan_id) {
      // a plan change re-checks capacity: growth is a conditional update (409 no_capacity), shrinkage releases
      await this.db.withPlatformScope((c) => this.capacity.resize(c, id, planNeed(plan!)));
      resized = true;
      set.push(`plan_id = $${params.push(plan.id)}`);
    }
    if (plan && (plan.id !== site.plan_id || newRuntime !== site.runtime)) {
      const node = await this.db.withPlatformScope(
        async (c) =>
          (await c.query(`SELECT compute_instance_id FROM hosting.nodes WHERE id = $1`, [nodeId]))
            .rows[0],
      );
      const t = {
        idempotencyToken: tokenFor(orgId, `${id}:${ifMatch}`, 'update_site'),
        operationId: `patch-${id}-${ifMatch}`,
      };
      const r = await this.adapter.updateSite(
        this.ctx(t.operationId),
        { nodeId, computeInstanceId: node!.compute_instance_id as string },
        site.node_name as string,
        {
          limits: planLimits(plan),
          ...(newRuntime !== site.runtime ? { runtime: newRuntime } : {}),
        },
        t,
      );
      if (r.status !== 'succeeded') {
        if (resized && oldPlan)
          await this.db
            .withPlatformScope((c) => this.capacity.resize(c, id, planNeed(oldPlan)))
            .catch(() => undefined);
        throw new ProblemException(
          'service_unavailable',
          r.status === 'uncertain'
            ? 'the node did not answer; try again'
            : 'the node refused the change',
        );
      }
      if (newRuntime !== site.runtime) set.push(`runtime = $${params.push(newRuntime)}`);
    }
    if (set.length === 0) return this.get(orgId, id);
    const idIdx = params.push(id);
    const orgIdx = params.push(orgId);
    const verIdx = params.push(ifMatch);
    const upd = await this.db.withOrg(orgId, async (c) => {
      try {
        return (
          await c.query(
            `UPDATE hosting.sites SET ${set.join(', ')}, version = version + 1, updated_at = now() WHERE id = $${idIdx} AND org_id = $${orgIdx} AND version = $${verIdx} RETURNING id`,
            params,
          )
        ).rowCount;
      } catch (e) {
        if ((e as { code?: string }).code === '23505')
          throw new ProblemException('conflict', 'a site with this name already exists');
        throw e;
      }
    });
    if (!upd)
      throw new ProblemException('precondition_failed', 'the site changed since you read it');
    await this.audit.record({
      action: 'hosting.site.updated',
      actorUserId: actor.userId,
      actorType: 'user',
      orgId,
      resource: { type: 'hosting_site', id },
      outcome: 'success',
      detail: { fields: Object.keys(body) },
    });
    if (resized && plan) await this.syncQuotas(id, plan);
    return this.get(orgId, id);
  }

  /** The per-site quota rows follow the plan (soft = softPercent of the limit, hard = the limit). */
  async syncQuotas(siteId: string, plan: PlanRow): Promise<void> {
    const l = planLimits(plan);
    const soft = this.cfg.softPercent / 100;
    const rows: [string, number][] = [
      ['disk_mb', l.diskMb],
      ['inodes', l.inodes],
      ['bandwidth_gb', l.bandwidthGbMonth],
      ['processes', l.maxProcesses],
      ['memory_mb', l.memoryMb],
      ['db_count', Number(plan.quotas.dbCount)],
      ['backup_count', Number(plan.quotas.backupCount ?? 7)],
      ['backup_gb', Number(plan.quotas.backupGb ?? 5)],
    ];
    await this.db.withPlatformScope(async (c) => {
      const site = (await c.query(`SELECT org_id FROM hosting.sites WHERE id = $1`, [siteId]))
        .rows[0];
      if (!site) return;
      for (const [dim, limit] of rows)
        await c.query(
          `INSERT INTO hosting.site_quotas (site_id, org_id, dim, limit_value, soft_limit) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (site_id, dim) DO UPDATE SET limit_value = EXCLUDED.limit_value, soft_limit = EXCLUDED.soft_limit, state = 'ok', enforced_at = now()`,
          [siteId, site.org_id, dim, limit, Math.floor(limit * soft)],
        );
    });
  }

  /* ───────────── delete (offboarding request) ───────────── */
  async requestDelete(
    orgId: string,
    actor: Caller,
    id: string,
    confirm: string | undefined,
  ): Promise<{ operationId: string; site: SiteDto }> {
    const site = await this.row(orgId, id);
    if (confirm !== site.name)
      throw new ProblemException(
        'validation_failed',
        'send the site name in the X-Confirm-Delete header to confirm',
      );
    if (site.status === 'deleting' || site.status === 'deleted')
      return { operationId: site.operation_id as string, site: await this.get(orgId, id) };
    if (site.status === 'creating' || site.status === 'restoring')
      throw new ProblemException(
        'site_not_active',
        `a ${site.status as string} site cannot be deleted yet`,
      );
    const hold = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id FROM audit.legal_holds WHERE status = 'active' AND (org_id = $1 OR org_id IS NULL) AND (dataset IS NULL OR dataset = ANY($2::text[])) LIMIT 1`,
            [orgId, ['hosting.sites', 'hosting.site_backups']],
          )
        ).rows[0],
    );
    if (hold)
      throw new ProblemException(
        'legal_hold_active',
        'the site or its backups are under a legal hold',
      );
    const op = await this.ops.create(orgId, {
      kind: KIND.delete,
      input: { siteId: id },
      resourceKind: 'hosting_site',
      resourceId: id,
      createdBy: actor.userId,
      maxAttempts: 8,
    });
    const exportUntil = new Date(this.clock().getTime() + this.cfg.exportWindowDays * 86_400_000);
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `UPDATE hosting.sites SET status = 'deleting', deletion_requested_at = now(), export_until = $3, operation_id = $2, version = version + 1, updated_at = now() WHERE id = $1`,
        [id, op.id, exportUntil],
      ),
    );
    await this.db.withOrg(orgId, (c) =>
      c.query(`UPDATE platform.operations SET next_run_at = $2 WHERE id = $1`, [
        op.id,
        exportUntil,
      ]),
    ); // the wipe starts when the export window ends
    await this.audit.record({
      action: 'hosting.site.delete.requested',
      actorUserId: actor.userId,
      actorType: 'user',
      orgId,
      resource: { type: 'hosting_site', id },
      outcome: 'success',
    });
    this.kick(orgId, op.id);
    return { operationId: op.id, site: await this.get(orgId, id) };
  }

  /* ───────────── staff: cross-org reads and suspension ───────────── */
  async adminList(
    staffId: string,
    q: {
      orgId?: string;
      nodeId?: string;
      status?: string;
      q?: string;
      limit: number;
      cursor?: string;
    },
  ) {
    const cur = decodeTimeCursor(q.cursor);
    const out = await this.db.withPlatformScope(async (c) => {
      const rows = (
        await c.query(
          `${STAFF_SELECT}
            WHERE ($1::uuid IS NULL OR s.org_id = $1) AND ($2::text IS NULL OR s.status = $2) AND ($3::text IS NULL OR s.name ILIKE '%' || $3 || '%' OR s.node_name = $3)
              AND ($4::timestamptz IS NULL OR (s.created_at, s.id) < ($4::timestamptz, $5::uuid)) AND ($7::uuid IS NULL OR s.node_id = $7) ORDER BY s.created_at DESC, s.id DESC LIMIT $6`,
          [
            q.orgId ?? null,
            q.status ?? null,
            q.q ?? null,
            cur?.t ?? null,
            cur?.id ?? null,
            q.limit + 1,
            q.nodeId ?? null,
          ],
        )
      ).rows;
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return {
        items: await this.decorate(c, page, true),
        nextCursor:
          rows.length > q.limit && last
            ? encodeTimeCursor(last.created_at as Date, last.id as string)
            : null,
      };
    });
    await this.audit.record({
      action: 'hosting.admin.cross_org_read',
      actorUserId: staffId,
      actorType: 'user',
      resource: { type: 'hosting_site' },
      outcome: 'success',
      detail: {
        filter: { orgId: q.orgId ?? null, status: q.status ?? null, q: q.q ? 'set' : null },
        count: out.items.length,
      },
    });
    return out;
  }
  async adminGet(staffId: string | null, id: string): Promise<SiteDto> {
    if (!UUID.test(id)) throw new ProblemException('not_found', 'site not found');
    const r = await this.db.withPlatformScope(async (c) => {
      const row = (await c.query(`${STAFF_SELECT} WHERE s.id = $1`, [id])).rows[0];
      if (!row) throw new ProblemException('not_found', 'site not found');
      return (await this.decorate(c, [row], true))[0]!;
    });
    if (staffId)
      await this.audit.record({
        action: 'hosting.admin.cross_org_read',
        actorUserId: staffId,
        actorType: 'user',
        orgId: r.orgId,
        resource: { type: 'hosting_site', id },
        outcome: 'success',
      });
    return r;
  }

  /**
   * Staff suspension / reinstatement (SI-M06-3: `PATCH /v1/admin/hosting/sites/{id}`; a reason is required). `by` records who: admin | abuse | dunning | quota.
   * The node must confirm before the database says so (nothing is changed on an uncertain answer).
   */
  async setSuspended(
    staffId: string | null,
    id: string,
    suspend: boolean,
    by: 'admin' | 'abuse' | 'dunning' | 'quota',
    reason: string,
  ): Promise<SiteDto> {
    if (reason.trim().length < 5 || reason.length > 200)
      throw new ProblemException('validation_failed', 'a reason of 5..200 characters is required');
    const site = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT s.*, n.compute_instance_id FROM hosting.sites s LEFT JOIN hosting.nodes n ON n.id = s.node_id WHERE s.id = $1`,
            [id],
          )
        ).rows[0],
    );
    if (!site) throw new ProblemException('not_found', 'site not found');
    const orgId = site.org_id as string;
    if (suspend && site.status !== 'active')
      throw new ProblemException('site_not_active', 'only an active site can be suspended');
    if (!suspend && site.status !== 'suspended')
      throw new ProblemException('conflict', 'the site is not suspended');
    const t = {
      idempotencyToken: tokenFor(
        orgId,
        `${id}:${suspend ? 's' : 'r'}:${site.version as number}`,
        suspend ? 'suspend' : 'resume',
      ),
      operationId: `susp-${id}-${site.version as number}`,
    };
    const ref = {
      nodeId: site.node_id as string,
      computeInstanceId: site.compute_instance_id as string,
    };
    const r = suspend
      ? await this.adapter.suspendSite(this.ctx(t.operationId), ref, site.node_name as string, t)
      : await this.adapter.resumeSite(this.ctx(t.operationId), ref, site.node_name as string, t);
    if (r.status !== 'succeeded')
      throw new ProblemException(
        'service_unavailable',
        'the node did not confirm the change; nothing was changed',
      );
    await this.db.withPlatformScope((c) =>
      suspend
        ? c.query(
            `UPDATE hosting.sites SET status = 'suspended', suspended_by = $2, suspension_reason = $3, version = version + 1, updated_at = now() WHERE id = $1`,
            [id, by, reason],
          )
        : c.query(
            `UPDATE hosting.sites SET status = 'active', suspended_by = NULL, suspension_reason = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
            [id],
          ),
    );
    await this.audit.record({
      action: suspend ? 'hosting.site.suspended' : 'hosting.site.resumed',
      actorUserId: staffId ?? undefined,
      actorType: staffId ? 'user' : 'system',
      orgId,
      resource: { type: 'hosting_site', id },
      outcome: 'success',
      detail: { by, reason },
    });
    return this.adminGet(null, id);
  }
}
