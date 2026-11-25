import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SAMPLE_SPEC } from '../fixtures/sample-spec';
import { runProbe } from '../../../../../templates/webapp-runtime/probe/suite';
import { newApp } from '../../../../../templates/webapp-runtime/__tests__/fixture';
import { generateProject } from './project';
import {
  PROBE_PROFILE,
  parseProbeOutput,
  probeGeneratedApp,
  REPORT_PREFIX,
  REQUIRED_CHECKS,
  simulatedProbeRuntime,
  type ProbeRuntimePort,
} from './probe-runner';

const OK_ISOLATION = {
  inheritedEnvNames: [],
  databaseHost: '127.0.0.1',
  databaseRole: 'app_owner',
  roleSuperuser: false,
  roleBypassRls: false,
  migrationsApplied: 1,
  migrationsReapplied: 0,
  databaseDestroyed: true,
};

/** A real report from the template's probe suite run against the template's fixture app (in-process, MemoryStore): the same JSON the in-runtime probe prints. */
let cached: Record<string, unknown> | null = null;
async function realReport(): Promise<Record<string, unknown>> {
  if (cached) return JSON.parse(JSON.stringify(cached));
  const a = newApp({ signupRole: 'rep', tenancy: 'single' });
  const report = await runProbe(a.transport, a.ctx);
  cached = {
    report: { ...report, app: SAMPLE_SPEC.slug },
    isolation: OK_ISOLATION,
    migrationLog: ['applied 0001_init.sql'],
    durationMs: 1,
  };
  return JSON.parse(JSON.stringify(cached));
}
const line = (o: unknown) => REPORT_PREFIX + JSON.stringify(o) + '\n';

describe('probe output parsing treats the runtime output as untrusted data', () => {
  it('accepts a real report, recomputes counts and the verdict, and verifies the isolation block', async () => {
    const r = parseProbeOutput('noise\n' + line(await realReport()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.probe.ok).toBe(true);
    expect(r.probe.requiredNotPassed).toEqual([]);
    expect(r.probe.isolation.ok).toBe(true);
  }, 120_000);
  it('does not believe the report about itself: a claimed ok with a failed or skipped required check is not ok', async () => {
    const j = (await realReport()) as {
      report: { ok: boolean; checks: { id: string; status: string }[] };
    };
    j.report.ok = true;
    j.report.checks.find((c) => c.id === 'cross-user-isolation')!.status = 'skipped';
    const r = parseProbeOutput(line(j));
    expect(r.ok && r.probe.ok).toBe(false);
    expect(r.ok && r.probe.requiredNotPassed).toEqual(['cross-user-isolation']);
    j.report.checks.find((c) => c.id === 'crud')!.status = 'fail';
    const f = parseProbeOutput(line(j));
    expect(f.ok && f.probe.failed).toBe(1);
  }, 120_000);
  it('a missing required check is not a pass', async () => {
    const j = (await realReport()) as { report: { checks: { id: string }[] } };
    j.report.checks = j.report.checks.filter((c) => c.id !== 'logout-revokes');
    const r = parseProbeOutput(line(j));
    expect(r.ok && r.probe.requiredNotPassed).toContain('logout-revokes');
  }, 120_000);
  it.each([
    ['no report', 'just text\n', 'no_probe_report'],
    [
      'two reports',
      line({ report: { schema: 'nuzm.app-probe/1', checks: [] } }) + line({}),
      'more_than_one_probe_report',
    ],
    ['not json', REPORT_PREFIX + '{bad\n', 'report_not_json'],
    ['wrong schema', line({ report: { schema: 'x' } }), 'report_schema'],
    [
      'a fatal probe error',
      line({ report: { schema: 'nuzm.app-probe/1', fatal: 'boom' } }),
      'report_checks',
    ],
    ['no checks', line({ report: { schema: 'nuzm.app-probe/1', checks: [] } }), 'report_checks'],
    [
      'a duplicate check id',
      line({
        report: {
          schema: 'nuzm.app-probe/1',
          checks: [
            { id: 'a', status: 'pass', title: 't', detail: 'd' },
            { id: 'a', status: 'pass', title: 't', detail: 'd' },
          ],
        },
      }),
      'report_check_id',
    ],
    [
      'an unknown status',
      line({
        report: {
          schema: 'nuzm.app-probe/1',
          checks: [{ id: 'a', status: 'great', title: 't', detail: 'd' }],
        },
      }),
      'report_check_status',
    ],
    [
      'a secret in the report',
      line({
        report: {
          schema: 'nuzm.app-probe/1',
          checks: [
            { id: 'a', status: 'pass', title: 't', detail: ['AKIA', 'ABCDEFGHIJKLMNOP'].join('') },
          ],
        },
      }),
      'report_contains_secret',
    ],
    ['an oversized report', REPORT_PREFIX + '"' + 'x'.repeat(210_000) + '"\n', 'report_too_large'],
  ])('rejects %s', (_n, out, reason) => {
    const r = parseProbeOutput(out);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe(reason);
  });
  it('the platform and the template agree on the required checks', () => {
    const text = readFileSync(
      join(__dirname, '../../../../../templates/webapp-runtime/probe/suite.ts'),
      'utf8',
    );
    const m = /REQUIRED_CHECKS = \[([^\]]+)\]/.exec(text)!;
    expect([...m[1]!.matchAll(/'([a-z-]+)'/g)].map((x) => x[1])).toEqual([...REQUIRED_CHECKS]);
  });
});

describe('probeGeneratedApp against the SIMULATED runtime', () => {
  it('the default simulated node prints a placeholder: SIMULATED, NOT VERIFIED, never a pass', async () => {
    const o = await probeGeneratedApp({
      spec: SAMPLE_SPEC,
      runtime: simulatedProbeRuntime(),
      options: { signupRole: 'auto' },
    });
    expect(o.stage).toBe('report');
    expect(o.gates.ok).toBe(true);
    expect(o.evidence).toMatchObject({
      label: 'SIMULATED',
      verdict: 'NOT VERIFIED',
      runtime: { origin: 'MOCK', profile: PROBE_PROFILE.profile },
    });
    expect(o.evidence.reasons).toContain('simulated_runtime_output_is_a_placeholder');
  }, 120_000);
  it('a scripted node that prints a perfect report is still only SIMULATED evidence, labelled as such', async () => {
    const o = await probeGeneratedApp({
      spec: SAMPLE_SPEC,
      options: { signupRole: 'auto' },
      runtime: simulatedProbeRuntime({ stdout: line(await realReport()) }),
    });
    expect(o.stage).toBe('verdict');
    expect(o.evidence.verdict).toBe('PASS');
    expect(o.evidence.label).toBe('SIMULATED');
    expect(o.evidence.reasons).toContain('origin_mock_not_live_evidence');
    expect(o.evidence.result.requiredNotPassed).toEqual([]);
    expect(o.evidence.inputs.filesDigest).toBe(o.gates.inputDigest);
  }, 120_000);
  it('a report from another app, a failed required check or a bad isolation block makes the verdict FAIL', async () => {
    const other = (await realReport()) as { report: { app: string } };
    other.report.app = 'someone-else';
    expect(
      (
        await probeGeneratedApp({
          spec: SAMPLE_SPEC,
          options: { signupRole: 'auto' },
          runtime: simulatedProbeRuntime({ stdout: line(other) }),
        })
      ).evidence.reasons,
    ).toContain('report_for_another_app');
    const bad = (await realReport()) as { isolation: typeof OK_ISOLATION };
    bad.isolation = { ...OK_ISOLATION, roleSuperuser: true };
    const b = await probeGeneratedApp({
      spec: SAMPLE_SPEC,
      options: { signupRole: 'auto' },
      runtime: simulatedProbeRuntime({ stdout: line(bad) }),
    });
    expect(b.evidence.verdict).toBe('FAIL');
    expect(b.evidence.reasons).toContain('isolation:role_not_superuser');
    const failing = (await realReport()) as {
      report: { checks: { id: string; status: string }[] };
    };
    failing.report.checks.find((c) => c.id === 'login')!.status = 'fail';
    const f = await probeGeneratedApp({
      spec: SAMPLE_SPEC,
      options: { signupRole: 'auto' },
      runtime: simulatedProbeRuntime({ stdout: line(failing), exitCode: 1 }),
    });
    expect(f.evidence.verdict).toBe('FAIL');
    expect(f.evidence.reasons).toEqual(
      expect.arrayContaining(['failed:login', 'probe_exit_code:1']),
    );
  }, 180_000);
  it('code that fails the static gates never reaches the runtime and the findings are the repair input', async () => {
    const files = new Map(generateProject(SAMPLE_SPEC, { signupRole: 'auto' }).files);
    files.set('src/evil.ts', "import { exec } from 'node:child_process';\nexec('curl x');\n");
    let called = 0;
    const runtime: ProbeRuntimePort = {
      run: async () => (
        called++,
        {
          origin: 'MOCK',
          label: 'SIMULATED',
          status: 'completed',
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 1,
        }
      ),
    };
    const o = await probeGeneratedApp({
      spec: SAMPLE_SPEC,
      options: { signupRole: 'auto' },
      files,
      runtime,
    });
    expect(called).toBe(0);
    expect(o.stage).toBe('static_gates');
    expect(o.evidence.verdict).toBe('FAIL');
    expect(o.evidence.reasons).toContain('forbidden-apis:child_process');
  }, 120_000);
  it('only a REAL, attested run with a clean verdict can be LIVE-VERIFIED (a fixture standing in for the qualified runtime)', async () => {
    const stdout = line(await realReport());
    const mk = (over: Partial<Awaited<ReturnType<ProbeRuntimePort['run']>>>): ProbeRuntimePort => ({
      run: async () => ({
        origin: 'REAL',
        label: 'LIVE',
        status: 'completed',
        exitCode: 0,
        stdout,
        stderr: '',
        durationMs: 5,
        attestationId: 'att-1',
        nodeId: 'node-1',
        ...over,
      }),
    });
    const live = await probeGeneratedApp({
      spec: SAMPLE_SPEC,
      options: { signupRole: 'auto' },
      runtime: mk({}),
    });
    expect(live.evidence.label).toBe('LIVE-VERIFIED');
    const noAtt = await probeGeneratedApp({
      spec: SAMPLE_SPEC,
      options: { signupRole: 'auto' },
      runtime: mk({ attestationId: undefined }),
    });
    expect(noAtt.evidence.label).toBe('NOT VERIFIED');
    const exit = await probeGeneratedApp({
      spec: SAMPLE_SPEC,
      options: { signupRole: 'auto' },
      runtime: mk({ exitCode: 1 }),
    });
    expect(exit.evidence).toMatchObject({ label: 'NOT VERIFIED', verdict: 'FAIL' });
  }, 180_000);
  it('a runtime that refuses is NOT VERIFIED, with the reason', async () => {
    const o = await probeGeneratedApp({
      spec: SAMPLE_SPEC,
      runtime: {
        run: async () => {
          throw new Error('node_unavailable');
        },
      },
    });
    expect(o.stage).toBe('runtime');
    expect(o.evidence).toMatchObject({ label: 'NOT VERIFIED', verdict: 'NOT VERIFIED' });
    expect(o.evidence.reasons[0]).toContain('node_unavailable');
  }, 120_000);
});
