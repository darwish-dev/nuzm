import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';
import { isUuid, type Row } from './model';
import {
  artifactManifest,
  verifyAgainstManifest,
  type ArtifactFile,
  type ArtifactManifest,
  type ManifestMismatch,
} from './qa/artifact';
import { measureEditDiff, type EditDiffStats } from './qa/edit-diff';
import { runWebsiteQa } from './qa/runner';
import type { QaOptions, QaReport } from './qa/types';
import type { SiteModel } from '@nuzm/domain';

/**
 * The hash-bound artifact of a STORED version (P3-S04 → P3-S07 hand-off, W4) and the QA of it. Reads `builder.project_files` of one version under the caller's
 * organization scope (RLS), builds the same manifest the static build produced, and can run the QA gates over exactly those stored bytes. Nothing here writes.
 */
export class VersionArtifactService {
  constructor(
    private readonly db: Db,
    /** the platform forms origin written into generated pages: the QA policy lets forms post there and nowhere else */
    private readonly formsBaseUrl?: string,
  ) {}

  private async load(orgId: string, projectId: string, versionId?: string) {
    if (!isUuid(projectId) || (versionId !== undefined && !isUuid(versionId)))
      throw new ProblemException('not_found');
    return this.db.withOrg(orgId, async (c) => {
      const p = (
        await c.query(
          `SELECT type, head_version_id FROM builder.projects WHERE id=$1 AND deleted_at IS NULL`,
          [projectId],
        )
      ).rows[0] as Row | undefined;
      if (!p) throw new ProblemException('not_found');
      if (p.type !== 'website')
        throw new ProblemException(
          'unsupported_capability',
          'only website projects have a static artifact',
        );
      const v = versionId ?? (p.head_version_id as string | null);
      if (!v) throw new ProblemException('not_found', 'the project has no version yet');
      const ver = (
        await c.query(
          `SELECT id, model_hash FROM builder.project_versions WHERE id=$1 AND project_id=$2`,
          [v, projectId],
        )
      ).rows[0] as Row | undefined;
      if (!ver) throw new ProblemException('not_found', 'version not found');
      const rows = (
        await c.query(
          `SELECT path, mime, content, content_hash FROM builder.project_files WHERE project_id=$1 AND version_id=$2 ORDER BY path`,
          [projectId, v],
        )
      ).rows as Row[];
      const files: ArtifactFile[] = rows.map((r) => ({
        path: r.path as string,
        mime: r.mime as string,
        bytes: Buffer.from(r.content as Uint8Array),
      }));
      return { versionId: v, modelHash: ver.model_hash as string, files };
    });
  }

  /** The manifest of a version's files; `rootHash` is what the deploy target must be able to reproduce from what it serves. */
  async manifest(
    orgId: string,
    projectId: string,
    versionId?: string,
  ): Promise<{ versionId: string; manifest: ArtifactManifest }> {
    const a = await this.load(orgId, projectId, versionId);
    return {
      versionId: a.versionId,
      manifest: artifactManifest(a.files, {
        modelHash: a.modelHash,
        source: 'builder.project_files',
      }),
    };
  }

  /** Files of a version as artifact files (for the static deploy hand-off). */
  async files(orgId: string, projectId: string, versionId?: string): Promise<ArtifactFile[]> {
    return (await this.load(orgId, projectId, versionId)).files;
  }

  /** The stored bytes still match the manifest built at commit time? (Detects a database-level tamper of a version's files.) */
  async verify(
    orgId: string,
    projectId: string,
    manifest: ArtifactManifest,
    versionId?: string,
  ): Promise<ManifestMismatch[]> {
    return verifyAgainstManifest(manifest, (await this.load(orgId, projectId, versionId)).files);
  }

  /** QA gates over the stored files of a version. Pass `mode: 'preview'` for a preview build (noindex) and a forms origin when the site has a contact form. */
  async qa(
    orgId: string,
    projectId: string,
    versionId?: string,
    opts: QaOptions = {},
  ): Promise<{ versionId: string; report: QaReport }> {
    const a = await this.load(orgId, projectId, versionId);
    let formsOrigin = opts.formsOrigin;
    if (formsOrigin === undefined && this.formsBaseUrl) {
      try {
        formsOrigin = new URL(this.formsBaseUrl).origin;
      } catch {
        /* an invalid base URL leaves the policy without a forms origin: any form then fails the gate, which is the safe direction */
      }
    }
    return {
      versionId: a.versionId,
      report: await runWebsiteQa(a.files, { ...opts, ...(formsOrigin ? { formsOrigin } : {}) }),
    };
  }

  /** How big a change between two versions is (W3): model-level and file-level, with a verdict. */
  async compare(
    orgId: string,
    projectId: string,
    fromVersionId: string,
    toVersionId: string,
  ): Promise<EditDiffStats> {
    if (!isUuid(projectId) || !isUuid(fromVersionId) || !isUuid(toVersionId))
      throw new ProblemException('not_found');
    return this.db.withOrg(orgId, async (c) => {
      const models = new Map<string, SiteModel>();
      for (const v of [fromVersionId, toVersionId]) {
        const r = (
          await c.query(
            `SELECT site_model FROM builder.project_versions WHERE id=$1 AND project_id=$2`,
            [v, projectId],
          )
        ).rows[0] as Row | undefined;
        if (!r) throw new ProblemException('not_found', 'version not found');
        models.set(v, r.site_model as SiteModel);
      }
      const filesOf = async (v: string): Promise<ArtifactFile[]> =>
        (
          (
            await c.query(
              `SELECT path, mime, content FROM builder.project_files WHERE project_id=$1 AND version_id=$2`,
              [projectId, v],
            )
          ).rows as Row[]
        ).map((r) => ({
          path: r.path as string,
          mime: r.mime as string,
          bytes: Buffer.from(r.content as Uint8Array),
        }));
      return measureEditDiff(models.get(fromVersionId)!, models.get(toVersionId)!, {
        before: await filesOf(fromVersionId),
        after: await filesOf(toVersionId),
      });
    });
  }
}
