import type { ProducedFile } from '../artifacts';
import type { RuntimeSpec } from '../runtime-spec';
import type {
  RuntimeIdentity,
  WaitResult,
  WorkspaceRuntime,
  WorkspaceSpec,
} from '../real-runtime/workspace-runtime';
import {
  NODE_LIMITS,
  NODE_PROTOCOL_VERSION,
  type NodeOp,
  type NodeRequestMap,
  type NodeResponse,
  type NodeResponseMap,
} from './protocol';
import { signRequestToken, type TokenSigner } from './token';

/**
 * P3-S02: the NODE CLIENT. `RemoteWorkspaceRuntime` implements `WorkspaceRuntime` over the node protocol, so `RealRuntimeService` (the real `ExecutionPort`) drives a real node agent
 * through exactly the interface it drives the simulated node through. It holds NO policy of its own: it signs a token per call, sends the body, and turns an error answer into
 * `Error(code)`. What may run is decided by the gateway before this client is reached and decided again by the agent after.
 *
 * ISOLATION IS NEVER READ FROM THE NODE. The `isolation` of this object is set by whoever constructs it: `'verified'` is accepted only over an authenticated https/mTLS transport
 * (the deployment factory additionally requires a live attestation for the service to start), and a loopback transport is forced to `'simulated'` so an in-process agent can never
 * be mistaken for a real node.
 */
export interface NodeHttpRequest {
  /** the client always sends POST; a server hands the REAL method to the handler, which answers anything else with 404 */
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
}
export interface NodeHttpResponse {
  status: number;
  body: Buffer;
}
export interface NodeTransport {
  /** `https-mtls`: an authenticated network transport. `loopback`: in-process or 127.0.0.1 plain http, for tests and the simulated node. */
  readonly kind: 'https-mtls' | 'loopback';
  send(req: NodeHttpRequest, timeoutMs: number): Promise<NodeHttpResponse>;
}
/** the agent side of a loopback: the same function the HTTPS server calls */
export type NodeRequestHandler = (req: NodeHttpRequest) => Promise<NodeHttpResponse>;
export class LoopbackTransport implements NodeTransport {
  readonly kind = 'loopback' as const;
  constructor(private readonly handler: NodeRequestHandler) {}
  async send(req: NodeHttpRequest): Promise<NodeHttpResponse> {
    return this.handler({ ...req, body: Buffer.from(req.body) });
  }
}

export interface RemoteWorkspaceRuntimeOptions {
  /** the node id this client talks to: it is the token audience, so a different node refuses every call */
  nodeId: string;
  transport: NodeTransport;
  signer: TokenSigner;
  runtimeClass: string;
  isolation: 'simulated' | 'verified';
  now?: () => number;
  /** per-call timeout (ms) */
  callTimeoutMs?: number;
  /** longest a `wait` may take in total before the client gives up (the service's own wall/kill timers fire long before) */
  waitDeadlineMs?: number;
  tokenTtlSeconds?: number;
}
export class RemoteWorkspaceRuntime implements WorkspaceRuntime {
  readonly isolation: 'simulated' | 'verified';
  readonly runtimeClass: string;
  /** how this client reaches its node (`loopback` can never be a real node) */
  readonly transportKind: NodeTransport['kind'];
  private readonly workspaceOrg = new Map<string, string>();
  private readonly runs = new Map<string, { orgId: string; workspaceId: string; gone: boolean }>();
  private readonly now: () => number;

  constructor(private readonly o: RemoteWorkspaceRuntimeOptions) {
    if (o.transport.kind === 'loopback' && o.isolation === 'verified')
      throw new Error('loopback_transport_cannot_be_verified');
    this.isolation = o.isolation;
    this.transportKind = o.transport.kind;
    this.runtimeClass = o.runtimeClass;
    this.now = o.now ?? (() => Date.now());
  }

  private async call<O extends NodeOp>(
    op: O,
    req: NodeRequestMap[O],
    bind: { orgId?: string; workspaceId?: string; handle?: string } = {},
    timeoutMs = this.o.callTimeoutMs ?? 30_000,
  ): Promise<NodeResponseMap[O]> {
    const body = Buffer.from(JSON.stringify(req), 'utf8');
    if (body.length > NODE_LIMITS.maxBodyBytes) throw new Error('too_large');
    const token = await signRequestToken(this.o.signer, {
      nodeId: this.o.nodeId,
      op,
      body,
      now: this.now(),
      ttlSeconds: this.o.tokenTtlSeconds,
      ...bind,
    });
    let res: NodeHttpResponse;
    try {
      res = await this.o.transport.send(
        {
          method: 'POST',
          path: `/v1/${op}`,
          headers: {
            'content-type': 'application/json',
            authorization: `NuzmNode ${token}`,
            'x-nuzm-protocol': String(NODE_PROTOCOL_VERSION),
          },
          body,
        },
        timeoutMs,
      );
    } catch {
      throw new Error('node_unreachable');
    }
    let parsed: NodeResponse<O>;
    try {
      parsed = JSON.parse(res.body.toString('utf8')) as NodeResponse<O>;
    } catch {
      throw new Error('node_bad_response');
    }
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.ok !== 'boolean')
      throw new Error('node_bad_response');
    if (!parsed.ok) {
      const code = typeof parsed.error?.code === 'string' ? parsed.error.code.slice(0, 60) : 'internal';
      const detail = typeof parsed.error?.detail === 'string' ? parsed.error.detail.slice(0, 300) : '';
      throw new Error(detail ? `${code}:${detail}` : code);
    }
    return parsed.result;
  }

  async identity(): Promise<RuntimeIdentity> {
    const r = await this.call('identity', {});
    if (r.protocol !== NODE_PROTOCOL_VERSION) throw new Error('node_protocol_mismatch');
    return {
      nodeId: r.nodeId,
      endpointId: r.endpointId,
      runtimeClass: r.runtimeClass,
      imageDigests: [...r.imageDigests],
    };
  }
  async health() {
    const t0 = this.now();
    const r = await this.call('health', {}, {}, 10_000);
    return { ...r, latencyMs: Math.max(0, this.now() - t0) };
  }
  async createWorkspace(w: WorkspaceSpec): Promise<void> {
    await this.call('createWorkspace', w, { orgId: w.orgId, workspaceId: w.workspaceId });
    this.workspaceOrg.set(w.workspaceId, w.orgId);
  }
  async putFiles(workspaceId: string, files: ReadonlyMap<string, string>): Promise<void> {
    await this.call(
      'putFiles',
      { workspaceId, files: [...files] },
      { orgId: this.workspaceOrg.get(workspaceId), workspaceId },
      120_000,
    );
  }
  async start(spec: RuntimeSpec): Promise<{ handle: string }> {
    const r = await this.call('start', { spec }, { orgId: spec.orgId, workspaceId: spec.workspaceId });
    this.runs.set(r.handle, { orgId: spec.orgId, workspaceId: spec.workspaceId, gone: false });
    return { handle: r.handle };
  }
  async wait(handle: string): Promise<WaitResult> {
    const run = this.runOf(handle);
    const deadline = this.now() + (this.o.waitDeadlineMs ?? 2 * 60 * 60 * 1000);
    for (;;) {
      if (run.gone) throw new Error('unknown_handle');
      const r = await this.call(
        'wait',
        { handle, maxWaitMs: NODE_LIMITS.maxWaitSliceMs },
        { orgId: run.orgId, handle },
        NODE_LIMITS.maxWaitSliceMs + 15_000,
      );
      if (r.done) return r.result;
      if (this.now() > deadline) throw new Error('wait_deadline');
    }
  }
  async stats(handle: string) {
    const run = this.runOf(handle);
    return this.call('stats', { handle }, { orgId: run.orgId, handle });
  }
  async kill(handle: string, how: 'soft' | 'hard'): Promise<void> {
    const run = this.runs.get(handle);
    if (!run) return; // like the simulated node: killing an unknown run is a no-op
    await this.call('kill', { handle, how }, { orgId: run.orgId, handle });
  }
  async destroy(handle: string): Promise<void> {
    const run = this.runs.get(handle);
    if (!run) return;
    run.gone = true;
    try {
      await this.call('destroy', { handle }, { orgId: run.orgId, handle });
    } finally {
      this.runs.delete(handle);
    }
  }
  async listProduced(workspaceId: string): Promise<ProducedFile[]> {
    const r = await this.call(
      'listProduced',
      { workspaceId },
      { orgId: this.workspaceOrg.get(workspaceId), workspaceId },
    );
    return r.files;
  }
  async readProduced(workspaceId: string, path: string, maxBytes: number): Promise<string> {
    const r = await this.call(
      'readProduced',
      { workspaceId, path, maxBytes },
      { orgId: this.workspaceOrg.get(workspaceId), workspaceId },
      60_000,
    );
    return r.content;
  }
  async destroyWorkspace(workspaceId: string): Promise<void> {
    await this.call(
      'destroyWorkspace',
      { workspaceId },
      { orgId: this.workspaceOrg.get(workspaceId), workspaceId },
      120_000,
    );
    this.workspaceOrg.delete(workspaceId);
  }
  async listWorkspaces() {
    const r = await this.call('listWorkspaces', {});
    for (const w of r.workspaces) this.workspaceOrg.set(w.workspaceId, w.orgId);
    return r.workspaces;
  }
  /** operator path: ask the node to kill everything it runs and destroy every workspace (kill switch, incident) */
  async emergencyStop() {
    return this.call('emergencyStop', {}, {}, 120_000);
  }
  async reap() {
    return this.call('reap', {}, {}, 120_000);
  }
  private runOf(handle: string) {
    const r = this.runs.get(handle);
    if (!r) throw new Error('unknown_handle');
    return r;
  }
}
