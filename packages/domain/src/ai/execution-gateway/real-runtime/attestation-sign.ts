import { createPublicKey, sign as edSign, type KeyObject } from 'node:crypto';
import { ATTESTATION_SCHEMA, attestationSigningBytes, verifyAttestation, type AttestationExpectation, type IsolationAttestation } from './attestation';
import type { DraftAttestation } from './attestation-draft';
import { DEFAULT_MIN_ISOLATING_ATTEMPTS, DEFAULT_MIN_SUITE_VERSION } from './real-runtime';

/**
 * The REVIEWER's tool (qualification step S13): complete a draft attestation with the facts only a human can state and sign it with the reviewer's OWN private key, which is
 * read from outside the repository by the CLI and is never stored by this code. The function refuses to sign a draft the verifier would refuse for a measurable reason (an
 * escape, an unverified attempt, fewer than the full isolating set), so a reviewer cannot sign over a failed run by mistake; it then verifies its own output in LIVE mode against the
 * matching public key and returns the verdict, so the reviewer sees the verifier's reasons before delivering the file.
 * The label LIVE-VERIFIED is the reviewer's assertion; this code does not make a node verified, it only seals a human decision.
 */
export interface ReviewerCompletion {
  keyId: string;
  attestationId?: string;
  securityReview: { ref: string; reviewer: string; decidedAt: string };
  d21: string;
}
export class SignRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(`attestation not signed: ${reasons.join(',')}`);
    this.name = 'SignRefused';
  }
}
export function completeAndSignAttestation(
  draft: DraftAttestation,
  c: ReviewerCompletion,
  privateKey: KeyObject,
  verifyWith: Omit<AttestationExpectation, 'mode' | 'nodeId' | 'endpointId' | 'minSuiteVersion' | 'minIsolatingAttempts' | 'maxValidityDays'> & Partial<Pick<AttestationExpectation, 'minSuiteVersion' | 'minIsolatingAttempts' | 'maxValidityDays'>>,
): { attestation: IsolationAttestation; verdict: ReturnType<typeof verifyAttestation> } {
  const why: string[] = [];
  const s = draft.evidence.escapeSuite;
  if (draft.schema !== ATTESTATION_SCHEMA) why.push('draft_schema_unknown');
  if (s.escaped !== 0) why.push('draft_has_escaped_attempts');
  if (s.notVerified !== 0) why.push('draft_has_unverified_attempts');
  if (s.isolatingAttempts < (verifyWith.minIsolatingAttempts ?? DEFAULT_MIN_ISOLATING_ATTEMPTS)) why.push('draft_isolating_set_incomplete');
  if (s.blocked !== s.isolatingAttempts) why.push('draft_not_all_blocked');
  if (privateKey.asymmetricKeyType !== 'ed25519') why.push('reviewer_key_not_ed25519');
  if (!c.keyId || !c.securityReview.ref || !c.securityReview.reviewer || !c.d21) why.push('reviewer_completion_incomplete');
  if (why.length > 0) throw new SignRefused(why);
  const body: Omit<IsolationAttestation, 'signature'> = {
    ...draft,
    attestationId: c.attestationId ?? draft.attestationId.replace(/^draft-/, 'att-'),
    evidence: { ...draft.evidence, label: 'LIVE-VERIFIED', securityReview: { ...c.securityReview }, decisionRefs: { d21: c.d21 } },
    signer: { keyId: c.keyId },
  };
  const attestation: IsolationAttestation = { ...body, signature: edSign(null, attestationSigningBytes(body), privateKey).toString('base64') };
  const pem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  const verdict = verifyAttestation(
    attestation,
    {
      nodeId: draft.node.nodeId,
      endpointId: draft.node.endpointId,
      mode: 'live',
      minSuiteVersion: DEFAULT_MIN_SUITE_VERSION,
      minIsolatingAttempts: DEFAULT_MIN_ISOLATING_ATTEMPTS,
      maxValidityDays: 90,
      ...verifyWith,
    },
    { [c.keyId]: pem },
  );
  return { attestation, verdict };
}
