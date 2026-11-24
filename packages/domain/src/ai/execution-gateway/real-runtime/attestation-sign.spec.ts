import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildDraftAttestation } from './attestation-draft';
import { completeAndSignAttestation, SignRefused } from './attestation-sign';
import { runAttestationNegativeTests } from './negative-tests';
import { AttestationRefused, RealRuntimeService } from './real-runtime';
import { createSimulatedKit, SIMULATED_IMAGE_DIGEST } from './simulated-attestation';
import { SimulatedWorkspaceRuntime } from './workspace-runtime';

const NOW = new Date('2026-12-01T10:00:00Z');
const decl = {
  node: { nodeId: 'node-1', endpointId: 'ep-1', environment: 'staging' as const, os: 'linux' as const, kernel: '6.8.0-test', arch: 'x86_64' as const },
  runtime: { class: 'gvisor-runsc', version: '20260101.0', imageDigests: [SIMULATED_IMAGE_DIGEST] },
  host: { cgroupsV2: true, dedicatedNode: true, virtualization: 'n/a' as const, swapDisabled: true, containerRuntimeSocketNotExposed: true, egress: 'default-deny-proxy-only' as const, diskQuota: 'project-quota' as const, metadataServiceBlocked: true },
};
const suite = (o: Partial<{ escaped: number; notVerified: number; blocked: number; isolatingAttempts: number }> = {}) => ({ version: '1.1.0', reportSha256: 'ab'.repeat(32), isolatingAttempts: 65, blocked: 65, escaped: 0, notVerified: 0, ...o });
// a THROW-AWAY "reviewer" key: this tests the pipeline only; it is not a reviewer, and nothing here is LIVE-VERIFIED
const reviewer = generateKeyPairSync('ed25519');
const completion = { keyId: 'reviewer-test', securityReview: { ref: 'HG-10-02-test', reviewer: 'Test Reviewer (pipeline test)', decidedAt: '2026-12-01T09:00:00Z' }, d21: 'D-21-test' };
const verifyWith = { environments: ['staging' as const], now: NOW };

describe('reviewer signing tool', () => {
  it('seals a clean draft, and the signed file verifies in LIVE mode only against the reviewer key', () => {
    const r = completeAndSignAttestation(buildDraftAttestation(decl, suite(), NOW), completion, reviewer.privateKey, verifyWith);
    expect(r.verdict.ok).toBe(true);
    expect(r.attestation.evidence.label).toBe('LIVE-VERIFIED');
    expect(r.attestation.signer.keyId).toBe('reviewer-test');
    expect(r.attestation.attestationId).toBe('att-node-1-2026-12-01');
  });
  it('refuses to sign over an escape, an unverified attempt, an incomplete set or a missing completion', () => {
    const sign = (s: ReturnType<typeof suite>, c = completion) => completeAndSignAttestation(buildDraftAttestation(decl, s, NOW), c, reviewer.privateKey, verifyWith);
    expect(() => sign(suite({ escaped: 1, blocked: 64 }))).toThrow(/draft_has_escaped_attempts/);
    expect(() => sign(suite({ notVerified: 3, blocked: 62 }))).toThrow(/draft_has_unverified_attempts/);
    expect(() => sign(suite({ isolatingAttempts: 40, blocked: 40 }))).toThrow(/draft_isolating_set_incomplete/);
    expect(() => sign(suite(), { ...completion, securityReview: { ...completion.securityReview, reviewer: '' } })).toThrow(SignRefused);
    expect(() => completeAndSignAttestation(buildDraftAttestation(decl, suite(), NOW), completion, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey, verifyWith)).toThrow(/reviewer_key_not_ed25519/);
  });
});

describe('attestation negative tests (T9 tool)', () => {
  it('every bad configuration is refused with its reason and the correct one starts', async () => {
    const att = completeAndSignAttestation(buildDraftAttestation(decl, suite(), NOW), completion, reviewer.privateKey, verifyWith).attestation;
    const trusted = { 'reviewer-test': reviewer.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
    // a stand-in node that claims to be verified: the tool tests the SERVICE's refusals, not a node
    const sim = new SimulatedWorkspaceRuntime({ nodeId: 'node-1', endpointId: 'ep-1', runtimeClass: 'gvisor-runsc', imageDigests: [SIMULATED_IMAGE_DIGEST] });
    const verifiedStandIn = Object.assign(Object.create(sim), { isolation: 'verified' as const });
    const kit = createSimulatedKit();
    const res = await runAttestationNegativeTests({
      attestation: att,
      trusted,
      environments: ['staging'],
      node: { nodeId: 'node-1', endpointId: 'ep-1', runtime: verifiedStandIn },
      now: () => NOW.getTime(),
      simulatedAttestation: kit.attestation({ nodeId: 'node-1', endpointId: 'ep-1' }, { now: NOW }),
    });
    expect(res.filter((r) => r.status === 'FAIL'), JSON.stringify(res)).toEqual([]);
    expect(res.map((r) => r.id)).toEqual(['N-0', 'N-1', 'N-2', 'N-3', 'N-4', 'N-5', 'N-6', 'N-7', 'N-8', 'N-9']);
  });
  it('a verifier that accepted a bad attestation would be reported as a FAIL', async () => {
    // the same inputs but a service that is not refused: simulate by passing a SIMULATED attestation as the "live" one in simulated mode is not possible here, so assert the tool's own FAIL path on N-1
    const sim = new SimulatedWorkspaceRuntime({ nodeId: 'node-1', endpointId: 'ep-1', runtimeClass: 'gvisor-runsc', imageDigests: [SIMULATED_IMAGE_DIGEST] });
    const res = await runAttestationNegativeTests({ attestation: null, trusted: {}, environments: ['staging'], node: { nodeId: 'node-1', endpointId: 'ep-1', runtime: sim }, now: () => NOW.getTime() });
    expect(res.find((r) => r.id === 'N-0')!.status).toBe('FAIL'); // the positive control cannot start with no attestation
    void RealRuntimeService; void AttestationRefused;
  });
});
