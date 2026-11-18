import type { Db } from '@nuzm/platform';
import { iso, newId, type AgentId, type Row } from '../core';
import type { AppSpec } from '../spec/app-spec';
import { validateAppSpec } from '../spec/app-spec';

export interface Score {
  agent: AgentId;
  score: number;
  details: Record<string, unknown>;
}
const ratio = (hit: number, total: number) => (total === 0 ? 1 : Math.min(1, hit / total));
const round = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * Evaluation harness (M10 §4 S44.4): scores each agent's artifact against a FIXTURE (the expected entities, roles, pages and so on). The scores are structural and
 * deterministic: they measure whether an agent covered what the fixture lists and produced something valid, NOT whether a language model has good judgement.
 * Rows produced from a scripted model carry `mock_model = true` and are never counted as evidence of model quality (NOT VERIFIED until D-18/HG-09-01).
 */
export interface EvalFixture {
  name: string;
  /** Names the requirements must mention. */
  entities: string[];
  roles: string[];
  locales: ('ar' | 'en')[];
  pages: string[];
}
export function fixtureFromSpec(name: string, spec: AppSpec): EvalFixture {
  return {
    name,
    entities: spec.entities.map((e) => e.name),
    roles: spec.roles.map((r) => r.name),
    locales: spec.locales,
    pages: spec.pages.map((p) => p.path),
  };
}

type Art = Record<string, unknown>;
type FileList = { path: string }[];

export function scoreArtifacts(fx: EvalFixture, a: Art): Score[] {
  const out: Score[] = [];
  const req = a['requirements'] as
    { entities?: { name: string }[]; roles?: string[]; locales?: string[] } | undefined;
  if (req) {
    const ents = new Set((req.entities ?? []).map((e) => e.name.toLowerCase()));
    const roles = new Set((req.roles ?? []).map((r) => r.toLowerCase()));
    const e = ratio(
      fx.entities.filter((n) => ents.has(n.toLowerCase())).length,
      fx.entities.length,
    );
    const r = ratio(fx.roles.filter((n) => roles.has(n.toLowerCase())).length, fx.roles.length);
    const l = ratio(
      fx.locales.filter((x) => (req.locales ?? []).includes(x)).length,
      fx.locales.length,
    );
    out.push({
      agent: 'requirements',
      score: round((e + r + l) / 3),
      details: { entityCoverage: e, roleCoverage: r, localeCoverage: l },
    });
  }
  const spec = a['app_spec'] as AppSpec | undefined;
  if (spec) {
    const v = validateAppSpec(spec);
    const e = ratio(
      fx.entities.filter((n) => spec.entities?.some((x) => x.name === n)).length,
      fx.entities.length,
    );
    const r = ratio(
      fx.roles.filter((n) => spec.roles?.some((x) => x.name === n)).length,
      fx.roles.length,
    );
    const p = ratio(
      fx.pages.filter((n) => spec.pages?.some((x) => x.path === n)).length,
      fx.pages.length,
    );
    out.push({
      agent: 'architecture',
      score: round(v.ok ? (e + r + p) / 3 : 0),
      details: {
        valid: v.ok,
        issues: v.issues.slice(0, 5),
        entityCoverage: e,
        roleCoverage: r,
        pageCoverage: p,
      },
    });
    const db = a['db_schema'] as
      { migrations?: { up: string; down: string }[]; tables?: string[] } | undefined;
    if (db) {
      const t = ratio(
        spec.entities.filter((x) => db.tables?.includes(x.plural)).length,
        spec.entities.length,
      );
      const reversible =
        (db.migrations ?? []).length > 0 &&
        (db.migrations ?? []).every((m) => m.down.trim().length > 0);
      const created = spec.entities.every((x) =>
        (db.migrations ?? []).some((m) => m.up.includes(`CREATE TABLE "${x.plural}"`)),
      );
      out.push({
        agent: 'database',
        score: round((t + (reversible ? 1 : 0) + (created ? 1 : 0)) / 3),
        details: { tableCoverage: t, reversible, created },
      });
    }
    const api = a['api_contract'] as
      { openapi?: { paths?: Record<string, unknown> }; files?: FileList } | undefined;
    if (api) {
      const paths = Object.keys(api.openapi?.paths ?? {});
      const cov = ratio(
        spec.entities.filter((x) => paths.some((p) => p.endsWith('/' + x.plural))).length,
        spec.entities.length,
      );
      out.push({
        agent: 'backend',
        score: round(
          (cov + ((api.files ?? []).some((f) => f.path === 'src/engine.ts') ? 1 : 0)) / 2,
        ),
        details: { pathCoverage: cov, pathCount: paths.length },
      });
    }
    const fe = a['frontend_bundle'] as { pages?: string[]; files?: FileList } | undefined;
    if (fe) {
      const cov = ratio(fx.pages.filter((p) => fe.pages?.includes(p)).length, fx.pages.length);
      const has = (p: string) => (fe.files ?? []).some((f) => f.path === p);
      out.push({
        agent: 'frontend',
        score: round(
          (cov +
            (has('public/index.html') ? 1 : 0) +
            (has('public/app.js') ? 1 : 0) +
            (has('public/styles.css') ? 1 : 0)) /
            4,
        ),
        details: { pageCoverage: cov },
      });
    }
    const qa = a['test_plan'] as
      { summary?: { contractTests: number; unitTests: number }; files?: FileList } | undefined;
    if (qa) {
      const files = (qa.files ?? []).map((f) => f.path);
      const wanted = [
        'tests/contract.test.ts',
        'tests/rbac.test.ts',
        'tests/validation.test.ts',
        'tests/auth.test.ts',
      ];
      const cov = ratio(wanted.filter((w) => files.includes(w)).length, wanted.length);
      out.push({
        agent: 'qa',
        score: round(cov),
        details: { requiredFiles: cov, summary: qa.summary },
      });
    }
    const dv = a['deploy_plan'] as
      { healthPath?: string; env?: string[]; files?: FileList } | undefined;
    if (dv) {
      const ok =
        dv.healthPath === '/health' &&
        (dv.env ?? []).includes('SESSION_SECRET') &&
        (dv.files ?? []).some((f) => f.path === 'nuzm.app.json');
      out.push({
        agent: 'devops',
        score: ok ? 1 : 0,
        details: { health: dv.healthPath, env: dv.env },
      });
    }
  }
  return out;
}

export class EvaluationService {
  constructor(private readonly db: Db) {}
  async record(
    orgId: string,
    i: {
      runId: string | null;
      suite: string;
      fixture: string;
      scores: Score[];
      mockModel: boolean;
      dataRegion: string;
    },
  ): Promise<Row[]> {
    const rows: Row[] = [];
    await this.db.withOrg(orgId, async (c) => {
      for (const s of i.scores)
        rows.push(
          (
            await c.query(
              `INSERT INTO ai.evaluations (id, org_id, run_id, suite, agent, fixture, score, details, mock_model, data_region) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
              [
                newId(),
                orgId,
                i.runId,
                i.suite,
                s.agent,
                i.fixture,
                s.score,
                JSON.stringify(s.details),
                i.mockModel,
                i.dataRegion,
              ],
            )
          ).rows[0] as Row,
        );
    });
    return rows;
  }
  async list(orgId: string, f: { runId?: string; limit?: number } = {}) {
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM ai.evaluations WHERE org_id = $1 AND ($2::uuid IS NULL OR run_id = $2) ORDER BY created_at DESC, id LIMIT $3`,
            [orgId, f.runId ?? null, Math.min(f.limit ?? 100, 500)],
          )
        ).rows as Row[],
    );
    return rows.map((r) => ({
      id: r.id as string,
      runId: (r.run_id as string | null) ?? null,
      suite: r.suite as string,
      agent: r.agent as string | null,
      fixture: r.fixture as string,
      score: Number(r.score),
      details: r.details as Record<string, unknown>,
      mockModel: r.mock_model as boolean,
      createdAt: iso(r.created_at)!,
    }));
  }
}
