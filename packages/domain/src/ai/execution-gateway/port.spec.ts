import { describe, expect, it } from 'vitest';
import { createMockExecutionPort, type ExecContext, type ExecutionRunContext } from './index';

const ctx: ExecContext = {
  orgId: 'org-1',
  runId: 'run-1',
  enabledProfiles: ['typecheck', 'unit-tests', 'build', 'run-script', 'install-deps'],
  projectScripts: ['lint'],
};
const run: ExecutionRunContext = { orgId: 'org-1', runId: 'run-1' };
const req = (over: Record<string, unknown> = {}) => ({
  orgId: 'org-1',
  runId: 'run-1',
  profile: 'typecheck',
  ...over,
});

describe('MockExecutionPort: scripted, never executes', () => {
  it('is labelled MOCK and returns the scripted outcome for an allowed decision', async () => {
    const port = createMockExecutionPort(ctx);
    expect(port.origin).toBe('MOCK');
    port.script('typecheck', { status: 'failed', exitCode: 2, stderr: 'TS2322\n' });
    const d = await port.request(req());
    expect(d.allowed).toBe(true);
    const out = await port.run(d, run);
    expect(out).toMatchObject({ status: 'failed', exitCode: 2, stderr: 'TS2322\n' });
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]!.decision).toMatchObject({ profile: 'typecheck' });
  });
  it('queues outcomes per profile and falls back to a default success', async () => {
    const port = createMockExecutionPort(ctx);
    port.script('unit-tests', { exitCode: 1, status: 'failed' }, { exitCode: 0 });
    const d = await port.request(req({ profile: 'unit-tests' }));
    expect((await port.run(d, run)).status).toBe('failed');
    expect((await port.run(d, run)).status).toBe('completed');
    const third = await port.run(d, run);
    expect(third.stdout).toContain('[MOCK]');
    expect(third.exitCode).toBe(0);
  });
  it('function scripts see the attempt number (a repair loop that passes on the second try)', async () => {
    const port = createMockExecutionPort(ctx);
    port.scriptDefault((c) =>
      c.attempt < 2 ? { status: 'failed', exitCode: 1 } : { exitCode: 0 },
    );
    const d = await port.request(req({ profile: 'build' }));
    expect((await port.run(d, run)).status).toBe('failed');
    expect((await port.run(d, run)).status).toBe('completed');
  });
  it('refuses exactly what the policy refuses and never runs a refused decision', async () => {
    const port = createMockExecutionPort(ctx);
    const d = await port.request(req({ argv: ['rm', '-rf', '/'] }));
    expect(d).toMatchObject({ allowed: false });
    const out = await port.run(d, run);
    expect(out).toMatchObject({ status: 'refused', exitCode: null });
    expect(port.calls).toHaveLength(0);
  });
  it('needs an approval id for profiles that require a human', async () => {
    const port = createMockExecutionPort(ctx);
    const d = await port.request(req({ profile: 'install-deps' }));
    expect(d).toMatchObject({ allowed: true, requiresApproval: true });
    expect((await port.run(d, run)).stderr).toContain('approval_required');
    expect((await port.run(d, { ...run, approvalId: 'appr-1' })).status).toBe('completed');
  });
  it('refuses another tenant or run at run time too', async () => {
    const port = createMockExecutionPort(ctx);
    const d = await port.request(req());
    expect((await port.run(d, { ...run, orgId: 'org-2' })).status).toBe('refused');
    expect((await port.run(d, { ...run, runId: 'run-2' })).status).toBe('refused');
    expect(port.calls).toHaveLength(0);
  });
  it('applies the decision limits: output truncation and wall-clock timeout', async () => {
    const port = createMockExecutionPort(ctx);
    port.script('typecheck', { stdout: 'x'.repeat(300 * 1024) }, { durationMs: 999_000 });
    const d = await port.request(req());
    const a = await port.run(d, run);
    expect(a.truncated).toBe(true);
    expect(Buffer.byteLength(a.stdout)).toBe(256 * 1024);
    const b = await port.run(d, run);
    expect(b).toMatchObject({ status: 'timeout', exitCode: null, durationMs: 180_000 });
  });
  it('emergency termination and abort signals end the run as terminated', async () => {
    const port = createMockExecutionPort(ctx);
    const d = await port.request(req());
    const ac = new AbortController();
    ac.abort();
    expect((await port.run(d, { ...run, signal: ac.signal })).status).toBe('terminated');
    port.terminate('run-1');
    expect((await port.run(d, run)).status).toBe('terminated');
    expect(port.calls).toHaveLength(0);
  });
  it('does not alias scripted artifacts between runs', async () => {
    const port = createMockExecutionPort(ctx);
    const shared = { artifacts: [{ path: 'dist/a.js', bytes: 3 }] };
    port.scriptDefault(shared);
    const d = await port.request(req({ profile: 'build' }));
    const o = await port.run(d, run);
    o.artifacts[0]!.bytes = 999;
    expect(shared.artifacts[0]!.bytes).toBe(3);
  });
  it('O-12: runs only decisions it issued: a hand-made or edited decision is refused', async () => {
    const port = createMockExecutionPort(ctx);
    const d = await port.request(req());
    if (!d.allowed) throw new Error('expected allowed');
    const handMade = { ...d, argv: ['sh', '-c', 'id'] };
    expect((await port.run(handMade, run)).stderr).toContain('decision_not_issued_by_gateway');
    expect((await port.run({ ...d, env: { ...d.env, X: '1' } }, run)).stderr).toContain(
      'decision_not_issued_by_gateway',
    );
    expect((await port.run({ allowed: true } as never, run)).status).toBe('refused');
    expect(port.calls).toHaveLength(0);
    expect((await port.run(d, run)).status).toBe('completed');
  });
  it('O-13: an artifact the runtime reports as a link is carried with its kind so the artifact policy can refuse it', async () => {
    const port = createMockExecutionPort(ctx);
    port.script('build', {
      artifacts: [{ path: 'dist/l', bytes: 3, sha256: 'a'.repeat(64), kind: 'symlink' }],
    });
    const o = await port.run(await port.request(req({ profile: 'build' })), run);
    expect(o.artifacts[0]!.kind).toBe('symlink');
  });
});
