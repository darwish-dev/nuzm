import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignedXml } from 'xml-crypto';

/**
 * A LOCAL test identity provider for the SAML tests (M12 AC-M12-01). It signs with a throwaway key generated at run time (openssl); nothing here
 * is a credential and nothing is committed. Results obtained with it are `NOT VERIFIED` against any real enterprise IdP (HG-12-02).
 */
export interface TestKey {
  privateKey: string;
  certificate: string;
}

export function makeTestKey(cn = 'test-idp', kind: 'rsa' | 'ec' = 'rsa'): TestKey {
  const dir = mkdtempSync(join(tmpdir(), 'nuzm-saml-'));
  try {
    const key = join(dir, 'k.pem');
    const crt = join(dir, 'c.pem');
    execFileSync(
      'openssl',
      kind === 'rsa'
        ? [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-keyout',
            key,
            '-out',
            crt,
            '-days',
            '30',
            '-subj',
            `/CN=${cn}`,
          ]
        : [
            'req',
            '-x509',
            '-newkey',
            'ec',
            '-pkeyopt',
            'ec_paramgen_curve:P-256',
            '-nodes',
            '-keyout',
            key,
            '-out',
            crt,
            '-days',
            '30',
            '-subj',
            `/CN=${cn}`,
          ],
      { stdio: 'pipe' },
    );
    return { privateKey: readFileSync(key, 'utf8'), certificate: readFileSync(crt, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ResponseOptions {
  idpEntityId: string;
  spEntityId: string;
  acsUrl: string;
  inResponseTo?: string | null;
  nameId?: string;
  email?: string;
  attributes?: Record<string, string[]>;
  now?: Date;
  assertionId?: string;
  responseId?: string;
  notBeforeSkewSeconds?: number;
  assertionValiditySeconds?: number;
  audience?: string | null;
  recipient?: string | null;
  destination?: string | null;
  confirmationNotOnOrAfterSeconds?: number;
  /** What to sign. */
  sign?: 'assertion' | 'response' | 'both' | 'none';
  signatureAlgorithm?: string;
  digestAlgorithm?: string;
  canonicalization?: string;
  statusCode?: string;
  /** Mutations applied to the SIGNED document string (wrapping attacks). */
  tamper?: (signedXml: string) => string;
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
export const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
export const RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
export const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';
export const SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1';
export const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
export const EXC_C14N_COMMENTS = 'http://www.w3.org/2001/10/xml-exc-c14n#WithComments';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

export function unsignedResponse(o: ResponseOptions): string {
  const now = o.now ?? new Date();
  const aid = o.assertionId ?? `_a${Math.random().toString(16).slice(2)}`;
  const rid = o.responseId ?? `_r${Math.random().toString(16).slice(2)}`;
  const notBefore = new Date(now.getTime() - (o.notBeforeSkewSeconds ?? 30) * 1000);
  const notAfter = new Date(now.getTime() + (o.assertionValiditySeconds ?? 300) * 1000);
  const confirmAfter = new Date(now.getTime() + (o.confirmationNotOnOrAfterSeconds ?? 300) * 1000);
  const irt = o.inResponseTo === null ? '' : ` InResponseTo="${o.inResponseTo ?? '_req1'}"`;
  const dest = o.destination === null ? '' : ` Destination="${o.destination ?? o.acsUrl}"`;
  const attrs = { email: [o.email ?? 'alice@acme.example'], ...(o.attributes ?? {}) };
  const attributeXml = Object.entries(attrs)
    .map(
      ([n, v]) =>
        `<saml:Attribute Name="${n}">${v.map((x) => `<saml:AttributeValue>${x}</saml:AttributeValue>`).join('')}</saml:Attribute>`,
    )
    .join('');
  return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${rid}" Version="2.0" IssueInstant="${iso(now)}"${dest}${irt}><saml:Issuer>${o.idpEntityId}</saml:Issuer><samlp:Status><samlp:StatusCode Value="${o.statusCode ?? 'urn:oasis:names:tc:SAML:2.0:status:Success'}"/></samlp:Status><saml:Assertion ID="${aid}" Version="2.0" IssueInstant="${iso(now)}"><saml:Issuer>${o.idpEntityId}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${o.nameId ?? o.email ?? 'alice@acme.example'}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(confirmAfter)}" Recipient="${o.recipient === null ? '' : (o.recipient ?? o.acsUrl)}"${irt}/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${iso(notBefore)}" NotOnOrAfter="${iso(notAfter)}"><saml:AudienceRestriction><saml:Audience>${o.audience === null ? '' : (o.audience ?? o.spEntityId)}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement>${attributeXml}</saml:AttributeStatement></saml:Assertion></samlp:Response>`;
}

function signElement(
  xml: string,
  key: TestKey,
  target: 'assertion' | 'response',
  o: ResponseOptions,
): string {
  const local = target === 'assertion' ? 'Assertion' : 'Response';
  const sx = new SignedXml({
    privateKey: key.privateKey,
    signatureAlgorithm: o.signatureAlgorithm ?? RSA_SHA256,
    canonicalizationAlgorithm: o.canonicalization ?? EXC_C14N,
    getKeyInfoContent: () => null,
  });
  sx.addReference({
    xpath: `//*[local-name(.)='${local}']`,
    transforms: [ENVELOPED, o.canonicalization ?? EXC_C14N],
    digestAlgorithm: o.digestAlgorithm ?? SHA256,
  });
  const issuerPath =
    target === 'assertion'
      ? "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']"
      : "/*[local-name(.)='Response']/*[local-name(.)='Issuer']";
  sx.computeSignature(xml, { location: { reference: issuerPath, action: 'after' } });
  return sx.getSignedXml();
}

/** A complete base64 `SAMLResponse` as a browser would POST it. */
export function samlResponse(key: TestKey, o: ResponseOptions): string {
  let xml = unsignedResponse(o);
  const mode = o.sign ?? 'assertion';
  if (mode === 'assertion' || mode === 'both') xml = signElement(xml, key, 'assertion', o);
  if (mode === 'response' || mode === 'both') xml = signElement(xml, key, 'response', o);
  if (o.tamper) xml = o.tamper(xml);
  return Buffer.from(xml, 'utf8').toString('base64');
}
