import type { DocType, Subtype } from './profile';

/**
 * The e-invoicing adapter boundary (ADR-014, D-11): `zatca-native` and a possible `zatca-vendor` both implement it. The only implementation
 * in this repository is the SIMULATED server (`simulated-adapter.ts`): a stand-in with OUR contract, not ZATCA's. No adapter in this repository
 * talks to a ZATCA environment (HG-03-03), and every result is NOT VERIFIED vs ZATCA.
 */
export interface Msg {
  code: string;
  message: string;
}
/** Resolved credentials (secret values come from the vault at call time and are never stored, logged or returned). */
export interface Credential {
  token: string;
  secret: string;
}
export interface IssuedCsid {
  token: string;
  secret: string;
  serial: string;
  expiresAt: Date;
}
export interface SubmitDoc {
  uuid: string;
  hash: string;
  type: DocType;
  subtype: Subtype;
  /** The stamped (final) XML. */
  xml: string;
}
export type Decision = 'cleared' | 'reported' | 'rejected';
export interface DecisionResult {
  status: Decision;
  /** Standard invoices only: the XML returned by clearance, to be stored and delivered. */
  clearedXml?: string;
  warnings: Msg[];
  errors: Msg[];
  requestRef: string;
}

/** The request did not happen (service unavailable, connection refused): nothing to reconcile, retry later. */
export class EInvoiceUnavailable extends Error {
  constructor(message = 'the e-invoicing service is unavailable') {
    super(message);
    this.name = 'EInvoiceUnavailable';
  }
}
/** The request may or may not have reached the service: the outcome is UNKNOWN; look the document up before any retry. */
export class EInvoiceTimeout extends Error {
  constructor(message = 'the e-invoicing service did not answer in time') {
    super(message);
    this.name = 'EInvoiceTimeout';
  }
}
/** A step the caller can fix (bad OTP, bad credentials): never retried automatically. */
export class EInvoiceAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EInvoiceAuthError';
  }
}

export interface EInvoiceAdapter {
  readonly provider: string;
  readonly environment: 'sandbox' | 'simulation';
  /** Compliance credential for a CSR, authorised by a one-time password a human obtained from the portal (HG-03-03). */
  requestComplianceCsid(i: { csrPem: string; otp: string }): Promise<IssuedCsid>;
  /** Mandatory compliance check of a sample document with the compliance credential. */
  complianceCheck(c: Credential, d: SubmitDoc): Promise<DecisionResult>;
  /** Production credential, requested with the compliance credential after the checks passed. */
  requestProductionCsid(c: Credential): Promise<IssuedCsid>;
  /** Standard invoice: clearance; simplified: reporting. Idempotent on the document uuid at the service. */
  submit(c: Credential, d: SubmitDoc): Promise<DecisionResult>;
  /** What the service knows about a document uuid (null = nothing): the reconcile-before-retry probe. */
  lookup(c: Credential, uuid: string): Promise<DecisionResult | null>;
}
