import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';
import type { ResidencyService } from '../../compliance';
import { MARKETPLACE_FLAG, badRequest, hint, isUuid, iso, pgCode, type Row } from './model';
import { ArtifactStore, ProjectInstallPort } from './ports';
import { satisfies } from './semver';

export interface InstallationDto {
  id: string;
  listingId: string;
  listingVersionId: string;
  entitlementId: string;
  targetType: 'workflow' | 'project';
  targetId: string | null;
  workspaceId: string | null;
  status: 'pending' | 'succeeded' | 'failed';
  error: unknown;
  createdAt: string;
}

/** Creates a workflow from a workflow template in the buyer's organization. Provided by the automation module's WorkflowService (a port so marketplace imports only its public surface). */
export type WorkflowTemplatePort = { createFromTemplate(orgId: string, actor: string, name: string, definition: unknown, source: { listingVersionId: string }): Promise<{ workflowId: string }> };

/**
 * Installing a purchased listing (M11 S53.5). The install is a COPY owned by the buyer: a new workflow / builder project with a new id and the buyer's org_id; nothing is shared with the publisher.
 * Gates, in order: feature flag → the version exists, is APPROVED and its listing PUBLISHED → the buyer holds an ACTIVE entitlement for the listing (RLS makes another organization's entitlements
 * invisible: the answer is `403 not_entitled`, never a different organization's data) whose version range covers the version and whose seats are not used up → the residency decision → copy.
 * The database refuses an installation row without an active entitlement of the same organization (trigger), so a bug above cannot install for the wrong tenant.
 */
export class InstallService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly artifacts: ArtifactStore,
    private readonly projects: ProjectInstallPort,
    private readonly workflows: WorkflowTemplatePort,
    private readonly residency: Pick<ResidencyService, 'evaluate'> | null,
    private readonly flags: { enabled(orgId: string | null, key: string): Promise<boolean> },
  ) {}

  private dto(r: Row): InstallationDto {
    return { id: r.id, listingId: r.listing_id, listingVersionId: r.listing_version_id, entitlementId: r.entitlement_id, targetType: r.target_type, targetId: r.target_id ?? null, workspaceId: r.workspace_id ?? null, status: r.status, error: r.error ?? null, createdAt: iso(r.created_at)! };
  }

  async create(orgId: string, actor: string, idempotencyKey: string, body: Record<string, unknown>): Promise<InstallationDto> {
    for (const k of Object.keys(body)) if (!['listingVersionId', 'workspaceId'].includes(k)) throw badRequest(`unknown field ${k}`);
    if (!(await this.flags.enabled(orgId, MARKETPLACE_FLAG))) throw new ProblemException('feature_disabled', 'the marketplace is not enabled for this organization');
    if (!isUuid(body.listingVersionId)) throw badRequest('listingVersionId is required');
    if (body.workspaceId !== undefined && !isUuid(body.workspaceId)) throw badRequest('workspaceId must be a uuid');
    const versionId = (body.listingVersionId as string).toLowerCase();
    const x = await this.db.withOrg(orgId, async (c) => {
      const v = (await c.query(`SELECT * FROM marketplace.listing_versions WHERE id = $1 AND (moderation_status = 'approved' OR org_id = $2)`, [versionId, orgId])).rows[0] as Row | undefined;
      const l = v ? ((await c.query(`SELECT * FROM marketplace.listings WHERE id = $1 AND (status = 'published' OR org_id = $2)`, [v.listing_id, orgId])).rows[0] as Row | undefined) : undefined;
      // entitlements are the buyer's own rows only (RLS): another organization's purchase cannot be seen, let alone used
      const e = l ? ((await c.query(`SELECT * FROM marketplace.entitlements_mkt WHERE org_id = $1 AND listing_id = $2 AND status = 'active'`, [orgId, l.id])).rows[0] as Row | undefined) : undefined;
      const used = e ? Number((await c.query(`SELECT count(*) n FROM marketplace.installations WHERE entitlement_id = $1 AND status <> 'failed'`, [e.id])).rows[0]!.n) : 0;
      return { v, l, e, used };
    });
    if (!x.v || !x.l) throw new ProblemException('not_found');
    const deny = (why: string) => new ProblemException('not_entitled', why);
    if (!x.e) throw deny('this organization holds no active entitlement for this listing');
    if (x.v.moderation_status !== 'approved' || x.l.status !== 'published') throw new ProblemException('not_purchasable', 'this version cannot be installed');
    if (!satisfies(x.v.version, x.e.version_range)) throw deny('the entitlement does not cover this version');
    if (x.e.licence === 'multi_seat' && x.used >= x.e.seats) throw deny('all seats of the licence are used');
    const target = x.l.type === 'workflow-template' ? 'workflow' : 'project';
    if (target === 'project' && !isUuid(body.workspaceId)) throw badRequest('workspaceId is required for website and app templates');
    if (this.residency) {
      const r = await this.residency.evaluate({ orgId, dataClass: 'customer-content', targetRegion: x.l.data_region, purpose: 'marketplace.install', operation: 'write' });
      if (r.decision === 'deny' || r.decision === 'requires_assessment') throw new ProblemException('residency_denied', 'the listing cannot be copied into this organization under its residency policy');
    }
    const id = uuidv7();
    try {
      await this.db.withOrg(orgId, (c) =>
        c.query(`INSERT INTO marketplace.installations (id, org_id, entitlement_id, listing_id, listing_version_id, target_type, workspace_id, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)`, [id, orgId, x.e!.id, x.l!.id, x.v!.id, target, (body.workspaceId as string | undefined)?.toLowerCase() ?? null, actor]),
      );
    } catch (e) {
      if (hint(e) === 'not_entitled') throw deny('no active entitlement');
      if (pgCode(e) === '23505') throw new ProblemException('conflict', 'this version is already installed in this workspace');
      throw e;
    }
    try {
      const content = await this.artifacts.read(x.v.artifact_ref);
      if (createHash('sha256').update(content).digest('hex') !== x.v.content_hash) throw new ProblemException('conflict', 'the artifact no longer matches the version that was approved');
      let targetId: string;
      if (target === 'workflow') {
        const r = await this.workflows.createFromTemplate(orgId, actor, x.l.title_en, JSON.parse(content.toString('utf8')), { listingVersionId: x.v.id });
        targetId = r.workflowId;
      } else {
        const r = await this.projects.install({ buyerOrgId: orgId, workspaceId: (body.workspaceId as string).toLowerCase(), type: x.l.type, artifactRef: x.v.artifact_ref, contentHash: x.v.content_hash, dataRegion: x.l.data_region, actorUserId: actor, idempotencyKey: idempotencyKey || id });
        targetId = r.projectId;
      }
      const row = (await this.db.withOrg(orgId, async (c) => (await c.query(`UPDATE marketplace.installations SET status = 'succeeded', target_id = $2 WHERE id = $1 RETURNING *`, [id, targetId])).rows[0])) as Row;
      await this.audit.record({ action: 'installation.installation.created', actorUserId: actor, orgId, resource: { type: 'installation', id }, outcome: 'success', after: { listingId: x.l.id, versionId: x.v.id, targetType: target, targetId } });
      return this.dto(row);
    } catch (e) {
      const err = e instanceof ProblemException ? { code: e.code, message: e.detail ?? e.message } : { code: 'install_failed', message: (e as Error).message.slice(0, 200) };
      await this.db.withOrg(orgId, (c) => c.query(`UPDATE marketplace.installations SET status = 'failed', error = $2 WHERE id = $1`, [id, JSON.stringify(err)])).catch(() => undefined);
      throw e;
    }
  }

  async list(orgId: string, q: { limit: number; cursor?: string }): Promise<Page<InstallationDto>> {
    const before = decodeCursor(q.cursor);
    const rows = await this.db.withOrg(orgId, async (c) => (await c.query(`SELECT * FROM marketplace.installations WHERE org_id = $1 AND ($2::uuid IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`, [orgId, before, q.limit + 1])).rows as Row[]);
    const p = pageOf(rows as (Row & { id: string })[], q.limit);
    return { items: p.items.map((r) => this.dto(r)), nextCursor: p.nextCursor };
  }
}
