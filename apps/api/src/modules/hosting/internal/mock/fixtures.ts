import { SimHostingAdapter } from './sim/adapter';
import { SimNode, type MockNodeOptions } from './sim/node';
import { SimRuntime } from './sim/runtime';
import { DirectSimTransport, SimChannel } from './sim/transport';
import { MemoryBackupSink, MemoryVault } from './mocks';
import type { SiteLimits } from '../ports';

export const LIMITS: SiteLimits = {
  diskMb: 100,
  inodes: 5000,
  maxProcesses: 20,
  memoryMb: 256,
  bandwidthGbMonth: 10,
};

/** One vault, one sink, one channel; `addNode` adds a simulated node. The first node is created for you. TEST DOUBLES for the platform's own logic. */
export function mockStack(
  nodeId = '00000000-0000-7000-8000-0000000000aa',
  over: Partial<MockNodeOptions> = {},
  clock?: () => Date,
) {
  const vault = new MemoryVault();
  const sink = new MemoryBackupSink();
  const runtimes = new Map<string, SimRuntime>();
  const nodes = new Map<string, SimNode>();
  const channel = new SimChannel(runtimes);
  const transport = new DirectSimTransport(channel);
  const adapter = new SimHostingAdapter(transport, { now: clock });
  const addNode = (id: string, o: Partial<MockNodeOptions> = {}) => {
    const node = new SimNode({
      nodeId: id,
      region: 'sa-test-1',
      secrets: vault.get,
      sink,
      ...over,
      ...o,
    });
    const runtime = new SimRuntime({ nodeId: id, executor: node, now: clock });
    runtimes.set(id, runtime);
    nodes.set(id, node);
    return { node, runtime };
  };
  const first = addNode(nodeId);
  return {
    nodeId,
    vault,
    sink,
    node: first.node,
    runtime: first.runtime,
    runtimes,
    nodes,
    addNode,
    channel,
    transport,
    adapter,
  };
}
export type MockStack = ReturnType<typeof mockStack>;
