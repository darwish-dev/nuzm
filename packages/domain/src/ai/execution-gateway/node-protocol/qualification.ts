import { ACCEPTABLE_RUNTIME_CLASSES } from '../runtime-spec';
import type { NodeDeclaration } from '../real-runtime/attestation-draft';
import { createSimulatedKit } from '../real-runtime/simulated-attestation';
import { RealRuntimeService } from '../real-runtime/real-runtime';
import type { ConformanceTarget } from '../real-runtime/conformance';
import { connectNode, type NodeEndpointConfig, type SecretResolver } from './connect';
import type { NodeTransport, RemoteWorkspaceRuntime } from './remote-runtime';

/**
 * P3-S02: the QUALIFICATION-TIME connection to a real node. Steps S8 (escape suite) and S10 (conformance with the real files) of the qualification procedure run BEFORE the node
 * has a reviewer-signed attestation, so they cannot use `startRealExecution` (which is fail-closed on exactly that). They use this harness instead, which is deliberately narrow:
 *   - it refuses without an approval reference (`HG-10-02-…` or `D-21-…`) that is ALSO confirmed in the environment (`NUZM_QUALIFICATION_APPROVED=<same ref>`);
 *   - it refuses a node declaration that is not `staging`, a connection that names another node or endpoint than the declaration, an unacceptable runtime class and anything
 *     that is not https with mutual TLS (a loopback transport is allowed only by the offline suites and then every report says SIMULATED);
 *   - it checks the node answers as the declared node, then runs the real-runtime service in `simulated` mode with a THROW-AWAY attestation that exists only to satisfy the
 *     service's own gate for this harness (never stored, never trusted elsewhere); the port reports origin `MOCK`; the resulting report is labelled `NOT VERIFIED`.
 * It can never produce a LIVE-VERIFIED label, an attestation the production gate would accept or isolation evidence.
 */
export class LiveRunRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(`live qualification run refused: ${reasons.join(',')}`);
    this.name = 'LiveRunRefused';
  }
}
export interface LiveRunInput {
  connection: NodeEndpointConfig;
  declaration: NodeDeclaration;
  approvalRef?: string;
  env: Readonly<Record<string, string | undefined>>;
  resolve: SecretResolver;
  now?: () => number;
  /** offline suites only: an in-process transport (the label is then SIMULATED, whatever else is true) */
  transport?: NodeTransport;
}
export function liveRunRefusals(i: LiveRunInput): string[] {
  const r: string[] = [];
  if (!i.approvalRef || !/^(HG-10-02|D-21)/.test(i.approvalRef)) r.push('approval_reference_missing');
  else if (i.env.NUZM_QUALIFICATION_APPROVED !== i.approvalRef) r.push('approval_not_confirmed_in_environment');
  if (i.declaration.node.environment !== 'staging') r.push('node_not_staging');
  if (i.connection.nodeId !== i.declaration.node.nodeId) r.push('connection_node_mismatch');
  if (i.connection.endpointId !== i.declaration.node.endpointId) r.push('connection_endpoint_mismatch');
  if (!(ACCEPTABLE_RUNTIME_CLASSES as readonly string[]).includes(i.declaration.runtime.class)) r.push('runtime_class_not_isolating');
  if (!i.transport && !/^https:\/\//.test(i.connection.baseUrl)) r.push('live_requires_https_mtls');
  return r;
}
export async function connectForQualification(i: LiveRunInput): Promise<{ node: RemoteWorkspaceRuntime; label: 'NOT VERIFIED' | 'SIMULATED'; imageDigests: string[] }> {
  const why = liveRunRefusals(i);
  if (why.length > 0) throw new LiveRunRefused(why);
  const node = connectNode({ ...i.connection, runtimeClass: i.declaration.runtime.class }, i.resolve, { mode: 'simulated', now: i.now, transport: i.transport });
  let ident;
  try {
    ident = await node.identity();
  } catch {
    throw new LiveRunRefused(['node_unreachable']);
  }
  if (ident.nodeId !== i.declaration.node.nodeId || ident.endpointId !== i.declaration.node.endpointId) throw new LiveRunRefused(['node_identity_mismatch']);
  if (ident.runtimeClass !== i.declaration.runtime.class) throw new LiveRunRefused(['node_runtime_class_mismatch']);
  if (!ident.imageDigests.every((d) => i.declaration.runtime.imageDigests.includes(d))) throw new LiveRunRefused(['node_image_not_declared']);
  return { node, label: node.transportKind === 'https-mtls' ? 'NOT VERIFIED' : 'SIMULATED', imageDigests: [...ident.imageDigests] };
}

/** a conformance target over the real node: the SAME fixtures, run with the real files (`fixture.simulate` is ignored by a real node) */
export async function createQualificationTarget(i: LiveRunInput): Promise<ConformanceTarget> {
  const { node, label, imageDigests } = await connectForQualification(i);
  const kit = createSimulatedKit('qualification-harness');
  const now = i.now ?? (() => Date.now());
  const id = { nodeId: i.declaration.node.nodeId, endpointId: i.declaration.node.endpointId };
  return {
    name: `RealRuntimeExecutionPort over the real node ${id.nodeId} (qualification harness, no reviewer attestation yet)`,
    origin: 'MOCK',
    label,
    supports: () => true,
    async portFor(ctx, f) {
      const svc = await RealRuntimeService.start({
        mode: 'simulated',
        nodes: [{ ...id, runtime: node, attestation: kit.attestation(id, { now: new Date(now()), imageDigests }) }],
        trust: kit.trusted,
        environments: ['staging'],
        now,
        artifactSink: { put: async () => undefined },
      });
      return svc.portFor(ctx, { seedFiles: () => new Map(Object.entries(f.files())), canaries: () => [] });
    },
    async leftovers() {
      return (await node.listWorkspaces()).map((w) => w.workspaceId);
    },
  };
}
