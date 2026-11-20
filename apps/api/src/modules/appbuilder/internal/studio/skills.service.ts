import { createHash } from 'node:crypto';
import {
  BUILTIN_SKILLS,
  SKILL_SCAN_RULESET,
  builtinSkillMarkdown,
  parseSkillManifest,
  projectProfile,
  resolveSkills,
  scanSkill,
  type SkillCatalogEntry,
  type SkillManifest,
  type StudioProjectType,
} from '@nuzm/domain';
import type { Db } from '@nuzm/platform';
import type { PoolClient } from 'pg';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import { isUuid, newId } from '../core';
import type { ProjectRecord } from '../ports/m09';
import type { StudioFileWriter } from './files';
import { hasFileTree } from './flag';
import { FOLDER_RE, REF_RE, REPO_RE, type SkillSource, type SkillSourceFile } from './skill-source';

type Row = Record<string, unknown>;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const SKILLS_DIR = '.claude/skills';

const hashFiles = (files: { path: string; content: string }[]) =>
  createHash('sha256')
    .update(JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path))))
    .digest('hex');
const cmpSemver = (a: string, b: string) => {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  return 0;
};

export interface SkillDto {
  id: string;
  slug: string;
  description: string;
  category: string | null;
  scope: string;
  frameworks: string[];
  languages: string[];
  industries: string[];
  source: { kind: string; repo: string | null };
  status: string;
  owner: 'platform' | 'organization';
  currentVersion: {
    id: string;
    semver: string;
    license: string | null;
    executable: boolean;
    scanVerdict: string;
  } | null;
  updatedAt: string;
}

/**
 * Skills registry, review workflow and project installation (ADR-064 point 2, D-40):
 *  - third-party skills enter through an anonymous `SkillSource` at a pinned commit, are scanned, and wait in review (quarantine);
 *  - approval needs a known licence, no `reject` finding, a note when the scan asks for review, and TWO different approvers for skills that ship
 *    executable files — neither of them the person who imported it;
 *  - installation is compatibility-based (`resolveSkills`) and writes `.claude/skills/<slug>/` through the normal change path, refusing to
 *    overwrite files the customer changed unless asked to.
 */
export class SkillsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly source: SkillSource,
    private readonly files: StudioFileWriter,
  ) {}

  // ---- mapping ----------------------------------------------------------------------------------------------------------------------
  private dto(r: Row, v?: Row): SkillDto {
    return {
      id: r.id as string,
      slug: r.slug as string,
      description: r.description as string,
      category: (r.category as string | null) ?? null,
      scope: r.scope as string,
      frameworks: (r.frameworks as string[]) ?? [],
      languages: (r.languages as string[]) ?? [],
      industries: (r.industries as string[]) ?? [],
      source: { kind: r.source_kind as string, repo: (r.source_repo as string | null) ?? null },
      status: r.status as string,
      owner: r.org_id ? 'organization' : 'platform',
      currentVersion: v
        ? {
            id: v.id as string,
            semver: v.semver as string,
            license: (v.license as string | null) ?? null,
            executable: v.executable as boolean,
            scanVerdict: (v.scan as Row).verdict as string,
          }
        : null,
      updatedAt: new Date(r.updated_at as string).toISOString(),
    };
  }
  private versionDto(v: Row) {
    return {
      id: v.id as string,
      semver: v.semver as string,
      sourceCommit: (v.source_commit as string | null) ?? null,
      sourcePath: (v.source_path as string | null) ?? null,
      license: (v.license as string | null) ?? null,
      executable: v.executable as boolean,
      reviewState: v.review_state as string,
      scan: v.scan,
      files: ((v.files as { path: string; executable?: boolean; content: string }[]) ?? []).map(
        (f) => ({
          path: f.path,
          executable: !!f.executable,
          bytes: Buffer.byteLength(f.content),
        }),
      ),
      createdAt: new Date(v.created_at as string).toISOString(),
      createdBy: (v.created_by as string | null) ?? null,
    };
  }

  // ---- built-in skills --------------------------------------------------------------------------------------------------------------
  /** Idempotent: inserts the Nuzm-owned starter skills that are missing (they are scanned like any other skill and must come out clean). */
  async ensureBuiltins(): Promise<number> {
    let added = 0;
    await this.db.withPlatformScope(async (c) => {
      for (const b of BUILTIN_SKILLS) {
        const have = (
          await c.query(`SELECT 1 FROM builder.skills WHERE org_id IS NULL AND slug = $1`, [b.slug])
        ).rows[0];
        if (have) continue;
        const md = builtinSkillMarkdown(b);
        const m = parseSkillManifest(md);
        const scan = scanSkill([{ path: 'SKILL.md', content: md }]);
        if (!m.ok || scan.verdict !== 'clean') continue; // a built-in that does not pass its own checks is never published
        const sid = newId();
        const vid = newId();
        const files = [{ path: 'SKILL.md', content: md, executable: false }];
        await c.query(
          `INSERT INTO builder.skills (id, org_id, slug, description, category, scope, frameworks, languages, industries, source_kind, status)
           VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, 'nuzm', 'in_review')`,
          [
            sid,
            b.slug,
            b.description,
            b.category,
            b.scope,
            b.frameworks,
            b.languages,
            b.industries,
          ],
        );
        await c.query(
          `INSERT INTO builder.skill_versions (id, skill_id, org_id, semver, manifest, files, content_hash, bytes, license, scan, executable, review_state)
           VALUES ($1,$2,NULL,'1.0.0',$3,$4,$5,$6,'Proprietary',$7,false,'approved')`,
          [
            vid,
            sid,
            JSON.stringify(m.manifest),
            JSON.stringify(files),
            hashFiles(files),
            Buffer.byteLength(md),
            JSON.stringify({ ruleset: SKILL_SCAN_RULESET, ...scan }),
          ],
        );
        await c.query(
          `UPDATE builder.skills SET status = 'approved', current_version_id = $2 WHERE id = $1`,
          [sid, vid],
        );
        added++;
      }
    });
    return added;
  }

  // ---- import into quarantine ------------------------------------------------------------------------------------------------------
  private prepare(raw: SkillSourceFile[]) {
    if (!raw.length) throw new ProblemException('validation_failed', 'the skill has no files');
    const bin = raw.filter((f) => f.content === null).map((f) => f.path);
    if (bin.length)
      throw new ProblemException(
        'validation_failed',
        'binary files are not accepted in a skill',
        bin.slice(0, 20).map((p) => ({ field: 'files', message: p })),
      );
    const skillMd = raw.find((f) => f.path === 'SKILL.md');
    if (!skillMd)
      throw new ProblemException(
        'validation_failed',
        'the skill folder needs a SKILL.md at its root',
      );
    const parsed = parseSkillManifest(skillMd.content!);
    if (!parsed.ok)
      throw new ProblemException(
        'validation_failed',
        'SKILL.md is invalid',
        parsed.errors.map((e) => ({ field: e.field, message: e.message })),
      );
    const scan = scanSkill(
      raw.map((f) => ({
        path: f.path,
        content: f.content,
        executable: f.executable,
        bytes: f.bytes,
      })),
    );
    const files = raw.map((f) => ({ path: f.path, content: f.content!, executable: f.executable }));
    return { manifest: parsed.manifest, scan, files };
  }

  private async insertVersion(
    c: PoolClient,
    skillId: string,
    orgId: string | null,
    m: SkillManifest,
    prep: ReturnType<SkillsService['prepare']>,
    actor: string | null,
    source: { commit?: string; path?: string },
    review: 'pending' | 'approved' | 'rejected',
  ) {
    const semver = m.version ?? '1.0.0';
    if (!SEMVER.test(semver))
      throw new ProblemException('validation_failed', 'version must be semantic');
    const latest = (
      await c.query(`SELECT semver FROM builder.skill_versions WHERE skill_id = $1`, [skillId])
    ).rows.map((r) => r.semver as string);
    if (latest.some((s) => cmpSemver(semver, s) <= 0))
      throw new ProblemException(
        'conflict',
        `version ${semver} is not newer than the versions already imported`,
      );
    const id = newId();
    const bytes = prep.files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
    await c.query(
      `INSERT INTO builder.skill_versions (id, skill_id, org_id, semver, source_commit, source_path, manifest, files, content_hash, bytes, license, scan, executable, review_state, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id,
        skillId,
        orgId,
        semver,
        source.commit ?? null,
        source.path ?? null,
        JSON.stringify(m),
        JSON.stringify(prep.files),
        hashFiles(prep.files),
        bytes,
        m.license ?? null,
        JSON.stringify({ ruleset: SKILL_SCAN_RULESET, ...prep.scan }),
        prep.scan.executable,
        review,
        actor,
      ],
    );
    return id;
  }

  /** Platform import: a GitHub folder at a pinned commit, or uploaded files. The new version waits in review (quarantine). */
  async adminImport(actor: string, body: Row) {
    let raw: SkillSourceFile[];
    let sourceKind: 'github' | 'upload';
    let repo: string | null = null;
    let commit: string | undefined;
    let folder: string | undefined;
    if (body.github !== undefined) {
      const g = (body.github ?? {}) as Row;
      if (typeof g.repo !== 'string' || !REPO_RE.test(g.repo))
        throw new ProblemException('validation_failed', 'github.repo must be owner/name');
      const ref = typeof g.ref === 'string' && g.ref ? g.ref : 'HEAD';
      if (!REF_RE.test(ref) || ref.includes('..'))
        throw new ProblemException('validation_failed', 'github.ref is invalid');
      folder = typeof g.path === 'string' ? g.path.replace(/^\/+|\/+$/g, '') : '';
      if (!FOLDER_RE.test(folder) || folder.split('/').includes('..'))
        throw new ProblemException('validation_failed', 'github.path is invalid');
      const got = await this.source.fetch(g.repo, ref, folder);
      raw = got.files;
      commit = got.commit;
      repo = g.repo;
      sourceKind = 'github';
    } else {
      raw = this.uploaded(body.files);
      sourceKind = 'upload';
    }
    const prep = this.prepare(raw);
    const m = prep.manifest;
    const out = await this.db.withPlatformScope(async (c) => {
      let skill = (
        await c.query(
          `SELECT * FROM builder.skills WHERE org_id IS NULL AND slug = $1 FOR UPDATE`,
          [m.name],
        )
      ).rows[0] as Row | undefined;
      if (skill && skill.source_kind !== sourceKind)
        throw new ProblemException(
          'conflict',
          `a skill named ${m.name} already exists from another source`,
        );
      if (!skill)
        skill = (
          await c.query(
            `INSERT INTO builder.skills (id, org_id, slug, description, category, scope, frameworks, languages, industries, source_kind, source_repo, status, created_by)
             VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'in_review', $11) RETURNING *`,
            [
              newId(),
              m.name,
              m.description,
              m.category ?? null,
              typeof body.scope === 'string' &&
              ['global', 'framework', 'language', 'template', 'industry'].includes(body.scope)
                ? body.scope
                : m.frameworks.length
                  ? 'framework'
                  : m.industries.length
                    ? 'industry'
                    : m.languages.length
                      ? 'language'
                      : 'global',
              m.frameworks,
              m.languages,
              m.industries,
              sourceKind,
              repo,
              actor,
            ],
          )
        ).rows[0] as Row;
      const review = prep.scan.verdict === 'reject' ? 'rejected' : 'pending';
      const vid = await this.insertVersion(
        c,
        skill.id as string,
        null,
        m,
        prep,
        actor,
        { commit, path: folder },
        review,
      );
      return { skillId: skill.id as string, versionId: vid, review };
    });
    await this.audit.record({
      action: 'builder.skill.imported',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'builder_skill_version', id: out.versionId },
      outcome: 'success',
      detail: {
        slug: m.name,
        source: sourceKind,
        verdict: prep.scan.verdict,
        executable: prep.scan.executable,
        ...(commit ? { commit } : {}),
      },
    });
    return {
      ...(await this.adminGet(out.skillId)),
      skillId: out.skillId,
      versionId: out.versionId,
      review: out.review,
    };
  }

  private uploaded(raw: unknown): SkillSourceFile[] {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200)
      throw new ProblemException(
        'validation_failed',
        'files must be a list of 1..200 {path, content}',
      );
    let total = 0;
    return raw.map((f, i) => {
      const o = (f ?? {}) as Row;
      if (typeof o.path !== 'string' || typeof o.content !== 'string')
        throw new ProblemException('validation_failed', `files[${i}] needs path and content`);
      total += Buffer.byteLength(o.content);
      if (total > 2_000_000)
        throw new ProblemException('payload_too_large', 'the skill is larger than 2 MB');
      return {
        path: o.path,
        content: o.content,
        executable: o.executable === true,
        bytes: Buffer.byteLength(o.content),
      };
    });
  }

  // ---- admin read ---------------------------------------------------------------------------------------------------------------------
  async adminList(status?: string) {
    return this.db.withPlatformScope(async (c) => {
      const rows = (
        await c.query(
          `SELECT s.*, v.id AS v_id FROM builder.skills s LEFT JOIN builder.skill_versions v ON v.id = s.current_version_id
           WHERE s.org_id IS NULL AND ($1::text IS NULL OR s.status = $1) ORDER BY s.slug`,
          [status ?? null],
        )
      ).rows as Row[];
      const pending = (
        await c.query(
          `SELECT skill_id, count(*)::int AS n FROM builder.skill_versions WHERE org_id IS NULL AND review_state = 'pending' GROUP BY skill_id`,
        )
      ).rows as Row[];
      const installs = (
        await c.query(
          `SELECT skill_id, count(*)::int AS n FROM builder.project_skills WHERE state = 'installed' GROUP BY skill_id`,
        )
      ).rows as Row[];
      const versions = new Map<string, Row>();
      for (const r of rows)
        if (r.v_id)
          versions.set(
            r.id as string,
            (await c.query(`SELECT * FROM builder.skill_versions WHERE id = $1`, [r.v_id]))
              .rows[0] as Row,
          );
      return {
        items: rows.map((r) => ({
          ...this.dto(r, versions.get(r.id as string)),
          pendingVersions: Number(pending.find((p) => p.skill_id === r.id)?.n ?? 0),
          installations: Number(installs.find((p) => p.skill_id === r.id)?.n ?? 0),
        })),
      };
    });
  }

  async adminGet(id: string) {
    if (!isUuid(id)) throw new ProblemException('not_found', 'skill not found');
    return this.db.withPlatformScope(async (c) => {
      const s = (
        await c.query(`SELECT * FROM builder.skills WHERE id = $1 AND org_id IS NULL`, [id])
      ).rows[0] as Row | undefined;
      if (!s) throw new ProblemException('not_found', 'skill not found');
      const vs = (
        await c.query(
          `SELECT * FROM builder.skill_versions WHERE skill_id = $1 ORDER BY created_at DESC`,
          [id],
        )
      ).rows as Row[];
      const reviews = (
        await c.query(
          `SELECT r.* FROM builder.skill_reviews r JOIN builder.skill_versions v ON v.id = r.skill_version_id WHERE v.skill_id = $1 ORDER BY r.created_at`,
          [id],
        )
      ).rows as Row[];
      return {
        ...this.dto(
          s,
          vs.find((v) => v.id === s.current_version_id),
        ),
        versions: vs.map((v) => ({
          ...this.versionDto(v),
          reviews: reviews
            .filter((r) => r.skill_version_id === v.id)
            .map((r) => ({
              reviewerId: r.reviewer_id as string,
              decision: r.decision as string,
              note: (r.note as string | null) ?? null,
              at: new Date(r.created_at as string).toISOString(),
            })),
        })),
      };
    });
  }

  /** One file of a skill version (read-only view for reviewers). */
  async adminFile(versionId: string, path: string) {
    if (!isUuid(versionId)) throw new ProblemException('not_found', 'version not found');
    const v = await this.db.withPlatformScope(
      async (c) =>
        (await c.query(`SELECT files FROM builder.skill_versions WHERE id = $1`, [versionId]))
          .rows[0] as Row | undefined,
    );
    const f = ((v?.files as { path: string; content: string }[]) ?? []).find(
      (x) => x.path === path,
    );
    if (!f) throw new ProblemException('not_found', 'file not found');
    return { path: f.path, content: f.content };
  }

  // ---- review ---------------------------------------------------------------------------------------------------------------------
  async review(actor: string, versionId: string, body: Row) {
    if (!isUuid(versionId)) throw new ProblemException('not_found', 'version not found');
    const decision = body.decision;
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '';
    if (decision !== 'approve' && decision !== 'reject')
      throw new ProblemException('validation_failed', 'decision must be approve or reject');
    const out = await this.db.withPlatformScope(async (c) => {
      const v = (
        await c.query(
          `SELECT * FROM builder.skill_versions WHERE id = $1 AND org_id IS NULL FOR UPDATE`,
          [versionId],
        )
      ).rows[0] as Row | undefined;
      if (!v) throw new ProblemException('not_found', 'version not found');
      if (v.review_state !== 'pending')
        throw new ProblemException(
          'conflict',
          `this version is already ${v.review_state as string}`,
        );
      const scan = v.scan as { verdict: string };
      if (decision === 'approve') {
        if (scan.verdict === 'reject')
          throw new ProblemException(
            'conflict',
            'the scan rejected this version: it cannot be approved',
          );
        if (!v.license)
          throw new ProblemException(
            'conflict',
            'the licence is unknown: an unlicensed skill cannot be published (D-40)',
          );
        if (scan.verdict === 'review' && !note)
          throw new ProblemException(
            'validation_failed',
            'the scan asks for a review: explain the decision in a note',
          );
        if (v.executable && v.created_by === actor)
          throw new ProblemException(
            'forbidden',
            'the person who imported an executable skill cannot approve it',
          );
      } else if (!note) throw new ProblemException('validation_failed', 'a rejection needs a note');
      const dup = (
        await c.query(
          `SELECT 1 FROM builder.skill_reviews WHERE skill_version_id = $1 AND reviewer_id = $2`,
          [versionId, actor],
        )
      ).rows[0];
      if (dup) throw new ProblemException('conflict', 'you already reviewed this version');
      await c.query(
        `INSERT INTO builder.skill_reviews (id, skill_version_id, reviewer_id, decision, note) VALUES ($1,$2,$3,$4,$5)`,
        [newId(), versionId, actor, decision, note || null],
      );
      const skill = (
        await c.query(`SELECT * FROM builder.skills WHERE id = $1 FOR UPDATE`, [v.skill_id])
      ).rows[0] as Row;
      if (decision === 'reject') {
        await c.query(`UPDATE builder.skill_versions SET review_state = 'rejected' WHERE id = $1`, [
          versionId,
        ]);
        if (!skill.current_version_id)
          await c.query(`UPDATE builder.skills SET status = 'rejected' WHERE id = $1`, [skill.id]);
        return { state: 'rejected', approvals: 0, needed: 0 };
      }
      const approvals = Number(
        (
          await c.query(
            `SELECT count(*)::int AS n FROM builder.skill_reviews WHERE skill_version_id = $1 AND decision = 'approve'`,
            [versionId],
          )
        ).rows[0]!.n,
      );
      const needed = v.executable ? 2 : 1;
      if (approvals < needed) return { state: 'pending', approvals, needed };
      const m = v.manifest as SkillManifest;
      await c.query(`UPDATE builder.skill_versions SET review_state = 'approved' WHERE id = $1`, [
        versionId,
      ]);
      await c.query(
        `UPDATE builder.skills SET status = 'approved', current_version_id = $2, description = $3, category = $4, frameworks = $5, languages = $6, industries = $7 WHERE id = $1`,
        [
          skill.id,
          versionId,
          m.description,
          m.category ?? null,
          m.frameworks,
          m.languages,
          m.industries,
        ],
      );
      return { state: 'approved', approvals, needed };
    });
    await this.audit.record({
      action: decision === 'approve' ? 'builder.skill.approved' : 'builder.skill.rejected',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'builder_skill_version', id: versionId },
      outcome: 'success',
      detail: out,
    });
    return out;
  }

  /** Disable (no new installations; installed copies stay in projects) or re-enable a skill that has an approved version. */
  async setStatus(actor: string, id: string, status: unknown) {
    if (!isUuid(id)) throw new ProblemException('not_found', 'skill not found');
    if (status !== 'disabled' && status !== 'approved')
      throw new ProblemException('validation_failed', 'status must be disabled or approved');
    await this.db.withPlatformScope(async (c) => {
      const s = (
        await c.query(`SELECT * FROM builder.skills WHERE id = $1 AND org_id IS NULL FOR UPDATE`, [
          id,
        ])
      ).rows[0] as Row | undefined;
      if (!s) throw new ProblemException('not_found', 'skill not found');
      if (status === 'approved' && !s.current_version_id)
        throw new ProblemException('conflict', 'the skill has no approved version');
      await c.query(`UPDATE builder.skills SET status = $2 WHERE id = $1`, [id, status]);
    });
    await this.audit.record({
      action: status === 'disabled' ? 'builder.skill.disabled' : 'builder.skill.enabled',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'builder_skill', id },
      outcome: 'success',
    });
    return this.adminGet(id);
  }

  // ---- customer side ------------------------------------------------------------------------------------------------------------------
  /** Approved platform skills plus the organization's own skills, with their current version. */
  private async catalogRows(c: PoolClient) {
    const rows = (
      await c.query(
        `SELECT s.*, v.id AS v_id, v.semver, v.license, v.executable, v.scan, v.manifest, v.files, v.created_at AS v_created
         FROM builder.skills s JOIN builder.skill_versions v ON v.id = s.current_version_id
         WHERE s.status = 'approved' ORDER BY s.org_id NULLS FIRST, s.slug`,
      )
    ).rows as Row[];
    return rows;
  }
  private entry(r: Row): SkillCatalogEntry {
    const m = r.manifest as SkillManifest;
    return {
      slug: r.slug as string,
      version: r.semver as string,
      scope: r.scope as SkillCatalogEntry['scope'],
      frameworks: (r.frameworks as string[]) ?? [],
      languages: (r.languages as string[]) ?? [],
      industries: (r.industries as string[]) ?? [],
      requires: m.requires ?? [],
      approval: 'approved',
      // a customer's own skill is theirs to run in their own sandbox: only a `reject` blocks it
      scan: r.org_id
        ? (r.scan as Row).verdict === 'reject'
          ? 'reject'
          : 'clean'
        : ((r.scan as Row).verdict as SkillCatalogEntry['scan']),
      executable: r.org_id ? false : (r.executable as boolean),
    };
  }

  async catalog(orgId: string) {
    return this.db.withOrg(orgId, async (c) => ({
      items: (await this.catalogRows(c)).map((r) =>
        this.dto(r, {
          id: r.v_id,
          semver: r.semver,
          license: r.license,
          executable: r.executable,
          scan: r.scan,
        }),
      ),
    }));
  }

  async installed(orgId: string, p: ProjectRecord) {
    return this.db.withOrg(orgId, async (c) => {
      const rows = (
        await c.query(
          `SELECT ps.*, v.semver FROM builder.project_skills ps JOIN builder.skill_versions v ON v.id = ps.skill_version_id
           WHERE ps.project_id = $1 AND ps.state = 'installed' ORDER BY ps.slug`,
          [p.id],
        )
      ).rows as Row[];
      return {
        items: rows.map((r) => ({
          id: r.id as string,
          skillId: r.skill_id as string,
          slug: r.slug as string,
          version: r.semver as string,
          reason: r.reason as string,
          installedAt: new Date(r.installed_at as string).toISOString(),
        })),
      };
    });
  }

  /** What the project should get: auto-installable set (dependencies first) and what is held back, with reasons. */
  async recommend(orgId: string, p: ProjectRecord, requested: string[] = [], industry?: string) {
    return this.db.withOrg(orgId, async (c) => {
      const rows = await this.catalogRows(c);
      const res = resolveSkills(
        rows.map((r) => this.entry(r)),
        projectProfile(p.type as StudioProjectType, {
          requested,
          ...(industry ? { industry } : {}),
        }),
      );
      const installed = new Set(
        (
          (
            await c.query(
              `SELECT slug FROM builder.project_skills WHERE project_id = $1 AND state = 'installed'`,
              [p.id],
            )
          ).rows as Row[]
        ).map((r) => r.slug as string),
      );
      return { ...res, installed: [...installed] };
    });
  }

  /** Installs the requested skills (and their dependencies), or every recommended one when `auto` is true; then writes `.claude/skills/`. */
  async install(orgId: string, actor: string, p: ProjectRecord, body: Row) {
    const requested = Array.isArray(body.skills)
      ? body.skills.filter((s): s is string => typeof s === 'string').slice(0, 50)
      : [];
    const auto = body.auto === true;
    if (!auto && !requested.length)
      throw new ProblemException(
        'validation_failed',
        'skills (a list of slugs) or auto: true is required',
      );
    const industry =
      typeof body.industry === 'string' ? body.industry.toLowerCase().slice(0, 40) : undefined;
    const rec = await this.recommend(orgId, p, requested, industry);
    const blockedRequested = rec.blocked.filter((b) => requested.includes(b.slug));
    if (blockedRequested.length)
      throw new ProblemException(
        'conflict',
        'some requested skills cannot be installed',
        blockedRequested.map((b) => ({
          field: b.slug,
          message: b.reason + (b.detail ? ` (${b.detail})` : ''),
        })),
      );
    // the closure of what was asked for, in dependency order; `auto` takes every installable recommendation
    const toAdd = await this.db
      .withOrg(orgId, async (c) => {
        const rows = await this.catalogRows(c);
        const requires = new Map(
          rows.map((r) => [r.slug as string, (r.manifest as SkillManifest).requires ?? []]),
        );
        const closure = new Set<string>();
        const walk = (s: string) => {
          if (closure.has(s)) return;
          closure.add(s);
          for (const d of requires.get(s) ?? []) walk(d);
        };
        requested.forEach(walk);
        const want = auto ? rec.install : rec.install.filter((s) => closure.has(s));
        return { rows, list: want.filter((s) => !rec.installed.includes(s)) };
      })
      .then(async ({ rows, list }) => {
        await this.insertInstalls(orgId, actor, p, rows, list, requested, rec.reasons);
        return list;
      });
    for (const slug of toAdd)
      await this.audit.record({
        action: 'builder.project_skill.installed',
        actorUserId: actor,
        actorType: 'user',
        orgId,
        resource: { type: 'builder_project', id: p.id },
        outcome: 'success',
        detail: { slug },
      });
    const sync = hasFileTree(p)
      ? await this.syncFiles(orgId, actor, p, body.overwrite === true)
      : null;
    return { added: toAdd, blocked: rec.blocked, ...(await this.installed(orgId, p)), files: sync };
  }
  private async insertInstalls(
    orgId: string,
    actor: string,
    p: ProjectRecord,
    rows: Row[],
    toAdd: string[],
    requested: string[],
    reasons: Record<string, string>,
  ) {
    await this.db.withOrg(orgId, async (c) => {
      for (const slug of toAdd) {
        const r = rows.find((x) => x.slug === slug && (x.org_id === orgId || x.org_id === null));
        if (!r) continue;
        await c.query(
          `INSERT INTO builder.project_skills (id, org_id, project_id, skill_id, skill_version_id, slug, reason, installed_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [
            newId(),
            orgId,
            p.id,
            r.id,
            r.v_id,
            slug,
            r.org_id
              ? 'customer'
              : requested.includes(slug)
                ? 'requested'
                : reasons[slug] === 'required by another skill'
                  ? 'dependency'
                  : 'recommended',
            actor,
          ],
        );
      }
    });
  }

  async uninstall(
    orgId: string,
    actor: string,
    p: ProjectRecord,
    skillId: string,
    overwrite: boolean,
  ) {
    if (!isUuid(skillId)) throw new ProblemException('not_found', 'skill not installed');
    const slug = await this.db.withOrg(orgId, async (c) => {
      const r = (
        await c.query(
          `UPDATE builder.project_skills SET state = 'removed', removed_at = now() WHERE project_id = $1 AND skill_id = $2 AND state = 'installed' RETURNING slug`,
          [p.id, skillId.toLowerCase()],
        )
      ).rows[0] as Row | undefined;
      return r?.slug as string | undefined;
    });
    if (!slug) throw new ProblemException('not_found', 'skill not installed');
    let sync: Awaited<ReturnType<SkillsService['syncFiles']>> | null;
    try {
      sync = hasFileTree(p) ? await this.syncFiles(orgId, actor, p, overwrite, [slug]) : null;
    } catch (err) {
      // the files could not be removed (for example customer-changed files): the skill stays installed
      await this.db.withOrg(orgId, (c) =>
        c.query(
          `UPDATE builder.project_skills SET state = 'installed', removed_at = NULL
           WHERE id = (SELECT id FROM builder.project_skills WHERE project_id = $1 AND skill_id = $2 AND state = 'removed' ORDER BY removed_at DESC LIMIT 1)`,
          [p.id, skillId.toLowerCase()],
        ),
      );
      throw err;
    }
    await this.audit.record({
      action: 'builder.project_skill.removed',
      actorUserId: actor,
      actorType: 'user',
      orgId,
      resource: { type: 'builder_project', id: p.id },
      outcome: 'success',
      detail: { slug },
    });
    return { removed: slug, files: sync };
  }

  /**
   * Makes `.claude/skills/` match the installed skills. A file the customer changed (content differs from every version Nuzm shipped for that path)
   * is never overwritten or deleted silently: the call answers 409 with the paths unless `overwrite` is true.
   */
  async syncFiles(
    orgId: string,
    actor: string,
    p: ProjectRecord,
    overwrite: boolean,
    removedSlugs: string[] = [],
  ) {
    const { desired, shipped } = await this.db.withOrg(orgId, async (c) => {
      const rows = (
        await c.query(
          `SELECT ps.slug, v.files FROM builder.project_skills ps JOIN builder.skill_versions v ON v.id = ps.skill_version_id
           WHERE ps.project_id = $1 AND ps.state = 'installed'`,
          [p.id],
        )
      ).rows as Row[];
      const desired = new Map<string, string>();
      for (const r of rows)
        for (const f of r.files as { path: string; content: string }[])
          desired.set(`${SKILLS_DIR}/${r.slug as string}/${f.path}`, f.content);
      // every content Nuzm ever shipped for these skills: a file equal to one of them is ours to replace
      const all = (
        await c.query(
          `SELECT ps.slug, v.files FROM builder.project_skills ps JOIN builder.skill_versions v ON v.skill_id = ps.skill_id WHERE ps.project_id = $1`,
          [p.id],
        )
      ).rows as Row[];
      const shipped = new Map<string, Set<string>>();
      for (const r of all)
        for (const f of r.files as { path: string; content: string }[]) {
          const k = `${SKILLS_DIR}/${r.slug as string}/${f.path}`;
          if (!shipped.has(k)) shipped.set(k, new Set());
          shipped.get(k)!.add(f.content);
        }
      return { desired, shipped };
    });
    const cur = await this.files.head(orgId, p);
    const deletes = [...cur.keys()].filter(
      (k) => removedSlugs.some((s) => k.startsWith(`${SKILLS_DIR}/${s}/`)) && !desired.has(k),
    );
    const conflicts = [...desired.keys(), ...deletes].filter((k) => {
      const now = cur.get(k);
      return now !== undefined && now !== desired.get(k) && !shipped.get(k)?.has(now);
    });
    if (conflicts.length && !overwrite)
      throw new ProblemException(
        'conflict',
        'some skill files were changed in the project; confirm to overwrite them',
        conflicts.slice(0, 50).map((path) => ({ field: 'path', message: path })),
      );
    const r = await this.files.apply(
      orgId,
      actor,
      p,
      desired,
      deletes,
      'Update .claude/skills (Nuzm Skills)',
    );
    return { changed: r !== null, conflictsOverwritten: overwrite ? conflicts : [] };
  }

  /** A customer's own skill: scanned; a `reject` finding refuses it; otherwise it is available to this organization only. */
  async customerCreate(orgId: string, actor: string, body: Row) {
    const prep = this.prepare(this.uploaded(body.files));
    if (prep.scan.verdict === 'reject')
      throw new ProblemException(
        'validation_failed',
        'the skill was refused by the security scan',
        prep.scan.findings
          .filter((f) => f.severity === 'reject')
          .slice(0, 20)
          .map((f) => ({ field: `${f.path}:${f.line}`, message: f.detail })),
      );
    const m = prep.manifest;
    const id = await this.db.withOrg(orgId, async (c) => {
      let s = (
        await c.query(`SELECT * FROM builder.skills WHERE org_id = $1 AND slug = $2 FOR UPDATE`, [
          orgId,
          m.name,
        ])
      ).rows[0] as Row | undefined;
      if (!s)
        s = (
          await c.query(
            `INSERT INTO builder.skills (id, org_id, slug, description, category, scope, frameworks, languages, industries, source_kind, status, created_by)
             VALUES ($1,$2,$3,$4,$5,'customer',$6,$7,$8,'customer','in_review',$9) RETURNING *`,
            [
              newId(),
              orgId,
              m.name,
              m.description,
              m.category ?? null,
              m.frameworks,
              m.languages,
              m.industries,
              actor,
            ],
          )
        ).rows[0] as Row;
      const vid = await this.insertVersion(
        c,
        s.id as string,
        orgId,
        m,
        prep,
        actor,
        {},
        'approved',
      );
      await c.query(
        `UPDATE builder.skills SET status = 'approved', current_version_id = $2, description = $3, frameworks = $4, languages = $5, industries = $6 WHERE id = $1`,
        [s.id, vid, m.description, m.frameworks, m.languages, m.industries],
      );
      return s.id as string;
    });
    await this.audit.record({
      action: 'builder.skill.created',
      actorUserId: actor,
      actorType: 'user',
      orgId,
      resource: { type: 'builder_skill', id },
      outcome: 'success',
      detail: { slug: m.name, verdict: prep.scan.verdict },
    });
    return { id, slug: m.name, scan: { verdict: prep.scan.verdict, findings: prep.scan.findings } };
  }
}
