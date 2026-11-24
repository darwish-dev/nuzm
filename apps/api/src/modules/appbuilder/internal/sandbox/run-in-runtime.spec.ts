import { executionGateway as eg } from '@nuzm/domain';
import { describe, expect, it } from 'vitest';
import { RunRefused, runInRuntime } from './run-in-runtime';
import { main } from './run-in-runtime.cli';

const files = new Map([
  ['package.json', '{"name":"x","private":true}\n'],
  ['src/a.ts', 'export {};\n'],
]);
const refs = { d21: 'D-21-test', hg1002: 'HG-10-02-test', adr: 'ADR-test', approval: 'APPR-1' };
const reasons = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof RunRefused ? e.reasons : ['other:' + String(e)];
  }
  return [];
};

describe('Track D runnable script: run in the isolated runtime (SIMULATED today)', () => {
  it('runs a typecheck against a simulated node: labelled SIMULATED, origin MOCK, fixed argv, nothing executed', async () => {
    const r = await runInRuntime({
      mode: 'simulated',
      endpoint: 'simulated:node-1',
      profile: 'typecheck',
      files,
    });
    expect(r.label).toBe('SIMULATED');
    expect(r.origin).toBe('MOCK');
    expect(r.statement).toContain('nothing was executed');
    expect(r.decision.argv).toEqual(['npx', '--no-install', 'tsc', '--noEmit']);
    expect(r.outcome.status).toBe('completed');
    expect(r.outcome.stdout).toContain('[SIMULATED]');
  });
  it('the profile is a name from the closed catalogue; an unknown, prototype or parameterised-wrong request is refused by the policy', async () => {
    expect(
      await reasons(
        runInRuntime({ mode: 'simulated', endpoint: 'simulated:n', profile: 'sh -c id', files }),
      ),
    ).toContain('policy:unknown_profile');
    expect(
      await reasons(
        runInRuntime({ mode: 'simulated', endpoint: 'simulated:n', profile: 'constructor', files }),
      ),
    ).toContain('policy:unknown_profile');
    expect(
      await reasons(
        runInRuntime({
          mode: 'simulated',
          endpoint: 'simulated:n',
          profile: 'run-script',
          params: { script: 'postinstall' },
          projectScripts: ['postinstall'],
          files,
          approvalId: 'a',
        }),
      ),
    ).toContain('policy:script_denied');
  });
  it('an approval-gated profile does not run without the approval id; secrets in the project stop the run before the node', async () => {
    const r = await runInRuntime({
      mode: 'simulated',
      endpoint: 'simulated:n',
      profile: 'install-deps',
      files: new Map([...files, ['package-lock.json', '{"lockfileVersion":3,"packages":{"":{}}}']]),
    });
    expect(r.outcome.status).toBe('refused');
    expect(r.outcome.stderr).toContain('approval_required');
    const s = await runInRuntime({
      mode: 'simulated',
      endpoint: 'simulated:n',
      profile: 'typecheck',
      files: new Map([...files, ['.env', 'X=1']]),
    });
    expect(s.outcome.stderr).toContain('workspace_refused');
  });
  it('simulated mode refuses a non-simulated endpoint', async () => {
    expect(
      await reasons(
        runInRuntime({
          mode: 'simulated',
          endpoint: 'https://node.example.invalid',
          profile: 'typecheck',
          files,
        }),
      ),
    ).toEqual(['only_simulated_endpoints_in_simulated_mode']);
  });
  it('LIVE refuses with every missing prerequisite listed, before any node contact', async () => {
    let contacted = false;
    const r = await reasons(
      runInRuntime({
        mode: 'live',
        endpoint: 'https://n.invalid',
        profile: 'typecheck',
        files,
        connect: async () => {
          contacted = true;
          return null;
        },
      }),
    );
    expect(r).toEqual(
      expect.arrayContaining([
        'd21_reference_missing',
        'hg_10_02_reference_missing',
        'adr_acceptance_reference_missing',
        'approval_reference_missing',
        'node_binding_missing',
        'attestation_missing',
      ]),
    );
    expect(contacted).toBe(false);
    expect(
      await reasons(
        runInRuntime({
          mode: 'live',
          endpoint: 'https://n.invalid',
          profile: 'typecheck',
          files,
          refs,
          nodeId: 'n',
          endpointId: 'e',
          attestation: {},
          env: {},
        }),
      ),
    ).toContain('approval_not_confirmed_in_environment');
    expect(
      await reasons(
        runInRuntime({
          mode: 'live',
          endpoint: 'simulated:n',
          profile: 'typecheck',
          files,
          refs,
          nodeId: 'n',
          endpointId: 'e',
          attestation: {},
          env: { NUZM_EXECUTION_APPROVED: 'APPR-1' },
        }),
      ),
    ).toContain('simulated_endpoint_cannot_be_live');
  });
  it('LIVE with every reference but no node client refuses; with an injected node it still refuses a SIMULATED or tampered attestation', async () => {
    const env = { NUZM_EXECUTION_APPROVED: 'APPR-1' };
    const base = {
      mode: 'live' as const,
      endpoint: 'https://n.invalid',
      profile: 'typecheck',
      files,
      refs,
      nodeId: 'node-1',
      endpointId: 'ep-1',
      env,
    };
    expect(await reasons(runInRuntime({ ...base, attestation: { x: 1 } }))).toEqual([
      'endpoint_client_unavailable',
    ]);
    const kit = eg.createSimulatedKit();
    const node = new eg.SimulatedWorkspaceRuntime({
      nodeId: 'node-1',
      endpointId: 'ep-1',
      runtimeClass: 'gvisor-runsc',
      imageDigests: [eg.SIMULATED_IMAGE_DIGEST],
    });
    const sim = kit.attestation({ nodeId: 'node-1', endpointId: 'ep-1' });
    const out = await reasons(
      runInRuntime({ ...base, attestation: sim, trust: kit.trusted, connect: async () => node }),
    );
    expect(out).toContain('attestation:node-1:evidence_not_live_verified');
    const bad = await reasons(
      runInRuntime({
        ...base,
        attestation: { ...sim, node: { ...sim.node, kernel: 'x' } },
        trust: kit.trusted,
        connect: async () => node,
      }),
    );
    expect(bad.some((r) => r.includes('signature_invalid'))).toBe(true);
    expect(node.accepted).toEqual([]); // nothing ever reached the node
  });
  it('the CLI exits 0 for a simulated run, 2 for usage and for every refusal', async () => {
    const log = console.log;
    const err = console.error;
    console.log = () => undefined;
    console.error = () => undefined;
    try {
      expect(await main(['--endpoint', 'simulated:node-1', '--profile', 'typecheck'])).toBe(0);
      expect(await main([])).toBe(2);
      expect(await main(['--endpoint', 'simulated:node-1', '--profile', 'bogus'])).toBe(2);
      expect(
        await main(
          ['--endpoint', 'https://x.invalid', '--profile', 'typecheck', '--mode', 'live'],
          {},
        ),
      ).toBe(2);
    } finally {
      console.log = log;
      console.error = err;
    }
  });
});
