import { createHash, X509Certificate } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';

/**
 * SAML 2.0 Web-Browser-SSO response validator (SP side, POST binding). M12 S55.
 *
 * Design rules (each one has a negative test in saml.spec.ts):
 *  - XML is parsed with DTDs refused outright (no entity expansion, no XXE) and any parser warning is fatal.
 *  - The signature is verified against the connection's PINNED IdP certificates only; a certificate carried in KeyInfo is never trusted.
 *  - Algorithm allow-list: RSA-SHA256/384/512 (ECDSA is not supported by the XML-DSig library and is refused); digests SHA-256/384/512; exclusive or inclusive C14N WITHOUT comments;
 *    transforms limited to enveloped-signature + C14N. SHA-1, `none`, HMAC and "with comments" are refused.
 *  - Signature-wrapping defence: exactly one Assertion, a direct child of the Response; every Signature element must sit directly under the Response
 *    or that Assertion; ID attributes must be unique in the document; exactly one Reference per signature and it must point at the parent's ID;
 *    and, most importantly, every claim is read from the XML that xml-crypto returns as SIGNED (canonicalised), never from the original document.
 *  - Conditions: NotBefore / NotOnOrAfter with at most 120 s of clock skew, AudienceRestriction must name this SP, Issuer must be the pinned IdP,
 *    SubjectConfirmation must be bearer with Recipient = our ACS URL, a live NotOnOrAfter and InResponseTo = the request we made (SP-initiated).
 *    An unsolicited (IdP-initiated) response is accepted only when the caller explicitly allows it.
 *  - Replay: the assertion id is claimed in a store shared by all instances; a second use is refused.
 *  - Encrypted assertions are not supported and are refused (never silently ignored).
 */
export type SamlErrorCode =
  | 'malformed'
  | 'doctype_refused'
  | 'too_large'
  | 'status_not_success'
  | 'unsigned'
  | 'bad_signature'
  | 'algorithm_refused'
  | 'wrapped'
  | 'encrypted_unsupported'
  | 'issuer_mismatch'
  | 'audience_mismatch'
  | 'recipient_mismatch'
  | 'destination_mismatch'
  | 'expired'
  | 'not_yet_valid'
  | 'in_response_to_mismatch'
  | 'unsolicited_refused'
  | 'replayed'
  | 'subject_missing'
  | 'confirmation_invalid';

export class SamlError extends Error {
  constructor(
    readonly code: SamlErrorCode,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export interface ReplayStore {
  /** Atomically claim an assertion id until `expiresAt`. Returns false when it was already claimed. */
  claim(assertionHash: string, expiresAt: Date): Promise<boolean>;
}

export interface SamlValidationInput {
  /** The base64 `SAMLResponse` form field. */
  samlResponse: string;
  idp: { entityId: string; certificates: string[] };
  sp: { entityId: string; acsUrl: string };
  /** The id of the AuthnRequest this browser flow started with (SP-initiated). Undefined = unsolicited response. */
  expectedRequestId?: string;
  allowUnsolicited?: boolean;
  now?: Date;
  /** Maximum clock skew in seconds; never above 120. */
  skewSeconds?: number;
  replay: ReplayStore;
}

export interface SamlIdentity {
  nameId: string;
  nameIdFormat: string | null;
  email: string | null;
  displayName: string | null;
  groups: string[];
  attributes: Record<string, string[]>;
  assertionId: string;
  sessionIndex: string | null;
  issuedBy: string;
  notOnOrAfter: Date;
}

const NS_PROTOCOL = 'urn:oasis:names:tc:SAML:2.0:protocol';
const NS_ASSERTION = 'urn:oasis:names:tc:SAML:2.0:assertion';
const NS_DSIG = 'http://www.w3.org/2000/09/xmldsig#';
const MAX_BYTES = 256 * 1024;
export const MAX_SKEW_SECONDS = 120;

export const ALLOWED_SIGNATURE_ALGORITHMS: ReadonlySet<string> = new Set([
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha384',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512',
]);
export const ALLOWED_DIGEST_ALGORITHMS: ReadonlySet<string> = new Set([
  'http://www.w3.org/2001/04/xmlenc#sha256',
  'http://www.w3.org/2001/04/xmldsig-more#sha384',
  'http://www.w3.org/2001/04/xmlenc#sha512',
]);
const ALLOWED_C14N: ReadonlySet<string> = new Set([
  'http://www.w3.org/2001/10/xml-exc-c14n#',
  'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
]);
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

type El = Element;
const kids = (e: El, ns: string, name: string): El[] =>
  Array.from(e.childNodes).filter(
    (n): n is El =>
      n.nodeType === 1 && (n as El).namespaceURI === ns && (n as El).localName === name,
  );
const first = (e: El, ns: string, name: string): El | undefined => kids(e, ns, name)[0];
const attr = (e: El, n: string): string | null => (e.hasAttribute(n) ? e.getAttribute(n) : null);
const text = (e: El | undefined): string => (e?.textContent ?? '').trim();

function parse(xml: string): Document {
  const problems: string[] = [];
  let doc: Document;
  try {
    doc = new DOMParser({
      onError: (level, msg) => problems.push(`${level}: ${msg}`),
    }).parseFromString(xml, 'text/xml') as unknown as Document;
  } catch (e) {
    throw new SamlError('malformed', (e as Error).message.slice(0, 200));
  }
  if (problems.length || !doc.documentElement) throw new SamlError('malformed', problems[0]);
  return doc;
}

const pemOf = (cert: string): string => {
  const c = cert.trim();
  if (c.includes('BEGIN CERTIFICATE')) return c;
  const body = c.replace(/\s+/g, '');
  return `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
};

/** SHA-256 hex of the assertion id: the replay cache never stores the assertion itself. */
export const assertionHash = (id: string): string =>
  createHash('sha256').update(`saml-assertion:${id}`).digest('hex');

function checkSignatureElement(sig: El, parent: El): void {
  const si = first(sig, NS_DSIG, 'SignedInfo');
  if (!si) throw new SamlError('malformed', 'SignedInfo missing');
  const c14n = attr(first(si, NS_DSIG, 'CanonicalizationMethod')!, 'Algorithm');
  const method = attr(first(si, NS_DSIG, 'SignatureMethod')!, 'Algorithm');
  if (!c14n || !ALLOWED_C14N.has(c14n))
    throw new SamlError('algorithm_refused', `canonicalization ${c14n}`);
  if (!method || !ALLOWED_SIGNATURE_ALGORITHMS.has(method))
    throw new SamlError('algorithm_refused', `signature algorithm ${method}`);
  const refs = kids(si, NS_DSIG, 'Reference');
  if (refs.length !== 1)
    throw new SamlError('wrapped', 'a signature must have exactly one Reference');
  const ref = refs[0]!;
  const id = attr(parent, 'ID');
  if (!id || attr(ref, 'URI') !== `#${id}`)
    throw new SamlError(
      'wrapped',
      'the Reference does not point at the element that carries the signature',
    );
  const digest = attr(first(ref, NS_DSIG, 'DigestMethod')!, 'Algorithm');
  if (!digest || !ALLOWED_DIGEST_ALGORITHMS.has(digest))
    throw new SamlError('algorithm_refused', `digest algorithm ${digest}`);
  const transforms = first(ref, NS_DSIG, 'Transforms');
  for (const t of transforms ? kids(transforms, NS_DSIG, 'Transform') : []) {
    const a = attr(t, 'Algorithm');
    if (a !== ENVELOPED && !(a && ALLOWED_C14N.has(a)))
      throw new SamlError('algorithm_refused', `transform ${a}`);
  }
}

/** Verify `sig` with each pinned certificate; returns the canonical XML of the signed element. */
function verify(xml: string, sig: El, certs: string[]): string {
  for (const cert of certs) {
    let publicKey: string;
    try {
      publicKey = new X509Certificate(pemOf(cert)).publicKey.export({
        type: 'spki',
        format: 'pem',
      }) as string;
    } catch {
      continue;
    }
    try {
      const sx = new SignedXml({ publicCert: publicKey, getCertFromKeyInfo: () => null });
      sx.loadSignature(sig as unknown as Node);
      if (!sx.checkSignature(xml)) continue;
      const signed = sx.getSignedReferences();
      if (signed.length !== 1)
        throw new SamlError('wrapped', 'exactly one signed reference is expected');
      return signed[0]!;
    } catch (e) {
      if (e instanceof SamlError) throw e;
    }
  }
  throw new SamlError(
    'bad_signature',
    'the signature does not verify with any pinned IdP certificate',
  );
}

export async function validateSamlResponse(input: SamlValidationInput): Promise<SamlIdentity> {
  const now = input.now ?? new Date();
  const skew =
    Math.min(Math.max(input.skewSeconds ?? MAX_SKEW_SECONDS, 0), MAX_SKEW_SECONDS) * 1000;

  const raw = Buffer.from(input.samlResponse.replace(/\s+/g, ''), 'base64');
  if (raw.length === 0) throw new SamlError('malformed', 'empty response');
  if (raw.length > MAX_BYTES) throw new SamlError('too_large');
  const xml = raw.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new SamlError('doctype_refused');

  const doc = parse(xml);
  const response = doc.documentElement;
  if (response.namespaceURI !== NS_PROTOCOL || response.localName !== 'Response')
    throw new SamlError('malformed', 'the root element is not samlp:Response');

  // Unique IDs: duplicate ID attributes are the classic wrapping primitive.
  const ids = new Set<string>();
  for (const e of Array.from(doc.getElementsByTagName('*'))) {
    const id = e.getAttribute('ID');
    if (id !== null) {
      if (ids.has(id)) throw new SamlError('wrapped', 'duplicate ID attribute');
      ids.add(id);
    }
  }

  if (doc.getElementsByTagNameNS(NS_ASSERTION, 'EncryptedAssertion').length)
    throw new SamlError('encrypted_unsupported');
  const assertions = Array.from(doc.getElementsByTagNameNS(NS_ASSERTION, 'Assertion'));
  const direct = kids(response, NS_ASSERTION, 'Assertion');
  if (assertions.length !== 1 || direct.length !== 1)
    throw new SamlError(
      'wrapped',
      'exactly one Assertion, directly under the Response, is required',
    );
  const assertion = direct[0]!;

  const status = first(first(response, NS_PROTOCOL, 'Status')!, NS_PROTOCOL, 'StatusCode');
  if (!status || attr(status, 'Value') !== 'urn:oasis:names:tc:SAML:2.0:status:Success')
    throw new SamlError('status_not_success');

  // Every Signature must be a direct child of the Response or of THE Assertion.
  const signatures = Array.from(doc.getElementsByTagNameNS(NS_DSIG, 'Signature'));
  if (signatures.length === 0) throw new SamlError('unsigned');
  for (const s of signatures) {
    const p = s.parentNode as El | null;
    if (p !== response && p !== assertion)
      throw new SamlError('wrapped', 'signature in an unexpected place');
  }
  const responseSig = kids(response, NS_DSIG, 'Signature');
  const assertionSig = kids(assertion, NS_DSIG, 'Signature');
  if (responseSig.length > 1 || assertionSig.length > 1)
    throw new SamlError('wrapped', 'multiple signatures');

  // The identity is read ONLY from XML that was actually covered by a verified signature.
  let signedAssertion: El | undefined;
  let signedResponseAttrs: { destination: string | null; inResponseTo: string | null } | undefined;
  if (assertionSig[0]) {
    checkSignatureElement(assertionSig[0], assertion);
    const canon = verify(xml, assertionSig[0], input.idp.certificates);
    signedAssertion = parse(canon).documentElement;
  }
  if (responseSig[0]) {
    checkSignatureElement(responseSig[0], response);
    const canon = verify(xml, responseSig[0], input.idp.certificates);
    const signedResponse = parse(canon).documentElement;
    signedResponseAttrs = {
      destination: attr(signedResponse, 'Destination'),
      inResponseTo: attr(signedResponse, 'InResponseTo'),
    };
    if (!signedAssertion) {
      const a = kids(signedResponse, NS_ASSERTION, 'Assertion');
      if (a.length !== 1)
        throw new SamlError(
          'wrapped',
          'the signed Response does not contain exactly one Assertion',
        );
      signedAssertion = a[0];
    }
  }
  if (!signedAssertion) throw new SamlError('unsigned');
  if (signedAssertion.localName !== 'Assertion' || signedAssertion.namespaceURI !== NS_ASSERTION)
    throw new SamlError('wrapped', 'the signed element is not the Assertion');
  const a = signedAssertion;

  // Response-level checks that are only meaningful when the Response itself was signed; otherwise the Assertion's own signed fields decide.
  const destination = signedResponseAttrs
    ? signedResponseAttrs.destination
    : attr(response, 'Destination');
  if (destination !== null && destination !== input.sp.acsUrl)
    throw new SamlError('destination_mismatch');

  const issuer = text(first(a, NS_ASSERTION, 'Issuer'));
  if (issuer !== input.idp.entityId) throw new SamlError('issuer_mismatch', `unexpected issuer`);
  const respIssuer = first(response, NS_ASSERTION, 'Issuer');
  if (respIssuer && signedResponseAttrs && text(respIssuer) !== input.idp.entityId)
    throw new SamlError('issuer_mismatch');

  const assertionId = attr(a, 'ID');
  if (!assertionId) throw new SamlError('malformed', 'Assertion ID missing');

  const subject = first(a, NS_ASSERTION, 'Subject');
  const nameIdEl = subject ? first(subject, NS_ASSERTION, 'NameID') : undefined;
  const nameId = text(nameIdEl);
  if (!subject || !nameId) throw new SamlError('subject_missing');

  // Bearer confirmation: recipient, lifetime and the request it answers.
  const confirmations = kids(subject, NS_ASSERTION, 'SubjectConfirmation').filter(
    (c) => attr(c, 'Method') === 'urn:oasis:names:tc:SAML:2.0:cm:bearer',
  );
  if (confirmations.length === 0)
    throw new SamlError('confirmation_invalid', 'no bearer confirmation');
  let confirmedUntil: Date | undefined;
  let recipientOk = false;
  let irtOk = false;
  let sawRecipient = false;
  for (const c of confirmations) {
    const d = first(c, NS_ASSERTION, 'SubjectConfirmationData');
    if (!d) continue;
    const recipient = attr(d, 'Recipient');
    sawRecipient = sawRecipient || recipient !== null;
    if (recipient !== input.sp.acsUrl) continue;
    recipientOk = true;
    const until = attr(d, 'NotOnOrAfter');
    if (!until) continue;
    const u = new Date(until);
    if (Number.isNaN(u.getTime())) throw new SamlError('malformed', 'bad NotOnOrAfter');
    if (u.getTime() + skew <= now.getTime()) throw new SamlError('expired');
    confirmedUntil = u;
    const irt = attr(d, 'InResponseTo') ?? signedResponseAttrs?.inResponseTo ?? null;
    if (input.expectedRequestId !== undefined) {
      if (irt === input.expectedRequestId) irtOk = true;
    } else if (irt === null) irtOk = true;
  }
  if (!recipientOk)
    throw new SamlError(
      'recipient_mismatch',
      sawRecipient ? 'recipient differs' : 'recipient missing',
    );
  if (!confirmedUntil) throw new SamlError('confirmation_invalid', 'NotOnOrAfter missing');
  if (input.expectedRequestId !== undefined) {
    if (!irtOk) throw new SamlError('in_response_to_mismatch');
  } else {
    if (!input.allowUnsolicited) throw new SamlError('unsolicited_refused');
    if (!irtOk)
      throw new SamlError(
        'in_response_to_mismatch',
        'an unsolicited response must not answer a request',
      );
  }

  const conditions = first(a, NS_ASSERTION, 'Conditions');
  if (!conditions) throw new SamlError('confirmation_invalid', 'Conditions missing');
  const nb = attr(conditions, 'NotBefore');
  const na = attr(conditions, 'NotOnOrAfter');
  if (!na) throw new SamlError('confirmation_invalid', 'Conditions/NotOnOrAfter missing');
  if (nb && new Date(nb).getTime() - skew > now.getTime()) throw new SamlError('not_yet_valid');
  if (new Date(na).getTime() + skew <= now.getTime()) throw new SamlError('expired');
  const restrictions = kids(conditions, NS_ASSERTION, 'AudienceRestriction');
  if (restrictions.length === 0)
    throw new SamlError('audience_mismatch', 'no audience restriction');
  for (const r of restrictions)
    if (!kids(r, NS_ASSERTION, 'Audience').some((x) => text(x) === input.sp.entityId))
      throw new SamlError('audience_mismatch');

  const authn = first(a, NS_ASSERTION, 'AuthnStatement');
  if (!authn) throw new SamlError('confirmation_invalid', 'AuthnStatement missing');
  const sessionNotOnOrAfter = attr(authn, 'SessionNotOnOrAfter');
  if (sessionNotOnOrAfter && new Date(sessionNotOnOrAfter).getTime() + skew <= now.getTime())
    throw new SamlError('expired');

  const attributes: Record<string, string[]> = {};
  for (const st of kids(a, NS_ASSERTION, 'AttributeStatement'))
    for (const at of kids(st, NS_ASSERTION, 'Attribute')) {
      const name = attr(at, 'Name');
      if (name)
        (attributes[name] ??= []).push(...kids(at, NS_ASSERTION, 'AttributeValue').map(text));
    }
  const pick = (...names: string[]) => names.map((n) => attributes[n]?.[0]).find((v) => v);
  const format = attr(nameIdEl!, 'Format');
  const email =
    pick(
      'email',
      'mail',
      'emailAddress',
      'urn:oid:0.9.2342.19200300.100.1.3',
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    ) ?? (format === 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' ? nameId : null);

  // Replay: only a fully valid assertion consumes its id.
  const keepUntil = new Date(Math.min(new Date(na).getTime(), confirmedUntil.getTime()) + skew);
  if (!(await input.replay.claim(assertionHash(assertionId), keepUntil)))
    throw new SamlError('replayed');

  return {
    nameId,
    nameIdFormat: format,
    email: email ? email.trim().toLowerCase() : null,
    displayName:
      pick('displayName', 'name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name') ??
      null,
    groups: attributes['groups'] ?? attributes['memberOf'] ?? [],
    attributes,
    assertionId,
    sessionIndex: attr(authn, 'SessionIndex'),
    issuedBy: issuer,
    notOnOrAfter: confirmedUntil,
  };
}
