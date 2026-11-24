import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executionGateway as eg } from '@nuzm/domain';
import { createAgentRig, type AgentRig } from './testing';
import { createLoopbackHttpServer } from './server';
import type { AddressInfo } from 'node:net';

const realSetTimeout = globalThis.setTimeout;
const pump = async (ms: number) => {
  await new Promise<void>((r) => realSetTimeout(r, 3));
  await vi.advanceTimersByTimeAsync(ms);
};

/** the PRODUCTION wiring (vault references -> signer, startRealExecution, RealRuntimeService) over a real agent, offline */
function productionTarget(): eg.ConformanceTarget & { dispose(): Promise<void> } {
  const kit = eg.createSimulatedKit();
  const rigs: AgentRig[] = [];
  let last: AgentRig | null = null;
  return {
    name: 'startRealExecution (vault refs) over the node agent (simulated launcher, loopback)',
    origin: 'MOCK',
    label: 'SIMULATED',
    pump,
    supports: () => true,
    async portFor(ctx, f) {
      const rig = await createAgentRig({ script: () => f.simulate, monitorMs: 1000 });
      rigs.push(rig);
      last = rig;
      const resolved: string[] = [];
      const svc = await eg.startRealExecution(
        {
          mode: 'simulated',
          environments: ['staging'],
          trustedAttestationKeys: kit.trusted,
          nodes: [
            {
              nodeId: rig.cfg.nodeId,
              endpointId: rig.cfg.endpointId,
              baseUrl: 'http://127.0.0.1:1',
              signer: { keyId: 'cp-test', keyRef: 'vault://exec/cp-signer' },
              tls: {
                caRef: 'vault://exec/ca',
                certRef: 'vault://exec/cert',
                keyRef: 'vault://exec/key',
              },
            },
          ],
        },
        {
          resolve: async (ref) => {
            resolved.push(ref);
            if (ref !== 'vault://exec/cp-signer') throw new Error('unexpected secret');
            return rig.signerPem;
          },
          loadAttestation: async (nodeId) =>
            kit.attestation({ nodeId, endpointId: rig.cfg.endpointId }, { now: new Date() }),
          transportFor: () => new eg.LoopbackTransport(rig.agent.handler),
          artifactSink: { put: async () => undefined },
        },
      );
      return svc.portFor(ctx, {
        seedFiles: () => new Map(Object.entries(f.files())),
        canaries: () => [],
      });
    },
    async leftovers() {
      return last ? (await last.agent.service.listWorkspaces()).map((w) => w.workspaceId) : [];
    },
    async dispose() {
      for (const r of rigs) await r.dispose();
    },
  };
}

describe('production wiring: startRealExecution -> RealRuntimeService -> node client -> agent', () => {
  describe('conformance (fake clock)', () => {
    beforeEach(() => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      vi.setSystemTime(new Date('2026-11-24T12:00:00.000Z'));
    });
    afterEach(() => vi.useRealTimers());
    const target = productionTarget();
    afterAll(() => target.dispose());
    it('passes every port conformance case (SIMULATED)', async () => {
      const r = await eg.runPortConformance(target);
      expect(r.fail, JSON.stringify(r.results.filter((x) => x.status === 'FAIL'))).toBe(0);
      expect(r.skipped).toBe(0);
      expect(r.isolationEvidence).toBe(false);
    }, 120_000);
  });

  it('works over a real socket too (real clock): the service starts on a verifying attestation and runs a typecheck end to end', async () => {
    const kit = eg.createSimulatedKit();
    const rig = await createAgentRig({ script: () => ({ exitCode: 0, stdout: 'clean\n' }) });
    const server = createLoopbackHttpServer({
      handler: rig.agent.handler,
      metrics: rig.agent.metrics,
    });
    const port = await new Promise<number>((r) =>
      server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)),
    );
    try {
      const svc = await eg.startRealExecution(
        {
          mode: 'simulated',
          environments: ['staging'],
          trustedAttestationKeys: kit.trusted,
          nodes: [
            {
              nodeId: rig.cfg.nodeId,
              endpointId: rig.cfg.endpointId,
              baseUrl: `http://127.0.0.1:${port}`,
              signer: { keyId: 'cp-test', keyRef: 'vault://exec/cp-signer' },
              tls: {
                caRef: 'vault://exec/ca',
                certRef: 'vault://exec/cert',
                keyRef: 'vault://exec/key',
              },
            },
          ],
        },
        {
          resolve: async () => rig.signerPem,
          loadAttestation: async (nodeId) =>
            kit.attestation({ nodeId, endpointId: rig.cfg.endpointId }),
          artifactSink: { put: async () => undefined },
        },
      );
      expect(svc.origin).toBe('MOCK');
      expect(svc.status()[0]).toMatchObject({ nodeId: 'sim-node', quarantined: null });
      const ctx = {
        orgId: 'org-x',
        runId: 'run-x',
        enabledProfiles: Object.keys(eg.EXEC_PROFILES),
        projectScripts: [],
      };
      const port_ = svc.portFor(ctx, {
        seedFiles: () => new Map([['package.json', '{}']]),
        canaries: () => [],
      });
      const d = await port_.request({ orgId: 'org-x', runId: 'run-x', profile: 'typecheck' });
      const o = await port_.run(d, { orgId: 'org-x', runId: 'run-x' });
      expect(o).toMatchObject({ status: 'completed', exitCode: 0, stdout: 'clean\n' });
      expect(await rig.agent.service.listWorkspaces()).toEqual([]); // cleaned up
      expect(rig.launcher.launched[0]!.spec.argv).toEqual([
        'npx',
        '--no-install',
        'tsc',
        '--noEmit',
      ]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await rig.dispose();
    }
  });

  it('with the node agent stopped, the service refuses to start: no port, nothing runs', async () => {
    const kit = eg.createSimulatedKit();
    const rig = await createAgentRig();
    await expect(
      eg.startRealExecution(
        {
          mode: 'simulated',
          environments: ['staging'],
          trustedAttestationKeys: kit.trusted,
          nodes: [
            {
              nodeId: 'sim-node',
              endpointId: 'sim-endpoint',
              baseUrl: 'http://127.0.0.1:1',
              signer: { keyId: 'cp-test', keyRef: 'vault://exec/cp-signer' },
              tls: { caRef: 'vault://a/b', certRef: 'vault://a/c', keyRef: 'vault://a/d' },
            },
          ],
        },
        {
          resolve: async () => rig.signerPem,
          loadAttestation: async (nodeId) =>
            kit.attestation({ nodeId, endpointId: 'sim-endpoint' }),
        },
      ),
    ).rejects.toThrow(/node_unreachable/);
    await rig.dispose();
  });
});
