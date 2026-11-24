import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, ORG_A, ORG_B, SEED_USER, type TestEnv } from '@nuzm/platform/testing';
import { executionGateway as eg } from '@nuzm/domain';
import { PgExecutionStore, type NewJob } from './store';

/**
 * P3-S02 durable stores on a real database through the RUNTIME role (RLS enforced): idempotent enqueue, fair atomic claim, lease expiry, the SQL transition guards equal to the
 * domain's (every pair), append-only history, single-use approvals under a race, kill-switch semantics, workspace and attestation records, cross-tenant isolation.
 * Synthetic data only; nothing is executed.
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
const digest = () => 'a'.repeat(64);
const job = (org: string, key: string, over: Partial<NewJob> = {}): NewJob => ({ orgId: org, runId: `run-${key}`, idempotencyKey: key, profile: 'typecheck', decisionDigest: digest(), origin: 'MOCK', requiresApproval: false, dataRegion: 'sa', ...over });
const states = ['requested', 'refused', 'awaiting_approval', 'rejected', 'queued', 'running', 'succeeded', 'failed', 'timed_out', 'terminated', 'cancelled', 'expired'] as const;

describe('jobs', () => {
  it('enqueue is idempotent per (org, key) and logs one transition', async () => {
    const a = await store.enqueue(job(ORG_A, 'k1'));
    const b = await store.enqueue(job(ORG_A, 'k1', { profile: 'build' }));
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    expect(b.job.profile).toBe('typecheck'); // the stored job, not the replay's fields
    const rows = await env.sql(`SELECT from_state, to_state, cause FROM execution.job_transitions WHERE job_id = $1`, [a.job.id]);
    expect(rows).toEqual([{ from_state: 'requested', to_state: 'queued', cause: 'enqueued' }]);
    // the same key in another organization is another job
    const c = await store.enqueue(job(ORG_B, 'k1'));
    expect(c.created).toBe(true);
    expect(c.job.id).not.toBe(a.job.id);
  });

  it('the database transition guard equals the domain transition function for every (from, to) pair', async () => {
    const mismatches: string[] = [];
    for (const from of states) {
      for (const to of states) {
        if (from === to) continue;
        const id = randomUUID();
        await env.sql(`INSERT INTO execution.jobs (id, org_id, run_id, idempotency_key, profile, decision_digest, state, origin, requires_approval, data_region) VALUES ($1,$2,'r',$1,'typecheck',$3,$4,'MOCK',false,'sa')`, [id, ORG_A, digest(), from]);
        let dbOk = true;
        try {
          await env.sql(`UPDATE execution.jobs SET state = $2 WHERE id = $1`, [id, to]);
        } catch {
          dbOk = false;
        }
        const domOk = eg.transitionJob(from, to).ok;
        if (dbOk !== domOk) mismatches.push(`${from}->${to}: db=${dbOk} domain=${domOk}`);
      }
    }
    expect(mismatches).toEqual([]);
  }, 120_000);

  it('the database workspace guard equals the domain workspace transitions for every pair', async () => {
    const ws = ['creating', 'ready', 'in_use', 'failed', 'destroying', 'destroyed'] as const;
    const mismatches: string[] = [];
    for (const from of ws) {
      for (const to of ws) {
        if (from === to) continue;
        const id = `ws-run-${randomUUID().slice(0, 8)}`;
        await env.sql(`INSERT INTO execution.workspaces (id, org_id, run_id, state, data_region, destroyed_at) VALUES ($1,$2,'r',$3,'sa', CASE WHEN $3 = 'destroyed' THEN now() END)`, [id, ORG_A, from]);
        let dbOk = true;
        try {
          await env.sql(`UPDATE execution.workspaces SET state = $2, destroyed_at = CASE WHEN $2 = 'destroyed' THEN now() ELSE NULL END WHERE id = $1`, [id, to]);
        } catch {
          dbOk = false;
        }
        if (dbOk !== eg.transitionWorkspace(from, to).ok) mismatches.push(`${from}->${to}`);
      }
    }
    expect(mismatches).toEqual([]);
  }, 120_000);

  it('transition goes through the domain, is guarded by the state the caller saw, and logs append-only history', async () => {
    const { job: j } = await store.enqueue(job(ORG_A, 'k-trans'));
    const bad = await store.transition(ORG_A, j.id, 'succeeded', 'skip');
    expect(bad).toEqual({ ok: false, reason: 'illegal_transition_queued_to_succeeded' });
    const run = await store.claim({ leaseMs: 60_000, nodeId: 'node-1' });
    expect(run?.state).toBe('running');
    const done = await store.transition(ORG_A, run!.id, 'succeeded', 'finished', { outcomeStatus: 'completed', exitCode: 0, durationMs: 1234, truncated: false, artifactCount: 2 });
    expect(done).toMatchObject({ ok: true, job: { state: 'succeeded', outcomeStatus: 'completed', leaseToken: null, artifactCount: 2 } });
    expect(await store.transition(ORG_A, run!.id, 'queued', 'again')).toEqual({ ok: false, reason: 'terminal_state_succeeded' });
    const hist = await env.sql(`SELECT to_state FROM execution.job_transitions WHERE job_id = $1 ORDER BY at, id`, [run!.id]);
    expect(hist.map((h) => h.to_state)).toEqual(expect.arrayContaining(['queued', 'running', 'succeeded']));
    await expect(env.sql(`UPDATE execution.job_transitions SET cause = 'x' WHERE job_id = $1`, [run!.id])).rejects.toThrow(/append-only/);
    await expect(env.sql(`DELETE FROM execution.job_transitions WHERE job_id = $1`, [run!.id])).rejects.toThrow(/append-only/);
    await expect(env.sql(`TRUNCATE execution.job_transitions`)).rejects.toThrow(/append-only/);
    await expect(env.sql(`UPDATE execution.jobs SET profile = 'build' WHERE id = $1`, [run!.id])).rejects.toThrow(/immutable/);
  });

  it('claim is atomic (parallel workers never share a job) and fair across organizations', async () => {
    await env.sql(`DELETE FROM execution.jobs WHERE state = 'queued'`);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await store.enqueue(job(ORG_A, `fair-a-${i}`))).job.id);
    ids.push((await store.enqueue(job(ORG_B, 'fair-b-0'))).job.id);
    const first = await store.claim({ leaseMs: 60_000, nodeId: 'node-1' });
    expect(first?.orgId).toBe(ORG_A); // oldest first when nobody is running
    // ORG_A now has one running job: the next claim prefers ORG_B even though ORG_A's jobs are older
    const second = await store.claim({ leaseMs: 60_000, nodeId: 'node-1' });
    expect(second?.orgId).toBe(ORG_B);
    const rest = await Promise.all(Array.from({ length: 6 }, () => store.claim({ leaseMs: 60_000, nodeId: 'node-2' })));
    const claimed = rest.filter((x): x is NonNullable<typeof x> => x !== null);
    expect(new Set(claimed.map((c) => c.id)).size).toBe(claimed.length); // no job claimed twice
    expect(claimed.length).toBe(3); // 5 queued minus the 2 claimed above
    expect(await store.claim({ leaseMs: 1000, nodeId: 'node-1' })).toBeNull();
  });

  it('leases: heartbeat extends only for the holder; an expired lease is requeued while attempts remain, then failed', async () => {
    await env.sql(`DELETE FROM execution.jobs WHERE state IN ('queued','running')`);
    await store.enqueue(job(ORG_A, 'lease-1'));
    const c1 = (await store.claim({ leaseMs: 60_000, nodeId: 'node-1' }))!;
    expect(await store.heartbeat(ORG_A, c1.id, c1.leaseToken!, 60_000)).toBe(true);
    expect(await store.heartbeat(ORG_A, c1.id, randomUUID(), 60_000)).toBe(false);
    expect(await store.heartbeat(ORG_B, c1.id, c1.leaseToken!, 60_000)).toBe(false); // another tenant cannot extend it
    await env.sql(`UPDATE execution.jobs SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [c1.id]);
    expect(await store.heartbeat(ORG_A, c1.id, c1.leaseToken!, 60_000)).toBe(false); // too late: it is reconciled, not revived
    expect(await store.sweepExpiredLeases(2)).toEqual({ requeued: [c1.id], failed: [] });
    const c2 = (await store.claim({ leaseMs: 60_000, nodeId: 'node-1' }))!;
    expect(c2.id).toBe(c1.id);
    expect(c2.attempts).toBe(2);
    await env.sql(`UPDATE execution.jobs SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [c1.id]);
    expect(await store.sweepExpiredLeases(2)).toEqual({ requeued: [], failed: [c1.id] });
    expect((await store.get(ORG_A, c1.id))?.state).toBe('failed');
  });
});

describe('approvals', () => {
  it('single use under a race: exactly one of many parallel consumes wins; an expired, revoked or wrongly-bound approval never does', async () => {
    const { job: j } = await store.enqueue(job(ORG_A, 'ap-1', { requiresApproval: true }), 'awaiting_approval');
    const ap = await store.requestApproval(ORG_A, j.id, digest(), 60_000, 'sa');
    expect(await store.consumeApproval(ORG_A, ap.id, digest())).toBeNull(); // not decided yet
    expect((await store.approve(ORG_A, ap.id, SEED_USER))?.decidedBy).toBe(SEED_USER);
    expect(await store.approve(ORG_A, ap.id, SEED_USER)).toBeNull(); // a decision is final
    expect(await store.consumeApproval(ORG_A, ap.id, 'b'.repeat(64))).toBeNull(); // bound to the exact decision
    expect(await store.consumeApproval(ORG_B, ap.id, digest())).toBeNull(); // another tenant
    const results = await Promise.all(Array.from({ length: 8 }, () => store.consumeApproval(ORG_A, ap.id, digest())));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await store.consumeApproval(ORG_A, ap.id, digest())).toBeNull();

    const ap2 = await store.requestApproval(ORG_A, j.id, digest(), 60_000, 'sa');
    await store.approve(ORG_A, ap2.id, SEED_USER);
    expect(await store.revokeApproval(ORG_A, ap2.id, 'kill_switch')).toBe(true);
    expect(await store.consumeApproval(ORG_A, ap2.id, digest())).toBeNull();
    expect(await store.revokeApproval(ORG_A, ap.id, 'late')).toBe(false); // consumed approvals cannot be revoked

    const ap3 = await store.requestApproval(ORG_A, j.id, digest(), 60_000, 'sa');
    await store.approve(ORG_A, ap3.id, SEED_USER);
    await env.sql(`ALTER TABLE execution.approvals DISABLE TRIGGER approvals_guard`);
    await env.sql(`UPDATE execution.approvals SET expires_at = now() - interval '1 second', requested_at = now() - interval '1 hour' WHERE id = $1`, [ap3.id]);
    await env.sql(`ALTER TABLE execution.approvals ENABLE TRIGGER approvals_guard`);
    expect(await store.consumeApproval(ORG_A, ap3.id, digest())).toBeNull(); // expired
  });
  it('the database refuses a non-human decider and tampering with a decided approval', async () => {
    const { job: j } = await store.enqueue(job(ORG_A, 'ap-2'));
    const ap = await store.requestApproval(ORG_A, j.id, digest(), 60_000, 'sa');
    await expect(env.sql(`UPDATE execution.approvals SET decided_by = $2, decider_kind = 'service_account', decided_at = now() WHERE id = $1`, [ap.id, SEED_USER])).rejects.toThrow();
    await store.approve(ORG_A, ap.id, SEED_USER);
    await expect(env.sql(`UPDATE execution.approvals SET decided_by = $2 WHERE id = $1`, [ap.id, randomUUID()])).rejects.toThrow(/final/);
    await expect(env.sql(`UPDATE execution.approvals SET decision_digest = $2 WHERE id = $1`, [ap.id, 'c'.repeat(64)])).rejects.toThrow(/immutable/);
  });
});

describe('kill switch, workspaces, usage, reservations, nodes, attestations', () => {
  it('the latest row wins; global applies to everyone, an org row only to that org; the app role cannot write a global row; reads fail closed', async () => {
    expect(await store.isStopped(ORG_A)).toBe(false);
    await store.setKillSwitch({ kind: 'org', orgId: ORG_A }, true, SEED_USER, 'abuse');
    expect(await store.isStopped(ORG_A)).toBe(true);
    expect(await store.isStopped(ORG_B)).toBe(false);
    await store.setKillSwitch({ kind: 'org', orgId: ORG_A }, false, SEED_USER, 'reviewed');
    expect(await store.isStopped(ORG_A)).toBe(false);
    await store.setKillSwitch({ kind: 'global' }, true, SEED_USER, 'incident');
    expect(await store.isStopped(ORG_A)).toBe(true);
    expect(await store.isStopped(ORG_B)).toBe(true);
    await store.setKillSwitch({ kind: 'global' }, false, SEED_USER, 'released');
    expect(await store.isStopped(ORG_B)).toBe(false);
    // the runtime role inside one organization's scope cannot insert a global row
    await expect(env.app.withOrg(ORG_A, (c) => c.query(`INSERT INTO execution.kill_switch (id, scope, org_id, engaged, reason_code) VALUES ($1,'global',NULL,true,'x')`, [randomUUID()]))).rejects.toThrow();
    await expect(env.app.withOrg(ORG_A, (c) => c.query(`INSERT INTO execution.kill_switch (id, scope, org_id, engaged, reason_code) VALUES ($1,'org',$2,true,'x')`, [randomUUID(), ORG_B]))).rejects.toThrow();
    await expect(env.sql(`UPDATE execution.kill_switch SET engaged = false`)).rejects.toThrow(/append-only/);
    const broken = new PgExecutionStore({ withOrg: async () => { throw new Error('db down'); } } as never);
    expect(await broken.isStopped(ORG_A)).toBe(true);
  });
  it('workspaces follow the domain lifecycle and the live set per node is queryable for reconciliation', async () => {
    await store.recordWorkspace({ id: 'ws-run-w1', orgId: ORG_A, runId: 'run-w1', jobId: null, nodeId: 'node-9', dataRegion: 'sa' });
    expect(await store.transitionWorkspace(ORG_A, 'ws-run-w1', 'ready')).toEqual({ ok: true });
    expect(await store.transitionWorkspace(ORG_A, 'ws-run-w1', 'destroyed')).toEqual({ ok: false, reason: 'illegal_transition_ready_to_destroyed' });
    expect((await store.liveWorkspaces('node-9')).map((w) => w.id)).toEqual(['ws-run-w1']);
    await store.transitionWorkspace(ORG_A, 'ws-run-w1', 'destroying');
    await store.transitionWorkspace(ORG_A, 'ws-run-w1', 'destroyed');
    expect(await store.liveWorkspaces('node-9')).toEqual([]);
    expect(await store.transitionWorkspace(ORG_A, 'ws-run-w1', 'ready')).toEqual({ ok: false, reason: 'terminal_state_destroyed' });
  });
  it('usage records are idempotent, immutable except billed (once), and reservations are final once closed; money is integer minor units', async () => {
    const u = { orgId: ORG_A, runId: 'run-u1', jobId: null as string | null, nodeId: 'node-1', runtimeClass: 'gvisor-runsc', profile: 'build', cpuSeconds: 12.5, wallMs: 20000, peakMemoryMb: 300, peakPids: 12, diskMb: 40, outputBytes: 1000, status: 'completed', estimatedMinor: 7, currency: 'SAR', dataRegion: 'sa' };
    expect(await store.recordUsage(u)).toBe(true);
    const { job: j } = await store.enqueue(job(ORG_A, 'u-job'));
    expect(await store.recordUsage({ ...u, runId: 'run-u2', jobId: j.id })).toBe(true);
    expect(await store.recordUsage({ ...u, runId: 'run-u2', jobId: j.id })).toBe(false);
    await expect(env.sql(`UPDATE execution.usage_records SET cpu_seconds = 0 WHERE run_id = 'run-u1'`)).rejects.toThrow(/immutable/);
    await expect(env.sql(`DELETE FROM execution.usage_records`)).rejects.toThrow(/append-only/);
    await env.sql(`UPDATE execution.usage_records SET billed = true WHERE run_id = 'run-u1'`);
    await expect(env.sql(`UPDATE execution.usage_records SET billed = false WHERE run_id = 'run-u1'`)).rejects.toThrow(/billed cannot be undone/);
    await expect(store.recordUsage({ ...u, runId: 'run-u3', estimatedMinor: -1 })).rejects.toThrow();
    expect(await store.holdReservation({ orgId: ORG_A, jobId: j.id, currency: 'SAR', reservedMinor: 500, concurrencySlots: 1, dataRegion: 'sa' })).toBe(true);
    expect(await store.holdReservation({ orgId: ORG_A, jobId: j.id, currency: 'SAR', reservedMinor: 500, concurrencySlots: 1, dataRegion: 'sa' })).toBe(false);
    expect(await store.closeReservation(ORG_A, j.id, 'settled')).toBe(true);
    expect(await store.closeReservation(ORG_A, j.id, 'released')).toBe(false);
    await expect(env.sql(`UPDATE execution.quota_reservations SET reserved_minor = 1 WHERE job_id = $1`, [j.id])).rejects.toThrow(/immutable|final/);
  });
  it('node registry and attestation records are platform-scoped public data; an attestation can only be revoked, once', async () => {
    await store.upsertNode({ nodeId: 'node-1', endpointId: 'ep-1', environment: 'staging', runtimeClass: 'gvisor-runsc' });
    expect(await store.setNodeState('node-1', 'quarantined', 'cleanup_failed')).toBe(true);
    expect(await store.listNodes()).toEqual([{ nodeId: 'node-1', state: 'quarantined', environment: 'staging' }]);
    const att = { attestationId: 'att-node-1-2026-12-01', nodeId: 'node-1', label: 'LIVE-VERIFIED', issuedAt: '2026-12-01T00:00:00Z', expiresAt: '2026-12-20T00:00:00Z', reportSha256: 'd'.repeat(64), reviewer: 'Test Reviewer', reviewRef: 'HG-10-02-test' };
    expect(await store.recordAttestation(att)).toBe(true);
    expect(await store.recordAttestation(att)).toBe(false);
    expect((await store.revokedAttestationIds()).size).toBe(0);
    expect(await store.revokeAttestation(att.attestationId, 'incident')).toBe(true);
    expect(await store.revokeAttestation(att.attestationId, 'again')).toBe(false);
    expect([...(await store.revokedAttestationIds())]).toEqual([att.attestationId]);
    await expect(env.sql(`UPDATE execution.attestations SET label = 'SIMULATED'`)).rejects.toThrow(/immutable/);
    await expect(env.sql(`DELETE FROM execution.attestations`)).rejects.toThrow(/append-only/);
    // a tenant scope cannot read the platform registry
    expect((await env.app.withOrg(ORG_A, (c) => c.query(`SELECT 1 FROM execution.runtime_nodes`))).rowCount).toBe(0);
  });
});

describe('cross-tenant isolation (row level security, runtime role)', () => {
  it('one organization never sees, updates or deletes another organization\'s jobs, transitions, workspaces, approvals, reservations and usage', async () => {
    const { job: a } = await store.enqueue(job(ORG_A, 'iso-a'));
    await store.recordWorkspace({ id: 'ws-run-iso', orgId: ORG_A, runId: 'run-iso', jobId: a.id, nodeId: 'node-1', dataRegion: 'sa' });
    const ap = await store.requestApproval(ORG_A, a.id, digest(), 60_000, 'sa');
    for (const t of ['jobs', 'job_transitions', 'workspaces', 'approvals', 'quota_reservations', 'usage_records']) {
      const seen = await env.app.withOrg(ORG_B, (c) => c.query(`SELECT count(*)::int AS n FROM execution.${t} WHERE org_id = $1`, [ORG_A]));
      expect(seen.rows[0].n, t).toBe(0);
    }
    expect(await store.get(ORG_B, a.id)).toBeNull();
    expect(await store.transition(ORG_B, a.id, 'cancelled', 'x')).toEqual({ ok: false, reason: 'job_not_found' });
    expect(await store.transitionWorkspace(ORG_B, 'ws-run-iso', 'ready')).toEqual({ ok: false, reason: 'workspace_not_found' });
    expect(await store.approve(ORG_B, ap.id, SEED_USER)).toBeNull();
    // writing a row for another tenant from this tenant's scope is rejected by the policy
    await expect(env.app.withOrg(ORG_B, (c) => c.query(`INSERT INTO execution.jobs (id, org_id, run_id, idempotency_key, profile, decision_digest, state, origin, requires_approval, data_region) VALUES ($1,$2,'r','k','typecheck',$3,'queued','MOCK',false,'sa')`, [randomUUID(), ORG_A, digest()]))).rejects.toThrow();
    // no org context at all: nothing visible, nothing writable
    const none = await env.app.withOrg('00000000-0000-7000-8000-0000000000ff', (c) => c.query(`SELECT count(*)::int AS n FROM execution.jobs`));
    expect(none.rows[0].n).toBe(0);
  });
});
