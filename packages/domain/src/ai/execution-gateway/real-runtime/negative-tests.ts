import type { AttestationExpectation, NodeEnvironment, TrustedKeys } from './attestation';
import { AttestationRefused, RealRuntimeService } from './real-runtime';
import type { WorkspaceRuntime } from './workspace-runtime';

/**
 * Qualification step S14 (T9): the attestation NEGATIVE TESTS, run against the REAL node's attestation after the reviewer signed it. Each case starts a `RealRuntimeService` in
 * live mode with exactly one thing wrong and must be REFUSED with the documented reason; then a positive control (nothing wrong) must start. A verifier that accepts a bad
 * attestation is a defect that must be fixed before any live use. No run is started in any case: only `RealRuntimeService.start` (identity and health) touches the node.
 */
export interface NegativeInput {
  attestation: unknown;
  trusted: TrustedKeys;
  environments: readonly NodeEnvironment[];
  node: { nodeId: string; endpointId: string; runtime: WorkspaceRuntime };
  now: () => number;
  /** a SIMULATED-label attestation for the same node (from the throw-away kit) to prove a live service refuses it */
  simulatedAttestation?: unknown;
}
export interface NegativeResult {
  id: string;
  title: string;
  expected: string;
  status: 'PASS' | 'FAIL';
  note: string;
}
const flip = (a: unknown): unknown => {
  const c = JSON.parse(JSON.stringify(a)) as { node?: { kernel?: string } };
  if (c.node) c.node.kernel = `${c.node.kernel ?? ''}-tampered`;
  return c;
};
export async function runAttestationNegativeTests(i: NegativeInput): Promise<NegativeResult[]> {
  const out: NegativeResult[] = [];
  const base = (
    over: Partial<Parameters<typeof RealRuntimeService.start>[0]> = {},
    node = i.node,
    att: unknown = i.attestation,
  ) =>
    RealRuntimeService.start({
      mode: 'live',
      nodes: [
        {
          nodeId: node.nodeId,
          endpointId: node.endpointId,
          runtime: node.runtime,
          attestation: att,
        },
      ],
      trust: i.trusted,
      environments: i.environments,
      now: i.now,
      ...over,
    });
  const expectRefused = async (
    id: string,
    title: string,
    expected: string,
    start: () => Promise<unknown>,
  ) => {
    try {
      await start();
      out.push({ id, title, expected, status: 'FAIL', note: 'ACCEPTED a bad configuration' });
    } catch (e) {
      const reasons =
        e instanceof AttestationRefused
          ? e.reasons.join(',')
          : `threw:${(e as Error).message.slice(0, 60)}`;
      out.push({
        id,
        title,
        expected,
        status: reasons.includes(expected) ? 'PASS' : 'FAIL',
        note: reasons.slice(0, 200),
      });
    }
  };
  await expectRefused('N-1', 'no attestation', 'attestation_missing', () => base({}, i.node, null));
  await expectRefused('N-2', 'expired (clock 400 days ahead)', 'attestation_expired', () =>
    base({ now: () => i.now() + 400 * 86_400_000 }),
  );
  await expectRefused('N-3', 'wrong node id', 'node_mismatch', () =>
    base({}, { ...i.node, nodeId: 'some-other-node' }),
  );
  await expectRefused('N-4', 'wrong endpoint id', 'endpoint_mismatch', () =>
    base({}, { ...i.node, endpointId: 'some-other-endpoint' }),
  );
  await expectRefused('N-5', 'tampered after signing', 'signature_invalid', () =>
    base({}, i.node, flip(i.attestation)),
  );
  if (i.simulatedAttestation !== undefined)
    await expectRefused(
      'N-6',
      'SIMULATED label in a live service',
      'evidence_not_live_verified',
      () => base({}, i.node, i.simulatedAttestation),
    );
  await expectRefused('N-7', 'no trusted signing key', 'signer_not_trusted', () =>
    base({ trust: {} }),
  );
  await expectRefused('N-8', 'revoked', 'attestation_revoked', () =>
    base({ isRevoked: () => true }),
  );
  const extra: WorkspaceRuntime = Object.create(i.node.runtime, {
    identity: {
      value: async () => ({
        ...(await i.node.runtime.identity()),
        imageDigests: [
          ...(await i.node.runtime.identity()).imageDigests,
          `sha256:${'9'.repeat(64)}`,
        ],
      }),
    },
  });
  await expectRefused(
    'N-9',
    'node reports an image that is not attested',
    'identity_image_not_attested',
    () => base({}, { ...i.node, runtime: extra }),
  );
  try {
    await base();
    out.push({
      id: 'N-0',
      title: 'positive control: the correct configuration starts',
      expected: 'start',
      status: 'PASS',
      note: 'started',
    });
  } catch (e) {
    out.push({
      id: 'N-0',
      title: 'positive control: the correct configuration starts',
      expected: 'start',
      status: 'FAIL',
      note:
        e instanceof AttestationRefused ? e.reasons.join(',') : (e as Error).message.slice(0, 100),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
export type { AttestationExpectation };
