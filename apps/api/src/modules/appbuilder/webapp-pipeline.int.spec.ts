import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleFiles } from './internal/agents/webapp-agents';
import { fixtureFromSpec, scoreArtifacts } from './internal/eval/evaluation';
import { CRM_SPEC } from './internal/fixtures/crm-appspec';
import { SAMPLE_SPEC } from './internal/fixtures/sample-spec';
import { generateProject } from './internal/gen/project';
import { WEBAPP_GRAPH } from './internal/graph/dag';
import { setupEngineEnv, type EngineEnv } from './internal/testing/engine-harness';
import { materialize } from './internal/testing/materialize';

let e: EngineEnv;
beforeAll(async () => {
  e = await setupEngineEnv();
  e.useRealAgents();
  e.model.register('requirements', () => ({
    summary: 'A CRM',
    entities: CRM_SPEC.entities.map((x) => ({ name: x.name })),
    roles: CRM_SPEC.roles.map((r) => r.name),
    locales: ['ar', 'en'],
  }));
  e.model.register('app_spec', () => CRM_SPEC);
}, 120_000);
afterAll(() => e.close());

const start = async (specOverride?: unknown) => {
  if (specOverride) e.model.register('app_spec', () => specOverride);
  const p = await e.projects.create(e.orgA, {
    type: 'webapp',
    name: 'crm',
    dataRegion: 'sa-central',
    createdBy: null,
  });
  const run = await e.runs.create(e.orgA, {
    kind: 'webapp',
    projectId: p.id,
    budget: { maxTokens: 900_000, maxCostMinor: 1_000_000, maxMinutes: 30 },
    dataRegion: 'sa-central',
    createdBy: null,
  });
  return { project: p, runId: run.id };
};

describe('web-app pipeline with the real agents on the reference-CRM spec fixture (scripted model: NOT VERIFIED for quality)', () => {
  it('runs the seven agents, stores a spec version, produces a complete project and scores every agent', async () => {
    const { project, runId } = await start();
    const out = await e.runner().run(e.orgA, runId, WEBAPP_GRAPH, { brief: { prompt: 'a CRM' } });
    if (out.status !== 'succeeded')
      throw new Error(
        JSON.stringify(out) +
          JSON.stringify(
            await e.env.sql(
              `SELECT node,status,error_code FROM ai.run_steps WHERE run_id=$1 ORDER BY seq`,
              [runId],
            ),
          ),
      );
    expect(out.status).toBe('succeeded');
    const arts = (out as { artifacts: Record<string, unknown> }).artifacts;
    const files = assembleFiles(arts);
    for (const f of [
      'src/engine.ts',
      'public/app.js',
      'db/migrations/0001_init.sql',
      'tests/rbac.test.ts',
      'package.json',
      'openapi.json',
      'nuzm.app.json',
    ])
      expect(files.has(f), f).toBe(true);
    const v = await e.projects.commit(e.orgA, project.id, {
      baseVersionId: null,
      files,
      label: 'generated',
      source: 'ai',
      createdBy: null,
    });
    expect((await e.projects.readFiles(e.orgA, project.id, v.id))!.size).toBe(files.size);
    // the spec version is stored, hashed and immutable
    const spec = await e.specs.get(e.orgA, project.id);
    expect(spec).toMatchObject({ version: 1, status: 'draft' });
    await expect(
      e.env.sql(`UPDATE builder.app_specs SET spec = '{}'::jsonb WHERE id = $1`, [spec.id]),
    ).rejects.toThrow(/immutable/);
    // evaluation: structural scores against the fixture, labelled mock_model
    const scores = scoreArtifacts(fixtureFromSpec('crm-v1', CRM_SPEC), arts);
    expect(scores.map((s) => s.agent)).toEqual([
      'requirements',
      'architecture',
      'database',
      'backend',
      'frontend',
      'qa',
      'devops',
    ]);
    for (const s of scores) expect(s.score, s.agent).toBe(1);
    const rows = await e.evals.record(e.orgA, {
      runId,
      suite: 'webapp.structural',
      fixture: 'crm-v1',
      scores,
      mockModel: true,
      dataRegion: 'sa-central',
    });
    expect(rows).toHaveLength(7);
    expect((await e.evals.list(e.orgB, { runId })).length).toBe(0);
    expect((await e.evals.list(e.orgA, { runId })).every((r) => r.mockModel)).toBe(true);
    await expect(e.env.sql(`UPDATE ai.evaluations SET score = 0`)).rejects.toThrow(/append-only/);
  });

  it('a spec the model gets wrong is repaired (semantic check) and a spec that stays invalid fails the run', async () => {
    const bad = JSON.parse(JSON.stringify(CRM_SPEC));
    bad.entities[1].fields[5].references = 'Ghost';
    let calls = 0;
    e.model.register('app_spec', () => (++calls === 1 ? bad : CRM_SPEC));
    const { runId } = await start();
    const out = await e.runner().run(e.orgA, runId, WEBAPP_GRAPH, { brief: {} });
    expect(out.status).toBe('succeeded');
    expect(calls).toBe(2);
    e.model.register('app_spec', () => bad);
    const { runId: r2 } = await start();
    expect(await e.runner().run(e.orgA, r2, WEBAPP_GRAPH, { brief: {} })).toEqual({
      status: 'failed',
      reason: 'artifact_invalid',
    });
    e.model.register('app_spec', () => CRM_SPEC);
  });

  it('a changed spec yields an expand/contract diff against the approved one; removing a field parks the run for the destructive_migration approval', async () => {
    const { project, runId } = await start();
    await e.runner().run(e.orgA, runId, WEBAPP_GRAPH, { brief: {} });
    const v1 = await e.specs.get(e.orgA, project.id);
    await e.specs.approve(e.orgA, project.id, v1.version, '00000000-0000-7000-8000-0000000000f1');
    const next = JSON.parse(JSON.stringify(CRM_SPEC));
    next.entities[2].fields = next.entities[2].fields.filter(
      (f: { name: string }) => f.name !== 'company',
    );
    next.entities[2].searchable = ['name', 'email']; // Lead.company removed
    next.entities[3].fields.push({
      name: 'forecast',
      type: 'decimal',
      labels: { ar: 'توقع', en: 'Forecast' },
    });
    e.model.register('app_spec', () => next);
    const run2 = await e.runs.create(e.orgA, {
      kind: 'webapp',
      projectId: project.id,
      budget: { maxTokens: 900_000, maxCostMinor: 1_000_000, maxMinutes: 30 },
      dataRegion: 'sa-central',
      createdBy: null,
    });
    const out = await e.runner().run(e.orgA, run2.id, WEBAPP_GRAPH, { brief: {} });
    expect(out.status).toBe('waiting_approval');
    const [ap] = await e.approvals.list(e.orgA, { runId: run2.id });
    expect(ap).toMatchObject({
      type: 'destructive_migration',
      status: 'pending',
      requestedByKind: 'ai',
    });
    expect((ap!.action as { statements: string[] }).statements.join()).toMatch(
      /DROP COLUMN "company"/,
    );
    const dbStep = (
      await e.env.sql(`SELECT status FROM ai.run_steps WHERE run_id = $1 AND node = 'database'`, [
        run2.id,
      ])
    )[0]!;
    expect(dbStep.status).toBe('waiting_approval');
    // nothing after the database node ran while the approval is pending
    expect(
      (
        await e.env.sql(`SELECT node FROM ai.run_steps WHERE run_id = $1 ORDER BY seq`, [run2.id])
      ).map((r) => r.node),
    ).toEqual(['requirements', 'architecture', 'database']);
    await e.approvals.decide(
      e.orgA,
      {
        userId: '00000000-0000-7000-8000-0000000000f1',
        role: 'admin',
        permissions: new Set(['ai:approve']),
      },
      ap!.id,
      { decision: 'approve', scopeHash: ap!.scopeHash },
    );
    const done = await e.runner().run(e.orgA, run2.id, WEBAPP_GRAPH, { brief: {} });
    expect(done.status).toBe('succeeded');
    const db = (
      done as {
        artifacts: Record<
          string,
          { migrations: { version: number; phase?: string; up: string }[] }
        >;
      }
    ).artifacts['db_schema']!;
    expect(db.migrations.map((m) => m.version)).toEqual([1, 2, 3]);
    expect(db.migrations[1]!.up).toMatch(/ADD COLUMN "forecast"/);
    expect(db.migrations[2]!.up).toMatch(/DROP COLUMN "company"/);
  });

  it('the generated reference CRM type-checks, and its own tests pass', () => {
    const m = materialize(generateProject(CRM_SPEC).files);
    try {
      const tsc = join(__dirname, '../../../../../node_modules/typescript/bin/tsc');
      const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
      const a = spawnSync(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json'], {
        cwd: m.dir,
        encoding: 'utf8',
        env,
        timeout: 280_000,
      });
      expect(a.stdout + a.stderr).toBe('');
      const t = spawnSync(
        process.execPath,
        ['--experimental-strip-types', '--test', '--test-concurrency=1', 'tests/*.test.ts'],
        { cwd: m.dir, encoding: 'utf8', env, timeout: 280_000 },
      );
      expect(t.stdout).toMatch(/# fail 0/);
      expect(Number(/# pass (\d+)/.exec(t.stdout)?.[1])).toBeGreaterThan(40);
    } finally {
      m.cleanup();
    }
  }, 600_000);

  it('the sample spec used elsewhere also generates (guards against a spec-specific generator)', () => {
    expect(generateProject(SAMPLE_SPEC).files.size).toBeGreaterThan(30);
  });
});
