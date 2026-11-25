import { describe, expect, it } from 'vitest';
import { CanaryRegistry, MemorySecurityAlerts } from './canary';
import { DEFAULT_ALLOW, EgressPolicy } from './egress';
import { ATTEMPTS, MIN_ATTEMPTS, SUITE_VERSION, runEscapeSuite } from './escape-suite';
import { EXEC_ATTEMPTS } from './escape-suite-exec';
import { MockSandboxRuntime } from './mock-runtime';
import { checkPath, scanSecrets } from './paths';

/**
 * The escape suite WITHOUT a database: the control-plane attempts that do not need tickets run for real, everything that needs an isolating runtime is NOT_VERIFIED on the mock.
 * The ticket attempts (WS-*) need the database and report NOT_VERIFIED here; the integration spec runs them.
 */
const mkCtx = async (runtime: MockSandboxRuntime) => {
  const egress = new EgressPolicy(DEFAULT_ALLOW, async (h) => {
    const m: Record<string, string[]> = {
      'npm-mirror.nuzm.internal': ['93.184.216.10'],
      'git.nuzm.internal': ['93.184.216.11'],
    };
    if (!m[h]) throw new Error('NXDOMAIN');
    return m[h]!;
  });
  const handle = await runtime.create({
    sandboxId: 's',
    orgId: 'o',
    projectId: 'p',
    quota: { vcpu: 1, memoryMb: 1024, diskGb: 1, pids: 64, buildTimeoutMinutes: 5 },
    egressProfile: 'standard',
  });
  return {
    egress,
    runtime,
    canaries: new CanaryRegistry(new MemorySecurityAlerts()),
    handle,
    tickets: null,
    writeThroughChanges: async (p: string, c: string) =>
      checkPath(p) === null && scanSecrets(c).length === 0,
  };
};

describe('escape suite 1.1.0 (execution extension) on the MOCK runtime', () => {
  it('is versioned 1.1.0, ids are unique and the suite is larger than the minimum', () => {
    expect(SUITE_VERSION).toBe('1.1.0');
    expect(new Set(ATTEMPTS.map((a) => a.id)).size).toBe(ATTEMPTS.length);
    expect(ATTEMPTS.length).toBeGreaterThanOrEqual(MIN_ATTEMPTS + EXEC_ATTEMPTS.length);
    expect(EXEC_ATTEMPTS.length).toBeGreaterThanOrEqual(140);
  });
  it('every execution control-plane attempt is BLOCKED; none ESCAPED; every isolating attempt is NOT_VERIFIED; no isolation evidence', async () => {
    const report = await runEscapeSuite(await mkCtx(new MockSandboxRuntime()));
    const ex = report.results.filter((r) => r.id.startsWith('EX-'));
    expect(ex.length).toBe(EXEC_ATTEMPTS.filter((a) => a.id.startsWith('EX-')).length);
    expect(ex.filter((r) => r.status !== 'BLOCKED')).toEqual([]);
    const xr = report.results.filter((r) => r.id.startsWith('XR-'));
    expect(xr.length).toBeGreaterThanOrEqual(20);
    expect(xr.every((r) => r.status === 'NOT_VERIFIED' && r.requires === 'isolating-runtime')).toBe(
      true,
    );
    expect(
      report.results.filter((r) => r.status === 'ESCAPED').map((r) => r.id + ' ' + r.note),
    ).toEqual([]);
    expect(report.escaped).toBe(0);
    expect(report.isolationEvidence).toBe(false);
    expect(report.suiteVersion).toBe('1.1.0');
  });
  it('a mock that CLAIMS verified isolation still cannot pass the isolating attempts (they would run and the mock cannot fail them)', async () => {
    const rt = new MockSandboxRuntime();
    const ctx = await mkCtx(rt);
    Object.defineProperty(rt, 'isolation', { value: 'verified' });
    // the mock answers every unknown command with 127 (not found), so "the attack failed" holds for the payloads that expect a non-zero exit:
    // that is precisely why a mock must never be allowed to claim `verified`. The suite output is NOT evidence; this test only documents the trap.
    const report = await runEscapeSuite(ctx);
    expect(report.runtime.isolation).toBe('verified');
    // the orchestrator and `executionGate` refuse such a runtime regardless (see execution-port.spec.ts, EX-GATE-8)
  });
  it('covers every area the ADR names: policy, environment, workspace, output, artifacts, gate, runtime spec, quota, symlinks and mounts, lifecycle scripts', () => {
    const cats = new Set(EXEC_ATTEMPTS.map((a) => a.category));
    for (const c of [
      'exec_policy',
      'exec_env',
      'exec_workspace',
      'exec_output',
      'exec_artifact',
      'exec_gate',
      'exec_runtime_spec',
      'exec_quota',
      'symlink_mount',
      'lifecycle_script',
      'resource_exhaustion',
      'dns_exfiltration',
      'lateral_movement',
      'metadata_service',
      'runtime_socket',
    ])
      expect(cats.has(c as never), c).toBe(true);
  });
});
