import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { createEnv, type TestEnv } from '@nuzm/platform/testing';
import { benchmarks as bm } from '@nuzm/domain';
import { BenchmarkFlags, BenchmarksService } from './internal/benchmarks.service';
import { PgBenchmarkStore } from './internal/store';

/**
 * S-AG5 persistence: migrations 1920 and 1921 on a real database through the runtime role (RLS enforced, platform scope only), append-only behaviour, idempotent inserts and a
 * full service run on the Postgres store. No model, no network.
 */
let env: TestEnv;
let store: PgBenchmarkStore;
beforeAll(async () => {
  env = await createEnv();
  store = new PgBenchmarkStore(env.app);
}, 120_000);
afterAll(async () => {
  await env?.close();
});

const run = (over: Record<string, unknown> = {}) => ({
  id: uuidv7(),
  label: 'x',
  datasetVersion: '2.0.0',
  datasetHash: 'a'.repeat(64),
  evidenceLabel: 'OFFLINE_REFERENCE_ORACLE',
  origins: ['REFERENCE'],
  adapters: ['reference-oracle:reference'],
  report: { tasks: 1 },
  scores: [],
  reportFingerprint: 'b'.repeat(64),
  requestId: randomUUID(),
  createdBy: randomUUID(),
  createdAt: new Date().toISOString(),
  ...over,
});

describe('benchmark tables', () => {
  it('store runs and records through the runtime role; a repeated requestId returns the stored row', async () => {
    const r = run();
    const a = await store.insertRun(r);
    const b = await store.insertRun({ ...r, id: uuidv7() });
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ created: false });
    expect(b.row.id).toBe(a.row.id);
    expect((await store.getRun(a.row.id))?.evidenceLabel).toBe('OFFLINE_REFERENCE_ORACLE');
    expect((await store.listRuns(5)).map((x) => x.id)).toContain(a.row.id);
    const rec = {
      id: uuidv7(),
      kind: 'budget' as const,
      subject: 'live',
      payload: { ref: 'B' },
      requestId: randomUUID(),
      recordedBy: randomUUID(),
      recordedAt: new Date().toISOString(),
    };
    expect((await store.insertRecord(rec)).created).toBe(true);
    expect((await store.insertRecord({ ...rec, id: uuidv7() })).created).toBe(false);
    expect((await store.records('budget', 'live')).length).toBe(1);
  });
  it('the runtime role cannot update or delete (append-only), and an unscoped session sees nothing (RLS)', async () => {
    const r = await store.insertRun(run());
    await expect(
      env.app.pool.query(`UPDATE ai.benchmark_runs SET label = 'y' WHERE id = $1`, [r.row.id]),
    ).rejects.toThrow(/permission denied/);
    await expect(env.app.pool.query(`DELETE FROM ai.benchmark_records`)).rejects.toThrow(
      /permission denied/,
    );
    const unscoped = await env.app.pool.query(`SELECT count(*)::int AS n FROM ai.benchmark_runs`);
    expect(unscoped.rows[0].n).toBe(0);
  });
  it('rejects rows that break the constraints (unknown evidence label, malformed hash, unknown kind)', async () => {
    await expect(store.insertRun(run({ evidenceLabel: 'REAL_MODEL_PERFORMANCE' }))).rejects.toThrow(
      /check constraint/,
    );
    await expect(store.insertRun(run({ datasetHash: 'zz' }))).rejects.toThrow(/check constraint/);
    await expect(
      store.insertRecord({
        id: uuidv7(),
        kind: 'nope' as never,
        subject: 's',
        payload: {},
        requestId: null,
        recordedBy: randomUUID(),
        recordedAt: '',
      }),
    ).rejects.toThrow(/check constraint/);
  });
  it('the service works end to end on the Postgres store (flag on): offline run, gate closed, live attempt refused', async () => {
    const svc = new BenchmarksService(
      store,
      { record: () => undefined },
      new (class extends BenchmarkFlags {
        enabled = () => Promise.resolve(true);
      })(),
    );
    const r = await svc.runOffline(randomUUID(), { source: 'mock:ideal', requestId: randomUUID() });
    expect(r.evidence).toBe('OFFLINE_MOCK_REPLAY');
    const g = await svc.evaluateGate(randomUUID(), { runId: r.id });
    expect(g.decision.allowed).toBe(false);
    const full = await svc.getRun(r.id);
    expect((full.report as bm.BenchmarkReport).tasks).toBe(bm.GOLDEN_TASKS.length);
    const live = await svc.attemptLiveRun(randomUUID(), { requestId: randomUUID() });
    expect(live.started).toBe(false);
    expect(full).toHaveProperty('scorecard');
    expect((full as { scorecard: unknown[] }).scorecard).toHaveLength(7);
  });

  it('a budget stored with its price card (jsonb round trip) makes the stage plan and the preflight use that price', async () => {
    const svc = new BenchmarksService(
      store,
      { record: () => undefined },
      new (class extends BenchmarkFlags {
        enabled = () => Promise.resolve(true);
      })(),
    );
    const who = randomUUID();
    await svc.setBudget(who, {
      ref: 'BUD-PG',
      currency: 'USD',
      maxCostMinor: '9000',
      maxTokens: 4_200_000,
      maxRequests: 500,
      price: {
        minorPerMillionInput: '400',
        minorPerMillionOutput: '2000',
        source: 'agreement ref',
      },
      requestId: randomUUID(),
    });
    const o = (await svc.overview()) as {
      live: {
        stages: {
          rateBasis: { status: string };
          plans: { stage: string; max: { costMinor: string } }[];
        };
      };
    };
    expect(o.live.stages.rateBasis.status).toBe('APPROVED_WITH_BUDGET');
    expect(o.live.stages.plans.find((p) => p.stage === 'C')!.max.costMinor).toBe('8360');
    const c = await svc.attemptLiveRun(who, { stage: 'C', requestId: randomUUID() });
    const codes = c.refusals.map((x) => x.code);
    expect(codes).not.toContain('PRICE_CARD_INVALID');
    expect(codes).not.toContain('BUDGET_TOO_SMALL');
    expect(codes).toContain('NO_CAPTURE_SOURCE');
    expect(c.started).toBe(false);
  });
});
