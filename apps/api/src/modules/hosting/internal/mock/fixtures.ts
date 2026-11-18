import { generateSigningKey } from '../agent/envelope';
import { AgentRuntime } from '../agent/agent-runtime';
import { AgentTransport, MockAgentChannel } from '../agent/agent-transport';
import { CloudPanelHostingAdapter } from '../cloudpanel-adapter';
import { MockCloudPanelNode, type MockNodeOptions } from './mock-cloudpanel';
import { MemoryBackupSink, MemoryVault } from './mocks';
import type { SiteLimits } from '../ports';

export const LIMITS: SiteLimits = {
  diskMb: 100,
  inodes: 5000,
  maxProcesses: 20,
  memoryMb: 256,
  bandwidthGbMonth: 10,
};

/** One signing key, one vault, one sink, one channel; `addNode` adds a mock node + its agent. The first node is created for you. */
export function mockStack(
  nodeId = '00000000-0000-7000-8000-0000000000aa',
  over: Partial<MockNodeOptions> = {},
  clock?: () => Date,
) {
  const { signing, publicKey } = generateSigningKey('cp-key-1');
  const vault = new MemoryVault();
  const sink = new MemoryBackupSink();
  const agents = new Map<string, AgentRuntime>();
  const nodes = new Map<string, MockCloudPanelNode>();
  const channel = new MockAgentChannel(agents);
  const transport = new AgentTransport(signing, channel, clock);
  const adapter = new CloudPanelHostingAdapter(transport, { now: clock });
  const addNode = (id: string, o: Partial<MockNodeOptions> = {}) => {
    const node = new MockCloudPanelNode({
      nodeId: id,
      region: 'sa-test-1',
      secrets: vault.get,
      sink,
      ...over,
      ...o,
    });
    const runtime = new AgentRuntime({
      nodeId: id,
      keys: new Map([[signing.keyId, publicKey]]),
      executor: node,
      now: clock,
    });
    agents.set(id, runtime);
    nodes.set(id, node);
    return { node, runtime };
  };
  const first = addNode(nodeId);
  return {
    nodeId,
    signing,
    publicKey,
    vault,
    sink,
    node: first.node,
    runtime: first.runtime,
    agents,
    nodes,
    addNode,
    channel,
    transport,
    adapter,
  };
}
export type MockStack = ReturnType<typeof mockStack>;
