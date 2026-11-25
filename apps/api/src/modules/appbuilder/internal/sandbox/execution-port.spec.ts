import { describe, expect, it } from 'vitest';
import { executionGateway as eg } from '@nuzm/domain';
import type { AuditEvent } from '../../../../common/audit';
import { MockSandboxRuntime } from './mock-runtime';
import type { SandboxRuntime } from './runtime';
import { ExecutionAuditAdapter, toAuditEvent } from '../../../execution';
import { SandboxRuntimeExecutionPort } from './execution-port';
import { quotaFromLimits } from './execution-mapping';

const ctx: eg.ExecContext = {
  orgId: 'org-1',
  runId: 'run-1',
  enabledProfiles: ['typecheck', 'unit-tests', 'install-deps'],
  projectScripts: [],
};
const run: eg.ExecutionRunContext = { orgId: 'org-1', runId: 'run-1' };
const mk = (
  runtime: SandboxRuntime,
  seed: Record<string, string> = { 'src/a.ts': 'export const a = 1;' },
) =>
  new SandboxRuntimeExecutionPort(runtime, {
    ctx,
    projectId: 'proj-1',
    sandboxIdFor: (r) => `sbx-${r}`,
    egressProfile: 'registry',
    seedFiles: () => new Map(Object.entries(seed)),
    canaries: () => ['NZCANARY-12345678'],
  });
const decide = async (p: SandboxRuntimeExecutionPort, profile = 'typecheck') => {
  const d = await p.request({ orgId: 'org-1', runId: 'run-1', profile });
  if (!d.allowed) throw new Error(d.reasons.join());
  return d;
};

describe('SandboxRuntimeExecutionPort over the mock sandbox runtime', () => {
  it('is MOCK for the in-memory runtime, runs the decision argv with the constant environment and destroys the sandbox', async () => {
    const rt = new MockSandboxRuntime();
    let seen: { argv: string[]; env: Record<string, string> } | null = null;
    rt.register('npx', ({ argv, env }) => {
      seen = { argv, env };
      return { stdout: 'tsc ok\n', exitCode: 0 };
    });
    const p = mk(rt);
    expect(p.origin).toBe('MOCK');
    const out = await p.run(await decide(p), run);
    expect(out).toMatchObject({ status: 'completed', exitCode: 0, stdout: 'tsc ok\n' });
    expect(seen).toEqual({ argv: ['npx', '--no-install', 'tsc', '--noEmit'], env: eg.EXEC_ENV });
    expect(rt.sandboxes.size).toBe(0);
  });
  it('maps a non-zero exit to failed and a CPU overrun to timeout; the sandbox is gone either way', async () => {
    const rt = new MockSandboxRuntime();
    rt.register('npx', () => ({ exitCode: 2, stderr: 'TS2322\n' }));
    rt.register('npm', () => ({ cpuSeconds: 9_999 }));
    const p = mk(rt);
    expect((await p.run(await decide(p), run)).status).toBe('failed');
    expect((await p.run(await decide(p, 'unit-tests'), run)).status).toBe('timeout');
    expect(rt.sandboxes.size).toBe(0);
  });
  it('turns a runtime exception into a refusal with an error NAME only, and still destroys the sandbox', async () => {
    const rt = new MockSandboxRuntime();
    rt.register('npx', () => {
      throw new TypeError('connect ECONNREFUSED /var/run/docker.sock');
    });
    const p = mk(rt);
    const out = await p.run(await decide(p), run);
    expect(out.status).toBe('refused');
    expect(out.stderr).toBe('refused: runtime_error:TypeError\n');
    expect(rt.sandboxes.size).toBe(0);
  });
  it('refuses a workspace that carries secrets, before any sandbox is created', async () => {
    const rt = new MockSandboxRuntime();
    const p = mk(rt, { '.env': 'A=1', 'src/a.ts': 'x' });
    const out = await p.run(await decide(p), run);
    expect(out.status).toBe('refused');
    expect(out.stderr).toContain('workspace_refused:secret_file_name');
    expect(rt.sandboxes.size).toBe(0);
  });
  it('refuses a missing approval, another tenant or run, a refused decision and an aborted signal', async () => {
    const rt = new MockSandboxRuntime();
    const p = mk(rt);
    const inst = await decide(p, 'install-deps');
    expect((await p.run(inst, run)).stderr).toContain('approval_required');
    const d = await decide(p);
    expect((await p.run(d, { ...run, orgId: 'org-2' })).stderr).toContain('another_tenant_or_run');
    expect((await p.run({ allowed: false, reasons: ['unknown_profile'] }, run)).status).toBe(
      'refused',
    );
    const ac = new AbortController();
    ac.abort();
    expect((await p.run(d, { ...run, signal: ac.signal })).status).toBe('terminated');
  });
  it('refuses an edited or hand-made decision (the registry of issued decisions refuses before the environment check)', async () => {
    const p = mk(new MockSandboxRuntime());
    const d = await decide(p);
    const tampered = { ...d, env: { ...d.env, LD_PRELOAD: '/x.so' } };
    expect((await p.run(tampered, run)).stderr).toContain('decision_not_issued_by_gateway');
    const handMade = { ...d, argv: ['sh', '-c', 'id'] };
    expect((await p.run(handMade, run)).stderr).toContain('decision_not_issued_by_gateway');
  });
  it('NEVER runs on the local-dev runner (real, non-isolated processes), whatever the decision', async () => {
    let created = false;
    const dev = {
      kind: 'local-dev',
      isolation: 'none',
      create: async () => ((created = true), 'h'),
    } as unknown as SandboxRuntime;
    const p = mk(dev);
    expect(p.origin).toBe('MOCK');
    const out = await p.run(await decide(p), run);
    expect(out.status).toBe('refused');
    expect(out.stderr).toContain('local_dev_runtime_never_runs_agent_execution');
    expect(created).toBe(false);
  });
  it('reports REAL only for a runtime that says isolation verified (nothing in this repository does)', () => {
    const fake = { kind: 'isolated', isolation: 'verified' } as unknown as SandboxRuntime;
    expect(mk(fake).origin).toBe('REAL');
    expect(new MockSandboxRuntime().isolation).not.toBe('verified');
  });
});

describe('end to end: orchestrator + sandbox port + platform audit sink', () => {
  it('runs on the mock runtime, audits through the sink without content, and a REAL-looking runtime is stopped by the closed gate', async () => {
    const events: AuditEvent[] = [];
    const sink = { record: (e: AuditEvent) => void events.push(e) };
    const build = (rt: SandboxRuntime) => {
      let t = 1_000;
      const port = mk(rt);
      return new eg.ExecutionOrchestrator({
        port,
        ledger: new eg.QuotaLedger(() => t),
        queue: new eg.ExecutionQueue<string>(eg.DEFAULT_QUEUE_CONFIG, () => t),
        approvals: new eg.ApprovalWorkflow(() => t),
        killSwitch: new eg.ExecutionKillSwitch(),
        audit: new ExecutionAuditAdapter(sink).record,
        gate: () => eg.CLOSED_GATE,
        flags: () => ({ execTools: true, aiKillSwitch: false }),
        ceilings: () => ({ ...eg.DEFAULT_ORG_CEILINGS, budgetCapMinor: 100_000 }),
        canaries: () => [],
        now: () => t++,
      });
    };
    const rt = new MockSandboxRuntime();
    rt.register('npx', () => ({ stdout: 'PRIVATE-STDOUT\n', exitCode: 0 }));
    const o = build(rt);
    const req = { orgId: 'org-1', runId: 'run-1', profile: 'typecheck' };
    expect(
      await o.submit({ orgId: 'org-1', runId: 'run-1', idempotencyKey: 'idem-0001', request: req }),
    ).toMatchObject({ status: 'queued' });
    expect((await o.runNext('w'))!.state).toBe('succeeded');
    expect(events.map((e) => e.action)).toEqual([
      'ai.execution.requested',
      'ai.execution.queued',
      'ai.execution.started',
      'ai.execution.finished',
    ]);
    expect(JSON.stringify(events)).not.toContain('PRIVATE-STDOUT');
    expect(events[0]).toMatchObject({
      orgId: 'org-1',
      resource: { type: 'ai_execution' },
      actorType: 'system',
    });

    const verifiedLooking = new MockSandboxRuntime();
    Object.defineProperty(verifiedLooking, 'isolation', { value: 'verified' });
    const o2 = build(verifiedLooking);
    expect(
      await o2.submit({
        orgId: 'org-1',
        runId: 'run-1',
        idempotencyKey: 'idem-0002',
        request: req,
      }),
    ).toEqual({
      status: 'refused',
      reasons: ['gate_closed'],
    });
  });
});

describe('mapping', () => {
  it('decision limits map to the M10 quota units without growing them', () => {
    const q = quotaFromLimits(eg.EXEC_PROFILES.build!.limits);
    expect(q).toMatchObject({
      memoryMb: 2048,
      pids: 128,
      diskGb: 1,
      buildTimeoutMinutes: 5,
      vcpu: 1,
    });
  });
  it('the platform audit event carries the run id and timestamp in detail, and maps the global org to none', () => {
    const rec = eg.buildExecAudit({
      action: 'ai.execution.terminated',
      orgId: '*',
      runId: '*',
      actorType: 'agent',
      outcome: 'success',
      detail: { scope: 'all' },
      at: new Date('2026-11-24T00:00:00Z'),
    });
    expect(toAuditEvent(rec)).toMatchObject({
      orgId: undefined,
      actorType: 'system',
      detail: { scope: 'all', runId: '*', at: '2026-11-24T00:00:00.000Z' },
    });
  });
});
