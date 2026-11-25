import { describe, expect, it } from 'vitest';
import { EXEC_PROFILES } from '../policy';
import { createSimulatedKit, SIMULATED_IMAGE_DIGEST } from './simulated-attestation';
import { RealRuntimeService, type PlacementResidency, type RunInputs } from './real-runtime';
import { SimulatedWorkspaceRuntime } from './workspace-runtime';

const NOW = Date.UTC(2026, 11, 1);
async function run(
  residency: PlacementResidency | undefined,
  region: string | undefined,
  dataRegion: string | undefined,
) {
  const kit = createSimulatedKit();
  const node = { nodeId: 'sim-node', endpointId: 'sim-ep' };
  const rt = new SimulatedWorkspaceRuntime({
    ...node,
    runtimeClass: 'gvisor-runsc',
    imageDigests: [SIMULATED_IMAGE_DIGEST],
  });
  const events: string[] = [];
  const svc = await RealRuntimeService.start({
    mode: 'simulated',
    nodes: [
      { ...node, runtime: rt, attestation: kit.attestation(node, { now: new Date(NOW) }), region },
    ],
    trust: kit.trusted,
    environments: ['staging'],
    now: () => NOW,
    residency,
    onEvent: (e) => events.push(e.type + ':' + (e.detail?.reason ?? '')),
    artifactSink: { put: async () => undefined },
  });
  const ctx = {
    orgId: 'org-1',
    runId: 'run-1',
    enabledProfiles: Object.keys(EXEC_PROFILES),
    projectScripts: [],
  };
  const inputs: RunInputs = {
    seedFiles: () => new Map([['package.json', '{}']]),
    canaries: () => [],
    dataRegion,
  };
  const port = svc.portFor(ctx, inputs);
  const d = await port.request({ orgId: 'org-1', runId: 'run-1', profile: 'typecheck' });
  const o = await port.run(d, { orgId: 'org-1', runId: 'run-1' });
  return { o, events, created: rt.liveWorkspaces().length };
}
const allow =
  (ok: boolean, reason = 'region_not_allowed'): PlacementResidency['evaluate'] =>
  async () => ({ allowed: ok, reason });

describe('placement residency (default off; fail closed when on)', () => {
  it('off by default: nothing changes', async () => {
    expect((await run(undefined, undefined, undefined)).o.status).toBe('completed');
    expect(
      (await run({ enforce: false, evaluate: allow(false) }, undefined, undefined)).o.status,
    ).toBe('completed');
  });
  it('on: allowed when node region and data region are known and the policy says yes', async () => {
    expect(
      (await run({ enforce: true, evaluate: allow(true) }, 'sa-central', 'sa-central')).o.status,
    ).toBe('completed');
  });
  it.each([
    ['the node has no region', undefined, 'sa-central', 'node_region_unknown'],
    ['the project has no data region', 'sa-central', undefined, 'data_region_unknown'],
  ])('on: refused when %s (no workspace is created)', async (_n, region, dr, why) => {
    const r = await run({ enforce: true, evaluate: allow(true) }, region, dr);
    expect(r.o).toMatchObject({ status: 'refused' });
    expect(r.o.stderr).toContain(`placement_refused:${why}`);
    expect(r.created).toBe(0);
    expect(r.events).toContain(`placement_refused:${why}`);
  });
  it('on: refused when the policy says no, and when the check itself fails (fail closed)', async () => {
    expect(
      (
        await run(
          { enforce: true, evaluate: allow(false, 'cross_region_denied') },
          'eu-west',
          'sa-central',
        )
      ).o.stderr,
    ).toContain('placement_refused:residency_cross_region_denied');
    const boom = await run(
      {
        enforce: true,
        evaluate: async () => {
          throw new Error('db down');
        },
      },
      'sa-central',
      'sa-central',
    );
    expect(boom.o.stderr).toContain('placement_refused:residency_check_failed');
  });
  it('syntheticOnly (a platform configuration, not a run property) exempts only missing regions, never a policy "no"', async () => {
    expect(
      (
        await run(
          { enforce: true, evaluate: allow(false), syntheticOnly: true },
          undefined,
          undefined,
        )
      ).o.status,
    ).toBe('completed');
    expect(
      (
        await run(
          { enforce: true, evaluate: allow(false), syntheticOnly: true },
          'eu-west',
          'sa-central',
        )
      ).o.status,
    ).toBe('refused');
  });
});
