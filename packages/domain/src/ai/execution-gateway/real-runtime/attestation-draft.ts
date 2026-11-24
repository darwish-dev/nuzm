import { ATTESTATION_SCHEMA, type IsolationAttestation } from './attestation';

/**
 * S-AG6 PHASE 2 (OFFLINE): the DRAFT attestation a qualification run produces for the human reviewer. The runner fills in what it MEASURED (the escape-suite numbers and the
 * report digest); everything that only a human can state (the HG-10-02 review reference, the reviewer, the decision date, the D-21 reference, the signature, the LIVE-VERIFIED
 * label) is left empty on purpose, so a draft can never verify. The reviewer completes it, and signs it with their own key outside this repository.
 */
export interface NodeDeclaration {
  node: IsolationAttestation['node'];
  runtime: IsolationAttestation['runtime'];
  host: IsolationAttestation['host'];
}
export interface SuiteSummary {
  version: string;
  reportSha256: string;
  isolatingAttempts: number;
  blocked: number;
  escaped: number;
  notVerified: number;
}
export type DraftAttestation = Omit<IsolationAttestation, 'signature' | 'signer'> & {
  signer: { keyId: '' };
};

export function buildDraftAttestation(
  decl: NodeDeclaration,
  suite: SuiteSummary,
  now: Date,
  validityDays = 30,
): DraftAttestation {
  return {
    schema: ATTESTATION_SCHEMA,
    attestationId: `draft-${decl.node.nodeId}-${now.toISOString().slice(0, 10)}`,
    node: decl.node,
    runtime: decl.runtime,
    host: decl.host,
    evidence: {
      label: 'NOT VERIFIED',
      escapeSuite: { ...suite },
      securityReview: { ref: '', reviewer: '', decidedAt: '' },
      decisionRefs: { d21: '' },
    },
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + validityDays * 86_400_000).toISOString(),
    signer: { keyId: '' },
  };
}
