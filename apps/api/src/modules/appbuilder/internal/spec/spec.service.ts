import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import { hashOf, iso, newId, type Row } from '../core';
import { validateAppSpec, type AppSpec } from './app-spec';

export interface AppSpecDto {
  id: string;
  projectId: string;
  version: number;
  status: 'draft' | 'approved' | 'superseded';
  contentHash: string;
  spec: AppSpec;
  runId: string | null;
  dataRegion: string;
  createdAt: string;
  approvedAt: string | null;
}

/** `builder.app_specs`: versioned, immutable structured specs. A new version supersedes the previous APPROVED one only when it is itself approved. */
export class AppSpecService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}
  dto(r: Row): AppSpecDto {
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      version: r.version as number,
      status: r.status as AppSpecDto['status'],
      contentHash: r.content_hash as string,
      spec: r.spec as AppSpec,
      runId: (r.run_id as string | null) ?? null,
      dataRegion: r.data_region as string,
      createdAt: iso(r.created_at)!,
      approvedAt: iso(r.approved_at),
    };
  }
  /** Validates, hashes and stores the next version. 422 `validation_failed` with every issue when the spec is invalid. */
  async create(
    orgId: string,
    projectId: string,
    spec: unknown,
    o: { runId?: string | null; createdBy?: string | null; dataRegion: string },
  ): Promise<AppSpecDto> {
    const check = validateAppSpec(spec);
    if (!check.ok)
      throw new ProblemException(
        'validation_failed',
        'the application spec is invalid',
        check.issues.map((i) => ({ field: i.path, message: i.message })),
      );
    const hash = hashOf(spec);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const row = await this.db.withOrg(orgId, async (c) => {
          const last = (
            await c.query(
              `SELECT version, content_hash FROM builder.app_specs WHERE org_id = $1 AND project_id = $2 ORDER BY version DESC LIMIT 1`,
              [orgId, projectId],
            )
          ).rows[0] as Row | undefined;
          if (last && last.content_hash === hash)
            return (
              await c.query(
                `SELECT * FROM builder.app_specs WHERE org_id = $1 AND project_id = $2 AND version = $3`,
                [orgId, projectId, last.version],
              )
            ).rows[0] as Row;
          return (
            await c.query(
              `INSERT INTO builder.app_specs (id, org_id, project_id, version, spec, content_hash, run_id, data_region, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
              [
                newId(),
                orgId,
                projectId,
                ((last?.version as number | undefined) ?? 0) + 1,
                JSON.stringify(spec),
                hash,
                o.runId ?? null,
                o.dataRegion,
                o.createdBy ?? null,
              ],
            )
          ).rows[0] as Row;
        });
        return this.dto(row);
      } catch (e) {
        if ((e as { code?: string }).code === '23505' && attempt < 2) continue; // concurrent writer took the version number
        throw e;
      }
    }
    throw new ProblemException('conflict', 'could not allocate a spec version');
  }
  async get(orgId: string, projectId: string, version?: number): Promise<AppSpecDto> {
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            version === undefined
              ? `SELECT * FROM builder.app_specs WHERE org_id = $1 AND project_id = $2 ORDER BY version DESC LIMIT 1`
              : `SELECT * FROM builder.app_specs WHERE org_id = $1 AND project_id = $2 AND version = $3`,
            version === undefined ? [orgId, projectId] : [orgId, projectId, version],
          )
        ).rows[0] as Row | undefined,
    );
    if (!r) throw new ProblemException('not_found', 'application spec not found');
    return this.dto(r);
  }
  async list(orgId: string, projectId: string): Promise<AppSpecDto[]> {
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM builder.app_specs WHERE org_id = $1 AND project_id = $2 ORDER BY version DESC LIMIT 100`,
            [orgId, projectId],
          )
        ).rows as Row[],
    );
    return rows.map((r) => this.dto(r));
  }
  /** Approve a draft version: earlier approved versions become `superseded`. */
  async approve(
    orgId: string,
    projectId: string,
    version: number,
    userId: string,
  ): Promise<AppSpecDto> {
    const r = await this.db.withOrg(orgId, async (c) => {
      const cur = (
        await c.query(
          `SELECT * FROM builder.app_specs WHERE org_id = $1 AND project_id = $2 AND version = $3`,
          [orgId, projectId, version],
        )
      ).rows[0] as Row | undefined;
      if (!cur) throw new ProblemException('not_found', 'application spec not found');
      if (cur.status === 'approved') return cur;
      if (cur.status !== 'draft')
        throw new ProblemException(
          'invalid_state',
          `a ${cur.status as string} spec cannot be approved`,
        );
      await c.query(
        `UPDATE builder.app_specs SET status = 'superseded' WHERE org_id = $1 AND project_id = $2 AND status = 'approved'`,
        [orgId, projectId],
      );
      return (
        await c.query(
          `UPDATE builder.app_specs SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1 RETURNING *`,
          [cur.id, userId],
        )
      ).rows[0] as Row;
    });
    await this.audit.record({
      action: 'builder.spec.approved',
      orgId,
      actorUserId: userId,
      resource: { type: 'app_spec', id: r.id as string },
      outcome: 'success',
      after: { projectId, version },
    });
    return this.dto(r);
  }
}
