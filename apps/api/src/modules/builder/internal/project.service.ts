import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { PoolClient } from 'pg';
import {
  OpInvalid,
  ResidencyDenied,
  applyOps,
  assertResidency,
  diffModels,
  emptySiteModel,
  getTemplate,
  seoReport,
  validateOps,
  validateSiteModel,
  type Op,
  type ResidencyEvaluator,
  type SiteModel,
} from '@nuzm/domain';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf } from '../../../common/pagination';
import { ASSET_MAX_BYTES, commitVersion, sniffImage } from './version.service';
import { isUuid, type BuilderConfig, type Row } from './model';

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export interface ProjectDto {
  id: string;
  type: string;
  name: string;
  locales: string[];
  templateId: string | null;
  headVersionId: string | null;
  headSeq: number | null;
  dataRegion: string;
  etag: number;
  createdAt: string;
  updatedAt: string;
  lastDeployment: { id: string; state: string; url: string | null; at: string } | null;
}
export interface ApplyInput {
  baseVersion: string;
  ops: unknown;
  source: 'user' | 'ai';
  label?: string;
  assetData?: Record<string, string>;
  runId?: string;
  userId: string;
  /** internal: an AI change set that a human approved (or the org auto-apply policy allowed for low-risk ops) */
  approvedByHuman?: boolean;
  changeId?: string;
}

/** Projects, versions, files, changes and restoration (M09 S39/S40). A project head moves only through `commitVersion`, under a row lock: single writer, optimistic concurrency. */
export class ProjectService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly residency: ResidencyEvaluator,
    private readonly cfg: BuilderConfig,
  ) {}

  private async dto(c: PoolClient, r: Row): Promise<ProjectDto> {
    const head = r.head_version_id
      ? ((
          await c.query(`SELECT seq FROM builder.project_versions WHERE id=$1`, [r.head_version_id])
        ).rows[0] as Row | undefined)
      : undefined;
    const dep = (
      await c.query(
        `SELECT id, state, url, created_at FROM deploy.deployments WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [r.id],
      )
    ).rows[0] as Row | undefined;
    return {
      id: r.id as string,
      type: r.type as string,
      name: r.name as string,
      locales: r.locales as string[],
      templateId: (r.template_id as string | null) ?? null,
      headVersionId: (r.head_version_id as string | null) ?? null,
      headSeq: head ? Number(head.seq) : null,
      dataRegion: r.data_region as string,
      etag: r.version as number,
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
      lastDeployment: dep
        ? {
            id: dep.id as string,
            state: dep.state as string,
            url: (dep.url as string | null) ?? null,
            at: iso(dep.created_at)!,
          }
        : null,
    };
  }
  /** The type of a project of this organization (`website` | `webapp` | `mobile`); 404 when it is not visible to it. */
  async typeOf(orgId: string, id: string): Promise<string> {
    if (!isUuid(id)) throw new ProblemException('not_found');
    const r = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT type FROM builder.projects WHERE id=$1 AND deleted_at IS NULL`, [
            id,
          ])
        ).rows[0],
    )) as Row | undefined;
    if (!r) throw new ProblemException('not_found');
    return r.type as string;
  }
  /** Website-only surfaces (previews, forms, CMS, SEO, editor operations) refuse the other project types. */
  async assertWebsite(orgId: string, id: string): Promise<void> {
    if ((await this.typeOf(orgId, id)) !== 'website')
      throw new ProblemException(
        'unsupported_capability',
        'this operation is for website projects (web-app projects have no site model)',
      );
  }

  /** A web-app project (M10A): the row only. Its versions are created by the agent graph / the changes pipeline, so it has no head version until the first generation. */
  private async createWebapp(
    orgId: string,
    userId: string,
    b: Record<string, unknown>,
  ): Promise<ProjectDto & { siteModel: null }> {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (name.length < 1 || name.length > 100)
      throw new ProblemException('validation_failed', 'name must be 1..100 characters');
    try {
      await assertResidency(this.residency, {
        orgId,
        dataClass: 'customer-content',
        targetRegion: this.cfg.dataRegion,
        purpose: 'builder_project_storage',
        operation: 'write',
      });
    } catch (e) {
      if (e instanceof ResidencyDenied)
        throw new ProblemException(
          'residency_denied',
          'the project region is not allowed by the residency policy',
          undefined,
          { evidenceRef: e.result.evidenceRef },
        );
      throw e;
    }
    const id = uuidv7();
    let out;
    try {
      out = await this.db.withOrg(orgId, async (c) => {
        const n = Number(
          (await c.query(`SELECT count(*) n FROM builder.projects WHERE deleted_at IS NULL`))
            .rows[0]!.n,
        );
        if (n >= this.cfg.maxProjects)
          throw new ProblemException(
            'quota_exceeded',
            `at most ${this.cfg.maxProjects} projects per organization`,
          );
        await c.query(
          `INSERT INTO builder.projects (id, org_id, type, name, locales, data_region, created_by) VALUES ($1,$2,'webapp',$3,$4,$5,$6)`,
          [id, orgId, name, ['ar', 'en'], this.cfg.dataRegion, userId],
        );
        return this.dto(
          c,
          (await c.query(`SELECT * FROM builder.projects WHERE id=$1`, [id])).rows[0] as Row,
        );
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException('name_taken', 'a project with this name already exists');
      throw e;
    }
    await this.audit.record({
      action: 'builder.project.created',
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'builder_project', id },
      outcome: 'success',
      detail: { type: 'webapp' },
    });
    return { ...out, siteModel: null };
  }

  async create(
    orgId: string,
    userId: string,
    b: Record<string, unknown>,
  ): Promise<ProjectDto & { siteModel: SiteModel | null }> {
    if (b.type === 'webapp') return this.createWebapp(orgId, userId, b);
    if (b.type !== undefined && b.type !== 'website')
      throw new ProblemException(
        'validation_failed',
        'type must be website or webapp (mobile arrives with M10B)',
      );
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (name.length < 1 || name.length > 100)
      throw new ProblemException('validation_failed', 'name must be 1..100 characters');
    const locales = Array.isArray(b.locale ?? b.locales)
      ? ((b.locale ?? b.locales) as unknown[])
      : ['ar', 'en'];
    if (
      locales.length < 1 ||
      locales.length > 2 ||
      locales.some((l) => l !== 'ar' && l !== 'en') ||
      new Set(locales).size !== locales.length
    )
      throw new ProblemException(
        'validation_failed',
        'locale must be ["ar"], ["en"], ["ar","en"] or ["en","ar"]',
      );
    const templateId = typeof b.templateId === 'string' ? b.templateId : null;
    const tpl = templateId ? getTemplate(templateId) : undefined;
    if (templateId && !tpl)
      throw new ProblemException(
        'validation_failed',
        `unknown template ${templateId.slice(0, 40)}`,
      );
    // residency hook m09-builder-assets: project files and versions are customer content stored in the project region
    try {
      await assertResidency(this.residency, {
        orgId,
        dataClass: 'customer-content',
        targetRegion: this.cfg.dataRegion,
        purpose: 'builder_project_storage',
        operation: 'write',
      });
    } catch (e) {
      if (e instanceof ResidencyDenied)
        throw new ProblemException(
          'residency_denied',
          'the project region is not allowed by the residency policy',
          undefined,
          { evidenceRef: e.result.evidenceRef },
        );
      throw e;
    }
    const loc = locales as ('ar' | 'en')[];
    const nm = Object.fromEntries(loc.map((l) => [l, name]));
    const model: SiteModel = tpl ? tpl.build({ name: nm, locales: loc }) : emptySiteModel(nm, loc);
    const id = uuidv7();
    let out;
    try {
      out = await this.db.withOrg(orgId, async (c) => {
        const n = Number(
          (await c.query(`SELECT count(*) n FROM builder.projects WHERE deleted_at IS NULL`))
            .rows[0]!.n,
        );
        if (n >= this.cfg.maxProjects)
          throw new ProblemException(
            'quota_exceeded',
            `at most ${this.cfg.maxProjects} projects per organization`,
          );
        await c.query(
          `INSERT INTO builder.projects (id, org_id, type, name, locales, template_id, data_region, created_by) VALUES ($1,$2,'website',$3,$4,$5,$6,$7)`,
          [id, orgId, name, loc, templateId, this.cfg.dataRegion, userId],
        );
        await commitVersion(c, this.cfg, {
          orgId,
          projectId: id,
          model,
          parentId: null,
          source: tpl ? 'template' : 'system',
          userId,
        });
        return this.dto(
          c,
          (await c.query(`SELECT * FROM builder.projects WHERE id=$1`, [id])).rows[0] as Row,
        );
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException('name_taken', 'a project with this name already exists');
      throw e;
    }
    await this.audit.record({
      action: 'builder.project.created',
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'builder_project', id },
      outcome: 'success',
      detail: { templateId, locales },
    });
    return { ...out, siteModel: model };
  }
  async list(orgId: string, o: { limit: number; cursor?: string }) {
    const cur = decodeCursor(o.cursor);
    return this.db.withOrg(orgId, async (c) => {
      const rows = (
        await c.query(
          `SELECT * FROM builder.projects WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR id < $1) ORDER BY id DESC LIMIT $2`,
          [cur, o.limit + 1],
        )
      ).rows as Row[];
      const p = pageOf(rows as (Row & { id: string })[], o.limit);
      return {
        items: await Promise.all(p.items.map((r) => this.dto(c, r))),
        nextCursor: p.nextCursor,
      };
    });
  }
  private async row(c: PoolClient, id: string, lock = false): Promise<Row> {
    if (!isUuid(id)) throw new ProblemException('not_found');
    const r = (
      await c.query(
        `SELECT * FROM builder.projects WHERE id=$1 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
        [id],
      )
    ).rows[0] as Row | undefined;
    if (!r) throw new ProblemException('not_found');
    return r;
  }
  /** Project with the model of the head (or `versionId`), the SEO score of that model and, with `compareTo`, the diff between two versions. */
  async get(orgId: string, id: string, o: { versionId?: string; compareTo?: string } = {}) {
    return this.db.withOrg(orgId, async (c) => {
      const r = await this.row(c, id);
      if (r.type !== 'website') {
        // a web-app project: files are the source of truth, there is no site model, SEO report or model diff
        const hv = (o.versionId ?? r.head_version_id ?? null) as string | null;
        const vr = hv
          ? ((
              await c.query(
                `SELECT id, seq FROM builder.project_versions WHERE id=$1 AND project_id=$2`,
                [hv, id],
              )
            ).rows[0] as Row | undefined)
          : undefined;
        if (hv && !vr) throw new ProblemException('not_found', 'version not found');
        return {
          ...(await this.dto(c, r)),
          versionId: (vr?.id as string | undefined) ?? null,
          versionSeq: vr ? Number(vr.seq) : null,
          siteModel: null,
          seo: null,
          diff: null,
        };
      }
      const vid = o.versionId ?? (r.head_version_id as string);
      if (!isUuid(vid)) throw new ProblemException('not_found');
      const v = (
        await c.query(
          `SELECT id, seq, site_model FROM builder.project_versions WHERE id=$1 AND project_id=$2`,
          [vid, id],
        )
      ).rows[0] as Row | undefined;
      if (!v) throw new ProblemException('not_found', 'version not found');
      const model = v.site_model as SiteModel;
      let diff: unknown = null;
      if (o.compareTo) {
        const o2 = (
          await c.query(
            `SELECT site_model FROM builder.project_versions WHERE id=$1 AND project_id=$2`,
            [o.compareTo, id],
          )
        ).rows[0] as Row | undefined;
        if (!o2) throw new ProblemException('not_found', 'compareTo version not found');
        diff = diffModels(o2.site_model as SiteModel, model);
      }
      return {
        ...(await this.dto(c, r)),
        versionId: v.id as string,
        versionSeq: Number(v.seq),
        siteModel: model,
        seo: seoReport(model),
        diff,
      };
    });
  }
  async patch(
    orgId: string,
    userId: string,
    id: string,
    ifMatch: number,
    b: Record<string, unknown>,
  ): Promise<ProjectDto> {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (name.length < 1 || name.length > 100)
      throw new ProblemException(
        'validation_failed',
        'only name (1..100 characters) can be changed; locales are fixed in v1',
      );
    if (Object.keys(b).some((k) => k !== 'name'))
      throw new ProblemException('validation_failed', 'only name can be changed');
    try {
      const out = await this.db.withOrg(orgId, async (c) => {
        const r = await this.row(c, id, true);
        if (r.version !== ifMatch)
          throw new ProblemException('etag_mismatch', 'the project changed since it was read');
        await c.query(
          `UPDATE builder.projects SET name=$2, version=version+1, updated_at=now() WHERE id=$1`,
          [id, name],
        );
        return this.dto(
          c,
          (await c.query(`SELECT * FROM builder.projects WHERE id=$1`, [id])).rows[0] as Row,
        );
      });
      await this.audit.record({
        action: 'builder.project.updated',
        actorUserId: userId,
        actorType: 'user',
        orgId,
        resource: { type: 'builder_project', id },
        outcome: 'success',
      });
      return out;
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException('name_taken', 'a project with this name already exists');
      throw e;
    }
  }
  /** Soft delete with a retention window. `confirmName` must equal the project name (a human typed it: that is the approval of a destructive action). */
  async remove(
    orgId: string,
    userId: string,
    id: string,
    confirmName: unknown,
  ): Promise<{ id: string; purgeAfter: string }> {
    const out = await this.db.withOrg(orgId, async (c) => {
      const r = await this.row(c, id, true);
      if (confirmName !== r.name)
        throw new ProblemException('validation_failed', 'confirmName must equal the project name');
      const busy = (
        await c.query(
          `SELECT 1 FROM deploy.deployments WHERE project_id=$1 AND state IN ('queued','building','deploying','smoke_checking') LIMIT 1`,
          [id],
        )
      ).rows[0];
      if (busy) throw new ProblemException('in_use', 'a deployment is in progress');
      const u = (
        await c.query(
          `UPDATE builder.projects SET deleted_at=now(), deleted_purge_after=now() + make_interval(days => $2), version=version+1 WHERE id=$1 RETURNING deleted_purge_after`,
          [id, this.cfg.projectRetentionDays],
        )
      ).rows[0] as Row;
      await c.query(
        `UPDATE builder.previews SET revoked_at=now() WHERE project_id=$1 AND revoked_at IS NULL`,
        [id],
      );
      return { id, purgeAfter: iso(u.deleted_purge_after)! };
    });
    await this.audit.record({
      action: 'builder.project.deleted',
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'builder_project', id },
      outcome: 'success',
      detail: { purgeAfter: out.purgeAfter },
    });
    return out;
  }

  // ---- files --------------------------------------------------------------------------------------------------------------------

  async files(orgId: string, id: string, versionId?: string) {
    return this.db.withOrg(orgId, async (c) => {
      const r = await this.row(c, id);
      if (!versionId && !r.head_version_id) return { versionId: null, items: [] }; // a web-app project before its first generation
      const v = versionId ?? (r.head_version_id as string);
      const rows = (
        await c.query(
          `SELECT path, size, mime, content_hash FROM builder.project_files WHERE project_id=$1 AND version_id=$2 ORDER BY path`,
          [id, v],
        )
      ).rows as Row[];
      if (
        rows.length === 0 &&
        !(
          await c.query(`SELECT 1 FROM builder.project_versions WHERE id=$1 AND project_id=$2`, [
            v,
            id,
          ])
        ).rows[0]
      )
        throw new ProblemException('not_found', 'version not found');
      return {
        versionId: v,
        items: rows.map((f) => ({
          path: f.path as string,
          size: Number(f.size),
          mime: f.mime as string,
          contentHash: f.content_hash as string,
        })),
      };
    });
  }
  async fileContent(orgId: string, id: string, path: unknown, versionId?: string) {
    return this.db.withOrg(orgId, async (c) => {
      const r = await this.row(c, id);
      if (typeof path !== 'string' || path.length < 1 || path.length > 300)
        throw new ProblemException('validation_failed', 'path is required');
      const f = (
        await c.query(
          `SELECT path, size, mime, content FROM builder.project_files WHERE project_id=$1 AND version_id=$2 AND path=$3`,
          [id, versionId ?? r.head_version_id, path],
        )
      ).rows[0] as Row | undefined;
      if (!f) throw new ProblemException('not_found', 'file not found');
      if (Number(f.size) > 1024 * 1024)
        throw new ProblemException('payload_too_large', 'the file is larger than 1 MiB');
      const text =
        /^(text\/|application\/(json|xml|ld\+json))/.test(f.mime as string) ||
        (f.mime as string).includes('svg');
      const buf = Buffer.from(f.content as Uint8Array);
      return {
        path: f.path as string,
        mime: f.mime as string,
        size: Number(f.size),
        encoding: text ? 'utf8' : 'base64',
        content: text ? buf.toString('utf8') : buf.toString('base64'),
      };
    });
  }

  // ---- versions -----------------------------------------------------------------------------------------------------------------

  async versions(orgId: string, id: string, o: { limit: number; cursor?: string }) {
    const cur = o.cursor ? Number(Buffer.from(o.cursor, 'base64url').toString()) : null;
    return this.db.withOrg(orgId, async (c) => {
      const r = await this.row(c, id);
      const rows = (
        await c.query(
          `SELECT id, seq, parent_id, label, named, source, run_id, restored_from, created_by, created_at, model_hash FROM builder.project_versions WHERE project_id=$1 AND ($2::int IS NULL OR seq < $2) ORDER BY seq DESC LIMIT $3`,
          [id, cur, o.limit + 1],
        )
      ).rows as Row[];
      const items = rows.slice(0, o.limit).map((v) => ({
        id: v.id as string,
        seq: Number(v.seq),
        parentId: (v.parent_id as string | null) ?? null,
        label: (v.label as string | null) ?? null,
        named: v.named as boolean,
        source: v.source as string,
        runId: (v.run_id as string | null) ?? null,
        restoredFrom: (v.restored_from as string | null) ?? null,
        createdBy: (v.created_by as string | null) ?? null,
        createdAt: iso(v.created_at)!,
        modelHash: v.model_hash as string,
        isHead: v.id === r.head_version_id,
      }));
      return {
        items,
        nextCursor:
          rows.length > o.limit
            ? Buffer.from(String(items[items.length - 1]!.seq)).toString('base64url')
            : null,
      };
    });
  }
  /** Restoration never rewrites history: it creates a NEW head version whose model is the chosen one. 409 when the chosen version already is the head. */
  async restore(orgId: string, userId: string, id: string, vid: string) {
    if (!isUuid(vid)) throw new ProblemException('not_found');
    const out = await this.db.withOrg(orgId, async (c) => {
      const p = await this.row(c, id, true);
      const v = (
        await c.query(`SELECT * FROM builder.project_versions WHERE id=$1 AND project_id=$2`, [
          vid,
          id,
        ])
      ).rows[0] as Row | undefined;
      if (!v) throw new ProblemException('not_found', 'version not found');
      if (v.id === p.head_version_id)
        throw new ProblemException('conflict', 'this version is already the head');
      const r = await commitVersion(c, this.cfg, {
        orgId,
        projectId: id,
        model: v.site_model as SiteModel,
        parentId: p.head_version_id as string,
        source: 'restore',
        restoredFrom: vid,
        label: `Restored from #${v.seq}`,
        userId,
      });
      return { versionId: r.versionId, seq: r.seq, restoredFrom: vid, restoredSeq: Number(v.seq) };
    });
    await this.audit.record({
      action: 'builder.version.restored',
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'builder_project', id },
      outcome: 'success',
      detail: { restoredFrom: vid, newVersion: out.versionId },
    });
    return out;
  }

  // ---- changes ------------------------------------------------------------------------------------------------------------------

  private assets(data: Record<string, string> | undefined): Record<string, Uint8Array> {
    const out: Record<string, Uint8Array> = {};
    for (const [hash, b64] of Object.entries(data ?? {})) {
      const bytes = Buffer.from(String(b64), 'base64');
      if (bytes.length === 0 || bytes.length > ASSET_MAX_BYTES)
        throw new ProblemException(
          'op_invalid',
          `an uploaded image must be 1..${ASSET_MAX_BYTES} bytes`,
        );
      if (sha256(bytes) !== hash)
        throw new ProblemException('op_invalid', 'assetData key must be the SHA-256 of the bytes');
      if (!sniffImage(bytes))
        throw new ProblemException(
          'op_invalid',
          'only PNG, JPEG and WebP images are accepted (SVG is refused: it can carry scripts)',
        );
      out[hash] = bytes;
    }
    return out;
  }
  /** Validate and apply an ordered op set atomically against `baseVersion`. 409 `base_outdated` carries rebase info; 422 `op_invalid` carries the issues. */
  async applyChange(orgId: string, projectId: string, a: ApplyInput) {
    await this.db.withOrg(orgId, (c) => this.row(c, projectId)); // 404 for another organization BEFORE any body validation
    if (!isUuid(a.baseVersion))
      throw new ProblemException('validation_failed', 'baseVersion must be a version id');
    if (a.source !== 'user' && a.source !== 'ai')
      throw new ProblemException('validation_failed', 'source must be user or ai');
    if (
      a.label !== undefined &&
      (typeof a.label !== 'string' || a.label.length < 1 || a.label.length > 100)
    )
      throw new ProblemException('validation_failed', 'label must be 1..100 characters');
    const empty = Array.isArray(a.ops) && a.ops.length === 0;
    if (empty && !a.label)
      throw new ProblemException(
        'validation_failed',
        'send at least one op, or a label to name the current version',
      );
    if (!empty) {
      try {
        validateOps(a.ops);
      } catch (e) {
        if (e instanceof OpInvalid) throw new ProblemException('op_invalid', e.message, e.issues);
        throw e;
      }
    }
    const assetData = this.assets(a.assetData);
    const out = await this.db.withOrg(orgId, async (c) => {
      const p = await this.row(c, projectId, true);
      if (p.head_version_id !== a.baseVersion) {
        const head = (
          await c.query(`SELECT id, seq, site_model FROM builder.project_versions WHERE id=$1`, [
            p.head_version_id,
          ])
        ).rows[0] as Row;
        const base = (
          await c.query(
            `SELECT site_model FROM builder.project_versions WHERE id=$1 AND project_id=$2`,
            [a.baseVersion, projectId],
          )
        ).rows[0] as Row | undefined;
        const changed = base
          ? [
              ...new Set(
                diffModels(base.site_model as SiteModel, head.site_model as SiteModel)
                  .structural.map((d) => d.pageId)
                  .filter(Boolean),
              ),
            ]
          : [];
        throw new ProblemException(
          'base_outdated',
          'the project changed since the base version: rebase and retry',
          undefined,
          { headVersionId: head.id, headSeq: Number(head.seq), changedPageIds: changed },
        );
      }
      const head = (
        await c.query(`SELECT * FROM builder.project_versions WHERE id=$1`, [p.head_version_id])
      ).rows[0] as Row;
      if (empty) {
        await c.query(`UPDATE builder.project_versions SET label=$2, named=true WHERE id=$1`, [
          head.id,
          a.label,
        ]);
        return {
          diff: { structural: [], text: [] },
          risks: [],
          newVersion: { id: head.id as string, seq: Number(head.seq) },
          inverseOps: [] as Op[],
          etag: p.version as number,
          changeId: null as string | null,
        };
      }
      if (a.source === 'ai' && !a.approvedByHuman)
        throw new ProblemException(
          'approval_required',
          'AI change sets are applied only after a human approval (or low-risk auto-apply)',
        );
      let res;
      try {
        res = applyOps(head.site_model as SiteModel, a.ops);
      } catch (e) {
        if (e instanceof OpInvalid) throw new ProblemException('op_invalid', e.message, e.issues);
        throw e;
      }
      const r = await commitVersion(c, this.cfg, {
        orgId,
        projectId,
        model: res.model,
        parentId: head.id as string,
        source: a.source,
        label: a.label ?? null,
        runId: a.runId ?? null,
        userId: a.userId,
        assetData,
      });
      const changeId = a.changeId ?? uuidv7();
      if (a.changeId)
        await c.query(
          `UPDATE builder.changes SET status='applied', result_version_id=$2, decided_at=now(), inverse_ops=$3 WHERE id=$1 AND status='proposed'`,
          [a.changeId, r.versionId, JSON.stringify(res.inverse)],
        );
      else
        await c.query(
          `INSERT INTO builder.changes (id, org_id, project_id, base_version_id, ops, diff, risks, status, result_version_id, source, run_id, inverse_ops, created_by, decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'applied',$8,$9,$10,$11,$12, now())`,
          [
            changeId,
            orgId,
            projectId,
            head.id,
            JSON.stringify(a.ops),
            JSON.stringify(res.diff),
            JSON.stringify(res.risks),
            r.versionId,
            a.source,
            a.runId ?? null,
            JSON.stringify(res.inverse),
            a.userId,
          ],
        );
      const etag = Number(
        (await c.query(`SELECT version FROM builder.projects WHERE id=$1`, [projectId])).rows[0]!
          .version,
      );
      return {
        diff: res.diff,
        risks: res.risks,
        newVersion: { id: r.versionId, seq: r.seq },
        inverseOps: res.inverse,
        etag,
        changeId,
      };
    });
    await this.audit.record({
      action: 'builder.change.applied',
      actorUserId: a.userId,
      actorType: a.source === 'ai' ? 'system' : 'user',
      orgId,
      resource: { type: 'builder_project', id: projectId },
      outcome: 'success',
      detail: {
        source: a.source,
        newVersion: out.newVersion.id,
        ops: empty ? 0 : (a.ops as unknown[]).length,
        risks: out.risks.map((r) => r.code),
      },
    });
    return out;
  }

  /** An AI proposal: stored, NOT applied. `lowRisk` tells the edit handler whether auto-apply may skip the approval. */
  async propose(
    orgId: string,
    p: {
      projectId: string;
      baseVersion: string;
      ops: unknown;
      runId: string;
      userId: string | null;
    },
  ) {
    return this.db.withOrg(orgId, async (c) => {
      const proj = await this.row(c, p.projectId);
      const base = (
        await c.query(
          `SELECT site_model FROM builder.project_versions WHERE id=$1 AND project_id=$2`,
          [p.baseVersion, p.projectId],
        )
      ).rows[0] as Row | undefined;
      if (!base) throw new ProblemException('not_found', 'base version not found');
      void proj;
      let res;
      try {
        res = applyOps(base.site_model as SiteModel, p.ops);
      } catch (e) {
        if (e instanceof OpInvalid) throw new ProblemException('op_invalid', e.message, e.issues);
        throw e;
      }
      const id = uuidv7();
      await c.query(
        `INSERT INTO builder.changes (id, org_id, project_id, base_version_id, ops, diff, risks, status, source, run_id, inverse_ops, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'proposed','ai',$8,$9,$10)`,
        [
          id,
          orgId,
          p.projectId,
          p.baseVersion,
          JSON.stringify(p.ops),
          JSON.stringify(res.diff),
          JSON.stringify(res.risks),
          p.runId,
          JSON.stringify(res.inverse),
          p.userId,
        ],
      );
      return { changeId: id, diff: res.diff, risks: res.risks, lowRisk: res.lowRisk };
    });
  }
  async changeRow(orgId: string, changeId: string): Promise<Row | undefined> {
    return this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM builder.changes WHERE id=$1`, [changeId])).rows[0] as
          Row | undefined,
    );
  }
  async rejectChange(orgId: string, changeId: string) {
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `UPDATE builder.changes SET status='rejected', decided_at=now() WHERE id=$1 AND status='proposed'`,
        [changeId],
      ),
    );
  }
  async headVersion(
    orgId: string,
    projectId: string,
  ): Promise<{ id: string; model: SiteModel } | null> {
    return this.db.withOrg(orgId, async (c) => {
      const r = (
        await c.query(
          `SELECT v.id, v.site_model FROM builder.projects p JOIN builder.project_versions v ON v.id = p.head_version_id WHERE p.id=$1 AND p.deleted_at IS NULL`,
          [projectId],
        )
      ).rows[0] as Row | undefined;
      return r ? { id: r.id as string, model: r.site_model as SiteModel } : null;
    });
  }
  /** a fresh model for a website run: replaces the head with the generated model as a NEW version */
  async commitGenerated(
    orgId: string,
    p: { projectId: string; model: SiteModel; runId: string; userId: string | null },
  ) {
    const issues = validateSiteModel(p.model);
    if (issues.length)
      throw new ProblemException(
        'op_invalid',
        'the generated site model is not valid',
        issues as unknown[],
      );
    return this.db.withOrg(orgId, async (c) => {
      const proj = await this.row(c, p.projectId, true);
      const r = await commitVersion(c, this.cfg, {
        orgId,
        projectId: p.projectId,
        model: p.model,
        parentId: (proj.head_version_id as string | null) ?? null,
        source: 'ai',
        runId: p.runId,
        label: 'AI generated site',
        userId: p.userId,
      });
      return r;
    });
  }
}
