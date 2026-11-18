import { describe, expect, it } from 'vitest';
import { SamlError, validateSamlResponse, type ReplayStore } from './saml-validator';
import { buildSpMetadata, parseIdpMetadata, MetadataError } from './saml-metadata';
import {
  EXC_C14N_COMMENTS,
  RSA_SHA1,
  SHA1,
  makeTestKey,
  samlResponse,
  type ResponseOptions,
} from '../testing/saml-test-idp';

const IDP = 'https://idp.acme.example/saml';
const SP = 'https://api.nuzm.example/scim/sp/acme';
const ACS = 'https://api.nuzm.example/v1/auth/sso/acs/acme';
const key = makeTestKey('acme-idp');
const attacker = makeTestKey('attacker');

class MemoryReplay implements ReplayStore {
  seen = new Set<string>();
  async claim(h: string) {
    if (this.seen.has(h)) return false;
    this.seen.add(h);
    return true;
  }
}
const base: ResponseOptions = {
  idpEntityId: IDP,
  spEntityId: SP,
  acsUrl: ACS,
  inResponseTo: '_req1',
};
const run = (b64: string, over: Partial<Parameters<typeof validateSamlResponse>[0]> = {}) =>
  validateSamlResponse({
    samlResponse: b64,
    idp: { entityId: IDP, certificates: [key.certificate] },
    sp: { entityId: SP, acsUrl: ACS },
    expectedRequestId: '_req1',
    replay: new MemoryReplay(),
    ...over,
  });
const rejects = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e, `expected ${code}`).toBeInstanceOf(SamlError);
  expect((e as SamlError).code).toBe(code);
};

describe('SAML response validation: positive cases (local test IdP, NOT VERIFIED against real IdPs)', () => {
  it('accepts a response signed on the assertion', async () => {
    const id = await run(
      samlResponse(key, { ...base, attributes: { groups: ['eng'], displayName: ['Alice A'] } }),
    );
    expect(id.email).toBe('alice@acme.example');
    expect(id.groups).toEqual(['eng']);
    expect(id.displayName).toBe('Alice A');
  });
  it('accepts a response signed on the Response element', async () => {
    expect((await run(samlResponse(key, { ...base, sign: 'response' }))).nameId).toBe(
      'alice@acme.example',
    );
  });
  it('accepts both signatures', async () => {
    expect((await run(samlResponse(key, { ...base, sign: 'both' }))).assertionId).toMatch(/^_a/);
  });
  it('refuses an ECDSA signature method (not supported by the XML-DSig library: documented limitation)', async () =>
    rejects(
      run(
        samlResponse(key, {
          ...base,
          tamper: (x) => x.replace('xmldsig-more#rsa-sha256', 'xmldsig-more#ecdsa-sha256'),
        }),
      ),
      'algorithm_refused',
    ));
  it('accepts either of two pinned certificates (IdP key rollover)', async () => {
    const b64 = samlResponse(key, base);
    expect(
      (
        await run(b64, {
          idp: { entityId: IDP, certificates: [attacker.certificate, key.certificate] },
        })
      ).email,
    ).toBeTruthy();
  });
  it('accepts clock skew within 2 minutes and refuses beyond', async () => {
    const issued = new Date('2026-11-18T10:00:00Z');
    const b64 = samlResponse(key, {
      ...base,
      now: issued,
      assertionValiditySeconds: 60,
      confirmationNotOnOrAfterSeconds: 60,
    });
    await expect(
      run(b64, { now: new Date(issued.getTime() + 60_000 + 100_000) }),
    ).resolves.toBeTruthy();
    await rejects(run(b64, { now: new Date(issued.getTime() + 60_000 + 125_000) }), 'expired');
  });
  it('accepts an unsolicited (IdP-initiated) response only when explicitly allowed', async () => {
    const b64 = samlResponse(key, { ...base, inResponseTo: null });
    await rejects(run(b64, { expectedRequestId: undefined }), 'unsolicited_refused');
    await expect(
      run(b64, { expectedRequestId: undefined, allowUnsolicited: true }),
    ).resolves.toBeTruthy();
  });
});

describe('SAML response validation: negative cases (every one must be rejected)', () => {
  it('unsigned', async () =>
    rejects(run(samlResponse(key, { ...base, sign: 'none' })), 'unsigned'));
  it('signed by a key that is not pinned', async () =>
    rejects(run(samlResponse(attacker, base)), 'bad_signature'));
  it('wrong audience', async () =>
    rejects(
      run(samlResponse(key, { ...base, audience: 'https://other.example' })),
      'audience_mismatch',
    ));
  it('wrong recipient', async () =>
    rejects(
      run(samlResponse(key, { ...base, recipient: 'https://evil.example/acs' })),
      'recipient_mismatch',
    ));
  it('wrong destination (signed Response)', async () =>
    rejects(
      run(
        samlResponse(key, { ...base, sign: 'response', destination: 'https://evil.example/acs' }),
      ),
      'destination_mismatch',
    ));
  it('wrong issuer', async () =>
    rejects(
      run(samlResponse(key, { ...base, idpEntityId: 'https://evil.example/idp' })),
      'issuer_mismatch',
    ));
  it('expired assertion', async () =>
    rejects(
      run(
        samlResponse(key, {
          ...base,
          now: new Date(Date.now() - 3_600_000),
          assertionValiditySeconds: 300,
          confirmationNotOnOrAfterSeconds: 300,
        }),
      ),
      'expired',
    ));
  it('not yet valid', async () =>
    rejects(
      run(samlResponse(key, { ...base, now: new Date(Date.now() + 3_600_000) })),
      'not_yet_valid',
    ));
  it('answers another request (InResponseTo mismatch)', async () =>
    rejects(
      run(samlResponse(key, { ...base, inResponseTo: '_someone_elses' })),
      'in_response_to_mismatch',
    ));
  it('failed status', async () =>
    rejects(
      run(
        samlResponse(key, { ...base, statusCode: 'urn:oasis:names:tc:SAML:2.0:status:Responder' }),
      ),
      'status_not_success',
    ));
  it('replayed assertion', async () => {
    const store = new MemoryReplay();
    const b64 = samlResponse(key, base);
    await run(b64, { replay: store });
    await rejects(run(b64, { replay: store }), 'replayed');
  });
  it('an invalid response does not consume the assertion id', async () => {
    const store = new MemoryReplay();
    await rejects(
      run(samlResponse(key, { ...base, audience: 'x' }), { replay: store }),
      'audience_mismatch',
    );
    expect(store.seen.size).toBe(0);
  });
  it('algorithm downgrade: RSA-SHA1 signature method', async () =>
    rejects(
      run(samlResponse(key, { ...base, signatureAlgorithm: RSA_SHA1 })),
      'algorithm_refused',
    ));
  it('algorithm downgrade: SHA-1 digest', async () =>
    rejects(run(samlResponse(key, { ...base, digestAlgorithm: SHA1 })), 'algorithm_refused'));
  it('canonicalization with comments', async () =>
    rejects(
      run(samlResponse(key, { ...base, canonicalization: EXC_C14N_COMMENTS })),
      'algorithm_refused',
    ));
  it('algorithm "none"', async () =>
    rejects(
      run(
        samlResponse(key, {
          ...base,
          tamper: (x) =>
            x.replace(
              'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
              'http://www.w3.org/2000/09/xmldsig#none',
            ),
        }),
      ),
      'algorithm_refused',
    ));
  it('DOCTYPE / entity expansion', async () =>
    rejects(
      run(samlResponse(key, { ...base, tamper: (x) => `<!DOCTYPE r [<!ENTITY a "aaaa">]>${x}` })),
      'doctype_refused',
    ));
  it('malformed XML', async () =>
    rejects(run(Buffer.from('<samlp:Response').toString('base64')), 'malformed'));
  it('not base64 / empty', async () => rejects(run(''), 'malformed'));
  it('too large', async () =>
    rejects(run(Buffer.alloc(300 * 1024, 65).toString('base64')), 'too_large'));
  it('tampered content after signing (attribute changed)', async () =>
    rejects(
      run(
        samlResponse(key, {
          ...base,
          tamper: (x) => x.replace('alice@acme.example', 'admin@acme.example'),
        }),
      ),
      'bad_signature',
    ));

  describe('signature wrapping', () => {
    it('a second, unsigned assertion next to the signed one', async () => {
      const b64 = samlResponse(key, {
        ...base,
        tamper: (x) => {
          const m = /<saml:Assertion[\s\S]*<\/saml:Assertion>/.exec(x)![0];
          const evil = m
            .replace(/<ds:Signature[\s\S]*?<\/ds:Signature>/, '')
            .replace('alice@acme.example', 'admin@acme.example')
            .replace(/ID="[^"]+"/, 'ID="_evil"');
          return x.replace('</samlp:Response>', `${evil}</samlp:Response>`);
        },
      });
      await rejects(run(b64), 'wrapped');
    });
    it('the signed assertion moved inside an Extensions element, with an unsigned one in its place', async () => {
      const b64 = samlResponse(key, {
        ...base,
        tamper: (x) => {
          const m = /<saml:Assertion[\s\S]*<\/saml:Assertion>/.exec(x)![0];
          const evil = m
            .replace(/<ds:Signature[\s\S]*?<\/ds:Signature>/, '')
            .replace('alice@acme.example', 'admin@acme.example')
            .replace(/ID="[^"]+"/, 'ID="_evil"');
          return x.replace(m, `${evil}<samlp:Extensions>${m}</samlp:Extensions>`);
        },
      });
      await rejects(run(b64), 'wrapped');
    });
    it('duplicate ID attributes', async () => {
      const b64 = samlResponse(key, {
        ...base,
        tamper: (x) =>
          x
            .replace(/ID="(_r[0-9a-f]+)"/, (_m, id: string) => `ID="${id}"`)
            .replace('<saml:Issuer>', '<saml:Issuer ID="_dup">')
            .replace('<saml:Subject>', '<saml:Subject ID="_dup">'),
      });
      await rejects(run(b64), 'wrapped');
    });
    it('a signature whose Reference points at another element', async () => {
      const b64 = samlResponse(key, {
        ...base,
        tamper: (x) => x.replace(/URI="#_a[0-9a-f]+"/, 'URI="#_other"'),
      });
      await rejects(run(b64), 'wrapped');
    });
    it('a forged assertion carrying a Signature element from elsewhere in the document', async () => {
      const b64 = samlResponse(key, {
        ...base,
        sign: 'response',
        tamper: (x) =>
          x.replace(
            '<saml:AttributeStatement>',
            '<saml:AttributeStatement><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"/>',
          ),
      });
      await rejects(run(b64), 'wrapped');
    });
    it('encrypted assertions are refused, never ignored', async () => {
      const b64 = samlResponse(key, {
        ...base,
        sign: 'response',
        tamper: (x) =>
          x.replace('</samlp:Response>', '<saml:EncryptedAssertion/></samlp:Response>'),
      });
      await rejects(run(b64), 'encrypted_unsupported');
    });
  });
});

describe('SAML metadata', () => {
  const idpMetadata = (cert: string, extra = '') => `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${IDP}"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
<md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${cert.replace(/-----[A-Z ]+-----|\s+/g, '')}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.acme.example/sso"/>${extra}</md:IDPSSODescriptor></md:EntityDescriptor>`;
  it('imports a valid IdP descriptor', () => {
    const m = parseIdpMetadata(idpMetadata(key.certificate));
    expect(m.entityId).toBe(IDP);
    expect(m.ssoUrl).toBe('https://idp.acme.example/sso');
    expect(m.certificates).toHaveLength(1);
  });
  it('refuses metadata without a signing certificate, DTDs, http endpoints and garbage', () => {
    expect(() =>
      parseIdpMetadata(
        idpMetadata(key.certificate).replace(/<md:KeyDescriptor[\s\S]*<\/md:KeyDescriptor>/, ''),
      ),
    ).toThrow(MetadataError);
    expect(() => parseIdpMetadata(`<!DOCTYPE x>${idpMetadata(key.certificate)}`)).toThrow(
      MetadataError,
    );
    expect(() =>
      parseIdpMetadata(
        idpMetadata(key.certificate).replace('Location="https://', 'Location="http://'),
      ),
    ).toThrow(MetadataError);
    expect(() => parseIdpMetadata('<a/>')).toThrow(MetadataError);
    expect(() => parseIdpMetadata('not xml')).toThrow(MetadataError);
  });
  it('exports SP metadata that asks for signed assertions', () => {
    const x = buildSpMetadata({ entityId: SP, acsUrl: ACS });
    expect(x).toContain('WantAssertionsSigned="true"');
    expect(x).toContain(ACS);
  });
});
