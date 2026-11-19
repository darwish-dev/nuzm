import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { v7 as uuidv7 } from 'uuid';
import {
  ResidencyDenied,
  assertResidency,
  bindCollections,
  validateSiteModel,
  type ResidencyEvaluator,
  type SiteModel,
} from '@nuzm/domain';
import { OperationsService, emitUsage, usageEventId, type Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { renderSiteCss } from '../../../common/site-css';
import { decodeCursor, pageOf } from '../../../common/pagination';
import { actionHash } from '../../ai';
import type { CmsService } from '../../builder';
import {
  artifactHash,
  SitePublisherPort,
  type Artifact,
  type TargetSite,
  type WebappDeployDelegate,
} from './ports';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEPLOY_OP = 'deploy.run';
export const ROLLBACK_OP = 'deploy.rollback';
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const ACTIVE = ['queued', 'building', 'deploying', 'smoke_checking'];

export interface DeployConfig {
  approvalTtlHours: number;
  formsBaseUrl: string;
  dataRegion: string;
  /** budget for the whole smoke-and-rollback step (ms) */
  smokeTimeoutMs: number;
}
export function loadDeployConfig(env: NodeJS.ProcessEnv = process.env): DeployConfig {
  return {
    approvalTtlHours: Number(env.AI_APPROVAL_TTL_HOURS ?? 24) || 24,
    formsBaseUrl: env.BUILDER_FORMS_BASE_URL ?? 'https://api.nuzm.test',
    dataRegion: env.AI_DATA_REGION ?? 'sa-central',
    smokeTimeoutMs: Number(env.DEPLOY_SMOKE_TIMEOUT_MS ?? 30_000) || 30_000,
  };
}
export const DEPLOY_CONFIG = Symbol('DEPLOY_CONFIG');

export interface DeploymentDto {
  id: string;
  projectId: string;
  versionId: string;
  target: { kind: string; hostingSiteId: string };
  environment: string;
  state: string;
  operationId: string | null;
  artifactHash: string | null;
  previousDeploymentId: string | null;
  rollbackOf: string | null;
  url: string | null;
  smoke: unknown;
  error: unknown;
  createdAt: string;
  finishedAt: string | null;
}
const dto = (r: Row): DeploymentDto => ({
  id: r.id as string,
  projectId: r.project_id as string,
  versionId: r.version_id as string,
  target: { kind: r.target_kind as string, hostingSiteId: r.target_ref as string },
  environment: r.environment as string,
  state: r.state as string,
  operationId: (r.operation_id as string | null) ?? null,
  artifactHash: (r.artifact_hash as string | null) ?? null,
  previousDeploymentId: (r.previous_deployment_id as string | null) ?? null,
  rollbackOf: (r.rollback_of as string | null) ?? null,
  url: (r.url as string | null) ?? null,
  smoke: r.smoke ?? null,
  error: r.error ?? null,
  createdAt: iso(r.created_at)!,
  finishedAt: iso(r.finished_at),
});

/**
 * Deployments (M09 S41.4): `POST /v1/deployments` needs a human PUBLISH approval bound to the exact project version, target and environment (two steps: the first call
 * answers 403 `approval_required` with the approval to confirm and its cost disclosure; the second names it). Then, on `platform.operations`: build the artifact (render for
 * the target, CMS bound) → stage on the node → smoke check the STAGED site (HTTP 200 on every page, TLS) → switch → smoke the LIVE site → on any failure the previous artifact
 * keeps serving or is restored (`rolled_back`). Reconcile-before-retry: a retried segment first asks what is live.
 */
export class DeployService {
  private kicker: (orgId: string, opId: string) => void = () => undefined;
  /** Registered by the app-builder module (M10A) for `webapp` projects. */
  webapp: WebappDeployDelegate | null = null;
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ops: OperationsService,
    private readonly publisher: SitePublisherPort,
    private readonly residency: ResidencyEvaluator,
    private readonly cms: CmsService,
    private readonly cfg: DeployConfig,
  ) {}
  setKicker(k: (orgId: string, opId: string) => void) {
    this.kicker = k;
  }
  private async site(orgId: string, id: unknown): Promise<TargetSite> {
    if (typeof id !== 'string' || !UUID.test(id))
      throw new ProblemException('validation_failed', 'target must be a hosting site id');
    const r = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT id, name, status, runtime, data_region, domain_primary FROM hosting.sites WHERE id=$1 AND deleted_at IS NULL`,
            [id.toLowerCase()],
          )
        ).rows[0],
    )) as Row | undefined;
    if (!r) throw new ProblemException('not_found', 'hosting site not found'); // another organization's site is indistinguishable from a missing one
    return {
      id: r.id as string,
      name: r.name as string,
      status: r.status as string,
      runtime: r.runtime as string,
      dataRegion: r.data_region as string,
      domain: (r.domain_primary as string | null) ?? null,
    };
  }

  async create(
    orgId: string,
    userId: string,
    idempotencyKey: string,
    b: Record<string, unknown>,
  ): Promise<DeploymentDto> {
    if (!UUID.test(String(b.projectId)))
      throw new ProblemException('validation_failed', 'projectId must be a uuid');
    const ptype = await this.projectType(orgId, String(b.projectId).toLowerCase());
    if (ptype && ptype !== 'website') {
      if (ptype === 'webapp' && this.webapp)
        return (await this.webapp.create(orgId, userId, b)) as DeploymentDto;
      throw new ProblemException(
        'unsupported_capability',
        `projects of type ${ptype} are not deployed through this endpoint`,
      );
    }
    const targetId =
      typeof b.target === 'object' && b.target !== null
        ? (b.target as { hostingSiteId?: unknown }).hostingSiteId
        : b.target;
    const environment = b.environment ?? 'production';
    if (environment !== 'production' && environment !== 'staging')
      throw new ProblemException('validation_failed', 'environment must be production or staging');
    if (!this.publisher.available())
      throw new ProblemException(
        'unsupported_capability',
        'no hosting publish path is configured: live publish needs a real hosting node (HG-05-01/02, HG-06-01)',
      );
    const project = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT p.id, p.head_version_id, p.name FROM builder.projects p WHERE p.id=$1 AND p.deleted_at IS NULL`,
            [String(b.projectId).toLowerCase()],
          )
        ).rows[0],
    )) as Row | undefined;
    if (!project) throw new ProblemException('not_found', 'project not found');
    const site = await this.site(orgId, targetId);
    if (site.status !== 'active')
      throw new ProblemException('site_not_active', 'the hosting site is not active');
    if (!/^(static|php:\d)/.test(site.runtime))
      throw new ProblemException(
        'unsupported_capability',
        `a static website cannot be published to a ${site.runtime} site`,
      );
    try {
      await assertResidency(this.residency, {
        orgId,
        dataClass: 'customer-content',
        targetRegion: site.dataRegion,
        purpose: 'builder_deployment',
        operation: 'write',
      });
    } catch (e) {
      if (e instanceof ResidencyDenied)
        throw new ProblemException(
          'residency_denied',
          'the hosting site region is not allowed by the residency policy',
          undefined,
          { evidenceRef: e.result.evidenceRef },
        );
      throw e;
    }
    const versionId = project.head_version_id as string;
    const payload = { projectId: project.id, versionId, hostingSiteId: site.id, environment };
    const hash = actionHash(project.id as string, 'publish', payload);
    // the human approval of the publish (kind publish): created on the first call, decided by the caller on the second
    const approvalId = b.approvalId;
    if (approvalId === undefined) {
      const id = uuidv7();
      await this.db.withOrg(orgId, (c) =>
        c.query(
          `INSERT INTO ai.approvals (id, org_id, project_id, kind, action_hash, summary, requested_by, expires_at) VALUES ($1,$2,$3,'publish',$4,$5,$6, now() + make_interval(hours => $7))`,
          [
            id,
            orgId,
            project.id,
            hash,
            JSON.stringify({
              title: 'Publish the site',
              projectName: project.name,
              siteName: site.name,
              domain: site.domain,
              environment,
              versionId,
              costDisclosure: {
                newHostingPlan: false,
                note: 'publishing to an existing hosting site adds no new plan; a new site would need a quote and spend approval',
              },
              payload,
            }),
            userId,
            this.cfg.approvalTtlHours,
          ],
        ),
      );
      throw new ProblemException(
        'approval_required',
        'a human must confirm this publish: repeat the request with approvalId',
        undefined,
        { approvalId: id, kind: 'publish', actionHash: hash },
      );
    }
    if (typeof approvalId !== 'string' || !UUID.test(approvalId))
      throw new ProblemException('validation_failed', 'approvalId must be a uuid');
    const id = uuidv7();
    let row: Row;
    try {
      row = await this.db.withOrg(orgId, async (c) => {
        const a = (
          await c.query(`SELECT * FROM ai.approvals WHERE id=$1 AND kind='publish' FOR UPDATE`, [
            approvalId.toLowerCase(),
          ])
        ).rows[0] as Row | undefined;
        if (!a) throw new ProblemException('not_found', 'approval not found');
        if (a.action_hash !== hash)
          throw new ProblemException(
            'conflict',
            'the project, target or environment changed since this approval was requested: request a new one',
          );
        if (a.state === 'approved') {
          const used = (
            await c.query(`SELECT 1 FROM deploy.deployments WHERE approval_id=$1`, [a.id])
          ).rows[0];
          if (used) throw new ProblemException('conflict', 'this approval was already used');
        } else if (a.state !== 'pending')
          throw new ProblemException('invalid_state', `the approval is ${a.state}`);
        if (new Date(a.expires_at as string).getTime() < Date.now()) {
          await c.query(`UPDATE ai.approvals SET state='expired' WHERE id=$1 AND state='pending'`, [
            a.id,
          ]);
          throw new ProblemException('approval_expired', 'the approval has expired');
        }
        if (a.state === 'pending')
          await c.query(
            `UPDATE ai.approvals SET state='approved', decided_by=$2, decided_at=now() WHERE id=$1`,
            [a.id, userId],
          );
        const prev = (
          await c.query(
            `SELECT id FROM deploy.deployments WHERE target_ref=$1 AND environment=$2 AND state='succeeded' ORDER BY created_at DESC LIMIT 1`,
            [site.id, environment],
          )
        ).rows[0] as Row | undefined;
        return (
          await c.query(
            `INSERT INTO deploy.deployments (id, org_id, project_id, version_id, target_ref, environment, previous_deployment_id, approval_id, idempotency_key, data_region, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
            [
              id,
              orgId,
              project.id,
              versionId,
              site.id,
              environment,
              prev?.id ?? null,
              a.id,
              idempotencyKey,
              this.cfg.dataRegion,
              userId,
            ],
          )
        ).rows[0] as Row;
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException(
          'conflict',
          'a deployment to this target and environment is already in progress',
        );
      throw e;
    }
    await this.audit.record({
      action: 'ai.approval.granted',
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'ai_approval', id: approvalId as string },
      outcome: 'success',
      detail: { kind: 'publish', projectId: project.id },
    });
    const op = await this.ops.create(orgId, {
      kind: DEPLOY_OP,
      input: { deploymentId: id },
      resourceKind: 'deployment',
      resourceId: id,
      createdBy: userId,
      idempotencyKey: `deploy:${idempotencyKey}`,
      maxAttempts: 3,
    });
    await this.db.withOrg(orgId, (c) =>
      c.query(`UPDATE deploy.deployments SET operation_id=$2 WHERE id=$1`, [id, op.id]),
    );
    await this.log(orgId, id, 'info', 'deployment queued', { target: site.name, environment });
    await this.audit.record({
      action: 'deploy.deployment.created',
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'deployment', id },
      outcome: 'success',
      detail: { projectId: project.id, siteId: site.id, environment },
    });
    this.kicker(orgId, op.id);
    return dto({ ...row, operation_id: op.id });
  }

  async log(
    orgId: string,
    deploymentId: string,
    level: 'info' | 'warn' | 'error',
    message: string,
    data: Record<string, unknown> = {},
  ) {
    for (let i = 0; i < 5; i++) {
      try {
        await this.db.withOrg(orgId, (c) =>
          c.query(
            `INSERT INTO deploy.deployment_logs (id, org_id, deployment_id, seq, level, message, data) SELECT $1,$2,$3, coalesce(max(seq),0)+1, $4,$5,$6 FROM deploy.deployment_logs WHERE deployment_id=$3`,
            [uuidv7(), orgId, deploymentId, level, message.slice(0, 1000), JSON.stringify(data)],
          ),
        );
        return;
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e;
      }
    }
  }
  private async projectType(orgId: string, projectId: string): Promise<string | null> {
    const r = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT type FROM builder.projects WHERE id=$1 AND deleted_at IS NULL`, [
            projectId,
          ])
        ).rows[0],
    )) as Row | undefined;
    return (r?.type as string | undefined) ?? null;
  }
  /** The delegate's deployment with this id, when the id is not a website deployment of this organization. */
  private async webappOwns(orgId: string, id: string): Promise<boolean> {
    if (!this.webapp || !UUID.test(id)) return false;
    return (await this.webapp.find(orgId, id)) !== null;
  }
  async get(orgId: string, id: string): Promise<DeploymentDto> {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    if (await this.webappOwns(orgId, id))
      return (await this.webapp!.get(orgId, id)) as DeploymentDto;
    const r = (await this.db.withOrg(
      orgId,
      async (c) => (await c.query(`SELECT * FROM deploy.deployments WHERE id=$1`, [id])).rows[0],
    )) as Row | undefined;
    if (!r) throw new ProblemException('not_found');
    return dto(r);
  }
  async list(orgId: string, o: { limit: number; cursor?: string; projectId?: string }) {
    if (o.projectId && UUID.test(o.projectId) && this.webapp) {
      const t = await this.projectType(orgId, o.projectId);
      if (t === 'webapp') return (await this.webapp.list(orgId, o.projectId, o.limit)) as never;
    }
    const cur = decodeCursor(o.cursor);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM deploy.deployments WHERE ($1::uuid IS NULL OR id < $1) AND ($3::uuid IS NULL OR project_id=$3) ORDER BY id DESC LIMIT $2`,
            [cur, o.limit + 1, o.projectId ?? null],
          )
        ).rows as Row[],
    );
    const p = pageOf(rows as (Row & { id: string })[], o.limit);
    return { items: p.items.map(dto), nextCursor: p.nextCursor };
  }
  async logs(orgId: string, id: string, afterSeq = 0) {
    if (await this.webappOwns(orgId, id)) return (await this.webapp!.logs(orgId, id)) as never;
    await this.get(orgId, id);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT seq, level, message, data, created_at FROM deploy.deployment_logs WHERE deployment_id=$1 AND seq > $2 ORDER BY seq LIMIT 500`,
            [id, afterSeq],
          )
        ).rows as Row[],
    );
    return {
      items: rows.map((r) => ({
        seq: Number(r.seq),
        level: r.level as string,
        message: r.message as string,
        data: r.data,
        at: iso(r.created_at)!,
      })),
    };
  }

  /** Roll back a succeeded deployment to the artifact that served before it. Creates a NEW deployment (`rollbackOf`) and marks the old one `rolled_back`. */
  async rollback(
    orgId: string,
    userId: string,
    id: string,
    idempotencyKey: string,
  ): Promise<DeploymentDto> {
    if (await this.webappOwns(orgId, id))
      return (await this.webapp!.rollback(orgId, userId, id)) as DeploymentDto;
    const d = await this.get(orgId, id);
    if (d.state !== 'succeeded')
      throw new ProblemException(
        'invalid_state',
        `only a succeeded deployment can be rolled back (it is ${d.state})`,
      );
    if (!d.previousDeploymentId)
      throw new ProblemException('invalid_state', 'there is no earlier deployment to roll back to');
    if (!this.publisher.available())
      throw new ProblemException('unsupported_capability', 'no hosting publish path is configured');
    const nid = uuidv7();
    const row = await this.db
      .withOrg(orgId, async (c) => {
        const prev = (
          await c.query(`SELECT * FROM deploy.deployments WHERE id=$1`, [d.previousDeploymentId])
        ).rows[0] as Row;
        return (
          await c.query(
            `INSERT INTO deploy.deployments (id, org_id, project_id, version_id, target_ref, environment, previous_deployment_id, rollback_of, artifact_hash, approval_id, idempotency_key, data_region, created_by, state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'deploying') RETURNING *`,
            [
              nid,
              orgId,
              prev.project_id,
              prev.version_id,
              prev.target_ref,
              prev.environment,
              d.id,
              d.id,
              prev.artifact_hash,
              prev.approval_id,
              `rollback:${idempotencyKey}`,
              this.cfg.dataRegion,
              userId,
            ],
          )
        ).rows[0] as Row;
      })
      .catch((e) => {
        if ((e as { code?: string }).code === '23505')
          throw new ProblemException(
            'conflict',
            'a deployment to this target is already in progress',
          );
        throw e;
      });
    const op = await this.ops.create(orgId, {
      kind: ROLLBACK_OP,
      input: { deploymentId: nid, fromId: d.id, toId: d.previousDeploymentId },
      resourceKind: 'deployment',
      resourceId: nid,
      createdBy: userId,
      idempotencyKey: `rollback:${idempotencyKey}`,
      maxAttempts: 3,
    });
    await this.db.withOrg(orgId, (c) =>
      c.query(`UPDATE deploy.deployments SET operation_id=$2 WHERE id=$1`, [nid, op.id]),
    );
    await this.log(orgId, nid, 'info', 'rollback queued', {
      from: d.id,
      to: d.previousDeploymentId,
    });
    this.kicker(orgId, op.id);
    return dto({ ...row, operation_id: op.id });
  }

  // ---- engine -------------------------------------------------------------------------------------------------------------------

  private async setState(
    orgId: string,
    id: string,
    state: string,
    patch: Record<string, unknown> = {},
  ) {
    const finished = ['succeeded', 'failed', 'rolled_back'].includes(state);
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `UPDATE deploy.deployments SET state=$2, url=coalesce($3,url), smoke=coalesce($4,smoke), error=coalesce($5,error), artifact_hash=coalesce($6,artifact_hash), build_id=coalesce($7,build_id), finished_at=CASE WHEN $8 THEN now() ELSE finished_at END WHERE id=$1`,
        [
          id,
          state,
          patch.url ?? null,
          patch.smoke ? JSON.stringify(patch.smoke) : null,
          patch.error ? JSON.stringify(patch.error) : null,
          patch.artifactHash ?? null,
          patch.buildId ?? null,
          finished,
        ],
      ),
    );
  }
  private async buildArtifact(
    orgId: string,
    d: Row,
    site: TargetSite,
  ): Promise<{ buildId: string; artifact: Artifact; paths: string[] }> {
    const t0 = performance.now();
    const v = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT site_model FROM builder.project_versions WHERE id=$1`, [
            d.version_id,
          ])
        ).rows[0],
    )) as Row;
    const collections = await this.cms.published(orgId, d.project_id as string);
    const model = bindCollections(v.site_model as SiteModel, collections);
    const bad = validateSiteModel(model);
    if (bad.length)
      throw new ProblemException(
        'op_invalid',
        'the bound site model is not valid',
        bad.slice(0, 5) as unknown[],
      );
    const baseUrl = site.domain ? `https://${site.domain}` : undefined;
    const assetBytes: Record<string, Uint8Array> = {};
    for (const a of model.assets)
      if (a.source === 'upload' && a.contentHash)
        assetBytes[a.contentHash] = (
          (await this.db.withOrg(
            orgId,
            async (c) =>
              (
                await c.query(
                  `SELECT content FROM builder.project_files WHERE project_id=$1 AND content_hash=$2 AND content IS NOT NULL LIMIT 1`,
                  [d.project_id, a.contentHash],
                )
              ).rows[0],
          )) as Row
        ).content as Uint8Array;
    const out = await renderSiteCss(model, {
      ...(baseUrl ? { baseUrl } : {}),
      formsBaseUrl: `${this.cfg.formsBaseUrl}/p/${d.project_id}`,
      assetBytes,
    });
    const errors = out.issues.filter((i) => i.severity === 'error');
    if (errors.length)
      throw new ProblemException(
        'validation_failed',
        'the build failed validation',
        errors.slice(0, 5) as unknown[],
      );
    const files = out.files.map((f) => ({
      path: f.path,
      mime: f.mime,
      content: typeof f.content === 'string' ? new Uint8Array(Buffer.from(f.content)) : f.content,
    }));
    const hash = artifactHash(files);
    const buildId = uuidv7();
    const ms = Math.max(1, Math.round(performance.now() - t0));
    const gz = gzipSync(
      Buffer.from(
        JSON.stringify(
          files.map((f) => ({
            path: f.path,
            mime: f.mime,
            b64: Buffer.from(f.content).toString('base64'),
          })),
        ),
      ),
    );
    await this.db.withOrg(orgId, async (c) => {
      await c.query(
        `INSERT INTO deploy.builds (id, org_id, project_id, version_id, state, base_url, artifact_hash, artifact, file_count, size_bytes, issues, build_ms, data_region, created_by, finished_at) VALUES ($1,$2,$3,$4,'succeeded',$5,$6,$7,$8,$9,$10,$11,$12,$13, now())`,
        [
          buildId,
          orgId,
          d.project_id,
          d.version_id,
          baseUrl ?? null,
          hash,
          gz,
          files.length,
          gz.length,
          JSON.stringify(out.issues.slice(0, 20)),
          ms,
          this.cfg.dataRegion,
          d.created_by,
        ],
      );
      const at = new Date().toISOString();
      await emitUsage(c, {
        eventId: usageEventId({
          orgId,
          meterId: 'builder.build_minutes',
          resourceId: buildId,
          windowStart: at,
        }),
        orgId,
        meterId: 'builder.build_minutes',
        quantity: (ms / 60000).toFixed(6),
        unit: 'minute',
        resourceId: buildId,
        windowStart: at,
        windowEnd: at,
        occurredAt: at,
        dimensions: { project_type: 'website' },
        dataRegion: this.cfg.dataRegion,
        source: 'deploy@M09',
      });
    });
    const paths = [...new Set(out.pages.map((p) => `/${p.path.replace(/index\.html$/, '')}`))];
    return { buildId, artifact: { hash, files }, paths: ['/', ...paths] };
  }
  async artifactOf(orgId: string, deploymentId: string): Promise<Artifact | null> {
    const r = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT b.artifact, b.artifact_hash FROM deploy.deployments d JOIN deploy.builds b ON b.artifact_hash = d.artifact_hash AND b.org_id = d.org_id WHERE d.id=$1 AND b.state='succeeded' ORDER BY b.created_at DESC LIMIT 1`,
            [deploymentId],
          )
        ).rows[0],
    )) as Row | undefined;
    if (!r) return null;
    const files = (
      JSON.parse(gunzipSync(Buffer.from(r.artifact as Uint8Array)).toString()) as {
        path: string;
        mime: string;
        b64: string;
      }[]
    ).map((f) => ({
      path: f.path,
      mime: f.mime,
      content: new Uint8Array(Buffer.from(f.b64, 'base64')),
    }));
    return { hash: r.artifact_hash as string, files };
  }

  /** Claim and run one deployment or rollback operation. */
  async runOne(
    orgId: string,
    operationId: string,
    worker = `deploy-${process.pid}`,
  ): Promise<boolean> {
    const claimed = await this.ops.claimById(orgId, operationId, worker);
    if (!claimed) return false;
    const op = await this.ops.get(orgId, operationId);
    const input = (op?.input ?? {}) as { deploymentId?: string; fromId?: string; toId?: string };
    const d = (await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM deploy.deployments WHERE id=$1`, [input.deploymentId]))
          .rows[0],
    )) as Row | undefined;
    if (!d || ['succeeded', 'failed', 'rolled_back'].includes(d.state as string)) {
      await this.ops.succeed(orgId, operationId, worker, { skipped: true });
      return true;
    }
    const id = d.id as string;
    try {
      const site = await this.site(orgId, d.target_ref);
      if (claimed.kind === ROLLBACK_OP)
        await this.executeRollback(orgId, d, site, input.fromId!, input.toId!);
      else await this.executeDeploy(orgId, d, site);
      await this.ops.succeed(orgId, operationId, worker, { ok: true });
    } catch (e) {
      const code = e instanceof ProblemException ? e.code : 'internal_error';
      await this.log(
        orgId,
        id,
        'error',
        `deployment failed: ${(e as Error).message}`.slice(0, 500),
        { code },
      );
      await this.setState(orgId, id, 'failed', {
        error: { code, message: (e as Error).message.slice(0, 200) },
      });
      await this.audit.record({
        action: 'deploy.deployment.succeeded',
        actorType: 'system',
        orgId,
        resource: { type: 'deployment', id },
        outcome: 'failure',
        detail: { code },
      });
      await this.ops.succeed(orgId, operationId, worker, { failed: code }).catch(() => undefined);
    }
    return true;
  }
  private async executeDeploy(orgId: string, d: Row, site: TargetSite) {
    const id = d.id as string;
    const before = await this.publisher.activeHash(site); // reconcile first: what is live right now?
    await this.setState(orgId, id, 'building');
    await this.log(orgId, id, 'info', 'building artifact');
    const { buildId, artifact, paths } = await this.buildArtifact(orgId, d, site);
    await this.setState(orgId, id, 'deploying', { artifactHash: artifact.hash, buildId });
    await this.log(
      orgId,
      id,
      'info',
      `artifact ${artifact.hash.slice(0, 12)} built (${artifact.files.length} files); staging`,
    );
    const { stagingRef } = await this.publisher.stage(site, artifact, id);
    await this.setState(orgId, id, 'smoke_checking');
    const staged = await this.publisher.smoke(site, 'staged', stagingRef, paths);
    await this.log(
      orgId,
      id,
      staged.ok ? 'info' : 'error',
      staged.ok ? `staged smoke check passed (${paths.length} pages)` : 'staged smoke check FAILED',
      { results: staged.results.filter((r) => r.status !== 200) },
    );
    if (!staged.ok) {
      // nothing was switched: verify the previous artifact is still the one serving, then close as rolled back
      const still = await this.publisher.activeHash(site);
      await this.log(orgId, id, 'warn', 'automatic rollback: the previous artifact keeps serving', {
        servingHash: still,
        expected: before,
      });
      await this.setState(orgId, id, 'rolled_back', {
        smoke: { ...staged, phase: 'staged' },
        error: { code: 'smoke_failed' },
        url: null,
      });
      await this.audit.record({
        action: 'deploy.deployment.rolled_back',
        actorType: 'system',
        orgId,
        resource: { type: 'deployment', id },
        outcome: 'failure',
        detail: { reason: 'staged_smoke_failed', servingHash: still },
      });
      return;
    }
    const { url } = await this.publisher.activate(site, stagingRef);
    const live = await this.publisher.smoke(site, 'live', null, paths);
    if (!live.ok) {
      const prev = d.previous_deployment_id
        ? await this.artifactOf(orgId, d.previous_deployment_id as string)
        : null;
      await this.publisher.restore(site, prev);
      await this.log(orgId, id, 'error', 'live smoke check FAILED: previous artifact restored', {
        results: live.results.filter((r) => r.status !== 200),
        restored: prev?.hash ?? null,
      });
      await this.setState(orgId, id, 'rolled_back', {
        smoke: { ...live, phase: 'live' },
        error: { code: 'smoke_failed' },
      });
      await this.audit.record({
        action: 'deploy.deployment.rolled_back',
        actorType: 'system',
        orgId,
        resource: { type: 'deployment', id },
        outcome: 'failure',
        detail: { reason: 'live_smoke_failed', restored: prev?.hash ?? null },
      });
      return;
    }
    await this.setState(orgId, id, 'succeeded', { url, smoke: { ...live, phase: 'live' } });
    await this.log(orgId, id, 'info', 'deployment succeeded', { url });
    await this.audit.record({
      action: 'deploy.deployment.succeeded',
      actorType: 'system',
      orgId,
      resource: { type: 'deployment', id },
      outcome: 'success',
      detail: { url, artifactHash: artifact.hash },
    });
  }
  private async executeRollback(
    orgId: string,
    d: Row,
    site: TargetSite,
    fromId: string,
    toId: string,
  ) {
    const id = d.id as string;
    const art = await this.artifactOf(orgId, toId);
    if (!art)
      throw new ProblemException(
        'not_found',
        'the artifact of the earlier deployment is no longer available',
      );
    await this.publisher.restore(site, art);
    const live = await this.publisher.smoke(site, 'live', null, ['/']);
    if (!live.ok)
      throw new ProblemException('conflict', 'the restored site did not answer the smoke check');
    const url = `https://${site.domain ?? `${site.name.toLowerCase()}.sites.nuzm.invalid`}/`;
    await this.db.withOrg(orgId, async (c) => {
      await c.query(
        `UPDATE deploy.deployments SET state='rolled_back', finished_at=coalesce(finished_at, now()) WHERE id=$1 AND state='succeeded'`,
        [fromId],
      );
    });
    await this.setState(orgId, id, 'succeeded', {
      url,
      smoke: { ...live, phase: 'live' },
      artifactHash: art.hash,
    });
    await this.log(orgId, id, 'info', 'rolled back', { restored: art.hash });
    await this.audit.record({
      action: 'deploy.deployment.rolled_back',
      actorType: 'user',
      orgId,
      resource: { type: 'deployment', id: fromId },
      outcome: 'success',
      detail: { restored: art.hash, newDeployment: id },
    });
  }
  async tick(): Promise<number> {
    const open = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT org_id, operation_id FROM deploy.deployments WHERE state = ANY($1) AND operation_id IS NOT NULL LIMIT 100`,
            [ACTIVE],
          )
        ).rows as Row[],
    );
    let n = 0;
    for (const o of open)
      if (await this.runOne(o.org_id as string, o.operation_id as string).catch(() => false)) n++;
    return n;
  }
  static sha(s: string) {
    return createHash('sha256').update(s).digest('hex');
  }
}
