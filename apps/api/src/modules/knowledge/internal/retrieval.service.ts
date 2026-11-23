import type { Db } from '@nuzm/platform';
import type { PoolClient } from 'pg';
import {
  DEFAULT_SETTINGS,
  MATCH_WEIGHT,
  MODES,
  PLATFORM_LIST,
  STRATEGIES,
  allowedUsages,
  decide,
  evaluateEligibility,
  frameworkId,
  groupMatches,
  normalizeText,
  parseColor,
  pickDefault,
  recommendedUsage,
  scoreCandidate,
  termGroups,
  tsQueryOf,
  validateSettings,
  type DefaultRule,
  type EngineSettings,
  type Mode,
  type Permissions,
  type Platform,
  type Requirement,
  type Strategy,
  type TermGroup,
} from '@nuzm/domain';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { parseLimit } from '../../../common/pagination';
import { isUuid, newId, oneOf, text, type Row } from './model';

/**
 * Retrieval and recommendation (S-K5, ADR-065 points 7 and 8, SCR-K-07). Platform staff only; customers reach the library through `knowledge.v_published_templates` (S-K7).
 * The order is permission-first: every platform resource is evaluated by the hard filters (licence, publication, reuse permission, platform and framework compatibility,
 * adaptation mode) BEFORE any text is matched or any score computed; only eligible versions are ranked, and the excluded ones are listed with every reason.
 * Retrieval is hybrid and has no model in it: structured metadata, lexical (`tsvector` with prefix matching and bilingual concept groups), symbol and component names, and the
 * Design DNA. The semantic layer stays BLOCKED (D-47). Read-only: nothing is written except settings and defaults, each audited.
 */
type Q = Pick<PoolClient, 'query'>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);
const MAX_CANDIDATES = 1000;
const MAX_RANKED = 300;

interface Candidate {
  resourceId: string;
  versionId: string | null;
  versionSeq: number | null;
  name: string;
  description: string | null;
  resourceType: string;
  platform: string | null;
  frameworks: string[];
  languages: string[];
  category: string | null;
  tags: string[];
  status: string;
  visibility: string;
  deleted: boolean;
  versionState: string | null;
  versionLicense: string | null;
  perms: (Permissions & { licenseSpdx: string | null }) | null;
}
interface Match {
  kind: string;
  ref: string;
  title: string;
  snippet: string;
  rank: number;
}

const stringsOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const bool = (v: unknown, f: string): boolean | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean')
    throw new ProblemException('validation_failed', `${f} must be true or false`);
  return v;
};

export class RetrievalService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  // ---- settings (D-48) -----------------------------------------------------------------------------------------------------------
  private async loadSettings(c: Q): Promise<{
    settings: EngineSettings;
    revision: number;
    updatedAt: string | null;
    updatedBy: string | null;
  }> {
    const r = (
      await c.query(
        `SELECT value, revision, updated_at, updated_by FROM knowledge.engine_settings WHERE key = 'recommendation'`,
      )
    ).rows[0] as Row | undefined;
    if (r) {
      const v = validateSettings(r.value);
      if (v.ok)
        return {
          settings: v.value,
          revision: Number(r.revision),
          updatedAt: iso(r.updated_at),
          updatedBy: (r.updated_by as string | null) ?? null,
        };
    }
    return { settings: DEFAULT_SETTINGS, revision: 0, updatedAt: null, updatedBy: null };
  }
  async settings() {
    const s = await this.db.withPlatformScope((c) => this.loadSettings(c));
    return {
      ...s.settings,
      revision: s.revision,
      updatedAt: s.updatedAt,
      updatedBy: s.updatedBy,
      defaults: DEFAULT_SETTINGS,
      isDefault: s.revision === 0,
    };
  }
  async settingsRevisions(rawLimit?: string) {
    const limit = parseLimit(rawLimit, 50);
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT revision, value, previous, changed_by, reason, created_at FROM knowledge.engine_setting_revisions WHERE key = 'recommendation' ORDER BY revision DESC LIMIT $1`,
            [limit],
          )
        ).rows as Row[],
    );
    return {
      items: rows.map((r) => ({
        revision: Number(r.revision),
        value: r.value as Row,
        previous: (r.previous as Row | null) ?? null,
        changedBy: (r.changed_by as string | null) ?? null,
        reason: r.reason as string,
        createdAt: iso(r.created_at),
      })),
    };
  }
  /** Replaces the recommendation settings. Needs the current revision (`If-Match`), a reason, valid weights; the previous value goes to the append-only history and the audit log. */
  async updateSettings(actor: string, ifMatch: string | undefined, body: Row) {
    const raw = (ifMatch ?? '').replace(/^W\//, '').replace(/"/g, '').trim();
    const expected = raw === '' ? Number.NaN : Number(raw);
    if (!Number.isInteger(expected) || expected < 0)
      throw new ProblemException(
        'validation_failed',
        'If-Match is required (the current settings revision, 0 while the defaults are in use)',
      );
    const reason = text(body.reason, 'reason', 500, false)!;
    if (reason.length < 10)
      throw new ProblemException('validation_failed', 'reason must be 10 to 500 characters');
    const v = validateSettings({ weights: body.weights, minScore: body.minScore });
    if (!v.ok) throw new ProblemException('validation_failed', v.error);
    const out = await this.db.withPlatformScope(async (c) => {
      const cur = await this.loadSettings(c);
      if (cur.revision !== expected)
        throw new ProblemException(
          'precondition_failed',
          'the settings changed since they were read; read them again',
        );
      const next = cur.revision + 1;
      if (cur.revision === 0) {
        const ins = await c.query(
          `INSERT INTO knowledge.engine_settings (key, value, revision, updated_by) VALUES ('recommendation', $1::jsonb, 1, $2) ON CONFLICT DO NOTHING`,
          [JSON.stringify(v.value), actor],
        );
        if (ins.rowCount !== 1)
          throw new ProblemException(
            'precondition_failed',
            'the settings changed since they were read; read them again',
          );
      } else {
        const upd = await c.query(
          `UPDATE knowledge.engine_settings SET value = $1::jsonb, revision = $2, updated_by = $3, updated_at = now() WHERE key = 'recommendation' AND revision = $4`,
          [JSON.stringify(v.value), next, actor, cur.revision],
        );
        if (upd.rowCount !== 1)
          throw new ProblemException(
            'precondition_failed',
            'the settings changed since they were read; read them again',
          );
      }
      await c.query(
        `INSERT INTO knowledge.engine_setting_revisions (id, key, revision, value, previous, changed_by, reason) VALUES ($1,'recommendation',$2,$3::jsonb,$4::jsonb,$5,$6)`,
        [
          newId(),
          next,
          JSON.stringify(v.value),
          cur.revision === 0 ? null : JSON.stringify(cur.settings),
          actor,
          reason,
        ],
      );
      return { before: cur.settings, revision: next };
    });
    await this.audit.record({
      action: 'knowledge.settings.updated',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'knowledge_settings', id: 'recommendation' },
      outcome: 'success',
      detail: {
        revision: out.revision,
        weights: v.value.weights,
        minScore: v.value.minScore,
        previous: out.before,
        reason,
      },
    });
    return this.settings();
  }

  // ---- admin defaults (template_defaults) ------------------------------------------------------------------------------------------
  async defaults() {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT d.id, d.platform, d.framework, d.category, d.plan, d.mode, d.resource_id, d.version_pin, d.updated_at, r.name AS resource_name
               FROM knowledge.template_defaults d LEFT JOIN knowledge.resources r ON r.id = d.resource_id ORDER BY d.platform, d.framework, d.category, d.plan, d.mode LIMIT 500`,
          )
        ).rows as Row[],
    );
    return {
      items: rows.map((r) => ({
        id: r.id as string,
        platform: r.platform as string,
        framework: r.framework as string,
        category: r.category as string,
        plan: r.plan as string,
        mode: r.mode as string,
        resourceId: r.resource_id as string,
        resourceName: (r.resource_name as string | null) ?? null,
        versionPin: (r.version_pin as string | null) ?? null,
        updatedAt: iso(r.updated_at),
      })),
    };
  }
  async setDefault(actor: string, body: Row) {
    const platform = oneOf([...PLATFORM_LIST, '*'] as const, body.platform ?? '*', 'platform');
    const mode = oneOf([...MODES, '*'] as const, body.mode ?? '*', 'mode');
    const framework = (text(body.framework ?? '*', 'framework', 40, false) as string).toLowerCase();
    const category = text(body.category ?? '*', 'category', 80, false) as string;
    const plan = text(body.plan ?? '*', 'plan', 40, false) as string;
    const resourceId = body.resourceId;
    if (!isUuid(resourceId))
      throw new ProblemException('validation_failed', 'resourceId must be a resource id');
    const pin =
      body.versionPin === undefined || body.versionPin === null
        ? null
        : isUuid(body.versionPin)
          ? body.versionPin
          : (() => {
              throw new ProblemException('validation_failed', 'versionPin must be a version id');
            })();
    const out = await this.db.withPlatformScope(async (c) => {
      const r = (
        await c.query(
          `SELECT id, status, org_id FROM knowledge.resources WHERE id = $1 AND deleted_at IS NULL`,
          [resourceId],
        )
      ).rows[0] as Row | undefined;
      if (!r || r.org_id !== null) throw new ProblemException('not_found', 'resource not found');
      if (r.status === 'ARCHIVED')
        throw new ProblemException('conflict', 'the resource is archived');
      if (
        pin &&
        !(
          await c.query(
            `SELECT 1 FROM knowledge.resource_versions WHERE id = $1 AND resource_id = $2`,
            [pin, resourceId],
          )
        ).rows.length
      )
        throw new ProblemException(
          'validation_failed',
          'versionPin is not a version of this resource',
        );
      const id = newId();
      const row = (
        await c.query(
          `INSERT INTO knowledge.template_defaults (id, platform, framework, category, plan, mode, resource_id, version_pin, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (platform, framework, category, plan, mode) DO UPDATE SET resource_id = EXCLUDED.resource_id, version_pin = EXCLUDED.version_pin, updated_by = EXCLUDED.updated_by, updated_at = now()
           RETURNING id`,
          [id, platform, framework, category, plan, mode, resourceId, pin, actor],
        )
      ).rows[0] as Row;
      return row.id as string;
    });
    await this.audit.record({
      action: 'knowledge.default.set',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'knowledge_default', id: out },
      outcome: 'success',
      detail: { platform, framework, category, plan, mode, resourceId, versionPin: pin },
    });
    return (await this.defaults()).items.find((x) => x.id === out);
  }
  async deleteDefault(actor: string, id: string) {
    if (!isUuid(id)) throw new ProblemException('not_found', 'default not found');
    const gone = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `DELETE FROM knowledge.template_defaults WHERE id = $1 RETURNING platform, framework, category, plan, mode, resource_id`,
            [id],
          )
        ).rows[0] as Row | undefined,
    );
    if (!gone) throw new ProblemException('not_found', 'default not found');
    await this.audit.record({
      action: 'knowledge.default.removed',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'knowledge_default', id },
      outcome: 'success',
      detail: {
        platform: gone.platform,
        framework: gone.framework,
        category: gone.category,
        plan: gone.plan,
        mode: gone.mode,
        resourceId: gone.resource_id,
      },
    });
    return { id };
  }

  // ---- shared loading --------------------------------------------------------------------------------------------------------------
  /** Every platform resource with its representative version (the ACTIVE one, else the newest) and its permissions. Archived ones only when asked. */
  private async candidates(c: Q, includeArchived: boolean): Promise<Candidate[]> {
    const rows = (
      await c.query(
        `SELECT r.id, r.name, r.description, r.resource_type, r.platform, r.frameworks, r.languages, r.category, r.tags, r.status, r.visibility, r.deleted_at,
                v.id AS version_id, v.seq, v.state AS version_state, v.license_verdict AS version_license,
                p.reuse_scope, p.component_reuse, p.starter_eligible, p.architecture_reference, p.ai_processing, p.license_verdict AS perm_license, p.license_spdx
           FROM knowledge.resources r
           LEFT JOIN LATERAL (SELECT * FROM knowledge.resource_versions x WHERE x.resource_id = r.id ORDER BY (x.state = 'ACTIVE') DESC, x.seq DESC LIMIT 1) v ON true
           LEFT JOIN knowledge.resource_permissions p ON p.resource_id = r.id
          WHERE r.org_id IS NULL AND r.deleted_at IS NULL ${includeArchived ? '' : `AND r.status <> 'ARCHIVED'`}
          ORDER BY r.created_at DESC, r.id LIMIT ${MAX_CANDIDATES}`,
      )
    ).rows as Row[];
    const ids = rows.map((r) => r.version_id as string | null).filter((x): x is string => !!x);
    const fw = new Map<string, string[]>();
    if (ids.length)
      for (const m of (
        await c.query(
          `SELECT DISTINCT ON (version_id) version_id, manifest -> 'frameworks' AS fw FROM knowledge.resource_manifests WHERE version_id = ANY($1::uuid[]) ORDER BY version_id, schema_version DESC`,
          [ids],
        )
      ).rows as Row[])
        fw.set(m.version_id as string, stringsOf(m.fw));
    return rows.map((r) => ({
      resourceId: r.id as string,
      versionId: (r.version_id as string | null) ?? null,
      versionSeq: r.seq === null || r.seq === undefined ? null : Number(r.seq),
      name: r.name as string,
      description: (r.description as string | null) ?? null,
      resourceType: r.resource_type as string,
      platform: (r.platform as string | null) ?? null,
      frameworks: [
        ...new Set([
          ...stringsOf(r.frameworks),
          ...(r.version_id ? (fw.get(r.version_id as string) ?? []) : []),
        ]),
      ].sort(),
      languages: stringsOf(r.languages),
      category: (r.category as string | null) ?? null,
      tags: stringsOf(r.tags),
      status: r.status as string,
      visibility: r.visibility as string,
      deleted: r.deleted_at !== null,
      versionState: (r.version_state as string | null) ?? null,
      versionLicense: (r.version_license as string | null) ?? null,
      perms: r.reuse_scope
        ? {
            licenseVerdict: r.perm_license as string,
            reuseScope: r.reuse_scope as string,
            componentReuse: r.component_reuse === true,
            starterEligible: r.starter_eligible === true,
            architectureReference: r.architecture_reference === true,
            aiProcessing: r.ai_processing === true,
            licenseSpdx: (r.license_spdx as string | null) ?? null,
          }
        : null,
    }));
  }

  /** Lexical, symbol and component matching of the term groups against the search documents of the given versions, plus the resource's own metadata. */
  private async lexical(c: Q, groups: TermGroup[], cands: Candidate[]) {
    const out = new Map<string, { matched: Map<string, number>; docs: Match[] }>();
    for (const k of cands) out.set(k.resourceId, { matched: new Map(), docs: [] });
    if (!groups.length) return out;
    const queries = groups.map((g) => tsQueryOf(g));
    const versionOf = new Map<string, string>();
    for (const k of cands) if (k.versionId) versionOf.set(k.versionId, k.resourceId);
    if (versionOf.size) {
      const idx: number[] = [];
      const qs: string[] = [];
      queries.forEach((q, i) => {
        if (q) {
          idx.push(i);
          qs.push(q);
        }
      });
      if (qs.length) {
        let rows: Row[];
        try {
          rows = (
            await c.query(
              `WITH q AS (SELECT g.i::int AS gi, to_tsquery('simple', g.q) AS tsq FROM unnest($1::text[]) WITH ORDINALITY AS g(q, i))
               SELECT q.gi, d.version_id, d.doc_kind, d.ref, d.title, left(d.body, 220) AS snippet, ts_rank_cd(d.tsv, q.tsq) AS rank
                 FROM q JOIN knowledge.resource_search_documents d ON d.version_id = ANY($2::uuid[]) AND d.tsv @@ q.tsq
                ORDER BY d.version_id, q.gi, rank DESC, d.ref LIMIT 20000`,
              [qs, [...versionOf.keys()]],
            )
          ).rows as Row[];
        } catch {
          throw new ProblemException(
            'validation_failed',
            'the search text could not be understood',
          );
        }
        for (const r of rows) {
          const res = out.get(versionOf.get(r.version_id as string)!);
          if (!res) continue;
          const g = groups[idx[Number(r.gi) - 1]!]!;
          const w = MATCH_WEIGHT[r.doc_kind as string] ?? 0.5;
          res.matched.set(g.key, Math.max(res.matched.get(g.key) ?? 0, w));
          if (res.docs.length < 40)
            res.docs.push({
              kind: r.doc_kind as string,
              ref: r.ref as string,
              title: r.title as string,
              snippet: r.snippet as string,
              rank: Number(r.rank) * w,
            });
        }
      }
    }
    // the resource's own metadata (name, description, tags, category): staff-entered, may be Arabic
    for (const k of cands) {
      const meta = normalizeText(
        [
          k.name,
          k.description ?? '',
          k.category ?? '',
          k.tags.join(' '),
          k.frameworks.join(' '),
        ].join(' '),
      );
      const res = out.get(k.resourceId)!;
      for (const g of groups)
        if (groupMatches(meta, g))
          res.matched.set(g.key, Math.max(res.matched.get(g.key) ?? 0, MATCH_WEIGHT.META!));
    }
    return out;
  }

  private evidence(docs: Match[]) {
    const seen = new Set<string>();
    const matches = docs
      .slice()
      .sort((a, b) => b.rank - a.rank || (a.ref < b.ref ? -1 : 1))
      .filter((d) => {
        const k = `${d.kind}|${d.ref}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 5)
      .map((d) => ({ kind: d.kind, ref: d.ref, title: d.title, snippet: d.snippet }));
    const components = [
      ...new Map(
        docs
          .filter((d) => d.kind === 'COMPONENT' || d.kind === 'SYMBOL')
          .map((d) => [d.ref, { name: d.title, ref: d.ref }]),
      ).values(),
    ].slice(0, 8);
    return { matches, components };
  }

  // ---- search --------------------------------------------------------------------------------------------------------------------
  /** Staff search over the platform library: structured filters, lexical/symbol/design matching, relevance, and for every hit whether it is eligible and why not. */
  async search(
    q: {
      q?: string;
      type?: string;
      platform?: string;
      framework?: string;
      language?: string;
      category?: string;
      tag?: string;
      status?: string;
      eligible?: string;
      mode?: string;
    },
    rawLimit?: string,
  ) {
    const limit = Math.min(parseLimit(rawLimit, 20), 50);
    const text0 = (q.q ?? '').slice(0, 300);
    const mode = oneOf(MODES, q.mode ?? 'ADAPTIVE', 'mode') as Mode;
    const platform = q.platform
      ? (oneOf(PLATFORM_LIST, q.platform, 'platform') as Platform)
      : undefined;
    const eligibleOnly =
      q.eligible === undefined
        ? undefined
        : oneOf(['true', 'false'] as const, q.eligible, 'eligible') === 'true';
    const groups = termGroups(text0);
    const req: Requirement = {
      mode,
      ...(platform ? { platform } : {}),
      ...(q.framework ? { frameworks: [q.framework] } : {}),
    };
    const out = await this.db.withPlatformScope(async (c) => {
      let cands = await this.candidates(c, q.status === 'ARCHIVED');
      if (q.type)
        cands = cands.filter(
          (k) =>
            k.resourceType ===
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
      if (platform) cands = cands.filter((k) => k.platform === platform);
      if (q.framework)
        cands = cands.filter((k) =>
          k.frameworks.map(frameworkId).includes(frameworkId(q.framework!)),
        );
      if (q.language)
        cands = cands.filter((k) =>
          k.languages.map((l) => l.toLowerCase()).includes(q.language!.toLowerCase()),
        );
      if (q.category)
        cands = cands.filter((k) => (k.category ?? '').toLowerCase() === q.category!.toLowerCase());
      if (q.tag)
        cands = cands.filter((k) =>
          k.tags.map((t) => t.toLowerCase()).includes(q.tag!.toLowerCase()),
        );
      if (q.status) cands = cands.filter((k) => k.status === q.status);
      const el = new Map(
        cands.map((k) => [
          k.resourceId,
          evaluateEligibility(
            {
              deleted: k.deleted,
              status: k.status,
              visibility: k.visibility,
              versionState: k.versionState,
              versionLicense: k.versionLicense,
              platform: k.platform,
              frameworks: k.frameworks,
              perms: k.perms,
              versionId: k.versionId,
            },
            { ...req, platform: undefined },
          ),
        ]),
      );
      if (eligibleOnly !== undefined)
        cands = cands.filter((k) => el.get(k.resourceId)!.eligible === eligibleOnly);
      const lex = await this.lexical(c, groups, cands);
      return { cands, el, lex };
    });
    const items = out.cands.map((k) => {
      const l = out.lex.get(k.resourceId)!;
      const cover = groups.length
        ? [...l.matched.values()].reduce((a, b) => a + b, 0) / groups.length
        : null;
      const ev = this.evidence(l.docs);
      return {
        resourceId: k.resourceId,
        versionId: k.versionId,
        versionSeq: k.versionSeq,
        name: k.name,
        description: k.description,
        resourceType: k.resourceType,
        platform: k.platform,
        frameworks: k.frameworks,
        category: k.category,
        tags: k.tags,
        status: k.status,
        relevance: cover === null ? null : Math.round(cover * 1000) / 10,
        matchedGroups: [...l.matched.keys()],
        rank: l.docs.reduce((a, d) => a + d.rank, 0),
        matches: ev.matches,
        components: ev.components,
        eligibility: out.el.get(k.resourceId)!,
        license: {
          spdx: k.perms?.licenseSpdx ?? null,
          verdict: k.perms?.licenseVerdict ?? 'UNKNOWN',
        },
        permissions: k.perms
          ? {
              reuseScope: k.perms.reuseScope,
              componentReuse: k.perms.componentReuse,
              starterEligible: k.perms.starterEligible,
              architectureReference: k.perms.architectureReference,
              aiProcessing: k.perms.aiProcessing,
              usages: allowedUsages(k.perms),
            }
          : null,
      };
    });
    const filtered = groups.length ? items.filter((x) => (x.relevance ?? 0) > 0) : items;
    filtered.sort(
      (a, b) =>
        (b.relevance ?? 0) - (a.relevance ?? 0) ||
        b.rank - a.rank ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : a.resourceId < b.resourceId ? -1 : 1),
    );
    return {
      query: {
        text: text0,
        groups: groups.map((g) => ({ key: g.key, from: g.from, concept: g.concept })),
      },
      total: filtered.length,
      items: filtered.slice(0, limit).map(({ rank: _rank, ...x }) => x),
    };
  }

  // ---- recommendation --------------------------------------------------------------------------------------------------------------
  private requirement(b: Row): { req: Requirement; limit: number } {
    const mode = oneOf(MODES, b.mode ?? 'ADAPTIVE', 'mode') as Mode;
    const req: Requirement = { mode };
    if (b.text !== undefined && b.text !== null) {
      if (typeof b.text !== 'string' || b.text.length > 2000)
        throw new ProblemException(
          'validation_failed',
          'text must be a string of at most 2000 characters',
        );
      if (b.text.trim()) req.text = b.text.trim();
    }
    if (b.platform !== undefined && b.platform !== null)
      req.platform = oneOf(PLATFORM_LIST, b.platform, 'platform') as Platform;
    if (b.frameworks !== undefined && b.frameworks !== null) {
      if (
        !Array.isArray(b.frameworks) ||
        b.frameworks.length > 10 ||
        b.frameworks.some((f) => typeof f !== 'string' || f.length < 1 || f.length > 40)
      )
        throw new ProblemException(
          'validation_failed',
          'frameworks must be a list of at most 10 names',
        );
      req.frameworks = [...new Set((b.frameworks as string[]).map((f) => f.trim()))];
    }
    const fr = bool(b.frameworksRequired, 'frameworksRequired');
    if (fr !== undefined) req.frameworksRequired = fr;
    if (b.category !== undefined && b.category !== null)
      req.category = text(b.category, 'category', 80)!;
    if (b.plan !== undefined && b.plan !== null) req.plan = text(b.plan, 'plan', 40)!;
    const ai = bool(b.requiresAiProcessing, 'requiresAiProcessing');
    if (ai !== undefined) req.requiresAiProcessing = ai;
    if (b.strategy !== undefined && b.strategy !== null)
      req.strategy = oneOf(STRATEGIES, b.strategy, 'strategy') as Strategy;
    if (b.resourceId !== undefined && b.resourceId !== null) {
      if (!isUuid(b.resourceId))
        throw new ProblemException('validation_failed', 'resourceId must be a resource id');
      req.resourceId = b.resourceId.toLowerCase();
    }
    if (req.strategy === 'USER_SELECTED' && !req.resourceId)
      throw new ProblemException('validation_failed', 'strategy USER_SELECTED needs resourceId');
    if (b.design !== undefined && b.design !== null) {
      const d = b.design as Row;
      if (typeof d !== 'object' || Array.isArray(d))
        throw new ProblemException('validation_failed', 'design must be an object');
      const design: NonNullable<Requirement['design']> = {};
      for (const k of ['darkMode', 'rtl', 'arabicFont', 'tailwind'] as const) {
        const v = bool(d[k], `design.${k}`);
        if (v !== undefined) design[k] = v;
      }
      if (d.primaryColor !== undefined && d.primaryColor !== null) {
        if (typeof d.primaryColor !== 'string' || !parseColor(d.primaryColor))
          throw new ProblemException(
            'validation_failed',
            'design.primaryColor must be a colour such as #2563eb',
          );
        design.primaryColor = d.primaryColor;
      }
      if (Object.keys(design).length) req.design = design;
    }
    const lim = b.limit === undefined ? 10 : Number(b.limit);
    if (!Number.isInteger(lim) || lim < 1 || lim > 20)
      throw new ProblemException('validation_failed', 'limit must be 1 to 20');
    return { req, limit: lim };
  }

  /** Ranks the eligible library for a requirement, explains every exclusion and every score, and applies the strategy. Read-only. */
  async recommend(body: Row) {
    const { req, limit } = this.requirement(body);
    const groups = req.text ? termGroups(req.text) : [];
    const out = await this.db.withPlatformScope(async (c) => {
      const cfg = await this.loadSettings(c);
      const all = await this.candidates(c, false);
      // 1. hard filters, before anything is matched or scored
      const evaluated = all.map((k) => ({
        k,
        e: evaluateEligibility(
          {
            deleted: k.deleted,
            status: k.status,
            visibility: k.visibility,
            versionState: k.versionState,
            versionLicense: k.versionLicense,
            platform: k.platform,
            frameworks: k.frameworks,
            perms: k.perms,
            versionId: k.versionId,
          },
          req,
        ),
      }));
      const eligible = evaluated.filter((x) => x.e.eligible).map((x) => x.k);
      const excluded = evaluated
        .filter((x) => !x.e.eligible)
        .map((x) => ({ resourceId: x.k.resourceId, name: x.k.name, reasons: x.e.reasons }));
      const pool = eligible.slice(0, MAX_RANKED);
      // 2. evidence for the eligible versions only
      const vids = pool.map((k) => k.versionId).filter((x): x is string => !!x);
      const arch = new Map<string, { architecture: unknown; components: number }>();
      const dna = new Map<string, unknown>();
      const quality = new Map<string, { dimension: string; score: number | null }[]>();
      if (vids.length) {
        for (const r of (
          await c.query(
            `SELECT DISTINCT ON (m.version_id) m.version_id, m.manifest -> 'architecture' AS architecture, (SELECT count(*)::int FROM knowledge.resource_components rc WHERE rc.version_id = m.version_id) AS components
               FROM knowledge.resource_manifests m WHERE m.version_id = ANY($1::uuid[]) ORDER BY m.version_id, m.schema_version DESC`,
            [vids],
          )
        ).rows as Row[])
          arch.set(r.version_id as string, {
            architecture: r.architecture,
            components: Number(r.components),
          });
        for (const r of (
          await c.query(
            `SELECT DISTINCT ON (version_id) version_id, result FROM knowledge.analysis_results WHERE version_id = ANY($1::uuid[]) AND analyzer = 'design-dna' ORDER BY version_id, created_at DESC`,
            [vids],
          )
        ).rows as Row[]) {
          const projects = (r.result as { projects?: unknown[]; primary?: number }).projects ?? [];
          dna.set(
            r.version_id as string,
            projects[(r.result as { primary?: number }).primary ?? 0] ?? projects[0] ?? null,
          );
        }
        for (const r of (
          await c.query(
            `SELECT DISTINCT ON (version_id, dimension) version_id, dimension, score, measured FROM knowledge.quality_scores WHERE version_id = ANY($1::uuid[]) ORDER BY version_id, dimension, computed_at DESC`,
            [vids],
          )
        ).rows as Row[]) {
          const l = quality.get(r.version_id as string) ?? [];
          l.push({
            dimension: r.dimension as string,
            score: r.measured === true && r.score !== null ? Number(r.score) : null,
          });
          quality.set(r.version_id as string, l);
        }
      }
      const lex = await this.lexical(c, groups, pool);
      // 3. the admin default (still has to pass every hard filter, with its pin)
      let adminDefault: { resourceId: string; eligible: boolean; reasons: string[] } | null = null;
      if ((req.strategy ?? 'AUTO_SELECT') === 'ADMIN_DEFAULT') {
        const rules = (
          await c.query(
            `SELECT platform, framework, category, plan, mode, resource_id, version_pin FROM knowledge.template_defaults`,
          )
        ).rows as Row[];
        const picked = pickDefault(
          rules.map((r): DefaultRule => ({
            platform: r.platform as string,
            framework: r.framework as string,
            category: r.category as string,
            plan: r.plan as string,
            mode: r.mode as string,
            resourceId: r.resource_id as string,
            versionPin: (r.version_pin as string | null) ?? null,
          })),
          req,
        );
        if (picked) {
          const k = all.find((x) => x.resourceId === picked.resourceId);
          const e = k
            ? evaluateEligibility(
                {
                  deleted: k.deleted,
                  status: k.status,
                  visibility: k.visibility,
                  versionState: k.versionState,
                  versionLicense: k.versionLicense,
                  platform: k.platform,
                  frameworks: k.frameworks,
                  perms: k.perms,
                  versionId: k.versionId,
                  pinnedVersionId: picked.versionPin,
                },
                req,
              )
            : { eligible: false, reasons: ['archived'] };
          adminDefault = {
            resourceId: picked.resourceId,
            eligible: e.eligible && !!pool.find((x) => x.resourceId === picked.resourceId),
            reasons: e.reasons,
          };
        }
      }
      return {
        cfg,
        pool,
        excluded,
        arch,
        dna,
        quality,
        lex,
        adminDefault,
        eligibleTotal: eligible.length,
        considered: all.length,
      };
    });
    // 4. score and rank (pure)
    const ranked = out.pool
      .map((k) => {
        const l = out.lex.get(k.resourceId)!;
        const a = k.versionId ? out.arch.get(k.versionId) : undefined;
        const scored = scoreCandidate(
          {
            req,
            functional: groups.length
              ? {
                  groups: groups.length,
                  matched: [...l.matched.entries()].map(([group, weight]) => ({ group, weight })),
                }
              : null,
            frameworks: k.frameworks,
            platform: k.platform,
            architecture: (a?.architecture as never) ?? null,
            componentCount: a?.components ?? 0,
            dna: k.versionId ? ((out.dna.get(k.versionId) as never) ?? null) : null,
            quality: k.versionId ? (out.quality.get(k.versionId) ?? []) : [],
            perms: k.perms,
          },
          out.cfg.settings,
        );
        const ev = this.evidence(l.docs);
        return {
          resourceId: k.resourceId,
          versionId: k.versionId,
          versionSeq: k.versionSeq,
          name: k.name,
          resourceType: k.resourceType,
          platform: k.platform,
          frameworks: k.frameworks,
          category: k.category,
          score: scored.score,
          confidence: scored.confidence,
          gated: scored.gated,
          dimensions: scored.dimensions,
          usage: {
            recommended: recommendedUsage(k.perms, req.mode),
            allowed: allowedUsages(k.perms),
          },
          license: {
            spdx: k.perms?.licenseSpdx ?? null,
            verdict: k.perms?.licenseVerdict ?? 'UNKNOWN',
          },
          permissions: k.perms
            ? {
                reuseScope: k.perms.reuseScope,
                componentReuse: k.perms.componentReuse,
                starterEligible: k.perms.starterEligible,
                architectureReference: k.perms.architectureReference,
                aiProcessing: k.perms.aiProcessing,
              }
            : null,
          matches: ev.matches,
          components: ev.components,
        };
      })
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.confidence - a.confidence ||
          (a.name < b.name ? -1 : a.name > b.name ? 1 : a.resourceId < b.resourceId ? -1 : 1),
      );
    const decision = decide({
      requested: req.strategy ?? 'AUTO_SELECT',
      ...(req.resourceId ? { resourceId: req.resourceId } : {}),
      ranked: ranked.map((r) => ({ resourceId: r.resourceId, score: r.score })),
      adminDefault: out.adminDefault
        ? { resourceId: out.adminDefault.resourceId, eligible: out.adminDefault.eligible }
        : null,
      minScore: out.cfg.settings.minScore,
    });
    const selected = ranked.find((r) => r.resourceId === decision.selectedResourceId) ?? null;
    const notes = [...decision.notes];
    // a user's choice that cannot be used is explained with its own reasons, and the alternatives are offered but never substituted
    let choice: { resourceId: string; name: string | null; reasons: string[] } | null = null;
    if (decision.strategy === 'USER_SELECTED' && !selected && req.resourceId) {
      const x = out.excluded.find((e) => e.resourceId === req.resourceId);
      choice = {
        resourceId: req.resourceId,
        name: x?.name ?? null,
        reasons: x?.reasons ?? ['not_found'],
      };
    }
    return {
      requirement: {
        ...req,
        groups: groups.map((g) => ({ key: g.key, from: g.from, concept: g.concept })),
      },
      settings: {
        weights: out.cfg.settings.weights,
        minScore: out.cfg.settings.minScore,
        revision: out.cfg.revision,
      },
      decision: {
        strategy: decision.strategy,
        selectedResourceId: decision.selectedResourceId,
        notes,
        requested: req.strategy ?? 'AUTO_SELECT',
      },
      selected,
      userChoice: choice,
      adminDefault: out.adminDefault,
      ranked: ranked.slice(0, limit),
      alternatives: decision.strategy === 'USER_SELECTED' && !selected ? ranked.slice(0, 3) : [],
      excluded: out.excluded.slice(0, 100),
      stats: {
        considered: out.considered,
        eligible: out.eligibleTotal,
        ranked: ranked.length,
        excluded: out.excluded.length,
        truncated: out.eligibleTotal > MAX_RANKED,
      },
    };
  }
}
