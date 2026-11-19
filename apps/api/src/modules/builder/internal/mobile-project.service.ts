import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { PoolClient } from 'pg';
import { ResidencyDenied, assertResidency, type ResidencyEvaluator } from '@nuzm/domain';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { isUuid, type BuilderConfig, type Row } from './model';

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );
/** at most this many files and bytes per mobile version (a Flutter template project is ~40 small files) */
export const MOBILE_MAX_FILES = 400;
export const MOBILE_MAX_FILE_BYTES = 1024 * 1024;
const MIME: Record<string, string> = {
  dart: 'text/x-dart',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  json: 'application/json',
  md: 'text/markdown',
  arb: 'application/json',
  kt: 'text/x-kotlin',
  kts: 'text/x-kotlin',
  gradle: 'text/x-gradle',
  xml: 'application/xml',
  properties: 'text/plain',
  txt: 'text/plain',
};
const mimeOf = (path: string) => MIME[path.split('.').pop()!.toLowerCase()] ?? 'text/plain';

/** Feature flag of the whole mobile builder (CLAUDE.md §4): default OFF; an organization row beats the global row. */
export const MOBILE_BUILDER_FLAG = 'mobile_builder.enabled';

export interface MobileManifest {
  kind: 'mobile';
  schemaVersion: 1;
  /** the template set and pinned toolchain the files were generated with */
  generator: Record<string, unknown>;
  /** the validated mobile spec the files were rendered from (null for an empty project) */
  spec: unknown;
  fileCount: number;
}
export interface MobileProjectView {
  id: string;
  type: 'mobile';
  name: string;
  locales: string[];
  templateId: string | null;
  headVersionId: string | null;
  headSeq: number | null;
  dataRegion: string;
  etag: number;
  createdAt: string;
  updatedAt: string;
}
export interface MobileCommit {
  orgId: string;
  projectId: string;
  /** relative path -> UTF-8 text */
  files: Record<string, string>;
  manifest: Omit<MobileManifest, 'kind' | 'schemaVersion' | 'fileCount'>;
  source: 'ai' | 'user' | 'system';
  runId?: string | null;
  label?: string | null;
  userId?: string | null;
}

/**
 * Mobile (Flutter) projects, M10B S48. They live in the SAME tables as every builder project (docs/04: project creation is `/v1/builder/projects` with `type=mobile`): a
 * versioned immutable head in `builder.project_versions` (the version's model column holds the mobile manifest) and the Flutter source in `builder.project_files`. No other
 * schema is written. Site-model operations (changes, restore, previews) refuse mobile projects in `ProjectService` / `PreviewService`.
 */
export class MobileProjectService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly residency: ResidencyEvaluator,
    private readonly cfg: BuilderConfig,
  ) {}

  async mobileEnabled(orgId: string): Promise<boolean> {
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT org_id, value FROM platform.feature_flags WHERE key = $1 AND (org_id IS NULL OR org_id = $2) ORDER BY org_id NULLS FIRST`,
            [MOBILE_BUILDER_FLAG, orgId],
          )
        ).rows as Row[],
    );
    const v = rows[rows.length - 1]?.value as unknown;
    return (
      v === true ||
      (typeof v === 'object' && v !== null && (v as { enabled?: unknown }).enabled === true)
    );
  }

  private view(r: Row, seq: number | null): MobileProjectView {
    return {
      id: r.id as string,
      type: 'mobile',
      name: r.name as string,
      locales: r.locales as string[],
      templateId: (r.template_id as string | null) ?? null,
      headVersionId: (r.head_version_id as string | null) ?? null,
      headSeq: seq,
      dataRegion: r.data_region as string,
      etag: r.version as number,
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
    };
  }
  private async seqOf(c: PoolClient, versionId: unknown): Promise<number | null> {
    if (!versionId) return null;
    const v = (await c.query(`SELECT seq FROM builder.project_versions WHERE id=$1`, [versionId]))
      .rows[0] as Row | undefined;
    return v ? Number(v.seq) : null;
  }

  async create(
    orgId: string,
    userId: string,
    b: Record<string, unknown>,
  ): Promise<MobileProjectView & { manifest: MobileManifest }> {
    if (!(await this.mobileEnabled(orgId)))
      throw new ProblemException(
        'not_found',
        'the mobile builder is not enabled for this organization',
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
    const templateId = typeof b.templateId === 'string' ? b.templateId.slice(0, 60) : null;
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
    const manifest: MobileManifest = {
      kind: 'mobile',
      schemaVersion: 1,
      generator: { templateSet: null },
      spec: null,
      fileCount: 0,
    };
    let view: MobileProjectView;
    try {
      view = await this.db.withOrg(orgId, async (c) => {
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
          `INSERT INTO builder.projects (id, org_id, type, name, locales, template_id, data_region, created_by) VALUES ($1,$2,'mobile',$3,$4,$5,$6,$7)`,
          [id, orgId, name, locales, templateId, this.cfg.dataRegion, userId],
        );
        await this.insertVersion(c, {
          orgId,
          projectId: id,
          parentId: null,
          manifest,
          fileHashes: [],
          source: 'system',
          userId,
        });
        const r = (await c.query(`SELECT * FROM builder.projects WHERE id=$1`, [id]))
          .rows[0] as Row;
        return this.view(r, await this.seqOf(c, r.head_version_id));
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
      detail: { type: 'mobile', templateId, locales },
    });
    return { ...view, manifest };
  }

  /** `GET /v1/builder/projects/{id}` for a mobile project: the project, the version and its manifest (never the file bytes). */
  async read(c: PoolClient, r: Row, versionId?: string) {
    const vid = versionId ?? (r.head_version_id as string);
    if (!isUuid(vid)) throw new ProblemException('not_found');
    const v = (
      await c.query(
        `SELECT id, seq, site_model FROM builder.project_versions WHERE id=$1 AND project_id=$2`,
        [vid, r.id],
      )
    ).rows[0] as Row | undefined;
    if (!v) throw new ProblemException('not_found', 'version not found');
    return {
      ...this.view(r, await this.seqOf(c, r.head_version_id)),
      lastDeployment: null,
      versionId: v.id as string,
      versionSeq: Number(v.seq),
      siteModel: null,
      manifest: v.site_model as MobileManifest,
      seo: null,
      diff: null,
    };
  }

  /** The mobile project of THIS organization (a project of another organization, a website or a deleted one: null = 404 for the caller). */
  async project(orgId: string, id: string): Promise<MobileProjectView | null> {
    if (!isUuid(id)) return null;
    return this.db.withOrg(orgId, async (c) => {
      const r = (
        await c.query(
          `SELECT * FROM builder.projects WHERE id=$1 AND type='mobile' AND deleted_at IS NULL`,
          [id.toLowerCase()],
        )
      ).rows[0] as Row | undefined;
      return r ? this.view(r, await this.seqOf(c, r.head_version_id)) : null;
    });
  }

  private async insertVersion(
    c: PoolClient,
    i: {
      orgId: string;
      projectId: string;
      parentId: string | null;
      manifest: MobileManifest;
      fileHashes: string[];
      source: 'ai' | 'user' | 'system';
      runId?: string | null;
      label?: string | null;
      userId?: string | null;
    },
  ): Promise<{ versionId: string; seq: number }> {
    const versionId = uuidv7();
    const seq = Number(
      (
        await c.query(
          `SELECT coalesce(max(seq),0)+1 AS s FROM builder.project_versions WHERE project_id=$1`,
          [i.projectId],
        )
      ).rows[0]!.s,
    );
    await c.query(
      `INSERT INTO builder.project_versions (id, org_id, project_id, parent_id, seq, site_model, model_hash, label, named, source, run_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        versionId,
        i.orgId,
        i.projectId,
        i.parentId,
        seq,
        JSON.stringify(i.manifest),
        sha256(canonical(i.manifest) + i.fileHashes.sort().join(',')),
        i.label ?? null,
        Boolean(i.label),
        i.source,
        i.runId ?? null,
        i.userId ?? null,
      ],
    );
    await c.query(
      `UPDATE builder.projects SET head_version_id=$2, version=version+1, updated_at=now() WHERE id=$1`,
      [i.projectId, versionId],
    );
    return { versionId, seq };
  }

  /** Commit Flutter source as a NEW immutable head version (single writer under the project row lock). Paths are validated again here: no traversal, no absolute path. */
  async commit(c: MobileCommit): Promise<{ versionId: string; seq: number; fileCount: number }> {
    const entries = Object.entries(c.files);
    if (entries.length < 1 || entries.length > MOBILE_MAX_FILES)
      throw new ProblemException(
        'validation_failed',
        `a mobile version has 1..${MOBILE_MAX_FILES} files`,
      );
    for (const [path, text] of entries) {
      if (
        path.length < 1 ||
        path.length > 300 ||
        /(^\/|\.\.|\/\/|\\|\0)/.test(path) ||
        path.split('/').some((seg) => seg === '' || seg === '.')
      )
        throw new ProblemException('validation_failed', `unsafe path ${path.slice(0, 80)}`);
      if (Buffer.byteLength(text, 'utf8') > MOBILE_MAX_FILE_BYTES)
        throw new ProblemException('payload_too_large', `${path} is larger than 1 MiB`);
    }
    const manifest: MobileManifest = {
      kind: 'mobile',
      schemaVersion: 1,
      ...c.manifest,
      fileCount: entries.length,
    };
    return this.db.withOrg(c.orgId, async (cl) => {
      const p = (
        await cl.query(
          `SELECT id, head_version_id FROM builder.projects WHERE id=$1 AND type='mobile' AND deleted_at IS NULL FOR UPDATE`,
          [c.projectId],
        )
      ).rows[0] as Row | undefined;
      if (!p) throw new ProblemException('not_found', 'project not found');
      if (c.runId) {
        // a run segment that crashed after committing replays without a second version
        const dup = (
          await cl.query(
            `SELECT id, seq FROM builder.project_versions WHERE project_id=$1 AND run_id=$2 ORDER BY seq LIMIT 1`,
            [c.projectId, c.runId],
          )
        ).rows[0] as Row | undefined;
        if (dup)
          return { versionId: dup.id as string, seq: Number(dup.seq), fileCount: entries.length };
      }
      const hashes: string[] = [];
      const bytes = entries.map(([path, text]) => {
        const b = Buffer.from(text, 'utf8');
        hashes.push(sha256(b));
        return { path, b };
      });
      const v = await this.insertVersion(cl, {
        orgId: c.orgId,
        projectId: c.projectId,
        parentId: (p.head_version_id as string | null) ?? null,
        manifest,
        fileHashes: hashes,
        source: c.source,
        ...(c.runId !== undefined ? { runId: c.runId } : {}),
        ...(c.label !== undefined ? { label: c.label } : {}),
        ...(c.userId !== undefined ? { userId: c.userId } : {}),
      });
      for (const { path, b } of bytes)
        await cl.query(
          `INSERT INTO builder.project_files (id, org_id, project_id, version_id, path, content_hash, size, mime, content) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [uuidv7(), c.orgId, c.projectId, v.versionId, path, sha256(b), b.length, mimeOf(path), b],
        );
      return { ...v, fileCount: entries.length };
    });
  }

  /** Source of a version (default: the head) as path -> text. null = the project/version is not a mobile project of this organization. */
  async sourceOf(
    orgId: string,
    projectId: string,
    versionId?: string,
  ): Promise<{
    versionId: string;
    files: Record<string, string>;
    manifest: MobileManifest;
  } | null> {
    if (!isUuid(projectId) || (versionId !== undefined && !isUuid(versionId))) return null;
    return this.db.withOrg(orgId, async (c) => {
      const p = (
        await c.query(
          `SELECT id, head_version_id FROM builder.projects WHERE id=$1 AND type='mobile' AND deleted_at IS NULL`,
          [projectId.toLowerCase()],
        )
      ).rows[0] as Row | undefined;
      if (!p) return null;
      const vid = versionId?.toLowerCase() ?? (p.head_version_id as string);
      const v = (
        await c.query(
          `SELECT id, site_model FROM builder.project_versions WHERE id=$1 AND project_id=$2`,
          [vid, p.id],
        )
      ).rows[0] as Row | undefined;
      if (!v) return null;
      const rows = (
        await c.query(
          `SELECT path, content FROM builder.project_files WHERE version_id=$1 ORDER BY path`,
          [vid],
        )
      ).rows as Row[];
      return {
        versionId: v.id as string,
        manifest: v.site_model as MobileManifest,
        files: Object.fromEntries(
          rows.map((f) => [f.path as string, Buffer.from(f.content as Buffer).toString('utf8')]),
        ),
      };
    });
  }
}
