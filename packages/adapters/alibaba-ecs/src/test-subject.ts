import { Redactor } from '@nuzm/adapter-contracts';
import { MemoryVaultClient, SimClock } from '@nuzm/adapter-runtime';
import { createFetchTransport } from '@nuzm/adapter-http';
import type { ConformanceSubject } from '@nuzm/adapter-conformance';
import { AlibabaEcsAdapter, type AlibabaOptions } from './adapter';
import { AlibabaSim, type SimFaultKind, type SimFaultOp } from './sim';

export const REF = 'vault://dev/alibaba/sim';

/** Test/demo subject: the adapter against the local documented-shape simulator (fixture evidence; NOT VERIFIED). */
export async function makeSubject(
  extra: Partial<AlibabaOptions> = {},
  forbidResize = true,
): Promise<
  ConformanceSubject & {
    sim: AlibabaSim;
    adapter: AlibabaEcsAdapter;
    redactor: Redactor;
    stop(): Promise<void>;
  }
> {
  const clock = new SimClock();
  const sim = await new AlibabaSim(() => clock.now()).start();
  // the kit runs resize on a RUNNING instance, which ECS refuses (type change needs Stopped): the simulated RAM user may not resize
  if (forbidResize) sim.forbidden.add('ModifyInstanceSpec');
  const redactor = new Redactor();
  const vault = new MemoryVaultClient({ [REF]: { ...sim.credentials } }, redactor);
  const adapter = new AlibabaEcsAdapter({
    vault,
    redactor,
    transport: createFetchTransport({
      policy: { adapterId: 'alibaba-ecs', hosts: ['127.0.0.1'], allowLoopback: true },
    }),
    now: () => clock.now(),
    endpoint: () => sim.baseUrl,
    bssEndpoint: sim.baseUrl,
    network: () => ({
      vSwitchId: 'vsw-sim0001',
      securityGroupId: 'sg-sim0001',
      zoneId: 'me-central-1a',
    }),
    ...extra,
  });
  const ctx = {
    providerAccountId: 'acct-alibaba-sim',
    credentialRef: REF,
    traceId: 'trace-1',
    deadlineMs: 1000,
  };
  return {
    adapter,
    clock,
    ctx,
    sim,
    redactor,
    evidenceKind: 'fixture',
    fixture: {
      providerRegionId: 'me-central-1',
      planRef: 'ecs.g6.large',
      imageRef: 'aliyun_3_x64_20G_alibase_20240101.vhd',
      unavailablePlanRef: 'ecs.g6.2xlarge',
    },
    stop: () => sim.stop(),
    controls: {
      billableCount: () => sim.billableCount(),
      billableByToken: (t) => sim.billableByToken(t),
      advance: (ms) => void clock.advance(ms),
      inject: (op, kind, times) => sim.inject(op as SimFaultOp, kind as SimFaultKind, times),
      // "the account's probe result changed": the adapter acts on its last probe
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
