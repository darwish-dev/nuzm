import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import {
  ATTESTATION_SCHEMA,
  attestationSigningBytes,
  type IsolationAttestation,
  type TrustedKeys,
} from './attestation';

/**
 * S-AG6 PHASE 2 (OFFLINE): builds SIMULATED attestations signed with a THROW-AWAY key generated in memory, for the conformance suite, the simulated escape-suite run and the
 * tests. The label is fixed to `SIMULATED`: this helper cannot produce a LIVE-VERIFIED attestation, and a `live`-mode service refuses its output (`evidence_not_live_verified`).
 * The key never leaves the process and is never written anywhere.
 */
export interface SimulatedKit {
  trusted: TrustedKeys;
  keyId: string;
  /** a verifying SIMULATED attestation for the node; `mutate` lets a test break exactly one property before signing */
  attestation(
    node: { nodeId: string; endpointId: string },
    opts?: {
      mutate?: (a: Omit<IsolationAttestation, 'signature'>) => void;
      now?: Date;
      imageDigests?: string[];
    },
  ): IsolationAttestation;
  /** sign any attestation body with the kit's key (tests that tamper after signing just edit the result) */
  sign(body: Omit<IsolationAttestation, 'signature'>): IsolationAttestation;
}
export const SIMULATED_IMAGE_DIGEST = `sha256:${'ab'.repeat(32)}`;

export function createSimulatedKit(keyId = 'sim-key-1'): SimulatedKit {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const trusted: TrustedKeys = {
    [keyId]: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
  const sign = (body: Omit<IsolationAttestation, 'signature'>): IsolationAttestation => ({
    ...body,
    signature: cryptoSign(null, attestationSigningBytes(body), privateKey).toString('base64'),
  });
  return {
    trusted,
    keyId,
    sign,
    attestation(node, opts = {}) {
      const now = opts.now ?? new Date();
      const body: Omit<IsolationAttestation, 'signature'> = {
        schema: ATTESTATION_SCHEMA,
        attestationId: `att-sim-${node.nodeId}`,
        node: {
          nodeId: node.nodeId,
          endpointId: node.endpointId,
          environment: 'staging',
          os: 'linux',
          kernel: '0.0.0-simulated',
          arch: 'x86_64',
        },
        runtime: {
          class: 'gvisor-runsc',
          version: '0.0.0',
          imageDigests: opts.imageDigests ?? [SIMULATED_IMAGE_DIGEST],
        },
        host: {
          cgroupsV2: true,
          dedicatedNode: true,
          virtualization: 'n/a',
          swapDisabled: true,
          containerRuntimeSocketNotExposed: true,
          egress: 'default-deny-proxy-only',
          diskQuota: 'project-quota',
          metadataServiceBlocked: true,
        },
        evidence: {
          label: 'SIMULATED',
          escapeSuite: {
            version: '1.1.0',
            reportSha256: 'cd'.repeat(32),
            isolatingAttempts: 21,
            blocked: 21,
            escaped: 0,
            notVerified: 0,
          },
          securityReview: {
            ref: 'HG-10-02 (simulated)',
            reviewer: 'simulated-reviewer',
            decidedAt: now.toISOString(),
          },
          decisionRefs: { d21: 'D-21 (simulated)' },
        },
        issuedAt: new Date(now.getTime() - 60_000).toISOString(),
        expiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
        signer: { keyId },
      };
      opts.mutate?.(body);
      return sign(body);
    },
  };
}
