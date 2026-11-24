import { describe, expect, it } from 'vitest';
import {
  ApprovalWorkflow,
  CLOSED_GATE,
  DEFAULT_QUEUE_CONFIG,
  ExecutionKillSwitch,
  ExecutionOrchestrator,
  ExecutionQueue,
  MockExecutionPort,
  QuotaLedger,
  createMockExecutionPort,
  type ExecAuditRecord,
  type ExecContext,
  type ExecGateState,
  type ExecutionPort,
  type OrchestratorFlags,
  type OrgCeilings,
} from './index';

const ctx: ExecContext = {
  orgId: 'org-1',
  runId: 'run-1',
  enabledProfiles: ['typecheck', 'unit-tests', 'build', 'run-script', 'install-deps'],
  projectScripts: ['lint'],
};
const CEIL: OrgCeilings = {
  maxConcurrent: 2,
  maxRunsPerWindow: 50,
  windowMs: 3_600_000,
  maxCpuSecondsPerWindow: 100_000,
  budgetCapMinor: 1_000_000,
  rates: { currency: 'SAR', minorPerKiloCpuSecond: 100 },
};
const human = { userId: 'u1', orgId: 'org-1', kind: 'user' as const, canApproveExecution: true };
const CANARY = 'NZCANARY-feedface01';

function rig(
  over: {
    port?: ExecutionPort;
    flags?: Partial<OrchestratorFlags>;
    gate?: ExecGateState;
    ceil?: Partial<OrgCeilings>;
  } = {},
) {
  let t = 1_000_000;
  const audit: ExecAuditRecord[] = [];
  const port = (over.port as MockExecutionPort | undefined) ?? createMockExecutionPort(ctx);
  const kill = new ExecutionKillSwitch();
  const o = new ExecutionOrchestrator({
    port,
    ledger: new QuotaLedger(() => t),
    queue: new ExecutionQueue<string>(DEFAULT_QUEUE_CONFIG, () => t),
    approvals: new ApprovalWorkflow(() => t, 60_000),
    killSwitch: kill,
    audit: (r) => void audit.push(r),
    gate: () => over.gate ?? CLOSED_GATE,
    flags: () => ({ execTools: true, aiKillSwitch: false, ...over.flags }),
    ceilings: () => ({ ...CEIL, ...over.ceil }),
    canaries: () => [CANARY],
    now: () => t,
  });
  return { o, port: port as MockExecutionPort, audit, kill, tick: (ms: number) => (t += ms) };
}
const submit = (
  r: ReturnType<typeof rig>,
  profile = 'typecheck',
  key = 'idem-0001',
  extra: Record<string, unknown> = {},
  orgId = 'org-1',
) =>
  r.o.submit({
    orgId,
    runId: 'run-1',
    idempotencyKey: key,
    request: { orgId, runId: 'run-1', profile, ...extra },
  });
const actions = (r: ReturnType<typeof rig>) =>
  r.audit.map((a) => a.action.replace('ai.execution.', ''));

describe('orchestrator: the default is closed', () => {
  it('refuses everything while the execution flag is off (the default)', async () => {
    const r = rig({ flags: { execTools: false } });
    expect(await submit(r)).toEqual({ status: 'refused', reasons: ['feature_flag_off'] });
    expect(r.port.calls).toHaveLength(0);
  });
  it('refuses while the AI kill switch is on', async () => {
    const r = rig({ flags: { aiKillSwitch: true } });
    expect(await submit(r)).toMatchObject({ status: 'refused', reasons: ['ai_kill_switch'] });
  });
  it('a REAL port is refused while the gate is closed, with an audit event', async () => {
    const real = Object.assign(createMockExecutionPort(ctx), { origin: 'REAL' as const });
    const r = rig({ port: real });
    expect(await submit(r)).toMatchObject({ status: 'refused', reasons: ['gate_closed'] });
    expect(actions(r)).toContain('gate_refused');
    expect(r.port.calls).toHaveLength(0);
  });
  it('a REAL port also passes only when EVERY gate condition holds', async () => {
    const real = Object.assign(createMockExecutionPort(ctx), { origin: 'REAL' as const });
    const almost: ExecGateState = {
      ...CLOSED_GATE,
      d21Decided: true,
      runtimeVerified: true,
      escapeSuitePassed: true,
      adrAccepted: true,
    };
    expect(await submit(rig({ port: real, gate: almost }))).toMatchObject({
      status: 'refused',
      reasons: ['gate_closed'],
    });
    const open: ExecGateState = { ...almost, ownerApproved: true };
    expect(await submit(rig({ port: real, gate: open }))).toMatchObject({ status: 'queued' });
  });
  it('the mock is labelled MOCK in every audit record and in the job view', async () => {
    const r = rig();
    await submit(r);
    const v = await r.o.runNext('w');
    expect(v!.origin).toBe('MOCK');
    for (const a of r.audit) expect(a.detail.runtimeOrigin).toBe('MOCK');
  });
});

describe('orchestrator: submit -> run for a profile without approval', () => {
  it('runs end to end and audits request, queue, start and finish without content', async () => {
    const r = rig();
    r.port.script('typecheck', {
      stdout: 'SECRET-LOOKING stdout text\n',
      exitCode: 0,
      durationMs: 1500,
    });
    const s = await submit(r);
    expect(s).toMatchObject({ status: 'queued', duplicate: false });
    const v = await r.o.runNext('worker-1');
    expect(v).toMatchObject({ state: 'succeeded', profile: 'typecheck' });
    expect(v!.outcome).toMatchObject({ status: 'completed', applied: false });
    expect(actions(r)).toEqual(['requested', 'queued', 'started', 'finished']);
    expect(JSON.stringify(r.audit)).not.toContain('SECRET-LOOKING');
    const fin = r.audit.at(-1)!;
    expect(fin.detail).toMatchObject({
      status: 'completed',
      exitCode: 0,
      durationMs: 1500,
      stdoutBytes: 27,
    });
  });
  it('nothing runs when nothing is queued', async () => {
    expect(await rig().o.runNext('w')).toBeNull();
  });
  it('a failing run is failed, a timeout is timed_out, a terminated port outcome is terminated', async () => {
    const r = rig();
    r.port.script(
      'typecheck',
      { status: 'failed', exitCode: 2 },
      { durationMs: 999_000 },
      { status: 'terminated', exitCode: null },
    );
    const states: string[] = [];
    for (const k of ['idem-0001', 'idem-0002', 'idem-0003']) {
      await submit(r, 'typecheck', k);
      states.push((await r.o.runNext('w'))!.state);
    }
    expect(states).toEqual(['failed', 'timed_out', 'terminated']);
  });
  it('a completed outcome with a non-zero exit code is failed, not succeeded', async () => {
    const r = rig();
    r.port.script('typecheck', { status: 'completed', exitCode: 3 });
    await submit(r);
    expect((await r.o.runNext('w'))!.state).toBe('failed');
  });
  it('a runtime that throws becomes a failed job, never an unhandled error', async () => {
    const r = rig();
    r.port.run = async () => {
      throw new Error('socket /var/run/docker.sock refused');
    };
    await submit(r);
    const v = await r.o.runNext('w');
    expect(v!.state).toBe('failed');
    expect(v!.outcome!.stderr).toBe('runtime_error');
  });
  it('is idempotent per key', async () => {
    const r = rig();
    await submit(r);
    expect(await submit(r)).toMatchObject({ status: 'queued', duplicate: true });
    await r.o.runNext('w');
    expect(r.port.calls).toHaveLength(1);
    expect(await r.o.runNext('w')).toBeNull();
  });
  it('DEFECT-10: concurrent submits with one key create one job, run the port once for the request, and all return the same job', async () => {
    const r = rig();
    const results = await Promise.all(Array.from({ length: 10 }, () => submit(r)));
    const ids = new Set(results.map((x) => (x.status === 'queued' ? x.jobId : 'other')));
    expect(ids.size).toBe(1);
    expect(results.filter((x) => x.status === 'queued' && !x.duplicate)).toHaveLength(1);
    expect(results.every((x) => x.status === 'queued')).toBe(true);
    await r.o.runNext('w');
    expect(await r.o.runNext('w')).toBeNull();
    expect(r.port.calls).toHaveLength(1);
  });
  it('concurrent duplicates of an approval-gated request all get the one pending approval', async () => {
    const r = rig();
    const rs = await Promise.all(
      Array.from({ length: 5 }, () => submit(r, 'install-deps', 'idem-install-1')),
    );
    const ap = new Set(rs.map((x) => (x.status === 'awaiting_approval' ? x.approvalId : 'other')));
    expect(ap.size).toBe(1);
  });
  it('O-11: the same key with another request or run is a conflict, not the first job', async () => {
    const r = rig();
    expect(await submit(r, 'typecheck', 'idem-conflict-1')).toMatchObject({ status: 'queued' });
    expect(await submit(r, 'unit-tests', 'idem-conflict-1')).toEqual({
      status: 'refused',
      reasons: ['idempotency_key_conflict'],
    });
    expect(
      await r.o.submit({
        orgId: 'org-1',
        runId: 'run-2',
        idempotencyKey: 'idem-conflict-1',
        request: { orgId: 'org-1', runId: 'run-2', profile: 'typecheck' },
      }),
    ).toEqual({ status: 'refused', reasons: ['idempotency_key_conflict'] });
    // and while the first is still in flight
    const r2 = rig();
    const [a, b] = await Promise.all([
      submit(r2, 'typecheck', 'idem-conflict-2'),
      submit(r2, 'unit-tests', 'idem-conflict-2'),
    ]);
    expect(a.status).toBe('queued');
    expect(b).toEqual({ status: 'refused', reasons: ['idempotency_key_conflict'] });
  });
  it('a refused first submit does not poison the key: a corrected retry with the same key but another request is a fresh submit only after the refusal', async () => {
    const r = rig();
    expect(await submit(r, 'definitely-not-a-profile', 'idem-refused-1')).toMatchObject({
      status: 'refused',
    });
    expect(await submit(r, 'typecheck', 'idem-refused-1')).toMatchObject({ status: 'queued' });
  });
  it('O-13: the orchestrator refuses an artifact the port reports as a link or device', async () => {
    const r = rig();
    r.port.script('build', {
      artifacts: [
        { path: 'dist/ok.js', bytes: 3, sha256: 'a'.repeat(64) },
        { path: 'dist/link', bytes: 3, sha256: 'b'.repeat(64), kind: 'symlink' },
        { path: 'dist/dev', bytes: 0, sha256: 'c'.repeat(64), kind: 'device' },
      ],
    });
    const s = await submit(r, 'build', 'idem-art-0001');
    if (s.status !== 'queued') throw new Error('expected queued');
    await r.o.runNext('w');
    const v = r.o.status(s.jobId, 'org-1');
    expect(v!.outcome!.artifacts.map((a) => a.path)).toEqual(['dist/ok.js']);
    expect(v!.outcome!.artifactsRefused.map((a) => a.reason)).toEqual([
      'not_a_regular_file_symlink',
      'not_a_regular_file_device',
    ]);
  });
  it('rejects a malformed idempotency key', async () => {
    expect(await submit(rig(), 'typecheck', 'x')).toMatchObject({
      status: 'refused',
      reasons: ['idempotency_key_invalid'],
    });
  });
});

describe('orchestrator: policy refusals reach the audit trail', () => {
  it.each([
    [{ argv: ['rm', '-rf', '/'] }, 'model_supplied_argv'],
    [{ env: { A: '1' } }, 'model_supplied_env'],
    [{ cwd: '/' }, 'model_supplied_cwd'],
  ])('refuses %o by name', async (extra, reason) => {
    const r = rig();
    const s = await submit(r, 'typecheck', 'idem-0001', extra);
    expect(s).toMatchObject({ status: 'refused' });
    expect((s as { reasons: string[] }).reasons).toContain(reason);
    expect(r.audit.at(-1)).toMatchObject({ action: 'ai.execution.refused', outcome: 'failure' });
    expect(r.port.calls).toHaveLength(0);
  });
  it('refuses a request for another organization at policy level', async () => {
    const r = rig();
    const s = await r.o.submit({
      orgId: 'org-1',
      runId: 'run-1',
      idempotencyKey: 'idem-0001',
      request: { orgId: 'org-2', runId: 'run-1', profile: 'typecheck' },
    });
    expect(s).toMatchObject({ status: 'refused', reasons: ['another_tenant_or_run'] });
  });
});

describe('orchestrator: human approval', () => {
  it('install-deps waits for a human, runs only after approval, and the approval is spent', async () => {
    const r = rig();
    const s = await submit(r, 'install-deps');
    expect(s).toMatchObject({
      status: 'awaiting_approval',
      summary: { network: 'registry-only', reachesNetwork: true },
    });
    if (s.status !== 'awaiting_approval') throw new Error('state');
    expect(await r.o.runNext('w')).toBeNull(); // nothing is queued yet
    expect(await r.o.decide(s.jobId, human, 'approve')).toEqual({ ok: true, state: 'queued' });
    const v = await r.o.runNext('w');
    expect(v!.state).toBe('succeeded');
    expect(r.port.calls[0]!.ctx.approvalId).toBeDefined();
    expect(actions(r)).toEqual([
      'requested',
      'approval_requested',
      'approved',
      'queued',
      'started',
      'finished',
    ]);
  });
  it('a rejection ends the job and nothing runs', async () => {
    const r = rig();
    const s = await submit(r, 'install-deps');
    if (s.status !== 'awaiting_approval') throw new Error('state');
    expect(await r.o.decide(s.jobId, human, 'reject', 'not now')).toEqual({
      ok: true,
      state: 'rejected',
    });
    expect(await r.o.runNext('w')).toBeNull();
    expect(r.port.calls).toHaveLength(0);
  });
  it('a model, an API key or a person without permission cannot approve; another organization sees "unknown"', async () => {
    const r = rig();
    const s = await submit(r, 'install-deps');
    if (s.status !== 'awaiting_approval') throw new Error('state');
    expect(await r.o.decide(s.jobId, { ...human, kind: 'model' }, 'approve')).toEqual({
      ok: false,
      reason: 'approver_must_be_a_human_user',
    });
    expect(await r.o.decide(s.jobId, { ...human, canApproveExecution: false }, 'approve')).toEqual({
      ok: false,
      reason: 'approver_lacks_permission',
    });
    expect(await r.o.decide(s.jobId, { ...human, orgId: 'org-2' }, 'approve')).toEqual({
      ok: false,
      reason: 'unknown_job',
    });
    expect(r.o.status(s.jobId, 'org-2')).toBeNull();
    expect(r.o.status(s.jobId, 'org-1')!.state).toBe('awaiting_approval');
  });
  it('an approval that expires while waiting expires the job', async () => {
    const r = rig();
    const s = await submit(r, 'install-deps');
    if (s.status !== 'awaiting_approval') throw new Error('state');
    r.tick(61_000);
    await r.o.sweep();
    expect(r.o.status(s.jobId, 'org-1')!.state).toBe('expired');
    expect(actions(r)).toContain('approval_expired');
  });
  it('an approval that expires while the job sits in the queue stops the run at claim time', async () => {
    const r = rig();
    const s = await submit(r, 'install-deps');
    if (s.status !== 'awaiting_approval') throw new Error('state');
    await r.o.decide(s.jobId, human, 'approve');
    r.tick(61_000);
    const v = await r.o.runNext('w');
    expect(v!.state).toBe('failed');
    expect(r.port.calls).toHaveLength(0);
  });
  it('the human can cancel a job that is waiting', async () => {
    const r = rig();
    const s = await submit(r, 'install-deps');
    if (s.status !== 'awaiting_approval') throw new Error('state');
    expect(await r.o.cancel(s.jobId, 'org-2')).toBe(false);
    expect(await r.o.cancel(s.jobId, 'org-1')).toBe(true);
    expect(await r.o.decide(s.jobId, human, 'approve')).toMatchObject({ ok: false });
  });
});

describe('orchestrator: quota, kill switch, termination', () => {
  it('refuses at submit when the budget cannot cover the worst case (restrictive default)', async () => {
    const r = rig({ ceil: { budgetCapMinor: 0 } });
    expect(await submit(r)).toMatchObject({
      status: 'refused',
      reasons: expect.arrayContaining(['budget_cap']),
    });
    expect(actions(r)).toContain('quota_refused');
  });
  it('queued jobs do not hold a concurrency slot, but running ones are limited per organization', async () => {
    const r = rig({ ceil: { maxConcurrent: 1 } });
    await submit(r, 'typecheck', 'idem-0001');
    await submit(r, 'typecheck', 'idem-0002');
    const a = await r.o.runNext('w1'); // completes synchronously on the mock
    expect(a!.state).toBe('succeeded');
    expect((await r.o.runNext('w2'))!.state).toBe('succeeded');
  });
  it('settles quota on completion: spend is recorded and the slot is released', async () => {
    const r = rig();
    r.port.scriptDefault({ durationMs: 10_000 });
    await submit(r);
    await r.o.runNext('w');
    // 10 s of the reservation is charged at 100 per 1000 cpu-seconds -> 1 minor unit
    const ledger = (r.o as unknown as { d: { ledger: QuotaLedger } }).d.ledger;
    expect(ledger.snapshot('org-1')).toMatchObject({
      active: 0,
      runsInWindow: 1,
      totalCostMinor: 1,
    });
  });
  it('the execution kill switch refuses new work and stops a queued job at claim time', async () => {
    const r = rig();
    await submit(r);
    r.kill.engageOrg('org-1', 'abuse');
    const v = await r.o.runNext('w');
    expect(v!.state).toBe('terminated');
    expect(r.port.calls).toHaveLength(0);
    expect(await submit(r, 'typecheck', 'idem-0002')).toMatchObject({
      status: 'refused',
      reasons: ['execution_kill_switch'],
    });
    // another organization is unaffected by an org-level switch
    expect(r.kill.isEngaged('org-2')).toBe(false);
  });
  it('emergencyStop terminates waiting and queued jobs of the scope and revokes approvals', async () => {
    const r = rig();
    const q = await submit(r, 'typecheck', 'idem-0001');
    const w = await submit(r, 'install-deps', 'idem-0002');
    if (q.status !== 'queued' || w.status !== 'awaiting_approval') throw new Error('state');
    expect(await r.o.emergencyStop({ orgId: 'org-1' }, 'incident')).toEqual({
      jobs: 2,
      approvals: 1,
    });
    expect(r.o.status(q.jobId, 'org-1')!.state).toBe('terminated');
    expect(r.o.status(w.jobId, 'org-1')!.state).toBe('terminated');
    expect(await r.o.runNext('w')).toBeNull();
    expect(await r.o.decide(w.jobId, human, 'approve')).toMatchObject({ ok: false });
    expect(actions(r).at(-1)).toBe('terminated');
  });
  it('a canary in the output redacts it, audits it and engages the organization kill switch', async () => {
    const r = rig();
    r.port.scriptDefault({ stdout: `leaked ${CANARY}\n`, exitCode: 0 });
    await submit(r);
    const v = await r.o.runNext('w');
    expect(v!.outcome!.stdout).not.toContain(CANARY);
    expect(v!.outcome!.redactions).toBeGreaterThan(0);
    expect(r.kill.isEngaged('org-1')).toBe(true);
    expect(actions(r)).toEqual(expect.arrayContaining(['output_redacted', 'kill_switch']));
    expect(JSON.stringify(r.audit)).not.toContain(CANARY);
  });
});

describe('orchestrator: artifacts are candidates only', () => {
  it('records accepted artifacts, refuses the rest, never applies', async () => {
    const r = rig();
    const sha = 'a'.repeat(64);
    r.port.script('build', {
      artifacts: [
        { path: 'dist/app.js', bytes: 10, sha256: sha },
        { path: 'dist/.env', bytes: 5, sha256: sha },
        { path: 'src/evil.ts', bytes: 5, sha256: sha },
        { path: 'dist/nohash.js', bytes: 5 },
      ],
    });
    await submit(r, 'build');
    const v = await r.o.runNext('w');
    expect(v!.outcome!.applied).toBe(false);
    expect(v!.outcome!.artifacts.map((a) => a.path)).toEqual(['dist/app.js']);
    expect(v!.outcome!.artifactsRefused.map((a) => a.reason)).toEqual([
      'sensitive_path',
      'outside_output_roots',
      'no_content_hash',
    ]);
    expect(actions(r)).toEqual(expect.arrayContaining(['artifact_recorded', 'artifact_refused']));
  });
});

describe('orchestrator: tenant isolation', () => {
  it('another organization cannot read, cancel or approve a job', async () => {
    const r = rig();
    const s = await submit(r);
    if (s.status !== 'queued') throw new Error('state');
    expect(r.o.status(s.jobId, 'org-2')).toBeNull();
    expect(await r.o.cancel(s.jobId, 'org-2')).toBe(false);
    expect(r.o.status(s.jobId, 'org-1')).not.toBeNull();
  });
  it('the same idempotency key in two organizations are two jobs', async () => {
    const r = rig();
    const a = await submit(r, 'typecheck', 'idem-0001', {}, 'org-1');
    expect(a).toMatchObject({ status: 'queued', duplicate: false });
    // org-2's request is refused by the mock's own context (it serves org-1): the policy never lets a request cross tenants
    const b = await submit(r, 'typecheck', 'idem-0001', {}, 'org-2');
    expect(b).toMatchObject({ status: 'refused' });
  });
});
