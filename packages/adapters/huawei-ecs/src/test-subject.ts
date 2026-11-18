import { Redactor } from '@nuzm/adapter-contracts';
import { MemoryVaultClient, SimClock } from '@nuzm/adapter-runtime';
import { createFetchTransport } from '@nuzm/adapter-http';
import type { ConformanceSubject } from '@nuzm/adapter-conformance';
import { HuaweiEcsAdapter, type HuaweiOptions } from './adapter';
import { HuaweiSim, type SimFaultKind, type SimFaultOp } from './sim';

export const REF = 'vault://dev/huawei/sim';

/** Test/demo subject: the adapter against the local documented-shape simulator (fixture evidence; NOT VERIFIED). */
export async function makeSubject(
  extra: Partial<HuaweiOptions> = {},
  tokenMode = false,
): Promise<
  ConformanceSubject & {
    sim: HuaweiSim;
    adapter: HuaweiEcsAdapter;
    redactor: Redactor;
    stop(): Promise<void>;
  }
> {
  const clock = new SimClock();
  const sim = await new HuaweiSim(() => clock.now()).start();
  const redactor = new Redactor();
  const c = sim.credentials;
  const fields: Record<string, string> = tokenMode
    ? { iamUser: c.iamUser, iamPassword: c.iamPassword, domainName: c.domainName }
    : { accessKey: c.accessKey, secretKey: c.secretKey };
  const vault = new MemoryVaultClient({ [REF]: fields }, redactor);
  const adapter = new HuaweiEcsAdapter({
    vault,
    redactor,
    transport: createFetchTransport({
      policy: { adapterId: 'huawei-ecs', hosts: ['127.0.0.1'], allowLoopback: true },
    }),
    now: () => clock.now(),
    endpoint: () => sim.baseUrl,
    network: () => ({ vpcId: 'vpc-sim', subnetId: 'subnet-sim', securityGroupId: 'sg-sim' }),
    capabilityMode: 'documented', // fixture run: the documented operations are exercised against the simulator
    // the kit resizes a RUNNING server, which the docs forbid (stop first): resize has its own spec
    disabledCapabilities: ['compute.action.resize'],
    ...extra,
  });
  const ctx = {
    providerAccountId: 'acct-huawei-sim',
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
      providerRegionId: 'me-east-1',
      planRef: 's6.large.2',
      imageRef: 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb',
      unavailablePlanRef: 's6.2xlarge.2',
    },
    stop: () => sim.stop(),
    controls: {
      billableCount: () => sim.billableCount(),
      billableByToken: (t) => sim.billableByToken(t),
      advance: (ms) => void clock.advance(ms),
      inject: (op, kind, times) => sim.inject(op as SimFaultOp, kind as SimFaultKind, times),
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
