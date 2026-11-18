import { X509Certificate } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';

/** SAML metadata import (IdP) and export (SP). No secrets are ever read or written here: metadata is public. */
const NS_MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const NS_DSIG = 'http://www.w3.org/2000/09/xmldsig#';

export interface IdpMetadata {
  entityId: string;
  ssoUrl: string;
  ssoBinding: 'redirect' | 'post';
  certificates: string[];
  wantAuthnRequestsSigned: boolean;
}

export class MetadataError extends Error {
  constructor(message: string) {
    super(message);
  }
}

const kids = (e: Element, ns: string, name: string): Element[] =>
  Array.from(e.childNodes).filter(
    (n): n is Element => n.nodeType === 1 && (n as Element).namespaceURI === ns && (n as Element).localName === name,
  );

const pem = (b64: string) =>
  `-----BEGIN CERTIFICATE-----\n${b64.replace(/\s+/g, '').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;

export function parseIdpMetadata(xml: string, now = new Date()): IdpMetadata {
  if (xml.length > 512 * 1024) throw new MetadataError('metadata is too large');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new MetadataError('DTDs are not accepted in metadata');
  const problems: string[] = [];
  let doc: Document;
  try {
    doc = new DOMParser({ onError: (_l, m) => problems.push(m) }).parseFromString(xml, 'text/xml') as unknown as Document;
  } catch {
    throw new MetadataError('metadata is not well-formed XML');
  }
  if (problems.length || !doc.documentElement) throw new MetadataError('metadata is not well-formed XML');
  let root = doc.documentElement;
  if (root.namespaceURI === NS_MD && root.localName === 'EntitiesDescriptor') {
    const all = kids(root, NS_MD, 'EntityDescriptor');
    if (all.length !== 1) throw new MetadataError('a metadata aggregate must contain exactly one EntityDescriptor');
    root = all[0]!;
  }
  if (root.namespaceURI !== NS_MD || root.localName !== 'EntityDescriptor')
    throw new MetadataError('the root element is not md:EntityDescriptor');
  const entityId = root.getAttribute('entityID');
  if (!entityId) throw new MetadataError('entityID is missing');
  const idp = kids(root, NS_MD, 'IDPSSODescriptor')[0];
  if (!idp) throw new MetadataError('the metadata has no IDPSSODescriptor');

  const services = kids(idp, NS_MD, 'SingleSignOnService');
  const pick =
    services.find((s) => s.getAttribute('Binding') === 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect') ??
    services.find((s) => s.getAttribute('Binding') === 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST');
  const ssoUrl = pick?.getAttribute('Location');
  if (!pick || !ssoUrl) throw new MetadataError('no HTTP-Redirect or HTTP-POST SingleSignOnService');
  let u: URL;
  try {
    u = new URL(ssoUrl);
  } catch {
    throw new MetadataError('the SingleSignOnService location is not a URL');
  }
  if (u.protocol !== 'https:') throw new MetadataError('the SingleSignOnService location must be https');

  const certificates: string[] = [];
  for (const kd of kids(idp, NS_MD, 'KeyDescriptor')) {
    const use = kd.getAttribute('use');
    if (use && use !== 'signing') continue;
    for (const ki of kids(kd, NS_DSIG, 'KeyInfo'))
      for (const x of kids(ki, NS_DSIG, 'X509Data'))
        for (const c of kids(x, NS_DSIG, 'X509Certificate')) {
          let cert: X509Certificate;
          try {
            cert = new X509Certificate(pem(c.textContent ?? ''));
          } catch {
            throw new MetadataError('a signing certificate in the metadata cannot be parsed');
          }
          if (new Date(cert.validTo).getTime() < now.getTime())
            throw new MetadataError('a signing certificate in the metadata has expired');
          certificates.push(pem(c.textContent ?? ''));
        }
  }
  // An IdP with no signing certificate cannot produce anything we can verify: refuse (the "unsigned" case of the API).
  if (certificates.length === 0) throw new MetadataError('the metadata declares no signing certificate: nothing could be verified');
  return {
    entityId,
    ssoUrl,
    ssoBinding: pick.getAttribute('Binding')!.endsWith('Redirect') ? 'redirect' : 'post',
    certificates,
    wantAuthnRequestsSigned: idp.getAttribute('WantAuthnRequestsSigned') === 'true',
  };
}

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Service-provider metadata for a connection. We sign nothing in the request and demand signed assertions. */
export function buildSpMetadata(sp: { entityId: string; acsUrl: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="${NS_MD}" entityID="${esc(sp.entityId)}">
  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${esc(sp.acsUrl)}" index="0" isDefault="true"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>
`;
}
