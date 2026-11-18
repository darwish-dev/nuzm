import { Redactor } from '@nuzm/adapter-contracts';
import { MemoryVaultClient, SimClock } from '@nuzm/adapter-runtime';
import { createFetchTransport } from '@nuzm/adapter-http';
import type { ConformanceSubject } from '@nuzm/adapter-conformance';
import { ContaboVpsAdapter } from './adapter';
import { ContaboSim, type SimFaultKind, type SimFaultOp } from './sim';

/** Test/demo subject: the adapter against the local documented-shape simulator (fixture evidence). */
export const REF = 'vault://dev/contabo/sim';

export async function makeSubject(): Promise<
  ConformanceSubject & { sim: ContaboSim; stop(): Promise<void> }
> {
  const clock = new SimClock();
  const sim = await new ContaboSim(() => clock.now()).start();
  const redactor = new Redactor();
  const vault = new MemoryVaultClient(
    {
      [REF]: {
        clientId: 'sim-client',
        clientSecret: 'sim-client-secret-value',
        apiUser: 'sim-user@example.invalid',
        apiPassword: 'sim-api-credential-value',
      },
    },
    redactor,
  );
  const adapter = new ContaboVpsAdapter({
    vault,
    redactor,
    transport: createFetchTransport({
      policy: { adapterId: 'contabo-vps', hosts: ['127.0.0.1'], allowLoopback: true },
    }),
    now: () => clock.now(),
    apiBase: sim.baseUrl,
    tokenUrl: sim.tokenUrl,
    capabilityMode: 'documented', // fixture run: documented operations are exercised against the simulator
  });
  const ctx = {
    providerAccountId: 'acct-contabo-sim',
    credentialRef: REF,
    traceId: 'trace-1',
    deadlineMs: 3000,
  };
  return {
    adapter,
    clock,
    ctx,
    evidenceKind: 'fixture',
    fixture: {
      providerRegionId: 'EU',
      planRef: 'V153',
      imageRef: 'afecbb85-e2fc-46f0-9684-b46b1faf00bb',
    },
    sim,
    stop: () => sim.stop(),
    controls: {
      billableCount: () => sim.billableCount(),
      billableByToken: (t) => sim.billableByToken(t),
      advance: (ms) => void clock.advance(ms),
      inject: (op, kind, times) => sim.inject(op as SimFaultOp, kind as SimFaultKind, times),
      // simulates "the account's probe result changed": the adapter acts on its last probe
      setCapabilities: (p) => {
        const cur = adapter.probeCache.get(ctx.providerAccountId) ?? {};
        adapter.probeCache.set(ctx.providerAccountId, {
          capabilities: { ...cur, ...p } as never,
          evidence: [],
          probedAt: clock.iso(),
        });
      },
      setConsistencyLag: (ms) => sim.setConsistencyLag(ms),
    },
  };
}
