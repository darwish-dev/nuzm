import { AuditSink, type AuditAction } from '../../../common/audit';
import { v7 as uuidv7 } from 'uuid';
import { enqueue, type Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';
import { ResidencyPolicy, RetentionHook } from './hooks';
import { decodeCursor, pageOf, parseLimit, type Page } from './pagination';
import { slugify } from './slug';
import { UUID } from '@nuzm/domain';

type Row = Record<string, unknown>;
const iso = (d: unknown) => (d as Date).toISOString();

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}
export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  defaultRegionPolicy: unknown;
  createdAt: string;
  updatedAt: string;
  version: number;
}
export interface Environment {
  id: string;
  projectId: string;
  name: string;
  kind: 'dev' | 'staging' | 'prod';
  dataRegion: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

const ws = (r: Row): Workspace => ({
  id: r.id as string,
  name: r.name as string,
  slug: r.slug as string,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  version: r.version as number,
});
const pr = (r: Row): Project => ({
  id: r.id as string,
  workspaceId: r.workspace_id as string,
  name: r.name as string,
  defaultRegionPolicy: r.default_region_policy,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  version: r.version as number,
});
const en = (r: Row): Environment => ({
  id: r.id as string,
  projectId: r.project_id as string,
  name: r.name as string,
  kind: r.kind as Environment['kind'],
  dataRegion: r.data_region as string,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  version: r.version as number,
});

const name = (v: unknown, what = 'name', max = 200) => {
  if (typeof v !== 'string' || v.trim().length < 1 || v.trim().length > max)
    throw new ProblemException('validation_failed', `${what} must be 1..${max} characters`);
  return v.trim();
};
const dup = (e: unknown, msg: string) => {
  if ((e as { code?: string }).code === '23505') throw new ProblemException('conflict', msg);
  throw e;
};

/** Workspaces, projects and environments. All reads/writes run inside the org RLS context; deletes are soft. */
export class WorkspaceService {
  constructor(
    private readonly db: Db,
    private readonly residency: ResidencyPolicy,
    private readonly retention: RetentionHook,
    private readonly audit: AuditSink,
  ) {}

  /** Audit inside the caller's transaction (the sink joins it): change + audit row commit together. */
  private rec(action: AuditAction, orgId: string, type: string, id: string) {
    return this.audit.record({
      action,
      orgId,
      resource: { type, id },
      outcome: 'success',
    });
  }

  // ---- workspaces ----
  async createWorkspace(
    orgId: string,
    userId: string,
    i: { name: unknown; slug?: unknown },
  ): Promise<Workspace> {
    const n = name(i.name);
    const slug = typeof i.slug === 'string' ? i.slug : slugify(n);
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug))
      throw new ProblemException(
        'validation_failed',
        'slug must be 1..63 chars of a-z, 0-9 and hyphen',
      );
    return this.db.withOrg(orgId, async (c) => {
      try {
        const id = uuidv7();
        const r = (
          await c.query(
            `INSERT INTO tenancy.workspaces (id, org_id, name, slug, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
            [id, orgId, n, slug, userId],
          )
        ).rows[0];
        await enqueue(c, orgId, 'workspace.created', { workspaceId: id });
        await this.rec('tenancy.workspace.created', orgId, 'workspace', id);
        return ws(r);
      } catch (e) {
        return dup(e, 'a workspace with this slug already exists');
      }
    });
  }
  async listWorkspaces(
    orgId: string,
    q: { limit?: unknown; cursor?: unknown },
  ): Promise<Page<Workspace>> {
    const limit = parseLimit(q.limit);
    const cur = decodeCursor(q.cursor);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM tenancy.workspaces WHERE deleted_at IS NULL AND ($2::uuid IS NULL OR id < $2) ORDER BY id DESC LIMIT $1`,
            [limit + 1, cur],
          )
        ).rows,
    );
    return pageOf(rows.map(ws), limit);
  }
  async getWorkspace(orgId: string, id: string): Promise<Workspace | null> {
    if (!UUID.test(id)) return null;
    return this.db.withOrg(orgId, async (c) => {
      const r = (
        await c.query(`SELECT * FROM tenancy.workspaces WHERE id=$1 AND deleted_at IS NULL`, [id])
      ).rows[0];
      return r ? ws(r) : null;
    });
  }
  async updateWorkspace(
    orgId: string,
    id: string,
    version: number,
    patch: { name?: unknown },
  ): Promise<Workspace> {
    const n = patch.name === undefined ? null : name(patch.name);
    return this.versioned(
      orgId,
      id,
      version,
      'workspaces',
      async (c) =>
        (
          await c.query(
            `UPDATE tenancy.workspaces SET name=COALESCE($3,name), updated_at=now(), version=version+1 WHERE id=$1 AND version=$2 AND deleted_at IS NULL RETURNING *`,
            [id, version, n],
          )
        ).rows[0],
      ws,
      'workspace.updated',
    );
  }
  async deleteWorkspace(orgId: string, id: string): Promise<void> {
    await this.db.withOrg(orgId, async (c) => {
      if (
        (
          await c.query(
            `SELECT 1 FROM tenancy.projects WHERE workspace_id=$1 AND deleted_at IS NULL`,
            [id],
          )
        ).rowCount
      )
        throw new ProblemException('conflict', 'workspace still has projects');
      const r = await c.query(
        `UPDATE tenancy.workspaces SET deleted_at=now(), version=version+1 WHERE id=$1 AND deleted_at IS NULL`,
        [id],
      );
      if (!r.rowCount) throw new ProblemException('not_found');
      await enqueue(c, orgId, 'workspace.deleted', { workspaceId: id });
      await this.rec('tenancy.workspace.deleted', orgId, 'workspace', id);
    });
    await this.retention.onSoftDelete(orgId, 'workspace', id);
  }

  // ---- projects ----
  async createProject(
    orgId: string,
    userId: string,
    i: { workspaceId: unknown; name: unknown; defaultRegionPolicy?: unknown },
  ): Promise<Project> {
    const n = name(i.name);
    if (typeof i.workspaceId !== 'string' || !UUID.test(i.workspaceId))
      throw new ProblemException('validation_failed', 'workspaceId must be a UUID');
    const policy = i.defaultRegionPolicy ?? {};
    if (typeof policy !== 'object' || Array.isArray(policy))
      throw new ProblemException('validation_failed', 'defaultRegionPolicy must be an object');
    return this.db.withOrg(orgId, async (c) => {
      if (
        !(
          await c.query(`SELECT 1 FROM tenancy.workspaces WHERE id=$1 AND deleted_at IS NULL`, [
            i.workspaceId,
          ])
        ).rowCount
      )
        throw new ProblemException('not_found', 'workspace not found'); // a foreign org's workspace is simply "not found"
      try {
        const id = uuidv7();
        const r = (
          await c.query(
            `INSERT INTO tenancy.projects (id, org_id, workspace_id, name, default_region_policy, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [id, orgId, i.workspaceId, n, JSON.stringify(policy), userId],
          )
        ).rows[0];
        await enqueue(c, orgId, 'project.created', { projectId: id });
        await this.rec('tenancy.project.created', orgId, 'project', id);
        return pr(r);
      } catch (e) {
        return dup(e, 'a project with this name already exists in the workspace');
      }
    });
  }
  async listProjects(
    orgId: string,
    q: { limit?: unknown; cursor?: unknown; workspaceId?: unknown },
  ): Promise<Page<Project>> {
    const limit = parseLimit(q.limit);
    const cur = decodeCursor(q.cursor);
    const wsId =
      typeof q.workspaceId === 'string' && UUID.test(q.workspaceId) ? q.workspaceId : null;
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM tenancy.projects WHERE deleted_at IS NULL AND ($3::uuid IS NULL OR workspace_id=$3) AND ($2::uuid IS NULL OR id < $2) ORDER BY id DESC LIMIT $1`,
            [limit + 1, cur, wsId],
          )
        ).rows,
    );
    return pageOf(rows.map(pr), limit);
  }
  async getProject(orgId: string, id: string): Promise<Project | null> {
    if (!UUID.test(id)) return null;
    return this.db.withOrg(orgId, async (c) => {
      const r = (
        await c.query(`SELECT * FROM tenancy.projects WHERE id=$1 AND deleted_at IS NULL`, [id])
      ).rows[0];
      return r ? pr(r) : null;
    });
  }
  async updateProject(
    orgId: string,
    id: string,
    version: number,
    patch: { name?: unknown; defaultRegionPolicy?: unknown },
  ): Promise<Project> {
    const n = patch.name === undefined ? null : name(patch.name);
    if (
      patch.defaultRegionPolicy !== undefined &&
      (typeof patch.defaultRegionPolicy !== 'object' ||
        patch.defaultRegionPolicy === null ||
        Array.isArray(patch.defaultRegionPolicy))
    )
      throw new ProblemException('validation_failed', 'defaultRegionPolicy must be an object');
    const pol =
      patch.defaultRegionPolicy === undefined ? null : JSON.stringify(patch.defaultRegionPolicy);
    return this.versioned(
      orgId,
      id,
      version,
      'projects',
      async (c) =>
        (
          await c.query(
            `UPDATE tenancy.projects SET name=COALESCE($3,name), default_region_policy=COALESCE($4::jsonb,default_region_policy), updated_at=now(), version=version+1 WHERE id=$1 AND version=$2 AND deleted_at IS NULL RETURNING *`,
            [id, version, n, pol],
          )
        ).rows[0],
      pr,
      'project.updated',
    );
  }
  async deleteProject(orgId: string, id: string): Promise<void> {
    await this.db.withOrg(orgId, async (c) => {
      if (
        (
          await c.query(
            `SELECT 1 FROM tenancy.environments WHERE project_id=$1 AND deleted_at IS NULL`,
            [id],
          )
        ).rowCount
      )
        throw new ProblemException('conflict', 'project still has environments');
      const r = await c.query(
        `UPDATE tenancy.projects SET deleted_at=now(), version=version+1 WHERE id=$1 AND deleted_at IS NULL`,
        [id],
      );
      if (!r.rowCount) throw new ProblemException('not_found');
      await enqueue(c, orgId, 'project.deleted', { projectId: id });
      await this.rec('tenancy.project.deleted', orgId, 'project', id);
    });
    await this.retention.onSoftDelete(orgId, 'project', id);
  }

  // ---- environments ----
  async createEnvironment(
    orgId: string,
    projectId: string,
    i: { name: unknown; kind: unknown; dataRegion?: unknown },
  ): Promise<Environment> {
    const n = name(i.name, 'name', 100);
    if (!['dev', 'staging', 'prod'].includes(i.kind as string))
      throw new ProblemException('validation_failed', 'kind must be dev, staging or prod');
    const region = typeof i.dataRegion === 'string' ? i.dataRegion : 'sa-pending';
    const verdict = await this.residency.evaluate(orgId, region); // allow-all stub until M04 (NOT VERIFIED)
    if (!verdict.allowed)
      throw new ProblemException(
        'forbidden',
        verdict.reason ?? 'data region not allowed by residency policy',
      );
    return this.db.withOrg(orgId, async (c) => {
      if (
        !UUID.test(projectId) ||
        !(
          await c.query(`SELECT 1 FROM tenancy.projects WHERE id=$1 AND deleted_at IS NULL`, [
            projectId,
          ])
        ).rowCount
      )
        throw new ProblemException('not_found');
      try {
        const id = uuidv7();
        const r = (
          await c.query(
            `INSERT INTO tenancy.environments (id, org_id, project_id, name, kind, data_region) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [id, orgId, projectId, n, i.kind, region],
          )
        ).rows[0];
        await enqueue(c, orgId, 'environment.created', { environmentId: id, projectId });
        await this.rec('tenancy.environment.created', orgId, 'environment', id);
        return en(r);
      } catch (e) {
        return dup(e, 'an environment with this name already exists in the project');
      }
    });
  }
  async listEnvironments(orgId: string, projectId: string): Promise<Page<Environment>> {
    if (!UUID.test(projectId)) throw new ProblemException('not_found');
    return this.db.withOrg(orgId, async (c) => {
      if (
        !(
          await c.query(`SELECT 1 FROM tenancy.projects WHERE id=$1 AND deleted_at IS NULL`, [
            projectId,
          ])
        ).rowCount
      )
        throw new ProblemException('not_found');
      const rows = (
        await c.query(
          `SELECT * FROM tenancy.environments WHERE project_id=$1 AND deleted_at IS NULL ORDER BY id DESC`,
          [projectId],
        )
      ).rows;
      return { items: rows.map(en), nextCursor: null };
    });
  }
  async updateEnvironment(
    orgId: string,
    projectId: string,
    id: string,
    version: number,
    patch: { name?: unknown },
  ): Promise<Environment> {
    const n = patch.name === undefined ? null : name(patch.name, 'name', 100);
    if (!UUID.test(projectId) || !UUID.test(id)) throw new ProblemException('not_found');
    const belongs = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT 1 FROM tenancy.environments WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
            [id, projectId],
          )
        ).rowCount,
    );
    if (!belongs) throw new ProblemException('not_found'); // wrong project == not found
    return this.versioned(
      orgId,
      id,
      version,
      'environments',
      async (c) =>
        (
          await c.query(
            `UPDATE tenancy.environments SET name=COALESCE($3,name), updated_at=now(), version=version+1 WHERE id=$1 AND version=$2 AND deleted_at IS NULL RETURNING *`,
            [id, version, n],
          )
        ).rows[0],
      en,
      'environment.updated',
    );
  }
  async deleteEnvironment(orgId: string, projectId: string, id: string): Promise<void> {
    await this.db.withOrg(orgId, async (c) => {
      const r = await c.query(
        `UPDATE tenancy.environments SET deleted_at=now(), version=version+1 WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
        [id, UUID.test(projectId) ? projectId : '00000000-0000-0000-0000-000000000000'],
      );
      if (!r.rowCount) throw new ProblemException('not_found');
      await enqueue(c, orgId, 'environment.deleted', { environmentId: id });
      await this.rec('tenancy.environment.deleted', orgId, 'environment', id);
    });
    await this.retention.onSoftDelete(orgId, 'environment', id);
  }

  /** UPDATE ... WHERE version = $expected; 0 rows → 412 if the row exists, else 404. */
  private async versioned<T>(
    orgId: string,
    id: string,
    version: number,
    table: string,
    run: (c: import('pg').PoolClient) => Promise<Row | undefined>,
    shape: (r: Row) => T,
    topic: string,
  ): Promise<T> {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    return this.db.withOrg(orgId, async (c) => {
      let r: Row | undefined;
      try {
        r = await run(c);
      } catch (e) {
        return dup(e, 'name already in use');
      }
      if (!r) {
        const exists = (
          await c.query(`SELECT 1 FROM tenancy.${table} WHERE id=$1 AND deleted_at IS NULL`, [id])
        ).rowCount;
        throw new ProblemException(exists ? 'precondition_failed' : 'not_found');
      }
      await enqueue(c, orgId, topic, { id });
      await this.rec(`tenancy.${topic}` as AuditAction, orgId, topic.split('.')[0]!, id);
      return shape(r);
    });
  }
}
