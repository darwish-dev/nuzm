import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, parseLimit } from '../../../common/pagination';
import { isUuid, newId, oneOf, text, type Row } from './model';

/**
 * Processing visibility and the review gate of the AI Intelligence Center (S-K2a, ADR-065 / SCR-K-02): jobs, logs, scan findings, the file inventory, approvals and
 * activation. Every rule that matters is ALSO enforced by the database (state machine, activation guard, review guard), so a mistake here can only produce a clearer or a
 * stricter error, never an activation the database would refuse. Customers never reach any of this: it is platform-scope only and reads platform rows (org_id NULL).
 */
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);
const REVIEWABLE = ['AWAITING_REVIEW'];
const COMPONENT_KINDS = [
  'react-component',
  'react-class-component',
  'next-page',
  'next-layout',
  'nest-module',
  'nest-controller',
  'nest-provider',
  'nest-dto',
  'flutter-widget',
  'flutter-stateful-widget',
  'flutter-state',
  'flutter-state-holder',
  'flutter-provider',
] as const;
const RELATIONS = [
  'renders',
  'imports',
  'declares',
  'exports',
  'injects',
  'guarded_by',
  'state_of',
  'routes_to',
  'route_renders',
] as const;
const THEME_CATEGORIES = [
  'color',
  'typography',
  'spacing',
  'radius',
  'shadow',
  'breakpoint',
  'motion',
  'other',
] as const;
const THEME_ORIGINS = [
  'css-var',
  'scss-var',
  'less-var',
  'tailwind-theme',
  'tailwind-config',
  'tokens-json',
  'js-theme',
  'flutter-theme',
] as const;
const RETRYABLE_REASONS = ['processing_failed', 'archive_missing', 'cancelled'];

export interface ReviewEntry {
  id: string;
  decision: string;
  reviewerId: string;
  reason: string | null;
  checklist: Row;
  createdAt: string | null;
}

export class ReviewService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  // ---- processing visibility --------------------------------------------------------------------------------------------------------
  async jobs(
    resourceId: string,
    versionId: string | undefined,
    rawLimit?: string,
    rawCursor?: string,
  ) {
    this.id(resourceId);
    const limit = parseLimit(rawLimit, 25);
    const cursor = decodeCursor(rawCursor);
    const rows = await this.db.withPlatformScope(async (c) => {
      const r = await this.resource(c, resourceId);
      const vid = versionId ? this.id(versionId) : null;
      const args: unknown[] = [resourceId, limit + 1];
      let where = `v.resource_id = $1`;
      if (vid) {
        args.push(vid);
        where += ` AND j.version_id = $${args.length}`;
      }
      if (cursor) {
        args.push(cursor);
        where += ` AND j.id < $${args.length}`;
      }
      void r;
      return (
        await c.query(
          `SELECT j.*, v.seq AS version_seq FROM knowledge.processing_jobs j JOIN knowledge.resource_versions v ON v.id = j.version_id WHERE ${where} ORDER BY j.id DESC LIMIT $2`,
          args,
        )
      ).rows as Row[];
    });
    return pageOf(rows.map(toJob), limit);
  }

  /** Logs of one job, oldest first; `cursor` is the last `seq` seen. */
  async logs(resourceId: string, jobId: string, rawLimit?: string, rawCursor?: string) {
    this.id(resourceId);
    this.id(jobId);
    const limit = parseLimit(rawLimit, 100);
    const after = /^\d{1,15}$/.test(String(rawCursor ?? '')) ? Number(rawCursor) : 0;
    const rows = await this.db.withPlatformScope(async (c) => {
      await this.resource(c, resourceId);
      const j = await c.query(
        `SELECT 1 FROM knowledge.processing_jobs j JOIN knowledge.resource_versions v ON v.id = j.version_id WHERE j.id = $1 AND v.resource_id = $2`,
        [jobId, resourceId],
      );
      if (!j.rowCount) throw new ProblemException('not_found', 'job not found');
      return (
        await c.query(
          `SELECT id, seq::text AS seq, level, stage, code, message, data, created_at FROM knowledge.processing_logs WHERE job_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
          [jobId, after, limit + 1],
        )
      ).rows as Row[];
    });
    const items = rows.slice(0, limit).map((l) => ({
      id: l.id as string,
      seq: Number(l.seq),
      level: l.level as string,
      stage: l.stage as string,
      code: l.code as string,
      message: l.message as string,
      data: l.data as Row,
      createdAt: iso(l.created_at),
    }));
    return { items, nextCursor: rows.length > limit ? String(items[items.length - 1]!.seq) : null };
  }

  async findings(
    resourceId: string,
    versionId: string,
    q: { severity?: string; scanner?: string },
    rawLimit?: string,
    rawCursor?: string,
  ) {
    this.id(resourceId);
    this.id(versionId);
    const limit = parseLimit(rawLimit, 100);
    const cursor = decodeCursor(rawCursor);
    const severity = q.severity
      ? oneOf(['info', 'warn', 'block'] as const, q.severity, 'severity')
      : null;
    const scanner = q.scanner
      ? oneOf(
          [
            'secrets',
            'license',
            'dependencies',
            'risky_files',
            'sensitive_files',
            'archive',
          ] as const,
          q.scanner,
          'scanner',
        )
      : null;
    const out = await this.db.withPlatformScope(async (c) => {
      await this.resource(c, resourceId);
      const v = await this.version(c, resourceId, versionId);
      const args: unknown[] = [versionId, v.analysis_job_id ?? null, limit + 1];
      // findings of the CURRENT analysis (plus rejection findings, which have their own failed job)
      let where = `version_id = $1 AND ($2::uuid IS NULL OR job_id = $2 OR scanner = 'archive')`;
      const and = (clause: string, value: unknown) => {
        args.push(value);
        where += ` AND ${clause.replace('?', `$${args.length}`)}`;
      };
      if (severity) and('severity = ?', severity);
      if (scanner) and('scanner = ?', scanner);
      if (cursor) and('id > ?', cursor);
      const rows = (
        await c.query(
          `SELECT * FROM knowledge.scan_findings WHERE ${where} ORDER BY id LIMIT $3`,
          args,
        )
      ).rows as Row[];
      const counts = (
        await c.query(
          `SELECT severity, count(*)::int AS n FROM knowledge.scan_findings WHERE version_id = $1 AND ($2::uuid IS NULL OR job_id = $2 OR scanner = 'archive') GROUP BY severity`,
          [versionId, v.analysis_job_id ?? null],
        )
      ).rows as Row[];
      return { rows, counts };
    });
    const items = out.rows.slice(0, limit).map((f) => ({
      id: f.id as string,
      scanner: f.scanner as string,
      code: f.code as string,
      severity: f.severity as string,
      path: (f.path as string | null) ?? null,
      line: f.line === null ? null : Number(f.line),
      detail: f.detail as string,
    }));
    const summary = { info: 0, warn: 0, block: 0 } as Record<string, number>;
    for (const r of out.counts) summary[r.severity as string] = Number(r.n);
    return {
      items,
      nextCursor:
        out.rows.length > limit
          ? Buffer.from(items[items.length - 1]!.id).toString('base64url')
          : null,
      summary,
    };
  }

  /** The inventory of the package: path, size, hash, language and whether the content was kept. Never file content. */
  async files(
    resourceId: string,
    versionId: string,
    q: { q?: string; stored?: string },
    rawLimit?: string,
    rawCursor?: string,
  ) {
    this.id(resourceId);
    this.id(versionId);
    const limit = parseLimit(rawLimit, 100);
    const cursor = decodeCursor(rawCursor);
    const rows = await this.db.withPlatformScope(async (c) => {
      await this.resource(c, resourceId);
      await this.version(c, resourceId, versionId);
      const args: unknown[] = [versionId, limit + 1];
      let where = 'version_id = $1';
      const and = (clause: string, value: unknown) => {
        args.push(value);
        where += ` AND ${clause.replace('?', `$${args.length}`)}`;
      };
      if (q.q) and('path ILIKE ?', `%${q.q.slice(0, 100).replace(/[%_\\]/g, '\\$&')}%`);
      if (q.stored === 'true') where += ' AND object_key IS NOT NULL';
      if (q.stored === 'false') where += ' AND object_key IS NULL';
      if (cursor) and('id > ?', cursor);
      return (
        await c.query(
          `SELECT id, path, sha256, bytes::text AS bytes, language, is_binary, is_executable, (object_key IS NOT NULL) AS stored, secret_findings FROM knowledge.resource_files WHERE ${where} ORDER BY id LIMIT $2`,
          args,
        )
      ).rows as Row[];
    });
    const items = rows.slice(0, limit).map((f) => ({
      id: f.id as string,
      path: f.path as string,
      sha256: f.sha256 as string,
      bytes: Number(f.bytes),
      language: (f.language as string | null) ?? null,
      isBinary: f.is_binary as boolean,
      isExecutable: f.is_executable as boolean,
      stored: f.stored as boolean,
      secretFindings: Number(f.secret_findings),
    }));
    return {
      items,
      nextCursor:
        rows.length > limit ? Buffer.from(items[items.length - 1]!.id).toString('base64url') : null,
    };
  }

  /** The component registry of a version (S-K2c): name, kind, framework, file, props, dependencies, style and asset imports, platforms. Never file content. */
  async components(
    resourceId: string,
    versionId: string,
    q: { q?: string; kind?: string; framework?: string },
    rawLimit?: string,
    rawCursor?: string,
  ) {
    this.id(resourceId);
    this.id(versionId);
    const limit = parseLimit(rawLimit, 100);
    const cursor = decodeCursor(rawCursor);
    const rows = await this.db.withPlatformScope(async (c) => {
      await this.resource(c, resourceId);
      await this.version(c, resourceId, versionId);
      const args: unknown[] = [versionId, limit + 1];
      let where = 'version_id = $1';
      if (q.q) {
        args.push(`%${q.q.slice(0, 100).replace(/[%_\\]/g, '\\$&')}%`);
        where += ` AND (name ILIKE $${args.length} OR path ILIKE $${args.length})`;
      }
      if (q.kind) {
        args.push(oneOf(COMPONENT_KINDS, q.kind, 'kind'));
        where += ` AND kind = $${args.length}`;
      }
      if (q.framework) {
        args.push(oneOf(['react', 'next', 'nestjs', 'flutter'] as const, q.framework, 'framework'));
        where += ` AND framework = $${args.length}`;
      }
      if (cursor) {
        args.push(cursor);
        where += ` AND id > $${args.length}`;
      }
      return (
        await c.query(
          `SELECT id, name, kind, framework, path, props, dependencies, style_deps, assets, platforms, reuse_allowed FROM knowledge.resource_components WHERE ${where} ORDER BY id LIMIT $2`,
          args,
        )
      ).rows as Row[];
    });
    const items = rows.slice(0, limit).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      kind: r.kind as string,
      framework: (r.framework as string | null) ?? null,
      path: r.path as string,
      props: r.props as Row[],
      dependencies: r.dependencies as string[],
      styleDeps: r.style_deps as string[],
      assets: r.assets as string[],
      platforms: r.platforms as string[],
      reuseAllowed: r.reuse_allowed === true,
    }));
    return {
      items,
      nextCursor:
        rows.length > limit ? Buffer.from(items[items.length - 1]!.id).toString('base64url') : null,
    };
  }

  /** Relationships of a version (renders, imports, declares, injects, routes_to, ...); `ref` matches either end. */
  async relationships(
    resourceId: string,
    versionId: string,
    q: { relation?: string; ref?: string },
    rawLimit?: string,
    rawCursor?: string,
  ) {
    this.id(resourceId);
    this.id(versionId);
    const limit = parseLimit(rawLimit, 100);
    const cursor = decodeCursor(rawCursor);
    const rows = await this.db.withPlatformScope(async (c) => {
      await this.resource(c, resourceId);
      await this.version(c, resourceId, versionId);
      const args: unknown[] = [versionId, limit + 1];
      let where = 'version_id = $1';
      if (q.relation) {
        args.push(oneOf(RELATIONS, q.relation, 'relation'));
        where += ` AND relation = $${args.length}`;
      }
      if (q.ref) {
        args.push(q.ref.slice(0, 300));
        where += ` AND (from_ref = $${args.length} OR to_ref = $${args.length})`;
      }
      if (cursor) {
        args.push(cursor);
        where += ` AND id > $${args.length}`;
      }
      return (
        await c.query(
          `SELECT id, from_kind, from_ref, to_kind, to_ref, relation, evidence FROM knowledge.resource_relationships WHERE ${where} ORDER BY id LIMIT $2`,
          args,
        )
      ).rows as Row[];
    });
    const items = rows.slice(0, limit).map((r) => ({
      id: r.id as string,
      fromKind: r.from_kind as string,
      fromRef: r.from_ref as string,
      toKind: r.to_kind as string,
      toRef: r.to_ref as string,
      relation: r.relation as string,
      evidence: r.evidence as Row,
    }));
    return {
      items,
      nextCursor:
        rows.length > limit ? Buffer.from(items[items.length - 1]!.id).toString('base64url') : null,
    };
  }

  /** The Design DNA of a version (S-K4): palette roles per mode with evidence and contrast, typography, spacing, radius, shadows, breakpoints, motion, traits; `design: null` when the design analysis has not run. */
  async design(resourceId: string, versionId: string) {
    this.id(resourceId);
    this.id(versionId);
    const row = await this.db.withPlatformScope(async (c) => {
      await this.resource(c, resourceId);
      await this.version(c, resourceId, versionId);
      return (
        await c.query(
          `SELECT result, created_at FROM knowledge.analysis_results WHERE version_id = $1 AND analyzer = 'design-dna' ORDER BY created_at DESC LIMIT 1`,
          [versionId],
        )
      ).rows[0] as Row | undefined;
    });
    return row
      ? { versionId, createdAt: iso(row.created_at), design: row.result as Row }
      : { versionId, createdAt: null, design: null };
  }

  /** The design tokens of a version: category, name, the value as written, the value after references were resolved, the mode, file and line. Computed values are `dynamic` with no value. */
  async themeTokens(
    resourceId: string,
    versionId: string,
    q: { q?: string; category?: string; mode?: string; origin?: string; dynamic?: string },
    rawLimit?: string,
    rawCursor?: string,
  ) {
    this.id(resourceId);
    this.id(versionId);
    const limit = parseLimit(rawLimit, 100);
    const cursor = decodeCursor(rawCursor);
    const rows = await this.db.withPlatformScope(async (c) => {
      await this.resource(c, resourceId);
      await this.version(c, resourceId, versionId);
      const args: unknown[] = [versionId, limit + 1];
      let where = 'version_id = $1';
      if (q.q) {
        args.push(`%${q.q.slice(0, 100).replace(/[%_\\]/g, '\\$&')}%`);
        where += ` AND (name ILIKE $${args.length} OR source_path ILIKE $${args.length})`;
      }
      if (q.category) {
        args.push(oneOf(THEME_CATEGORIES, q.category, 'category'));
        where += ` AND category = $${args.length}`;
      }
      if (q.mode) {
        args.push(q.mode.slice(0, 40));
        where += ` AND mode = $${args.length}`;
      }
      if (q.origin) {
        args.push(oneOf(THEME_ORIGINS, q.origin, 'origin'));
        where += ` AND origin = $${args.length}`;
      }
      if (q.dynamic !== undefined) {
        args.push(oneOf(['true', 'false'] as const, q.dynamic, 'dynamic') === 'true');
        where += ` AND dynamic = $${args.length}`;
      }
      if (cursor) {
        args.push(cursor);
        where += ` AND id > $${args.length}`;
      }
      return (
        await c.query(
          `SELECT id, category, name, value, resolved_value, source_path, mode, line, origin, dynamic FROM knowledge.theme_tokens WHERE ${where} ORDER BY id LIMIT $2`,
          args,
        )
      ).rows as Row[];
    });
    const items = rows.slice(0, limit).map((r) => ({
      id: r.id as string,
      category: r.category as string,
      name: r.name as string,
      value: (r.value as string | null) ?? null,
      resolvedValue: (r.resolved_value as string | null) ?? null,
      sourcePath: (r.source_path as string | null) ?? null,
      mode: r.mode as string,
      line: (r.line as number | null) ?? null,
      origin: r.origin as string,
      dynamic: r.dynamic === true,
    }));
    return {
      items,
      nextCursor:
        rows.length > limit ? Buffer.from(items[items.length - 1]!.id).toString('base64url') : null,
    };
  }

  /** Theme variants of a version: colour schemes, layouts, sidebars, headers, page templates, screens, each with its descriptor (file, component, mode). */
  async themeVariants(
    resourceId: string,
    versionId: string,
    q: { kind?: string },
    rawLimit?: string,
    rawCursor?: string,
  ) {
    this.id(resourceId);
    this.id(versionId);
    const limit = parseLimit(rawLimit, 100);
    const cursor = decodeCursor(rawCursor);
    const rows = await this.db.withPlatformScope(async (c) => {
      await this.resource(c, resourceId);
      await this.version(c, resourceId, versionId);
      const args: unknown[] = [versionId, limit + 1];
      let where = 'version_id = $1';
      if (q.kind) {
        args.push(q.kind.slice(0, 40));
        where += ` AND kind = $${args.length}`;
      }
      if (cursor) {
        args.push(cursor);
        where += ` AND id > $${args.length}`;
      }
      return (
        await c.query(
          `SELECT id, kind, name, descriptor, preview_key FROM knowledge.theme_variants WHERE ${where} ORDER BY id LIMIT $2`,
          args,
        )
      ).rows as Row[];
    });
    const items = rows.slice(0, limit).map((r) => ({
      id: r.id as string,
      kind: r.kind as string,
      name: r.name as string,
      descriptor: r.descriptor as Row,
      hasPreview: r.preview_key != null,
    }));
    return {
      items,
      nextCursor:
        rows.length > limit ? Buffer.from(items[items.length - 1]!.id).toString('base64url') : null,
    };
  }

  /** The evidence-backed project manifest of a version (S-K2b), or `manifest: null` when detection has not run. Full detail; platform scope only. */
  async manifest(resourceId: string, versionId: string) {
    this.id(resourceId);
    this.id(versionId);
    const row = await this.db.withPlatformScope(async (c) => {
      await this.resource(c, resourceId);
      await this.version(c, resourceId, versionId);
      return (
        await c.query(
          `SELECT schema_version, manifest, created_at FROM knowledge.resource_manifests WHERE version_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [versionId],
        )
      ).rows[0] as Row | undefined;
    });
    return row
      ? {
          versionId,
          schemaVersion: row.schema_version as string,
          createdAt: iso(row.created_at),
          manifest: row.manifest as Row,
        }
      : { versionId, schemaVersion: null, createdAt: null, manifest: null };
  }

  // ---- review ----------------------------------------------------------------------------------------------------------------------
  /** Everything a reviewer needs, and exactly why a version can or cannot be activated now. */
  async state(actor: string, resourceId: string, versionId: string) {
    this.id(resourceId);
    this.id(versionId);
    return this.db.withPlatformScope((c) => this.stateIn(c, actor, resourceId, versionId));
  }

  private async stateIn(c: Q, actor: string, resourceId: string, versionId: string) {
    const r = await this.resource(c, resourceId);
    const v = await this.version(c, resourceId, versionId);
    const thirdParty = (r.provenance_class ?? 'THIRD_PARTY') === 'THIRD_PARTY';
    const need = thirdParty ? 2 : 1;
    const job = v.analysis_job_id
      ? ((
          await c.query(`SELECT id, state FROM knowledge.processing_jobs WHERE id = $1`, [
            v.analysis_job_id,
          ])
        ).rows[0] as Row | undefined)
      : undefined;
    const sev = (
      await c.query(
        `SELECT severity, count(*)::int AS n FROM knowledge.scan_findings WHERE version_id = $1 AND job_id = $2 GROUP BY severity`,
        [versionId, v.analysis_job_id ?? null],
      )
    ).rows as Row[];
    const findings = { info: 0, warn: 0, block: 0 };
    for (const f of sev) findings[f.severity as 'info' | 'warn' | 'block'] = Number(f.n);
    const reviews = (
      v.analysis_job_id
        ? (
            await c.query(
              `SELECT id, decision, reviewer_id, reason, checklist, created_at FROM knowledge.resource_reviews WHERE version_id = $1 AND analysis_job_id = $2 ORDER BY created_at, id`,
              [versionId, v.analysis_job_id],
            )
          ).rows
        : []
    ) as Row[];
    const all: ReviewEntry[] = reviews.map((x) => ({
      id: x.id as string,
      decision: x.decision as string,
      reviewerId: x.reviewer_id as string,
      reason: (x.reason as string | null) ?? null,
      checklist: x.checklist as Row,
      createdAt: iso(x.created_at),
    }));
    const uploader = (v.created_by as string | null) ?? null;
    const approvers = [
      ...new Set(
        all
          .filter((x) => x.decision === 'APPROVE' && (!thirdParty || x.reviewerId !== uploader))
          .map((x) => x.reviewerId),
      ),
    ];
    const rejected = all.some((x) => x.decision === 'REJECT');
    const proposal = (v.license_proposal as Row | null) ?? null;
    const blockers: { code: string; detail: string }[] = [];
    if (!REVIEWABLE.includes(v.state as string) && v.state !== 'DISABLED')
      blockers.push({
        code: 'state',
        detail: `the version is ${String(v.state)}; only a version awaiting review can be activated`,
      });
    if (!job || job.state !== 'SUCCEEDED')
      blockers.push({ code: 'not_analyzed', detail: 'the analysis has not completed' });
    if (findings.block > 0)
      blockers.push({
        code: 'blocking_findings',
        detail: `${findings.block} blocking finding(s) in the scan`,
      });
    if (!proposal || proposal.verdict !== 'ALLOWED')
      blockers.push({
        code: 'license_not_allowed',
        detail: `the licence proposal is ${String(proposal?.verdict ?? 'missing')}; only ALLOWED can be activated`,
      });
    if (rejected) blockers.push({ code: 'rejected', detail: 'a reviewer rejected this analysis' });
    if (approvers.length < need)
      blockers.push({
        code: 'approvals_missing',
        detail: `${need} approval(s) from different people are needed${thirdParty ? ' (the uploader cannot approve a third-party resource)' : ''}; ${approvers.length} recorded`,
      });
    const mine = all.find((x) => x.reviewerId === actor && x.decision === 'APPROVE');
    return {
      versionId,
      resourceId,
      state: v.state as string,
      stateReason: (v.state_reason as string | null) ?? null,
      provenanceClass: (r.provenance_class as string | undefined) ?? 'THIRD_PARTY',
      uploadedBy: uploader,
      analysisJobId: (v.analysis_job_id as string | null) ?? null,
      licenseProposal: proposal,
      licenseVerdict: v.license_verdict as string,
      summary: (v.ingest_summary as Row | null) ?? null,
      findings,
      requiredApprovals: need,
      approvals: approvers,
      reviews: all,
      blockers,
      canActivate: blockers.length === 0,
      you: {
        canReview:
          REVIEWABLE.includes(v.state as string) &&
          !!v.analysis_job_id &&
          !(thirdParty && uploader === actor) &&
          !mine,
        hasApproved: !!mine,
        isUploader: uploader === actor,
      },
    };
  }

  /** Records an approval or a rejection of the CURRENT analysis. A rejection also returns the version to QUARANTINED. */
  async review(actor: string, resourceId: string, body: Row) {
    this.id(resourceId);
    const versionId = this.id(body.versionId);
    const decision = oneOf(['approve', 'reject'] as const, body.decision, 'decision')!;
    const note = text(body.note, 'note', 2000);
    const checklist = (body.checklist ?? {}) as Row;
    if (decision === 'reject' && (note ?? '').trim().length < 10)
      throw new ProblemException(
        'validation_failed',
        'a rejection needs a note of at least 10 characters saying why',
      );
    if (
      decision === 'approve' &&
      !(checklist.findingsReviewed === true && checklist.licenseReviewed === true)
    )
      throw new ProblemException(
        'validation_failed',
        'an approval confirms that the findings and the licence were reviewed: checklist.findingsReviewed and checklist.licenseReviewed must be true',
      );
    const out = await this.db.withPlatformScope(async (c) => {
      const r = await this.resource(c, resourceId, true);
      const v = await this.version(c, resourceId, versionId, true);
      if (v.state !== 'AWAITING_REVIEW' || !v.analysis_job_id)
        throw new ProblemException(
          'conflict',
          `the version is ${String(v.state)}; only a version awaiting review can be reviewed`,
        );
      try {
        await c.query(
          `INSERT INTO knowledge.resource_reviews (id, version_id, resource_id, org_id, analysis_job_id, decision, reviewer_id, reason, checklist) VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8::jsonb)`,
          [
            newId(),
            versionId,
            resourceId,
            v.analysis_job_id,
            decision.toUpperCase(),
            actor,
            note,
            JSON.stringify(
              decision === 'approve' ? { findingsReviewed: true, licenseReviewed: true } : {},
            ),
          ],
        );
      } catch (e) {
        throw mapDb(e);
      }
      if (decision === 'reject') {
        await c.query(
          `UPDATE knowledge.resource_versions SET state = 'QUARANTINED', state_reason = 'rejected' WHERE id = $1 AND state = 'AWAITING_REVIEW'`,
          [versionId],
        );
        await c.query(
          `UPDATE knowledge.resources SET status = 'QUARANTINED' WHERE id = $1 AND current_version_id = $2`,
          [resourceId, versionId],
        );
      }
      return { r, state: await this.stateIn(c, actor, resourceId, versionId) };
    });
    await this.audit.record({
      action: decision === 'approve' ? 'knowledge.version.approved' : 'knowledge.version.rejected',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'knowledge_resource', id: resourceId },
      outcome: 'success',
      detail: {
        versionId,
        analysisJobId: out.state.analysisJobId,
        note: note ?? null,
        approvals: out.state.approvals.length,
        required: out.state.requiredApprovals,
      },
    });
    return out.state;
  }

  /** Activation. The previous ACTIVE version is retired to DISABLED (restorable through the same gate), never overwritten. */
  async activate(actor: string, resourceId: string, body: Row) {
    this.id(resourceId);
    const versionId = this.id(body.versionId);
    const note = text(body.note, 'note', 500);
    const out = await this.db.withPlatformScope(async (c) => {
      const r = await this.resource(c, resourceId, true);
      if (r.status === 'ARCHIVED')
        throw new ProblemException('conflict', 'the resource is archived');
      const v = await this.version(c, resourceId, versionId, true);
      if (v.state === 'ACTIVE')
        throw new ProblemException('conflict', 'the version is already active');
      const before = await this.stateIn(c, actor, resourceId, versionId);
      const prior = (
        await c.query(
          `SELECT id FROM knowledge.resource_versions WHERE resource_id = $1 AND state = 'ACTIVE' AND id <> $2`,
          [resourceId, versionId],
        )
      ).rows as Row[];
      await c.query(
        `UPDATE knowledge.resource_versions SET state = 'DISABLED', retired_at = now() WHERE resource_id = $1 AND state = 'ACTIVE' AND id <> $2`,
        [resourceId, versionId],
      );
      try {
        // the licence verdict is copied from the proposal ONLY here, after the approvals; the database re-checks the proposal, the findings and the approvals
        await c.query(
          `UPDATE knowledge.resource_versions SET state = 'ACTIVE', license_verdict = 'ALLOWED', activated_by = $2, retired_at = NULL WHERE id = $1`,
          [versionId, actor],
        );
      } catch (e) {
        throw mapDb(e);
      }
      const proposal = (v.license_proposal as Row | null) ?? {};
      await c.query(
        `UPDATE knowledge.resource_permissions SET license_verdict = 'ALLOWED', license_spdx = $2, updated_by = $3, updated_at = now() WHERE resource_id = $1`,
        [resourceId, typeof proposal.spdx === 'string' ? proposal.spdx.slice(0, 120) : null, actor],
      );
      await c.query(`UPDATE knowledge.resources SET status = 'ACTIVE' WHERE id = $1`, [resourceId]);
      return {
        before,
        prior: prior.map((p) => p.id as string),
        after: await this.stateIn(c, actor, resourceId, versionId),
      };
    });
    await this.audit.record({
      action: 'knowledge.version.activated',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'knowledge_resource', id: resourceId },
      outcome: 'success',
      detail: {
        versionId,
        approvers: out.before.approvals,
        retiredVersions: out.prior,
        note: note ?? null,
        licenseSpdx: out.before.licenseProposal?.spdx ?? null,
      },
    });
    return out.after;
  }

  // ---- operations ------------------------------------------------------------------------------------------------------------------
  async cancel(actor: string, resourceId: string, jobId: string) {
    this.id(resourceId);
    this.id(jobId);
    const out = await this.db.withPlatformScope(async (c) => {
      await this.resource(c, resourceId);
      const j = (
        await c.query(
          `SELECT j.* FROM knowledge.processing_jobs j JOIN knowledge.resource_versions v ON v.id = j.version_id WHERE j.id = $1 AND v.resource_id = $2 AND j.org_id IS NULL FOR UPDATE OF j`,
          [jobId, resourceId],
        )
      ).rows[0] as Row | undefined;
      if (!j) throw new ProblemException('not_found', 'job not found');
      if (j.state === 'QUEUED') {
        await c.query(
          `UPDATE knowledge.processing_jobs SET state = 'CANCELLED', finished_at = now(), error_code = 'cancelled', error_detail = 'cancelled by an administrator before it started' WHERE id = $1`,
          [jobId],
        );
        await c.query(
          `UPDATE knowledge.resource_versions SET state = 'QUARANTINED', state_reason = 'cancelled' WHERE id = $1 AND state IN ('QUARANTINED','VALIDATING')`,
          [j.version_id],
        );
        await c.query(
          `INSERT INTO knowledge.processing_logs (id, job_id, version_id, org_id, level, stage, code, message) VALUES ($1,$2,$3,NULL,'warn',$4,'job.cancelled','cancelled by an administrator before it started')`,
          [newId(), jobId, j.version_id, j.kind],
        );
        return 'CANCELLED';
      }
      if (j.state === 'RUNNING') {
        await c.query(
          `UPDATE knowledge.processing_jobs SET cancel_requested = true WHERE id = $1`,
          [jobId],
        );
        await c.query(
          `INSERT INTO knowledge.processing_logs (id, job_id, version_id, org_id, level, stage, code, message) VALUES ($1,$2,$3,NULL,'warn',$4,'job.cancel_requested','cancellation requested; the worker stops at its next checkpoint')`,
          [newId(), jobId, j.version_id, j.kind],
        );
        return 'CANCEL_REQUESTED';
      }
      throw new ProblemException(
        'conflict',
        `the job is ${String(j.state).toLowerCase()} and cannot be cancelled`,
      );
    });
    await this.audit.record({
      action: 'knowledge.job.cancelled',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'knowledge_resource', id: resourceId },
      outcome: 'success',
      detail: { jobId, result: out },
    });
    return { jobId, result: out };
  }

  /** Puts a version whose processing was interrupted (infrastructure failure, missing archive, cancellation) back in the queue. A rejected package is never retried. */
  async reprocess(actor: string, resourceId: string, versionId: string) {
    this.id(resourceId);
    this.id(versionId);
    const jobId = await this.db.withPlatformScope(async (c) => {
      await this.resource(c, resourceId, true);
      const v = await this.version(c, resourceId, versionId, true);
      // an analysed version keeps its files; only the later stages can be re-run: detection (S-K2b) while no manifest exists, components (S-K2c) while only schema 1 exists
      let kind: 'VALIDATE' | 'DETECT' | 'COMPONENTS' | 'DESIGN' | 'INDEX' = 'VALIDATE';
      // the indexing stage (S-K5) runs last and leaves no manifest of its own: an interrupted INDEX job is retried as itself
      const last = (
        await c.query(
          `SELECT kind, state FROM knowledge.processing_jobs WHERE version_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
          [versionId],
        )
      ).rows[0] as Row | undefined;
      const indexInterrupted =
        !!v.analysis_job_id &&
        last?.kind === 'INDEX' &&
        ['FAILED', 'CANCELLED', 'DEAD_LETTER'].includes(String(last.state));
      if (indexInterrupted) kind = 'INDEX';
      else if (v.analysis_job_id) {
        const have = new Set(
          (
            await c.query(
              `SELECT schema_version FROM knowledge.resource_manifests WHERE version_id = $1`,
              [versionId],
            )
          ).rows.map((r) => r.schema_version as string),
        );
        if (have.has('3'))
          throw new ProblemException(
            'conflict',
            'this version was already analysed; upload a new version to analyse again',
          );
        kind = have.has('2') ? 'DESIGN' : have.has('1') ? 'COMPONENTS' : 'DETECT';
      }
      if (
        !['FAILED', 'QUARANTINED'].includes(v.state as string) ||
        !RETRYABLE_REASONS.includes(String(v.state_reason ?? ''))
      )
        throw new ProblemException(
          'conflict',
          'only a version whose processing was interrupted can be retried; a rejected package must be re-uploaded fixed',
        );
      if (v.state === 'FAILED')
        await c.query(
          `UPDATE knowledge.resource_versions SET state = 'QUARANTINED', state_reason = NULL WHERE id = $1`,
          [versionId],
        );
      else
        await c.query(`UPDATE knowledge.resource_versions SET state_reason = NULL WHERE id = $1`, [
          versionId,
        ]);
      await c.query(
        `UPDATE knowledge.resources SET status = 'QUARANTINED' WHERE id = $1 AND current_version_id = $2`,
        [resourceId, versionId],
      );
      const id = newId();
      try {
        await c.query(
          `INSERT INTO knowledge.processing_jobs (id, version_id, org_id, kind, created_by) VALUES ($1,$2,NULL,$4,$3)`,
          [id, versionId, actor, kind],
        );
      } catch (e) {
        if ((e as { code?: string }).code === '23505')
          throw new ProblemException(
            'conflict',
            'the version already has a job waiting or running',
          );
        throw e;
      }
      return id;
    });
    await this.audit.record({
      action: 'knowledge.version.reprocessing_requested',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'knowledge_resource', id: resourceId },
      outcome: 'success',
      detail: { versionId, jobId },
    });
    return { versionId, jobId };
  }

  // ---- helpers ---------------------------------------------------------------------------------------------------------------------
  private id(x: unknown): string {
    if (!isUuid(x)) throw new ProblemException('not_found', 'not found');
    return x.toLowerCase();
  }
  private async resource(c: Q, id: string, lock = false): Promise<Row> {
    const r = (
      await c.query(
        `SELECT * FROM knowledge.resources WHERE id = $1 AND org_id IS NULL AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
        [id],
      )
    ).rows[0] as Row | undefined;
    if (!r) throw new ProblemException('not_found', 'resource not found');
    return r;
  }
  private async version(c: Q, resourceId: string, versionId: string, lock = false): Promise<Row> {
    const v = (
      await c.query(
        `SELECT * FROM knowledge.resource_versions WHERE id = $1 AND resource_id = $2${lock ? ' FOR UPDATE' : ''}`,
        [versionId, resourceId],
      )
    ).rows[0] as Row | undefined;
    if (!v) throw new ProblemException('not_found', 'version not found');
    return v;
  }
}
type Q = Parameters<Parameters<Db['withPlatformScope']>[0]>[0];

const toJob = (j: Row) => ({
  id: j.id as string,
  versionId: j.version_id as string,
  versionSeq: Number(j.version_seq),
  kind: j.kind as string,
  state: j.state as string,
  attempt: Number(j.attempt),
  maxAttempts: Number(j.max_attempts),
  progress: Number(j.progress),
  errorCode: (j.error_code as string | null) ?? null,
  errorDetail: (j.error_detail as string | null) ?? null,
  cancelRequested: j.cancel_requested === true,
  startedAt: iso(j.started_at),
  finishedAt: iso(j.finished_at),
  createdAt: iso(j.created_at),
});

/** The database's own guards speak through the HINT of their error; turn them into the platform's problem types. */
function mapDb(e: unknown): Error {
  const err = e as { hint?: string; code?: string; message?: string };
  switch (err.hint) {
    case 'approvals_missing':
      return new ProblemException(
        'knowledge_approval_required',
        err.message ?? 'approvals are missing',
      );
    case 'license_not_allowed':
      return new ProblemException(
        'knowledge_license_blocked',
        'the licence proposal and verdict must both be ALLOWED before activation',
      );
    case 'blocking_findings':
    case 'rejected':
    case 'not_analyzed':
      return new ProblemException(
        'knowledge_resource_ineligible',
        err.message ?? 'the version is not eligible',
      );
    case 'self_review':
      return new ProblemException(
        'forbidden',
        'the uploader cannot review a third-party resource they uploaded',
      );
    case 'not_reviewable':
    case 'invalid_transition':
      return new ProblemException('conflict', err.message ?? 'the version cannot change state');
    case 'checklist_incomplete':
      return new ProblemException('validation_failed', err.message ?? 'checklist incomplete');
    default:
      if (err.code === '23505')
        return new ProblemException('conflict', 'you have already approved this analysis');
      return e as Error;
  }
}
