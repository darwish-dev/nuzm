import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, ORG_A, ORG_B, type TestEnv } from '@nuzm/platform/testing';
import { executionGateway as eg } from '@nuzm/domain';
import {
  durableExecutionEnabled,
  PgExecutionJournal,
  type JournalErrorReport,
} from './durable-journal';
import { PgExecutionStore } from './internal/store';

/**
 * P3-S02: the orchestrator with the Postgres journal attached, on a real database through the RUNTIME role (RLS enforced). Mock port only: nothing is executed. Proves what the journal
 * promises: the job and every transition are durable and ordered, creation is fail-closed, a restart terminates (never resumes) what the previous process left, the kill switch
 * survives a restart, and one organization never sees another's rows. The work queue itself stays in memory (documented in journal.ts): this is NOT a durable queue.
 */
let env: TestEnv;
let store: PgExecutionStore;
beforeAll(async () => {
  env = await createEnv();
  store = new PgExecutionStore(env.app);
}, 180_000);
afterAll(async () => {
  await env?.close();
});

const ctx = (orgId: string): eg.ExecContext => ({
  orgId,
  runId: 'run-1',
  enabledProfiles: ['typecheck', 'unit-tests', 'build'],
  projectScripts: [],
});
const CEIL: eg.OrgCeilings = {
  maxConcurrent: 2,
  maxRunsPerWindow: 50,
  windowMs: 3_600_000,
  maxCpuSecondsPerWindow: 100_000,
  budgetCapMinor: 1_000_000,
  rates: { currency: 'SAR', minorPerKiloCpuSecond: 100 },
};
function orchestrator(
  orgId: string,
  journal: eg.ExecutionJournal,
  killSwitch: eg.ExecutionKillSwitch = new eg.ExecutionKillSwitch(),
) {
  return new eg.ExecutionOrchestrator({
    port: eg.createMockExecutionPort(ctx(orgId)),
    ledger: new eg.QuotaLedger(() => Date.now()),
    queue: new eg.ExecutionQueue<string>(eg.DEFAULT_QUEUE_CONFIG, () => Date.now()),
    approvals: new eg.ApprovalWorkflow(() => Date.now(), 60_000),
    killSwitch,
    audit: () => undefined,
    gate: () => eg.CLOSED_GATE,
    flags: () => ({ execTools: true, aiKillSwitch: false }),
    ceilings: () => CEIL,
    canaries: () => [],
    now: () => Date.now(),
    journal: { sink: journal, dataRegion: () => 'sa' },
  });
}
const submit = (o: eg.ExecutionOrchestrator, orgId: string, key: string) =>
  o.submit({
    orgId,
    runId: 'run-1',
    idempotencyKey: key,
    request: { orgId, runId: 'run-1', profile: 'typecheck' },
  });
const rowsOf = (key: string) =>
  env.sql(
    `SELECT id, state, attempts, outcome_status, exit_code, duration_ms, artifact_count, data_region, origin, started_at, ended_at FROM execution.jobs WHERE idempotency_key = $1`,
    [key],
  );

describe('flag', () => {
  it('is OFF unless exactly true', () => {
    for (const v of [undefined, null, false, 0, 1, 'true', 'on', {}])
      expect(durableExecutionEnabled(v)).toBe(false);
    expect(durableExecutionEnabled(true)).toBe(true);
  });
});

describe('PgExecutionJournal with the orchestrator', () => {
  it('records the job and every transition, in order, with the outcome', async () => {
    const errors: JournalErrorReport[] = [];
    const j = new PgExecutionJournal(store, (e) => errors.push(e));
    const o = orchestrator(ORG_A, j);
    expect(await submit(o, ORG_A, 'idem-journal-1')).toMatchObject({ status: 'queued' });
    expect(await o.runNext('w')).toMatchObject({ state: 'succeeded' });
    await j.drain();
    const [row] = await rowsOf('idem-journal-1');
    expect(row).toMatchObject({
      state: 'succeeded',
      attempts: 1,
      outcome_status: 'completed',
      exit_code: 0,
      data_region: 'sa',
      origin: 'MOCK',
    });
    expect(row.started_at).not.toBeNull();
    expect(row.ended_at).not.toBeNull();
    const t = await env.sql(
      `SELECT from_state, to_state, cause FROM execution.job_transitions WHERE job_id = $1 ORDER BY at, id`,
      [row.id],
    );
    expect(
      t.map((x: { from_state: string; to_state: string }) => `${x.from_state}>${x.to_state}`),
    ).toEqual(['requested>requested', 'requested>queued', 'queued>running', 'running>succeeded']);
    expect(errors).toEqual([]);
    expect(j.failures()).toBe(0);
  });

  it('FAIL CLOSED: when the store is down the submit is refused, no row exists, nothing runs', async () => {
    const down = new PgExecutionStore(env.app);
    down.enqueue = () => Promise.reject(new Error('connection refused'));
    const errors: JournalErrorReport[] = [];
    const j = new PgExecutionJournal(down, (e) => errors.push(e));
    const o = orchestrator(ORG_A, j);
    expect(await submit(o, ORG_A, 'idem-journal-down')).toEqual({
      status: 'refused',
      reasons: ['journal_unavailable'],
    });
    expect(await o.runNext('w')).toBeNull();
    expect(await rowsOf('idem-journal-down')).toEqual([]);
    expect(errors).toEqual([{ op: 'created', jobId: 'ej-1', reason: 'store_error' }]);
  });

  it('a write-behind failure is counted and reported but never reaches the run', async () => {
    const flaky = new PgExecutionStore(env.app);
    const errors: JournalErrorReport[] = [];
    const j = new PgExecutionJournal(flaky, (e) => errors.push(e));
    const o = orchestrator(ORG_A, j);
    await submit(o, ORG_A, 'idem-journal-flaky');
    await j.drain();
    flaky.transition = () => Promise.reject(new Error('timeout'));
    expect(await o.runNext('w')).toMatchObject({ state: 'succeeded' }); // the run completes in memory
    await j.drain();
    expect(j.failures()).toBe(2); // queued>running, running>succeeded
    expect(errors.every((e) => e.op === 'moved' && e.reason === 'store_error')).toBe(true);
    const [row] = await rowsOf('idem-journal-flaky');
    expect(row.state).toBe('queued'); // the durable record lags; reconcileOnStart repairs it on the next start
  });

  it('restart: reconcileOnStart terminates what the previous process left, and the old key is refused (never silently resumed)', async () => {
    const first = new PgExecutionJournal(store);
    const o1 = orchestrator(ORG_A, first);
    await submit(o1, ORG_A, 'idem-journal-restart');
    await first.drain();
    expect((await rowsOf('idem-journal-restart'))[0].state).toBe('queued');
    // the process dies here; a new one starts
    const second = new PgExecutionJournal(store);
    const r = await second.reconcileOnStart();
    expect(r.terminated).toBeGreaterThanOrEqual(1);
    const [row] = await rowsOf('idem-journal-restart');
    expect(row).toMatchObject({ state: 'terminated', outcome_status: 'terminated' });
    const last = await env.sql(
      `SELECT cause FROM execution.job_transitions WHERE job_id = $1 ORDER BY at DESC, id DESC LIMIT 1`,
      [row.id],
    );
    expect(last[0].cause).toBe('restart_recovery');
    const o2 = orchestrator(ORG_A, second);
    expect(await submit(o2, ORG_A, 'idem-journal-restart')).toEqual({
      status: 'refused',
      reasons: ['idempotency_key_already_recorded'],
    });
    expect(await o2.runNext('w')).toBeNull();
    // a new key works
    expect(await submit(o2, ORG_A, 'idem-journal-restart-2')).toMatchObject({ status: 'queued' });
    await second.drain();
  });

  it('records only identifiers, states, causes and numbers: no request, output or environment column exists to leak into', async () => {
    const cols = await env.sql(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'execution' AND table_name IN ('jobs','job_transitions')`,
    );
    const names = cols.map((c: { column_name: string }) => c.column_name);
    expect(
      names.filter((n: string) => /stdout|stderr|argv|env|payload|request|secret/i.test(n)),
    ).toEqual([]);
  });

  it('cross-tenant: another organization sees none of the journaled rows', async () => {
    const j = new PgExecutionJournal(store);
    const o = orchestrator(ORG_A, j);
    await submit(o, ORG_A, 'idem-journal-iso');
    await j.drain();
    const [row] = await rowsOf('idem-journal-iso');
    expect(await store.get(ORG_B, row.id)).toBeNull();
    const seen = await env.app.withOrg(ORG_B, (c) =>
      c.query(`SELECT count(*)::int AS n FROM execution.jobs WHERE org_id = $1`, [ORG_A]),
    );
    expect(seen.rows[0].n).toBe(0);
  });
});

describe('durable kill switch', () => {
  const settle = async (j: PgExecutionJournal, want: boolean, orgId: string) => {
    for (let i = 0; i < 50; i++) {
      if ((await store.isStopped(orgId)) === want) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('kill switch write never landed');
  };
  it('every engage and release is appended, and a restart restores the engaged state (never silently released)', async () => {
    const j = new PgExecutionJournal(store);
    const ks = j.createKillSwitch();
    ks.engageOrg(ORG_A, 'canary_in_output');
    await settle(j, true, ORG_A);
    expect(await store.isStopped(ORG_B)).toBe(false);
    // a new process: a fresh switch starts released in memory, then hydrates from the store
    const j2 = new PgExecutionJournal(store);
    const ks2 = j2.createKillSwitch();
    expect(ks2.isEngaged(ORG_A)).toBe(false);
    await j2.hydrateKillSwitch(ks2);
    expect(ks2.isEngaged(ORG_A)).toBe(true);
    expect(ks2.isEngaged(ORG_B)).toBe(false);
    // hydration does not append rows
    const before = await env.sql(`SELECT count(*)::int AS n FROM execution.kill_switch`);
    await j2.hydrateKillSwitch(j2.createKillSwitch());
    expect((await env.sql(`SELECT count(*)::int AS n FROM execution.kill_switch`))[0].n).toBe(
      before[0].n,
    );
    // the orchestrator refuses while it is engaged
    const o = orchestrator(ORG_A, j2, ks2);
    expect(await submit(o, ORG_A, 'idem-journal-kill')).toMatchObject({
      status: 'refused',
      reasons: expect.arrayContaining(['execution_kill_switch']),
    });
    // release is deliberate and recorded; the next start sees it released
    ks.releaseOrg(ORG_A);
    await settle(j, false, ORG_A);
    const ks3 = new PgExecutionJournal(store).createKillSwitch();
    await new PgExecutionJournal(store).hydrateKillSwitch(ks3);
    expect(ks3.isEngaged(ORG_A)).toBe(false);
    const hist = await env.sql(
      `SELECT engaged, reason_code FROM execution.kill_switch WHERE org_id = $1 ORDER BY at, id`,
      [ORG_A],
    );
    expect(hist.map((h: { engaged: boolean }) => h.engaged)).toEqual([true, false]);
    expect(hist[0].reason_code).toBe('canary_in_output');
  });

  it('start FAILS when the kill-switch state cannot be read (no execution with an unknown state)', async () => {
    const broken = new PgExecutionStore(env.app);
    broken.engagedScopes = () => Promise.reject(new Error('db down'));
    const j = new PgExecutionJournal(broken);
    await expect(j.hydrateKillSwitch(j.createKillSwitch())).rejects.toThrow('db down');
  });
});
