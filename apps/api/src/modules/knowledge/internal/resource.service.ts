import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, parseLimit } from '../../../common/pagination';
import {
  PLATFORMS,
  REUSE_SCOPES,
  RESOURCE_TYPES,
  STATES,
  VISIBILITIES,
  isUuid,
  oneOf,
  stringList,
  text,
  toResource,
  type Row,
} from './model';

export interface ResourceFilters {
  type?: string;
  status?: string;
  framework?: string;
  platform?: string;
  category?: string;
  visibility?: string;
  q?: string;
  source?: string;
  createdFrom?: string;
  createdTo?: string;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);

/**
 * Library resources for staff (ADR-065, S-K1): list, read, edit metadata and permissions, disable, archive. Every read and write here is the PLATFORM library
 * (`org_id IS NULL`); a customer's private templates are never listed in the admin console. Rows are changed only through guarded updates (the database refuses
 * to change a resource's identity or a version's content) and every mutation is audited with before/after.
 */
export class ResourceService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  async list(f: ResourceFilters, rawLimit?: unknown, rawCursor?: unknown) {
    const limit = parseLimit(rawLimit, 25);
    const cursor = decodeCursor(rawCursor);
    const where: string[] = ['org_id IS NULL', 'deleted_at IS NULL'];
    const args: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      args.push(v);
      where.push(sql.replace('?', `$${args.length}`));
    };
    if (f.type) add('resource_type = ?', oneOf(RESOURCE_TYPES, f.type, 'type'));
    if (f.status) add('status = ?', oneOf(STATES, f.status, 'status'));
    if (f.platform) add('platform = ?', oneOf(PLATFORMS, f.platform, 'platform'));
    if (f.visibility) add('visibility = ?', oneOf(VISIBILITIES, f.visibility, 'visibility'));
    if (f.framework) add('? = ANY (frameworks)', f.framework.slice(0, 60));
    if (f.category) add('category = ?', f.category.slice(0, 80));
    if (f.source) add('source_kind = ?', f.source.slice(0, 20));
    if (f.q) {
      args.push(`%${f.q.slice(0, 100).replace(/[%_\\]/g, '\\$&')}%`);
      where.push(
        `(name ILIKE $${args.length} OR description ILIKE $${args.length} OR EXISTS (SELECT 1 FROM unnest(tags) t WHERE t ILIKE $${args.length}))`,
      );
    }
    for (const [k, col, op] of [
      ['createdFrom', 'created_at', '>='],
      ['createdTo', 'created_at', '<='],
    ] as const) {
      const v = f[k];
      if (v) {
        if (Number.isNaN(Date.parse(v)))
          throw new ProblemException('validation_failed', `${k} must be a date-time`);
        add(`${col} ${op} ?`, new Date(v));
      }
    }
    if (cursor) add('id < ?', cursor);
    args.push(limit + 1);
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT * FROM knowledge.resources WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${args.length}`,
            args,
          )
        ).rows as Row[],
    );
    return pageOf(rows.map(toResource), limit);
  }

  async get(id: string) {
    if (!isUuid(id)) throw new ProblemException('not_found', 'resource not found');
    const out = await this.db.withPlatformScope(async (c) => {
      const r = (
        await c.query(
          `SELECT * FROM knowledge.resources WHERE id = $1 AND org_id IS NULL AND deleted_at IS NULL`,
          [id],
        )
      ).rows[0] as Row | undefined;
      if (!r) return null;
      const perms = (
        await c.query(`SELECT * FROM knowledge.resource_permissions WHERE resource_id = $1`, [id])
      ).rows[0] as Row | undefined;
      const version = r.current_version_id
        ? ((
            await c.query(`SELECT * FROM knowledge.resource_versions WHERE id = $1`, [
              r.current_version_id,
            ])
          ).rows[0] as Row | undefined)
        : undefined;
      const quality = (
        await c.query(
          `SELECT DISTINCT ON (dimension) dimension, score, method, evidence_ref, measured
             FROM knowledge.quality_scores WHERE version_id = $1 ORDER BY dimension, computed_at DESC`,
          [r.current_version_id ?? id],
        )
      ).rows as Row[];
      const comps = Number(
        (
          await c.query(
            `SELECT count(*) AS n FROM knowledge.resource_components WHERE version_id = $1`,
            [r.current_version_id ?? id],
          )
        ).rows[0]!.n,
      );
      const jobs = (
        await c.query(
          `SELECT * FROM knowledge.processing_jobs WHERE version_id = $1 ORDER BY created_at DESC LIMIT 20`,
          [r.current_version_id ?? id],
        )
      ).rows as Row[];
      const manifest = (
        await c.query(
          `SELECT schema_version, manifest FROM knowledge.resource_manifests WHERE version_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [r.current_version_id ?? id],
        )
      ).rows[0] as Row | undefined;
      return { r, perms, version, quality, comps, jobs, manifest };
    });
    if (!out) throw new ProblemException('not_found', 'resource not found');
    const { r, perms, version, quality, comps, jobs, manifest } = out;
    return {
      ...toResource(r),
      metadata: {
        name: r.name,
        description: r.description,
        resourceType: r.resource_type,
        platform: r.platform,
        frameworks: r.frameworks,
        languages: r.languages,
        category: r.category,
        tags: r.tags,
        source: r.source_ref,
        visibility: r.visibility,
        defaultEligible: r.default_eligible,
        dataRegion: r.data_region,
      },
      permissions: perms
        ? {
            reuseScope: perms.reuse_scope,
            aiProcessing: perms.ai_processing,
            componentReuse: perms.component_reuse,
            starterEligible: perms.starter_eligible,
            architectureReference: perms.architecture_reference,
            licenseSpdx: perms.license_spdx,
            licenseVerdict: perms.license_verdict,
          }
        : null,
      currentVersion: version
        ? {
            id: version.id,
            seq: version.seq,
            state: version.state,
            licenseVerdict: version.license_verdict,
            bytes: Number(version.bytes),
            checksumSha256: version.checksum_sha256,
          }
        : null,
      manifest: manifest
        ? { schemaVersion: manifest.schema_version, ...summarizeManifest(manifest.manifest as Row) }
        : null,
      quality: quality.map((q) => ({
        dimension: q.dimension,
        score: q.score === null ? null : Number(q.score),
        method: q.method,
        evidenceRef: q.evidence_ref,
        measured: q.measured,
      })),
      componentCount: comps,
      jobs: jobs.map(toJob),
    };
  }

  /** `If-Match` carries the resource `version`. Allowed: metadata, visibility (publish permission), permissions (AI processing needs publish). */
  async patch(
    actor: string,
    canPublish: boolean,
    id: string,
    ifMatch: string | undefined,
    body: Row,
  ) {
    if (!isUuid(id)) throw new ProblemException('not_found', 'resource not found');
    const expected = Number((ifMatch ?? '').replace(/^W\//, '').replace(/"/g, ''));
    if (!Number.isInteger(expected) || expected < 1)
      throw new ProblemException(
        'validation_failed',
        'If-Match is required (the resource version)',
      );
    const sets: string[] = [];
    const args: unknown[] = [];
    const set = (col: string, v: unknown) => {
      args.push(v);
      sets.push(`${col} = $${args.length}`);
    };
    if ('name' in body) set('name', text(body.name, 'name', 200, false));
    if ('description' in body) set('description', text(body.description, 'description', 4000));
    if ('category' in body) set('category', text(body.category, 'category', 80));
    if ('tags' in body) set('tags', stringList(body.tags, 'tags'));
    if ('frameworks' in body) set('frameworks', stringList(body.frameworks, 'frameworks'));
    if ('platform' in body)
      set('platform', oneOf(PLATFORMS, body.platform, 'platform', true) ?? null);
    if ('defaultEligible' in body) {
      if (typeof body.defaultEligible !== 'boolean')
        throw new ProblemException('validation_failed', 'defaultEligible must be true or false');
      if (body.defaultEligible && !canPublish)
        throw new ProblemException(
          'forbidden',
          'making a resource default-eligible needs the publish permission',
        );
      set('default_eligible', body.defaultEligible);
    }
    if ('visibility' in body) {
      const v = oneOf(VISIBILITIES, body.visibility, 'visibility')!;
      if (v === 'PLATFORM_PUBLISHED' && !canPublish)
        throw new ProblemException(
          'forbidden',
          'publishing a resource needs the publish permission',
        );
      set('visibility', v);
    }
    const p = (body.permissions ?? undefined) as Row | undefined;
    const permSets: string[] = [];
    const permArgs: unknown[] = [];
    const pset = (col: string, v: unknown) => {
      permArgs.push(v);
      permSets.push(`${col} = $${permArgs.length + 1}`);
    };
    if (p) {
      if ('reuseScope' in p)
        pset('reuse_scope', oneOf(REUSE_SCOPES, p.reuseScope, 'permissions.reuseScope'));
      for (const [k, col] of [
        ['componentReuse', 'component_reuse'],
        ['starterEligible', 'starter_eligible'],
        ['architectureReference', 'architecture_reference'],
        ['aiProcessing', 'ai_processing'],
      ] as const)
        if (k in p) {
          if (typeof p[k] !== 'boolean')
            throw new ProblemException(
              'validation_failed',
              `permissions.${k} must be true or false`,
            );
          if (k === 'aiProcessing' && p[k] === true && !canPublish)
            throw new ProblemException(
              'forbidden',
              'allowing AI processing of a resource needs the publish permission',
            );
          pset(col, p[k]);
        }
      if ('licenseSpdx' in p)
        pset('license_spdx', text(p.licenseSpdx, 'permissions.licenseSpdx', 120));
      // the licence VERDICT is never set here: it is decided by the review (S-K2) and the database refuses ACTIVE without ALLOWED
      if ('licenseVerdict' in p)
        throw new ProblemException(
          'validation_failed',
          'the licence verdict is decided by review, not edited',
        );
    }
    if (sets.length === 0 && permSets.length === 0)
      throw new ProblemException('validation_failed', 'nothing to change');

    const result = await this.db.withPlatformScope(async (c) => {
      const before = (
        await c.query(
          `SELECT * FROM knowledge.resources WHERE id = $1 AND org_id IS NULL AND deleted_at IS NULL FOR UPDATE`,
          [id],
        )
      ).rows[0] as Row | undefined;
      if (!before) throw new ProblemException('not_found', 'resource not found');
      if (Number(before.version) !== expected)
        throw new ProblemException('conflict', 'the resource changed: reload and try again');
      if (before.status === 'ARCHIVED')
        throw new ProblemException('conflict', 'the resource is archived');
      const after =
        sets.length > 0
          ? ((
              await c.query(
                `UPDATE knowledge.resources SET ${sets.join(', ')} WHERE id = $${args.length + 1} RETURNING *`,
                [...args, id],
              )
            ).rows[0] as Row)
          : ((
              await c.query(
                `UPDATE knowledge.resources SET updated_at = now() WHERE id = $1 RETURNING *`,
                [id],
              )
            ).rows[0] as Row);
      if (permSets.length > 0)
        await c.query(
          `UPDATE knowledge.resource_permissions SET ${permSets.join(', ')}, updated_by = $${permArgs.length + 2}, updated_at = now() WHERE resource_id = $1`,
          [id, ...permArgs, actor],
        );
      return { before, after };
    });
    await this.audit.record({
      action: 'knowledge.resource.updated',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'knowledge_resource', id },
      outcome: 'success',
      before: pick(result.before),
      after: pick(result.after),
      detail: { permissionsChanged: permSets.length > 0 },
    });
    return this.get(id);
  }

  async versions(id: string, rawLimit?: unknown, rawCursor?: unknown) {
    if (!isUuid(id)) throw new ProblemException('not_found', 'resource not found');
    const limit = parseLimit(rawLimit, 25);
    const cursor = decodeCursor(rawCursor);
    const rows = await this.db.withPlatformScope(async (c) => {
      const exists = await c.query(
        `SELECT 1 FROM knowledge.resources WHERE id = $1 AND org_id IS NULL AND deleted_at IS NULL`,
        [id],
      );
      if (!exists.rowCount) throw new ProblemException('not_found', 'resource not found');
      return (
        await c.query(
          `SELECT * FROM knowledge.resource_versions WHERE resource_id = $1 ${cursor ? 'AND id < $3' : ''} ORDER BY id DESC LIMIT $2`,
          cursor ? [id, limit + 1, cursor] : [id, limit + 1],
        )
      ).rows as Row[];
    });
    return pageOf(
      rows.map((v) => ({
        id: v.id as string,
        seq: Number(v.seq),
        semver: (v.semver as string | null) ?? null,
        state: v.state as string,
        checksumSha256: v.checksum_sha256 as string,
        bytes: Number(v.bytes),
        sourceCommit: (v.source_commit as string | null) ?? null,
        licenseVerdict: v.license_verdict as string,
        createdAt: iso(v.created_at),
        activatedAt: iso(v.activated_at),
      })),
      limit,
    );
  }

  /** Disable: new generations stop using it at once; customer copies are unaffected. */
  async disable(actor: string, id: string, reason: unknown) {
    return this.retire(actor, id, reason, 'DISABLED', 'knowledge.resource.disabled');
  }
  /** Archive: soft delete under the retention policy (`deleted_at`); versions are kept. */
  async archive(actor: string, id: string, reason: unknown) {
    return this.retire(actor, id, reason, 'ARCHIVED', 'knowledge.resource.archived');
  }

  private async retire(
    actor: string,
    id: string,
    reason: unknown,
    status: 'DISABLED' | 'ARCHIVED',
    action: 'knowledge.resource.disabled' | 'knowledge.resource.archived',
  ) {
    if (!isUuid(id)) throw new ProblemException('not_found', 'resource not found');
    const why = text(reason, 'reason', 500, false)!;
    const out = await this.db.withPlatformScope(async (c) => {
      const before = (
        await c.query(
          `SELECT * FROM knowledge.resources WHERE id = $1 AND org_id IS NULL AND deleted_at IS NULL FOR UPDATE`,
          [id],
        )
      ).rows[0] as Row | undefined;
      if (!before) throw new ProblemException('not_found', 'resource not found');
      if (before.status === 'ARCHIVED')
        throw new ProblemException('conflict', 'the resource is already archived');
      if (status === 'DISABLED' && before.status === 'DISABLED')
        throw new ProblemException('conflict', 'the resource is already disabled');
      const after = (
        await c.query(
          `UPDATE knowledge.resources SET status = $2, visibility = 'PLATFORM_PRIVATE', default_eligible = false${status === 'ARCHIVED' ? ', deleted_at = now()' : ''} WHERE id = $1 RETURNING *`,
          [id, status],
        )
      ).rows[0] as Row;
      // an ACTIVE version stops being served: its state follows the resource (the history stays)
      await c.query(
        `UPDATE knowledge.resource_versions SET state = $2, retired_at = now() WHERE resource_id = $1 AND state = 'ACTIVE'`,
        [id, status],
      );
      return { before, after };
    });
    await this.audit.record({
      action,
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'knowledge_resource', id },
      outcome: 'success',
      before: pick(out.before),
      after: pick(out.after),
      detail: { reason: why },
    });
    return toResource(out.after);
  }
}

const pick = (r: Row) => ({
  name: r.name,
  status: r.status,
  visibility: r.visibility,
  platform: r.platform,
  category: r.category,
  defaultEligible: r.default_eligible,
  tags: r.tags,
  frameworks: r.frameworks,
});

const toJob = (j: Row) => ({
  id: j.id as string,
  kind: j.kind as string,
  state: j.state as string,
  attempt: Number(j.attempt),
  progress: Number(j.progress),
  errorCode: (j.error_code as string | null) ?? null,
  errorDetail: (j.error_detail as string | null) ?? null,
  startedAt: iso(j.started_at),
  finishedAt: iso(j.finished_at),
});

/** Only the facts a staff member needs at a glance; every capability keeps its confidence and evidence. */
function summarizeManifest(m: Row) {
  const caps = Array.isArray(m.capabilities) ? (m.capabilities as Row[]) : [];
  return {
    frameworks: Array.isArray(m.frameworks) ? m.frameworks : [],
    languages: Array.isArray(m.languages) ? m.languages : [],
    modules: Array.isArray(m.modules) ? m.modules : [],
    components: Array.isArray(m.components) ? m.components : [],
    capabilities: caps.map((c) => ({
      name: c.name,
      confidence: c.confidence,
      evidence: Array.isArray(c.evidence) ? c.evidence : [],
    })),
  };
}
