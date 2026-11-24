import { AdapterTimeoutError } from '../../m05-contracts';
import type { SimReply, SimRequest, SimRuntime } from './runtime';

/** The request a simulated adapter sends to a simulated node. TEST DOUBLE ONLY. */
export interface SimTransportRequest extends SimRequest {
  nodeId: string;
  deadlineMs: number;
}
export interface SimTransportResponse {
  /** `uncertain` when the channel timed out or dropped after the command was sent. */
  status: 'ok' | 'rejected' | 'failed' | 'uncertain';
  reason?: string;
  result?: unknown;
  rawSummary: string;
}
export interface SimTransport {
  send(req: SimTransportRequest): Promise<SimTransportResponse>;
}

/** In-process channel to a simulated node, with fault injection for the reconcile tests. */
export class SimChannel {
  /** the next N deliveries execute on the node but their reply is lost (the caller sees a timeout) */
  loseReplies = 0;
  /** when set, only deliveries of this command id lose their reply */
  loseOnly: string | null = null;
  /** the next N deliveries never reach the node */
  dropRequests = 0;
  readonly seen: SimRequest[] = [];
  constructor(private readonly nodes: Map<string, SimRuntime>) {}
  async deliver(nodeId: string, req: SimRequest, _deadlineMs?: number): Promise<SimReply> {
    this.seen.push(req);
    if (this.dropRequests > 0) {
      this.dropRequests--;
      throw new AdapterTimeoutError('request lost');
    }
    const node = this.nodes.get(nodeId);
    if (!node) throw new AdapterTimeoutError('no node connected');
    const reply = await node.handle(req);
    if (this.loseReplies > 0 && (!this.loseOnly || this.loseOnly === req.commandId)) {
      this.loseReplies--;
      throw new AdapterTimeoutError('reply lost');
    }
    return reply;
  }
}

/** Maps a node's reply to the adapter's view; a lost channel is `uncertain`. */
export class DirectSimTransport implements SimTransport {
  constructor(private readonly channel: SimChannel) {}
  async send(req: SimTransportRequest): Promise<SimTransportResponse> {
    try {
      const r = await this.channel.deliver(
        req.nodeId,
        { commandId: req.commandId, args: req.args, idempotencyToken: req.idempotencyToken, operationId: req.operationId },
        req.deadlineMs,
      );
      const raw = `${req.commandId}: ${r.status}${r.reason ? ' (' + r.reason + ')' : ''}`; // never the args
      if (r.status === 'ok') return { status: 'ok', result: r.result, rawSummary: raw };
      if (r.status === 'rejected') return { status: 'rejected', reason: r.reason, rawSummary: raw };
      return {
        status: r.reason === 'timeout' ? 'uncertain' : 'failed',
        reason: r.category ?? r.reason,
        result: r.message,
        rawSummary: raw,
      };
    } catch (e) {
      if (e instanceof AdapterTimeoutError) return { status: 'uncertain', rawSummary: `${req.commandId}: channel timeout` };
      return { status: 'uncertain', rawSummary: `${req.commandId}: channel error` };
    }
  }
}
