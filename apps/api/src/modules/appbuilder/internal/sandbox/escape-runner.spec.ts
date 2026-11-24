import { executionGateway as eg } from '@nuzm/domain';
import { describe, expect, it } from 'vitest';
import { ATTEMPTS } from './escape-suite';
import { EndpointSandboxRuntime } from './endpoint-runtime';
import { QualificationRefused, renderReport, runQualification } from './escape-runner';
import { main } from './escape-runner.cli';

const decl: eg.NodeDeclaration = {
  node: {
    nodeId: 'stg-1',
    endpointId: 'ep-stg-1',
    environment: 'staging',
    os: 'linux',
    kernel: '6.1.0',
    arch: 'x86_64',
  },
  runtime: { class: 'gvisor-runsc', version: '1', imageDigests: [eg.SIMULATED_IMAGE_DIGEST] },
  host: {
    cgroupsV2: true,
    dedicatedNode: true,
    virtualization: 'n/a',
    swapDisabled: true,
    containerRuntimeSocketNotExposed: true,
    egress: 'default-deny-proxy-only',
    diskQuota: 'project-quota',
    metadataServiceBlocked: true,
  },
};
const rejects = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof QualificationRefused ? e.reasons : ['other:' + String(e)];
  }
  return [];
};

describe('escape-suite qualification runner (S-AG6 phase 2, offline)', () => {
  it('runs suite 1.1.0 against a simulated endpoint: control-plane PASS, isolating NOT_VERIFIED, labelled SIMULATED, not eligible', async () => {
    const r = await runQualification({ mode: 'simulated', endpoint: 'simulated:node-1' });
    expect(r.suiteVersion).toBe('1.1.0');
    expect(r.label).toBe('SIMULATED');
    expect(r.totals.fail).toBe(0);
    expect(r.totals.isolatingAttempts).toBeGreaterThanOrEqual(21);
    expect(r.totals.isolatingPass).toBe(0);
    expect(
      r.lines
        .filter((l) => l.requires === 'isolating-runtime')
        .every((l) => l.verdict === 'NOT_VERIFIED'),
    ).toBe(true);
    expect(r.lines.filter((l) => l.requires === 'control-plane' && l.verdict === 'FAIL')).toEqual(
      [],
    );
    expect(r.eligibleForReview).toBe(false);
    expect(r.draftAttestation).toBeNull();
    expect(r.reportSha256).toMatch(/^[0-9a-f]{64}$/);
    const text = renderReport(r);
    expect(text).toContain('SIMULATED: nothing was isolated or executed');
    expect(text).toContain('evidence=SIMULATED');
  });
  it('the attestation minimum equals the number of isolating attempts in the suite', () => {
    expect(ATTEMPTS.filter((a) => a.requires === 'isolating-runtime').length).toBe(
      eg.DEFAULT_MIN_ISOLATING_ATTEMPTS,
    );
  });
  it('refuses non-simulated endpoints in simulated mode, and live modes without approval, staging and a node client', async () => {
    expect(
      await rejects(
        runQualification({ mode: 'simulated', endpoint: 'https://node.example.invalid' }),
      ),
    ).toContain('only_simulated_endpoints_in_simulated_mode');
    expect(
      await rejects(
        runQualification({ mode: 'qualify', endpoint: 'https://n.invalid', declaration: decl }),
      ),
    ).toContain('approval_reference_missing');
    expect(
      await rejects(
        runQualification({
          mode: 'qualify',
          endpoint: 'https://n.invalid',
          declaration: decl,
          approvalRef: 'HG-10-02-x',
        }),
      ),
    ).toContain('approval_not_confirmed_in_environment');
    expect(
      await rejects(
        runQualification({
          mode: 'qualify',
          endpoint: 'simulated:n',
          declaration: decl,
          approvalRef: 'HG-10-02-x',
          env: { NUZM_QUALIFICATION_APPROVED: 'HG-10-02-x' },
        }),
      ),
    ).toContain('simulated_endpoint_cannot_be_live_qualification');
    expect(
      await rejects(
        runQualification({
          mode: 'qualify',
          endpoint: 'https://n.invalid',
          declaration: { ...decl, node: { ...decl.node, environment: 'production' } },
          approvalRef: 'HG-10-02-x',
          env: { NUZM_QUALIFICATION_APPROVED: 'HG-10-02-x' },
        }),
      ),
    ).toContain('node_not_staging');
    expect(
      await rejects(
        runQualification({
          mode: 'qualify',
          endpoint: 'https://n.invalid',
          approvalRef: 'HG-10-02-x',
          env: { NUZM_QUALIFICATION_APPROVED: 'HG-10-02-x' },
        }),
      ),
    ).toContain('node_declaration_missing');
    // everything else in place: still no node client in this repository
    expect(
      await rejects(
        runQualification({
          mode: 'qualify',
          endpoint: 'https://n.invalid',
          declaration: decl,
          approvalRef: 'HG-10-02-x',
          env: { NUZM_QUALIFICATION_APPROVED: 'HG-10-02-x' },
        }),
      ),
    ).toEqual(['endpoint_client_unavailable']);
  });
  it('requalify verifies the attestation fail-closed first', async () => {
    const r = await rejects(
      runQualification({
        mode: 'requalify',
        endpoint: 'https://n.invalid',
        declaration: decl,
        attestation: null,
        approvalRef: 'D-21-x',
        env: { NUZM_QUALIFICATION_APPROVED: 'D-21-x' },
      }),
    );
    expect(r).toContain('attestation:attestation_missing');
  });
  it('a live qualification of an injected node that BLOCKS every isolating attempt is eligible for review and yields an UNVERIFIABLE draft', async () => {
    // a stand-in node that makes every attack payload fail (exit 1): this proves the runner's wiring, never any isolation
    const node = new eg.SimulatedWorkspaceRuntime({
      nodeId: 'stg-1',
      endpointId: 'ep-stg-1',
      runtimeClass: 'gvisor-runsc',
      imageDigests: [eg.SIMULATED_IMAGE_DIGEST],
    });
    node.setScript((spec) =>
      spec.argv.join(' ').includes('while(true)')
        ? { exitCode: null, signal: 'SIGKILL' }
        : { exitCode: 1, stdout: '' },
    );
    const r = await runQualification({
      mode: 'qualify',
      endpoint: 'https://stg-1.invalid',
      declaration: decl,
      approvalRef: 'HG-10-02-test',
      env: { NUZM_QUALIFICATION_APPROVED: 'HG-10-02-test' },
      connect: async () => node,
    });
    expect(r.label).toBe('NOT VERIFIED');
    expect(r.totals.isolatingPass).toBe(r.totals.isolatingAttempts);
    expect(r.totals.fail).toBe(0);
    expect(r.eligibleForReview).toBe(true);
    expect(r.draftAttestation?.evidence.label).toBe('NOT VERIFIED');
    expect(r.draftAttestation?.evidence.securityReview.reviewer).toBe('');
    const kit = eg.createSimulatedKit();
    const v = eg.verifyAttestation(
      { ...r.draftAttestation, signature: '' },
      {
        nodeId: 'stg-1',
        endpointId: 'ep-stg-1',
        mode: 'live',
        environments: ['staging'],
        minSuiteVersion: '1.1.0',
        minIsolatingAttempts: eg.DEFAULT_MIN_ISOLATING_ATTEMPTS,
        maxValidityDays: 90,
        now: new Date(),
      },
      kit.trusted,
    );
    expect(v.ok).toBe(false);
  });
  it('a node on which an attack SUCCEEDS makes the qualification FAIL and not eligible', async () => {
    const node = new eg.SimulatedWorkspaceRuntime({
      nodeId: 'stg-1',
      endpointId: 'ep-stg-1',
      runtimeClass: 'gvisor-runsc',
      imageDigests: [eg.SIMULATED_IMAGE_DIGEST],
    });
    node.setScript(() => ({ exitCode: 0, stdout: 'uid=0(root) gid=0(root)\n' }));
    const r = await runQualification({
      mode: 'qualify',
      endpoint: 'https://stg-1.invalid',
      declaration: decl,
      approvalRef: 'D-21-test',
      env: { NUZM_QUALIFICATION_APPROVED: 'D-21-test' },
      connect: async () => node,
    });
    expect(r.totals.fail).toBeGreaterThan(0);
    expect(r.eligibleForReview).toBe(false);
    expect(r.problems.join()).toContain('ESCAPED');
  });
  it('refuses a node whose identity differs from the declaration', async () => {
    const node = new eg.SimulatedWorkspaceRuntime({
      nodeId: 'someone-else',
      endpointId: 'ep-x',
      runtimeClass: 'gvisor-runsc',
      imageDigests: [eg.SIMULATED_IMAGE_DIGEST],
    });
    expect(
      await rejects(
        runQualification({
          mode: 'qualify',
          endpoint: 'https://stg-1.invalid',
          declaration: decl,
          approvalRef: 'HG-10-02-t',
          env: { NUZM_QUALIFICATION_APPROVED: 'HG-10-02-t' },
          connect: async () => node,
        }),
      ),
    ).toEqual(['node_identity_mismatch']);
  });
  it('the node adapter gives attack payloads the hardened spec, cleans up, and the simulated node refuses anything weaker', async () => {
    const node = new eg.SimulatedWorkspaceRuntime({
      nodeId: 'n',
      endpointId: 'e',
      runtimeClass: 'gvisor-runsc',
      imageDigests: [eg.SIMULATED_IMAGE_DIGEST],
    });
    const rt = new EndpointSandboxRuntime(
      node,
      'simulated',
      eg.SIMULATED_IMAGE_DIGEST,
      'gvisor-runsc',
    );
    const h = await rt.create({
      sandboxId: 'qual-1',
      orgId: 'o',
      projectId: 'p',
      quota: { vcpu: 1, memoryMb: 512, diskGb: 1, pids: 64, buildTimeoutMinutes: 1 },
      egressProfile: 'standard',
    });
    await rt.exec(h, { argv: ['id'], timeoutMs: 5000 });
    expect(eg.validateRuntimeSpec(node.accepted[0]!)).toEqual([]);
    expect(node.accepted[0]!.user.uid).not.toBe(0);
    expect(node.liveRuns()).toEqual([]);
    await rt.destroy(h);
    expect(node.liveWorkspaces()).toEqual([]);
    const bad = new EndpointSandboxRuntime(node, 'simulated', eg.SIMULATED_IMAGE_DIGEST, 'runc');
    const h2 = await bad.create({
      sandboxId: 'qual-2',
      orgId: 'o',
      projectId: 'p',
      quota: { vcpu: 1, memoryMb: 512, diskGb: 1, pids: 64, buildTimeoutMinutes: 1 },
      egressProfile: 'standard',
    });
    await expect(bad.exec(h2, { argv: ['id'], timeoutMs: 5000 })).rejects.toThrow(
      /runtime_class_not_isolating/,
    );
    await bad.destroy(h2);
  });
  it('the CLI exits 0 on a clean simulated run and 2 on a refusal or bad usage', async () => {
    const log = console.log;
    const err = console.error;
    console.log = () => undefined;
    console.error = () => undefined;
    try {
      expect(await main(['--endpoint', 'simulated:node-1'])).toBe(0);
      expect(await main([])).toBe(2);
      expect(await main(['--endpoint', 'https://x.invalid'])).toBe(2);
      expect(await main(['--endpoint', 'https://x.invalid', '--mode', 'qualify'], {})).toBe(2);
    } finally {
      console.log = log;
      console.error = err;
    }
  });
});
