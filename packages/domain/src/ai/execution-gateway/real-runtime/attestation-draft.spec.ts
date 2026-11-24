import { describe, expect, it } from 'vitest';
import { verifyAttestation, type AttestationExpectation } from './attestation';
import { buildDraftAttestation } from './attestation-draft';
import { createSimulatedKit } from './simulated-attestation';

const NOW = new Date('2026-11-24T12:00:00.000Z');
const kit = createSimulatedKit();
const base = kit.attestation({ nodeId: 'n', endpointId: 'e' }, { now: NOW });
const decl = { node: base.node, runtime: base.runtime, host: base.host };
const suite = {
  version: '1.1.0',
  reportSha256: 'ef'.repeat(32),
  isolatingAttempts: 21,
  blocked: 21,
  escaped: 0,
  notVerified: 0,
};
const expectation: AttestationExpectation = {
  nodeId: 'n',
  endpointId: 'e',
  mode: 'simulated',
  environments: ['staging'],
  minSuiteVersion: '1.1.0',
  minIsolatingAttempts: 21,
  maxValidityDays: 90,
  now: NOW,
};

describe('draft attestation for the reviewer', () => {
  it('carries the measured suite numbers and never verifies', () => {
    const d = buildDraftAttestation(decl, suite, NOW);
    expect(d.evidence.escapeSuite).toEqual(suite);
    expect(d.evidence.label).toBe('NOT VERIFIED');
    const v = verifyAttestation({ ...d, signature: '' }, expectation, kit.trusted);
    expect(v.ok).toBe(false);
    const why = v.ok ? [] : v.reasons;
    expect(why).toEqual(
      expect.arrayContaining([
        'security_review_missing',
        'reviewer_missing',
        'd21_reference_missing',
        'signer_not_trusted',
      ]),
    );
  });
  it('once a human completes and signs it, it verifies (simulated kit here; a live one needs the reviewer key)', () => {
    const d = buildDraftAttestation(decl, suite, NOW);
    const done = kit.sign({
      ...d,
      evidence: {
        ...d.evidence,
        label: 'SIMULATED',
        securityReview: { ref: 'HG-10-02 (sim)', reviewer: 'r', decidedAt: NOW.toISOString() },
        decisionRefs: { d21: 'D-21 (sim)' },
      },
      signer: { keyId: kit.keyId },
    } as never);
    expect(verifyAttestation(done, expectation, kit.trusted).ok).toBe(true);
  });
  it('a draft with escapes or unexecuted attempts is refused even when signed', () => {
    const d = buildDraftAttestation(decl, { ...suite, escaped: 1, blocked: 20 }, NOW);
    const done = kit.sign({
      ...d,
      evidence: {
        ...d.evidence,
        label: 'SIMULATED',
        securityReview: { ref: 'HG-10-02', reviewer: 'r', decidedAt: NOW.toISOString() },
        decisionRefs: { d21: 'D-21' },
      },
      signer: { keyId: kit.keyId },
    } as never);
    const v = verifyAttestation(done, expectation, kit.trusted);
    expect(v.ok ? [] : v.reasons).toContain('escape_suite_escaped');
  });
});
