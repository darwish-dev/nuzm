import { verifySignature } from './signing';
import { documentHash } from './hash-chain';
import { stripStamp } from './ubl';
import {
  EInvoiceAuthError,
  EInvoiceTimeout,
  EInvoiceUnavailable,
  type Credential,
  type DecisionResult,
  type EInvoiceAdapter,
  type IssuedCsid,
  type SubmitDoc,
} from './adapter';

/**
 * SIMULATED e-invoicing server (`zatca-sim`). It implements OUR adapter contract, not ZATCA's: nothing in it is documented ZATCA behaviour
 * (no official documents were supplied, HG-03-03), so every outcome is `NOT VERIFIED vs ZATCA`.
 * What it does, deterministically:
 *  - issues credentials for a CSR + a six-digit OTP; compliance credentials may only run compliance checks, production credentials may only submit;
 *  - checks that a submitted document's stamp is internally consistent (the hash of the body equals the declared hash, the signature verifies
 *    with the embedded public key); a document that fails is rejected with a code;
 *  - decides each document uuid ONCE and answers a repeated submission with the same decision, counting it (`duplicateSubmissions`), so tests can
 *    prove the platform does not resubmit what is already decided;
 *  - scenarios for the NEXT submission(s): accept, accept with warnings, reject, unavailable (nothing happened), timeout (decided, answer lost).
 */
export type SimScenario = 'accept' | 'warn' | 'reject' | 'unavailable' | 'timeout';

export class SimulatedZatca implements EInvoiceAdapter {
  readonly provider = 'zatca-sim';
  readonly environment: 'sandbox' | 'simulation';
  private seq = 0;
  private readonly credentials = new Map<
    string,
    { secret: string; kind: 'compliance' | 'production' }
  >();
  private readonly decided = new Map<string, DecisionResult>();
  private readonly scenarios: SimScenario[] = [];
  /** Submissions of a uuid that was already decided (must stay 0 when the platform reconciles before retrying). */
  duplicateSubmissions = 0;
  submissions = 0;
  lookups = 0;

  constructor(environment: 'sandbox' | 'simulation' = 'sandbox') {
    this.environment = environment;
  }

  queue(...s: SimScenario[]): void {
    this.scenarios.push(...s);
  }

  private issue(kind: 'compliance' | 'production'): IssuedCsid {
    const n = ++this.seq;
    const token = `sim_${kind}_tok_${String(n).padStart(6, '0')}`;
    const secret = `sim_${kind}_sec_${String(n).padStart(6, '0')}`;
    this.credentials.set(token, { secret, kind });
    return {
      token,
      secret,
      serial: `SIM-${kind.toUpperCase()}-${n}`,
      expiresAt: new Date(Date.now() + 365 * 86_400_000),
    };
  }
  private auth(c: Credential, kind: 'compliance' | 'production') {
    const known = this.credentials.get(c.token);
    if (!known || known.secret !== c.secret) throw new EInvoiceAuthError('unknown credential');
    if (known.kind !== kind)
      throw new EInvoiceAuthError(`a ${known.kind} credential cannot be used here`);
  }

  async requestComplianceCsid(i: { csrPem: string; otp: string }): Promise<IssuedCsid> {
    if (!/^\d{6}$/.test(i.otp))
      throw new EInvoiceAuthError('the one-time password is not accepted');
    if (
      !/-----BEGIN CERTIFICATE REQUEST-----[\s\S]{100,}-----END CERTIFICATE REQUEST-----/.test(
        i.csrPem,
      )
    )
      throw new EInvoiceAuthError('the CSR is not accepted');
    return this.issue('compliance');
  }
  async requestProductionCsid(c: Credential): Promise<IssuedCsid> {
    this.auth(c, 'compliance');
    return this.issue('production');
  }

  /** Internal consistency of a stamped document: the declared hash is the hash of the body and the signature verifies with the embedded key. */
  private verify(d: SubmitDoc) {
    const errors: { code: string; message: string }[] = [];
    const body = stripStamp(d.xml);
    if (body === d.xml)
      errors.push({ code: 'SIM-NOSTAMP', message: 'the document carries no stamp' });
    if (documentHash(body) !== d.hash)
      errors.push({
        code: 'SIM-HASH',
        message: 'the hash of the document does not match the declared hash',
      });
    const sig = /<cac:ExternalReference><cbc:URI>([^<]+)<\/cbc:URI>/.exec(d.xml)?.[1];
    const pub = /<cac:SignatoryParty><cac:PartyIdentification><cbc:ID>([^<]+)<\/cbc:ID>/.exec(
      d.xml,
    )?.[1];
    try {
      if (
        !sig ||
        !pub ||
        !verifySignature(
          Buffer.from(pub, 'base64'),
          Buffer.from(d.hash, 'base64'),
          Buffer.from(sig, 'base64'),
        )
      )
        errors.push({ code: 'SIM-SIG', message: 'the signature does not verify' });
    } catch {
      errors.push({ code: 'SIM-SIG', message: 'the signature cannot be read' });
    }
    return errors;
  }
  private decide(d: SubmitDoc, scenario: SimScenario | undefined): DecisionResult {
    const errors = this.verify(d);
    const requestRef = `sim-req-${String(++this.seq).padStart(6, '0')}`;
    if (scenario === 'reject')
      errors.push({ code: 'SIM-REJ', message: 'rejected by the simulated server (scenario)' });
    if (errors.length) return { status: 'rejected', warnings: [], errors, requestRef };
    const warnings =
      scenario === 'warn'
        ? [{ code: 'SIM-WARN', message: 'accepted with a warning (scenario)' }]
        : [];
    if (d.subtype === 'standard') {
      const clearedXml = d.xml.replace(
        /<\/(Invoice|CreditNote|DebitNote)>$/,
        '<cbc:Note>SIMULATED-CLEARANCE</cbc:Note></$1>',
      );
      return { status: 'cleared', clearedXml, warnings, errors: [], requestRef };
    }
    return { status: 'reported', warnings, errors: [], requestRef };
  }

  async complianceCheck(c: Credential, d: SubmitDoc): Promise<DecisionResult> {
    this.auth(c, 'compliance');
    return this.decide(d, undefined);
  }

  async submit(c: Credential, d: SubmitDoc): Promise<DecisionResult> {
    this.auth(c, 'production');
    this.submissions++;
    const prior = this.decided.get(d.uuid);
    if (prior) {
      this.duplicateSubmissions++;
      return prior;
    }
    const scenario = this.scenarios.shift();
    if (scenario === 'unavailable') throw new EInvoiceUnavailable();
    const result = this.decide(d, scenario);
    this.decided.set(d.uuid, result);
    if (scenario === 'timeout') throw new EInvoiceTimeout(); // decided, but the answer is lost
    return result;
  }

  async lookup(c: Credential, uuid: string): Promise<DecisionResult | null> {
    this.auth(c, 'production');
    this.lookups++;
    return this.decided.get(uuid) ?? null;
  }
}
