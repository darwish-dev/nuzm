import type { CloudPanelTransport, TransportRequest, TransportResponse } from '../ports';
import { AdapterTimeoutError } from '../m05-contracts';
import type { AgentReply, AgentRuntime } from './agent-runtime';
import { signEnvelope, type Envelope, type SigningKey } from './envelope';

/** The channel to one node's agent. Production = an outbound-mTLS session the agent dials (not built: HG-06-01); tests = MockAgentChannel. */
export interface AgentChannel {
  deliver(nodeId: string, envelope: Envelope, deadlineMs: number): Promise<AgentReply>;
}

/** Control-plane transport: signs a command envelope per request (fresh nonce each time) and maps the reply; a lost channel is `uncertain`. */
export class AgentTransport implements CloudPanelTransport {
  readonly mode = 'node-agent' as const;
  constructor(
    private readonly key: SigningKey,
    private readonly channel: AgentChannel,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async send(req: TransportRequest): Promise<TransportResponse> {
    const env = signEnvelope(this.key, {
      nodeId: req.nodeId,
      operationId: req.operationId,
      idempotencyToken: req.idempotencyToken,
      commandId: req.commandId,
      args: req.args,
      now: this.now(),
    });
    try {
      const r = await this.channel.deliver(req.nodeId, env, req.deadlineMs);
      const raw = `${req.commandId}: ${r.status}${r.reason ? ' (' + r.reason + ')' : ''}`; // never the args: they may carry vault refs / domains
      if (r.status === 'ok') return { status: 'ok', result: r.result, rawSummary: raw };
      if (r.status === 'rejected') return { status: 'rejected', reason: r.reason, rawSummary: raw };
      return { status: r.reason === 'timeout' ? 'uncertain' : 'failed', reason: r.category ?? r.reason, result: r.message, rawSummary: raw };
    } catch (e) {
      if (e instanceof AdapterTimeoutError) return { status: 'uncertain', rawSummary: `${req.commandId}: channel timeout` };
      return { status: 'uncertain', rawSummary: `${req.commandId}: channel error` };
    }
  }
}

/** In-process channel to a mock agent, with fault injection for the reconcile tests. */
export class MockAgentChannel implements AgentChannel {
  /** the next N deliveries execute on the node but their reply is lost (the caller sees a timeout) */
  loseReplies = 0;
  /** the next N deliveries never reach the node */
  dropRequests = 0;
  readonly seen: Envelope[] = [];
  constructor(private readonly agents: Map<string, AgentRuntime>) {}
  async deliver(nodeId: string, envelope: Envelope): Promise<AgentReply> {
    this.seen.push(envelope);
    if (this.dropRequests > 0) {
      this.dropRequests--;
      throw new AdapterTimeoutError('request lost');
    }
    const agent = this.agents.get(nodeId);
    if (!agent) throw new AdapterTimeoutError('no agent connected for this node');
    const reply = await agent.handle(envelope);
    if (this.loseReplies > 0) {
      this.loseReplies--;
      throw new AdapterTimeoutError('reply lost');
    }
    return reply;
  }
}
