import { createPrivateKey, sign as edSign, type KeyObject } from 'node:crypto';
import type { TrustedKeys } from '../real-runtime/attestation';
import {
  RealRuntimeService,
  type ArtifactSink,
  type RealRuntimeNode,
  type RunAccounting,
  type RuntimeEvent,
} from '../real-runtime/real-runtime';
import type { NodeEnvironment } from '../real-runtime/attestation';
import { HttpsTransport, type TlsCredentials } from './https-transport';
import { RemoteWorkspaceRuntime, type NodeTransport } from './remote-runtime';
import type { TokenSigner } from './token';

/**
 * P3-S02: how the control plane connects to real nodes and obtains THE REAL `ExecutionPort`.
 *
 * Nothing secret is configured here: a node entry carries VAULT REFERENCES (`vault://…`) for the control plane's token-signing key and for its mutual-TLS client credential, and
 * the deployment supplies a resolver (`SecretResolver`, e.g. the platform `SecretStore.get`). An inline PEM, a file path or any non-reference value is refused at construction.
 *
 * `startRealExecution` is the production start-up path and it is FAIL-CLOSED by construction: it returns a `RealRuntimeService` only through `RealRuntimeService.start`, which
 * refuses unless every node holds a verifying, signed, unexpired, node-bound attestation (LIVE-VERIFIED in `live` mode) AND the node answers as the attested node. With no node
 * configured, no attestation, a stale one, or an unreachable node, it throws `AttestationRefused` and there is no service and no port. In `live` mode it additionally refuses any
 * transport that is not https with mutual TLS. The `simulated` mode exists for the offline suites and reports origin `MOCK`.
 */
export type SecretResolver = (ref: string) => Promise<string>;
export class ConnectionRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(`node connection refused: ${reasons.join(',')}`);
    this.name = 'ConnectionRefused';
  }
}
export interface NodeEndpointConfig {
  nodeId: string;
  endpointId: string;
  baseUrl: string;
  runtimeClass?: string;
  /** control-plane token-signing key: its id (as the node's trusted-keys map names it) and the vault reference of the Ed25519 private key (PEM) */
  signer: { keyId: string; keyRef: string };
  /** vault references of the mutual-TLS material: the node's CA and this control plane's client certificate and key */
  tls: { caRef: string; certRef: string; keyRef: string };
  /** optional pin of the node's leaf certificate (sha256 hex) */
  pinnedLeafSha256?: string;
}
const VAULT_REF = /^vault:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,198}$/;
export function isVaultRef(v: unknown): v is string {
  return typeof v === 'string' && VAULT_REF.test(v) && !v.includes('..') && !v.includes('//', 8);
}

/** a signer that fetches its key through the vault resolver and keeps the parsed key only for a short time */
export class VaultTokenSigner implements TokenSigner {
  private cached: { key: KeyObject; until: number } | null = null;
  constructor(
    readonly keyId: string,
    private readonly keyRef: string,
    private readonly resolve: SecretResolver,
    private readonly now: () => number = () => Date.now(),
    private readonly cacheMs = 30_000,
  ) {
    if (!isVaultRef(keyRef)) throw new ConnectionRefused(['secret_reference_invalid']);
  }
  async sign(bytes: Buffer): Promise<Buffer> {
    if (!this.cached || this.cached.until < this.now()) {
      const key = createPrivateKey(await this.resolve(this.keyRef));
      if (key.asymmetricKeyType !== 'ed25519')
        throw new ConnectionRefused(['signer_key_not_ed25519']);
      this.cached = { key, until: this.now() + this.cacheMs };
    }
    return edSign(null, bytes, this.cached.key);
  }
}

export function connectNode(
  cfg: NodeEndpointConfig,
  resolve: SecretResolver,
  opts: {
    mode: 'live' | 'simulated';
    now?: () => number;
    /** offline suites only: an in-process transport instead of the network (refused in live mode) */ transport?: NodeTransport;
  },
): RemoteWorkspaceRuntime {
  const reasons: string[] = [];
  for (const r of [cfg.signer.keyRef, cfg.tls.caRef, cfg.tls.certRef, cfg.tls.keyRef])
    if (!isVaultRef(r)) reasons.push('secret_reference_invalid');
  if (!/^[a-z0-9-]{3,40}$/.test(cfg.nodeId)) reasons.push('node_id_invalid');
  if (reasons.length > 0) throw new ConnectionRefused([...new Set(reasons)]);
  let cache: { c: TlsCredentials; until: number } | null = null;
  const now = opts.now ?? (() => Date.now());
  const credentials = async (): Promise<TlsCredentials> => {
    if (cache && cache.until > now()) return cache.c;
    const [ca, cert, key] = await Promise.all([
      resolve(cfg.tls.caRef),
      resolve(cfg.tls.certRef),
      resolve(cfg.tls.keyRef),
    ]);
    cache = { c: { ca, cert, key }, until: now() + 30_000 };
    return cache.c;
  };
  if (opts.transport && opts.mode === 'live')
    throw new ConnectionRefused(['live_requires_https_mtls']);
  const transport =
    opts.transport ??
    new HttpsTransport({
      baseUrl: cfg.baseUrl,
      credentials,
      pinnedLeafSha256: cfg.pinnedLeafSha256,
    });
  // a live service accepts only an authenticated network transport; the offline suites may use loopback (which can never claim "verified")
  if (opts.mode === 'live' && transport.kind !== 'https-mtls')
    throw new ConnectionRefused(['live_requires_https_mtls']);
  return new RemoteWorkspaceRuntime({
    nodeId: cfg.nodeId,
    transport,
    signer: new VaultTokenSigner(cfg.signer.keyId, cfg.signer.keyRef, resolve, now),
    runtimeClass: cfg.runtimeClass ?? 'gvisor-runsc',
    isolation: opts.mode === 'live' ? 'verified' : 'simulated',
    now,
  });
}

export interface RealExecutionConfig {
  mode: 'live' | 'simulated';
  environments: readonly NodeEnvironment[];
  nodes: readonly NodeEndpointConfig[];
  /** public keys that may sign attestations (the reviewers'); changing them is change-controlled */
  trustedAttestationKeys: TrustedKeys;
}
export interface RealExecutionDeps {
  resolve: SecretResolver;
  /** the stored signed attestation JSON for a node, or null */
  loadAttestation: (nodeId: string) => Promise<unknown | null>;
  now?: () => number;
  /** offline suites only (simulated mode): an in-process transport per node */
  transportFor?: (nodeId: string) => NodeTransport | undefined;
  isRevoked?: (attestationId: string) => boolean;
  artifactSink?: ArtifactSink;
  onEvent?: (e: RuntimeEvent) => void;
  onUsage?: (a: RunAccounting) => void;
}
export async function startRealExecution(
  cfg: RealExecutionConfig,
  deps: RealExecutionDeps,
): Promise<RealRuntimeService> {
  const now = deps.now ?? (() => Date.now());
  const nodes: RealRuntimeNode[] = [];
  for (const n of cfg.nodes) {
    const runtime = connectNode(n, deps.resolve, {
      mode: cfg.mode,
      now,
      transport: deps.transportFor?.(n.nodeId),
    });
    nodes.push({
      nodeId: n.nodeId,
      endpointId: n.endpointId,
      runtime,
      attestation: await deps.loadAttestation(n.nodeId),
    });
  }
  // `RealRuntimeService.start` is the only door: no node, no attestation, a bad one, or a node that does not answer as attested => AttestationRefused
  return RealRuntimeService.start({
    mode: cfg.mode,
    nodes,
    trust: cfg.trustedAttestationKeys,
    environments: cfg.environments,
    now,
    isRevoked: deps.isRevoked,
    artifactSink: deps.artifactSink,
    onEvent: deps.onEvent,
    onUsage: deps.onUsage,
  });
}
