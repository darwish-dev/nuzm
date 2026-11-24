import { describe, expect, it } from 'vitest';
import {
  verifyAttestation,
  canonicalJson,
  type AttestationExpectation,
  type IsolationAttestation,
} from './attestation';
import { createSimulatedKit } from './simulated-attestation';

const NOW = new Date('2026-11-24T12:00:00.000Z');
const NODE = { nodeId: 'node-a', endpointId: 'ep-a' };
const kit = createSimulatedKit();
const expectFor = (o: Partial<AttestationExpectation> = {}): AttestationExpectation => ({
  ...NODE,
  mode: 'simulated',
  environments: ['staging'],
  minSuiteVersion: '1.1.0',
  minIsolatingAttempts: 21,
  maxValidityDays: 90,
  now: NOW,
  ...o,
});
const good = () => kit.attestation(NODE, { now: NOW });
const reasons = (raw: unknown, e = expectFor()) => {
  const v = verifyAttestation(raw, e, kit.trusted);
  return v.ok ? [] : v.reasons;
};

describe('isolation attestation (S-AG6 phase 2, offline)', () => {
  it('a well-formed SIMULATED attestation verifies in simulated mode only', () => {
    expect(reasons(good())).toEqual([]);
    expect(reasons(good(), expectFor({ mode: 'live' }))).toContain('evidence_not_live_verified');
  });
  it('is fail-closed for absent and malformed input', () => {
    expect(reasons(null)).toEqual(['attestation_missing']);
    expect(reasons(undefined)).toEqual(['attestation_missing']);
    expect(reasons('x')).toEqual(['attestation_malformed']);
    expect(reasons([])).toEqual(['attestation_malformed']);
    expect(reasons({})).toContain('attestation_malformed');
    expect(reasons({ ...good(), node: null })).toContain('attestation_malformed');
  });
  const breaks: [string, (a: Omit<IsolationAttestation, 'signature'>) => void, string][] = [
    ['plain container class', (a) => (a.runtime.class = 'runc'), 'runtime_class_not_isolating'],
    ['unpinned image', (a) => (a.runtime.imageDigests = ['node:22']), 'image_digest_not_pinned'],
    ['no image', (a) => (a.runtime.imageDigests = []), 'image_digests_missing'],
    ['no cgroups v2', (a) => (a.host.cgroupsV2 = false), 'cgroups_v2_missing'],
    ['shared node', (a) => (a.host.dedicatedNode = false), 'node_not_dedicated'],
    ['swap on', (a) => (a.host.swapDisabled = false), 'swap_enabled'],
    [
      'runtime socket exposed',
      (a) => (a.host.containerRuntimeSocketNotExposed = false),
      'runtime_socket_exposed',
    ],
    [
      'metadata reachable',
      (a) => (a.host.metadataServiceBlocked = false),
      'metadata_service_reachable',
    ],
    [
      'old suite',
      (a) => (a.evidence.escapeSuite.version = '1.0.0'),
      'escape_suite_version_too_old',
    ],
    ['one escape', (a) => (a.evidence.escapeSuite.escaped = 1), 'escape_suite_escaped'],
    [
      'not verified remains',
      (a) => (a.evidence.escapeSuite.notVerified = 2),
      'escape_suite_not_verified_remaining',
    ],
    [
      'too few attempts',
      (a) => (a.evidence.escapeSuite.isolatingAttempts = 5),
      'escape_suite_incomplete',
    ],
    [
      'blocked != attempts',
      (a) => (a.evidence.escapeSuite.blocked = 20),
      'escape_suite_not_all_blocked',
    ],
    [
      'report not hashed',
      (a) => (a.evidence.escapeSuite.reportSha256 = 'abc'),
      'escape_suite_report_unhashed',
    ],
    [
      'no review ref',
      (a) => (a.evidence.securityReview.ref = 'ticket-1'),
      'security_review_missing',
    ],
    ['no D-21 ref', (a) => (a.evidence.decisionRefs.d21 = ''), 'd21_reference_missing'],
    ['expired', (a) => (a.expiresAt = '2026-11-01T00:00:00.000Z'), 'attestation_expired'],
    ['future issue', (a) => (a.issuedAt = '2027-01-01T00:00:00.000Z'), 'issued_in_the_future'],
    ['validity too long', (a) => (a.expiresAt = '2030-01-01T00:00:00.000Z'), 'validity_too_long'],
    ['production node', (a) => (a.node.environment = 'production'), 'environment_not_allowed'],
    ['other node', (a) => (a.node.nodeId = 'node-b'), 'node_mismatch'],
    ['other endpoint', (a) => (a.node.endpointId = 'ep-z'), 'endpoint_mismatch'],
    ['not linux', (a) => ((a.node as { os: string }).os = 'darwin'), 'os_not_linux'],
    [
      'egress open',
      (a) => ((a.host as { egress: string }).egress = 'open'),
      'egress_not_default_deny',
    ],
  ];
  for (const [name, mutate, code] of breaks)
    it(`refuses: ${name} -> ${code}`, () => {
      expect(reasons(kit.attestation(NODE, { now: NOW, mutate }))).toContain(code);
    });
  it('a microVM class needs a virtualization statement', () => {
    const a = kit.attestation(NODE, {
      now: NOW,
      mutate: (x) => {
        x.runtime.class = 'kata-qemu';
        x.host.virtualization = 'n/a';
      },
    });
    expect(reasons(a)).toContain('virtualization_missing');
    const b = kit.attestation(NODE, {
      now: NOW,
      mutate: (x) => {
        x.runtime.class = 'firecracker-microvm';
        x.host.virtualization = 'bare-metal';
      },
    });
    expect(reasons(b)).toEqual([]);
  });
  it('an extra member added after signing changes the signed bytes and is refused', () => {
    expect(reasons({ ...good(), kernel: 'x' })).toContain('signature_invalid');
  });
  it('rejects a modified signed field, a missing signature and a foreign signer', () => {
    const a = good();
    const tampered = { ...a, node: { ...a.node, kernel: '6.1.0' } };
    expect(reasons(tampered)).toContain('signature_invalid');
    expect(reasons({ ...a, signature: '' })).toContain('signature_missing');
    expect(reasons({ ...a, signer: { keyId: 'unknown' } })).toContain('signer_not_trusted');
    const other = createSimulatedKit();
    const v = verifyAttestation(other.attestation(NODE, { now: NOW }), expectFor(), kit.trusted);
    expect(v.ok).toBe(false);
    expect(v.ok ? [] : v.reasons).toContain('signature_invalid');
  });
  it('honours revocation and never matches prototype keys as signers', () => {
    expect(reasons(good(), expectFor({ isRevoked: (id) => id === 'att-sim-node-a' }))).toContain(
      'attestation_revoked',
    );
    expect(reasons({ ...good(), signer: { keyId: 'constructor' } })).toContain(
      'signer_not_trusted',
    );
    expect(reasons({ ...good(), signer: { keyId: '__proto__' } })).toContain('signer_not_trusted');
  });
  it('canonical JSON is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [2, { y: 2, z: 1 }] }, b: 1 }),
    );
  });
  it('reasons never contain attestation content', () => {
    const a = kit.attestation(NODE, {
      now: NOW,
      mutate: (x) => (x.node.kernel = 'SECRET-KERNEL-STRING'),
    });
    const bad = { ...a, runtime: { ...a.runtime, class: 'runc' } };
    expect(JSON.stringify(reasons(bad))).not.toContain('SECRET-KERNEL');
  });
});
