import type { Db } from '@nuzm/platform';
import {
  allowedUsages,
  groupMatches,
  normalizeText,
  termGroups,
  type Mode,
  type Permissions,
  type Usage,
} from '@nuzm/domain';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { isUuid, newId, oneOf, type Row } from './model';
import { KnowledgeObjectStore } from './object-store';
import { RetrievalService } from './retrieval.service';

/**
 * What a customer may do with the platform library (S-K7, SCR-K-08): browse the published templates, ask for a recommendation, prepare a copy and record a plan.
 * The contract (SCR-K-01 §3): a customer never receives file contents, object keys, file paths, manifest excerpts, search-document text or the names and reasons of resources it may not
 * see; a resource that is not ACTIVE, published, licence-eligible and reuse-permitted is 404 to customers. Metadata comes ONLY from `knowledge.v_published_templates`; the files of a
 * copy come ONLY from `knowledge.v_template_copy_files`, which is empty unless the transaction names one eligible version. Everything here is tenant-scoped (`withOrg`): usage events
 * and plans are the customer's own rows.
 */
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);
const MAX_ROWS = 500;
/** Reasons that would tell a customer a resource exists although it may not see it: they are answered as "not found". */
const HIDDEN_REASONS = new Set([
  'not_found',
  'archived',
  'not_active',
  'no_active_version',
  'not_published',
  'license_not_allowed',
  'no_reuse_permission',
]);

export interface TemplateDto {
  id: string;
  versionId: string;
  versionSeq: number;
  semver: string | null;
  name: string;
  description: string | null;
  resourceType: string;
  platform: string | null;
  frameworks: string[];
  languages: string[];
  category: string | null;
  tags: string[];
  ownership: 'PLATFORM' | 'OWN';
  reuse: {
    scope: string;
    componentReuse: boolean;
    starterEligible: boolean;
    architectureReference: boolean;
    usages: Usage[];
  };
  license: { spdx: string | null; verdict: string };
  design: Row | null;
  capabilities: string[];
  componentCount: number;
  previewCount: number;
}
export interface CopyFile {
  path: string;
  bytes: number;
  sha256: string;
  language: string | null;
  objectKey: string;
}
export interface CopyPlan {
  resourceId: string;
  versionId: string;
  versionSeq: number | null;
  name: string;
  license: { spdx: string | null };
  mode: Mode;
  usage: Usage | null;
  files: CopyFile[];
}

const permsOf = (r: Row): Permissions => ({
  licenseVerdict: r.license_verdict as string,
  reuseScope: r.reuse_scope as string,
  componentReuse: r.component_reuse === true,
  starterEligible: r.starter_eligible === true,
  architectureReference: r.architecture_reference === true,
  aiProcessing: false,
});
const toDto = (r: Row, orgId: string): TemplateDto => {
  const perms = permsOf(r);
  const caps = Array.isArray(r.capabilities)
    ? (r.capabilities as { name?: unknown }[])
        .map((c) => c.name)
        .filter((n): n is string => typeof n === 'string')
    : [];
  return {
    id: r.resource_id as string,
    versionId: r.version_id as string,
    versionSeq: Number(r.version_seq),
    semver: (r.semver as string | null) ?? null,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    resourceType: r.resource_type as string,
    platform: (r.platform as string | null) ?? null,
    frameworks: (r.frameworks as string[]) ?? [],
    languages: (r.languages as string[]) ?? [],
    category: (r.category as string | null) ?? null,
    tags: (r.tags as string[]) ?? [],
    ownership: r.org_id === orgId ? 'OWN' : 'PLATFORM',
    reuse: {
      scope: perms.reuseScope,
      componentReuse: perms.componentReuse,
      starterEligible: perms.starterEligible,
      architectureReference: perms.architectureReference,
      usages: allowedUsages(perms),
    },
    license: { spdx: (r.license_spdx as string | null) ?? null, verdict: perms.licenseVerdict },
    design: (r.design_dna as Row | null) ?? null,
    capabilities: caps,
    componentCount: Number(r.component_count ?? 0),
    previewCount: Array.isArray(r.preview_keys) ? r.preview_keys.length : 0,
  };
};

export class CustomerTemplateService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly retrieval: RetrievalService,
    private readonly store: KnowledgeObjectStore,
  ) {}

  // ---- gallery ---------------------------------------------------------------------------------------------------------------------
  /** The published templates of the platform library (and the customer's own private ones), filtered; text search is over the published metadata only. */
  async list(
    orgId: string,
    q: {
      q?: string;
      type?: string;
      platform?: string;
      framework?: string;
      category?: string;
      tag?: string;
    },
    rawLimit?: string,
    rawCursor?: string,
  ) {
    const limit = Math.min(Math.max(Number(rawLimit ?? 24) || 24, 1), 60);
    const rows = await this.db.withOrg(orgId, async (c) => {
      const args: unknown[] = [];
      let where = 'true';
      if (q.type) {
        args.push(
          oneOf(
            [
              'PROJECT',
              'THEME',
              'COMPONENT_LIBRARY',
              'DESIGN_SYSTEM',
              'DOCUMENTATION',
              'API_SPECIFICATION',
              'DATABASE_SCHEMA',
              'STARTER_KIT',
              'REUSABLE_MODULE',
            ] as const,
            q.type,
            'type',
          ),
        );
        where += ` AND resource_type = $${args.length}`;
      }
      if (q.platform) {
        args.push(
          oneOf(
            ['WEB', 'MOBILE', 'BACKEND', 'FULL_STACK', 'CROSS_PLATFORM'] as const,
            q.platform,
            'platform',
          ),
        );
        where += ` AND platform = $${args.length}`;
      }
      if (q.framework) {
        args.push(q.framework.slice(0, 40).toLowerCase());
        where += ` AND EXISTS (SELECT 1 FROM unnest(frameworks) f WHERE lower(f) = $${args.length})`;
      }
      if (q.category) {
        args.push(q.category.slice(0, 80).toLowerCase());
        where += ` AND lower(category) = $${args.length}`;
      }
      if (q.tag) {
        args.push(q.tag.slice(0, 60).toLowerCase());
        where += ` AND EXISTS (SELECT 1 FROM unnest(tags) t WHERE lower(t) = $${args.length})`;
      }
      return (
        await c.query(
          `SELECT * FROM knowledge.v_published_templates WHERE ${where} ORDER BY name, resource_id LIMIT ${MAX_ROWS}`,
          args,
        )
      ).rows as Row[];
    });
    let items = rows.map((r) => toDto(r, orgId));
    const text0 = (q.q ?? '').slice(0, 300).trim();
    if (text0) {
      const groups = termGroups(text0);
      items = items.filter((t) => {
        const hay = normalizeText(
          [
            t.name,
            t.description ?? '',
            t.category ?? '',
            t.tags.join(' '),
            t.frameworks.join(' '),
            t.capabilities.join(' '),
          ].join(' '),
        );
        return groups.length > 0 && groups.some((g) => groupMatches(hay, g));
      });
    }
    let start = 0;
    if (rawCursor) {
      const after = Buffer.from(rawCursor, 'base64url').toString('utf8');
      const i = items.findIndex((t) => `${t.name}\u0000${t.id}` === after);
      if (i < 0) throw new ProblemException('validation_failed', 'cursor is not valid');
      start = i + 1;
    }
    const page = items.slice(start, start + limit);
    const last = page[page.length - 1];
    return {
      items: page,
      nextCursor:
        start + limit < items.length && last
          ? Buffer.from(`${last.name}\u0000${last.id}`).toString('base64url')
          : null,
    };
  }

  async get(orgId: string, resourceId: string): Promise<TemplateDto> {
    if (!isUuid(resourceId)) throw new ProblemException('not_found', 'template not found');
    const row = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT * FROM knowledge.v_published_templates WHERE resource_id = $1`, [
            resourceId.toLowerCase(),
          ])
        ).rows[0] as Row | undefined,
    );
    if (!row) throw new ProblemException('not_found', 'template not found');
    return toDto(row, orgId);
  }

  // ---- recommendation --------------------------------------------------------------------------------------------------------------
  /** The engine of S-K5, answered for a customer: only what the customer may see (no exclusion list, no document text, no paths, nothing about unpublished resources). */
  async recommend(orgId: string, body: Row) {
    const r = (await this.retrieval.recommend({
      ...body,
      requiresAiProcessing: undefined,
    })) as unknown as Row;
    const strip = (c: Row) => ({
      resourceId: c.resourceId,
      versionId: c.versionId,
      versionSeq: c.versionSeq,
      name: c.name,
      resourceType: c.resourceType,
      platform: c.platform,
      frameworks: c.frameworks,
      category: c.category,
      score: c.score,
      confidence: c.confidence,
      gated: c.gated,
      dimensions: c.dimensions,
      usage: c.usage,
      license: c.license,
      components: ((c.components as { name: string }[]) ?? [])
        .slice(0, 6)
        .map((x) => ({ name: x.name })),
    });
    const ranked = ((r.ranked as Row[]) ?? []).map(strip);
    const decision = r.decision as Row;
    let userChoice: { resourceId: string; reasons: string[] } | null = null;
    const uc = r.userChoice as { resourceId: string; reasons: string[] } | null;
    if (uc)
      userChoice = {
        resourceId: uc.resourceId,
        reasons: uc.reasons.some((x) => HIDDEN_REASONS.has(x)) ? ['not_found'] : uc.reasons,
      };
    const stats = r.stats as Row;
    if (ranked.length)
      await this.db.withOrg(orgId, async (c) => {
        for (const x of ranked.slice(0, 3))
          await c.query(
            `INSERT INTO knowledge.usage_events (id, org_id, resource_id, version_id, kind) VALUES ($1,$2,$3,$4,'RECOMMENDED')`,
            [newId(), orgId, x.resourceId, x.versionId],
          );
      });
    return {
      requirement: { groups: (r.requirement as Row).groups },
      decision: {
        requested: decision.requested,
        strategy: decision.strategy,
        selectedResourceId: decision.selectedResourceId,
        notes: decision.notes,
      },
      selected: r.selected ? strip(r.selected as Row) : null,
      userChoice,
      ranked,
      alternatives: userChoice ? [] : ((r.alternatives as Row[]) ?? []).map(strip),
      stats: { eligible: stats.eligible, ranked: ranked.length },
    };
  }

  // ---- copy ------------------------------------------------------------------------------------------------------------------------
  /** Re-checks eligibility for the mode at copy time and returns the stored text files of the pinned version. Nothing is written; the files are read only through the guarded view. */
  async prepareCopy(
    orgId: string,
    input: { resourceId: unknown; versionId?: unknown; mode?: unknown },
  ): Promise<CopyPlan> {
    if (!isUuid(input.resourceId)) throw new ProblemException('not_found', 'template not found');
    const mode = oneOf(
      ['STRICT', 'ADAPTIVE', 'CREATIVE'] as const,
      input.mode ?? 'ADAPTIVE',
      'adaptationMode',
    ) as Mode;
    const resourceId = input.resourceId.toLowerCase();
    const pin =
      input.versionId === undefined || input.versionId === null
        ? null
        : isUuid(input.versionId)
          ? input.versionId.toLowerCase()
          : (() => {
              throw new ProblemException('validation_failed', 'versionId must be a version id');
            })();
    const r = (await this.retrieval.recommend({
      strategy: 'USER_SELECTED',
      resourceId,
      mode,
      limit: 1,
    })) as unknown as Row;
    const sel = r.selected as Row | null;
    if (!sel) {
      const reasons = ((r.userChoice as { reasons: string[] } | null)?.reasons ?? [
        'not_found',
      ]) as string[];
      if (reasons.some((x) => HIDDEN_REASONS.has(x)))
        throw new ProblemException('not_found', 'template not found');
      throw new ProblemException(
        'knowledge_template_incompatible',
        'this template cannot be used in the chosen mode',
        reasons.map((x) => ({ field: 'mode', message: x })),
      );
    }
    const versionId = sel.versionId as string;
    if (pin && pin !== versionId)
      throw new ProblemException(
        'knowledge_template_incompatible',
        'the template changed since it was shown: its active version is no longer the one you chose',
        [{ field: 'versionId', message: 'pinned_version_unavailable' }],
      );
    const rows = await this.db.withOrg(orgId, async (c) => {
      await c.query(`SELECT set_config('app.template_copy_version', $1, true)`, [versionId]);
      return (
        await c.query(
          `SELECT path, bytes::text AS bytes, sha256, language, object_key FROM knowledge.v_template_copy_files WHERE version_id = $1 ORDER BY path LIMIT 6000`,
          [versionId],
        )
      ).rows as Row[];
    });
    if (rows.length === 0)
      throw new ProblemException(
        'unsupported_capability',
        'this template has no stored files to copy',
      );
    return {
      resourceId,
      versionId,
      versionSeq: (sel.versionSeq as number | null) ?? null,
      name: sel.name as string,
      license: { spdx: ((sel.license as Row).spdx as string | null) ?? null },
      mode,
      usage: ((sel.usage as Row).recommended as Usage | null) ?? null,
      files: rows.map((x) => ({
        path: x.path as string,
        bytes: Number(x.bytes),
        sha256: x.sha256 as string,
        language: (x.language as string | null) ?? null,
        objectKey: x.object_key as string,
      })),
    };
  }

  /** The bytes of one stored file of a prepared copy. Server side only. */
  async readFile(objectKey: string): Promise<Buffer> {
    return this.store.read(objectKey);
  }

  /** The customer's own record of a copy: usage events, the link from the project to the pinned version, and the audit event. */
  async recordCopied(
    orgId: string,
    actor: string,
    a: {
      resourceId: string;
      versionId: string;
      projectId: string;
      mode: Mode;
      usage: Usage | null;
      copied: number;
      skipped: number;
      planId?: string | null;
      /** path → sha256 of exactly the files the copy wrote (S-K6: what the workspace is later compared with) */
      baseline?: Record<string, string>;
    },
  ) {
    await this.db.withOrg(orgId, async (c) => {
      for (const kind of ['SELECTED', 'COPIED'])
        await c.query(
          `INSERT INTO knowledge.usage_events (id, org_id, resource_id, version_id, kind) VALUES ($1,$2,$3,$4,$5)`,
          [newId(), orgId, a.resourceId, a.versionId, kind],
        );
      await c.query(
        `INSERT INTO knowledge.generation_resource_links (id, org_id, plan_id, resource_version_id, role, strategy, project_id, baseline) VALUES ($1,$2,$3,$4,'STARTER','COPY',$5,$6::jsonb)`,
        [
          newId(),
          orgId,
          a.planId ?? null,
          a.versionId,
          a.projectId,
          a.baseline ? JSON.stringify(a.baseline) : null,
        ],
      );
    });
    await this.audit.record({
      action: 'knowledge.template.copied',
      actorUserId: actor,
      actorType: 'user',
      orgId,
      resource: { type: 'builder_project', id: a.projectId },
      outcome: 'success',
      detail: {
        resourceId: a.resourceId,
        versionId: a.versionId,
        mode: a.mode,
        usage: a.usage,
        copied: a.copied,
        skipped: a.skipped,
      },
    });
  }

  // ---- plans -----------------------------------------------------------------------------------------------------------------------
  /** Records the requirement and the deterministic selection for a project. Executing a plan (generation) is the run engine's job (S-K6) and needs the model: it is reported as blocked. */
  async createPlan(orgId: string, actor: string, input: { projectId: string; body: Row }) {
    const body = input.body;
    const rec = await this.recommend(orgId, body);
    const mode = oneOf(
      ['STRICT', 'ADAPTIVE', 'CREATIVE'] as const,
      body.mode ?? 'ADAPTIVE',
      'mode',
    );
    const sel = rec.selected;
    const requirements = {
      text: typeof body.text === 'string' ? body.text.slice(0, 2000) : null,
      platform: body.platform ?? null,
      frameworks: Array.isArray(body.frameworks)
        ? (body.frameworks as unknown[]).filter((x) => typeof x === 'string').slice(0, 10)
        : [],
      mode,
      design: body.design ?? null,
    };
    const plan = {
      strategy: rec.decision.strategy,
      notes: rec.decision.notes,
      selected: sel
        ? {
            resourceId: sel.resourceId,
            versionId: sel.versionId,
            name: sel.name,
            score: sel.score,
            confidence: sel.confidence,
            usage: sel.usage,
          }
        : null,
      considered: rec.ranked
        .slice(0, 3)
        .map((x) => ({ resourceId: x.resourceId, versionId: x.versionId, score: x.score })),
      execution: {
        status: 'BLOCKED',
        reason:
          'generation is executed by the run engine with a model (S-K6); this plan only records the requirement and the selection',
      },
    };
    const id = newId();
    await this.db.withOrg(orgId, async (c) => {
      await c.query(
        `INSERT INTO knowledge.generation_plans (id, org_id, project_id, status, selection_strategy, adaptation_mode, requirements, plan, created_by) VALUES ($1,$2,$3,'PLANNED',$4,$5,$6::jsonb,$7::jsonb,$8)`,
        [
          id,
          orgId,
          input.projectId,
          rec.decision.strategy,
          mode,
          JSON.stringify(requirements),
          JSON.stringify(plan),
          actor,
        ],
      );
    });
    await this.audit.record({
      action: 'knowledge.plan.created',
      actorUserId: actor,
      actorType: 'user',
      orgId,
      resource: { type: 'knowledge_plan', id },
      outcome: 'success',
      detail: {
        projectId: input.projectId,
        strategy: rec.decision.strategy,
        selected: sel ? sel.resourceId : null,
      },
    });
    return this.getPlan(orgId, id);
  }
  async getPlan(orgId: string, id: string) {
    if (!isUuid(id)) throw new ProblemException('not_found', 'plan not found');
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT id, project_id, status, selection_strategy, adaptation_mode, requirements, plan, created_at FROM knowledge.generation_plans WHERE id = $1`,
            [id.toLowerCase()],
          )
        ).rows[0] as Row | undefined,
    );
    if (!r) throw new ProblemException('not_found', 'plan not found');
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      status: r.status as string,
      strategy: r.selection_strategy as string,
      mode: r.adaptation_mode as string,
      requirements: r.requirements as Row,
      plan: r.plan as Row,
      createdAt: iso(r.created_at),
    };
  }

  // ---- S-K6: the workspace of a copied project, and the plan's run -------------------------------------------------------------------
  /** A plan of this organization, with the run it started (if any). 404 for another organization's plan. */
  async planRow(orgId: string, id: string): Promise<Row> {
    if (!isUuid(id)) throw new ProblemException('not_found', 'plan not found');
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT * FROM knowledge.generation_plans WHERE id = $1`, [
            id.toLowerCase(),
          ])
        ).rows[0] as Row | undefined,
    );
    if (!r) throw new ProblemException('not_found', 'plan not found');
    return r;
  }

  /** The newest template copy recorded for a project that has a baseline (copies made before S-K6 have none). Tenant rows only. */
  async linkForProject(
    orgId: string,
    projectId: string,
  ): Promise<{
    versionId: string;
    baseline: Record<string, string>;
    createdAt: string | null;
  } | null> {
    if (!isUuid(projectId)) return null;
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT resource_version_id, baseline, created_at FROM knowledge.generation_resource_links
              WHERE project_id = $1 AND baseline IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
            [projectId.toLowerCase()],
          )
        ).rows[0] as Row | undefined,
    );
    if (!r) return null;
    return {
      versionId: r.resource_version_id as string,
      baseline: r.baseline as Record<string, string>,
      createdAt: iso(r.created_at),
    };
  }

  /** What may be said about the template of a copy and what its permission allows. `null` once the template is no longer eligible (disabled, withdrawn, licence changed): the diff still works from the baseline. */
  async templateFacts(
    orgId: string,
    versionId: string,
  ): Promise<{ template: TemplateDto; aiProcessing: boolean } | null> {
    if (!isUuid(versionId)) return null;
    const rows = await this.db.withOrg(orgId, async (c) => {
      const t = (
        await c.query(`SELECT * FROM knowledge.v_published_templates WHERE version_id = $1`, [
          versionId.toLowerCase(),
        ])
      ).rows[0] as Row | undefined;
      const p = (
        await c.query(
          `SELECT ai_processing FROM knowledge.v_template_context_permissions WHERE version_id = $1`,
          [versionId.toLowerCase()],
        )
      ).rows[0] as Row | undefined;
      return { t, p };
    });
    if (!rows.t) return null;
    return { template: toDto(rows.t, orgId), aiProcessing: rows.p?.ai_processing === true };
  }

  /** The plan has started a run: PLANNED → RUNNING, once. `false` when it was not PLANNED any more (a second start). */
  async attachRun(orgId: string, planId: string, runId: string): Promise<boolean> {
    return this.db.withOrg(
      orgId,
      async (c) =>
        ((
          await c.query(
            `UPDATE knowledge.generation_plans SET status = 'RUNNING', run_id = $2, version = version + 1
              WHERE id = $1 AND status = 'PLANNED' AND run_id IS NULL`,
            [planId, runId],
          )
        ).rowCount ?? 0) === 1,
    );
  }

  /** The plan follows its run: RUNNING → COMPLETED | FAILED | CANCELLED (never backwards). */
  async settlePlan(
    orgId: string,
    planId: string,
    status: 'COMPLETED' | 'FAILED' | 'CANCELLED',
  ): Promise<void> {
    await this.db.withOrg(orgId, async (c) => {
      await c.query(
        `UPDATE knowledge.generation_plans SET status = $2, version = version + 1 WHERE id = $1 AND status = 'RUNNING'`,
        [planId, status],
      );
    });
  }
}
