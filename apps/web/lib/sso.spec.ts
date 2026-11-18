import { describe, expect, it } from 'vitest';
import {
  canEnforce,
  createSsoBody,
  readDomains,
  readPublicConfig,
  splitDomains,
  testLoginSucceeded,
} from './sso';

const saml = {
  protocol: 'saml' as const,
  name: 'Corporate IdP',
  domains: 'Example.com, example.com, sub.example.org',
  xml: '',
  metadataUrl: 'https://idp.example.com/metadata',
  issuer: '',
  clientId: '',
  clientSecretRef: '',
  jitEnabled: true,
  jitRole: 'viewer',
};
const oidc = {
  ...saml,
  protocol: 'oidc' as const,
  metadataUrl: '',
  issuer: 'https://login.example.com',
  clientId: 'nuzm',
  clientSecretRef: 'vault://tenant/sso/oidc',
};

describe('SSO create body (UI-M12-01)', () => {
  it('SAML: lowercases and de-duplicates domains, sends the metadata address and the JIT policy', () => {
    expect(createSsoBody(saml).body).toEqual({
      protocol: 'saml',
      name: 'Corporate IdP',
      domains: ['example.com', 'sub.example.org'],
      jit: { enabled: true, defaultRole: 'viewer' },
      metadataUrl: 'https://idp.example.com/metadata',
    });
  });
  it('SAML: exactly one of xml and metadata address', () => {
    expect(createSsoBody({ ...saml, metadataUrl: '' }).error).toBe('metadata');
    expect(createSsoBody({ ...saml, xml: '<EntityDescriptor/>' }).error).toBe('metadata');
    expect(
      createSsoBody({ ...saml, metadataUrl: '', xml: '<EntityDescriptor/>' }).body,
    ).toMatchObject({ xml: '<EntityDescriptor/>' });
    expect(createSsoBody({ ...saml, metadataUrl: 'http://idp.example.com/m' }).error).toBe(
      'metadataUrl',
    );
  });
  it('OIDC: a vault reference only; a secret value is never put in a body', () => {
    expect(createSsoBody(oidc).body).toMatchObject({
      protocol: 'oidc',
      clientSecretRef: 'vault://tenant/sso/oidc',
    });
    const b = createSsoBody({ ...oidc, clientSecretRef: 'super-secret-value' });
    expect(b.error).toBe('clientSecretRef');
    expect(b.body).toBeUndefined();
    expect(createSsoBody({ ...oidc, issuer: 'http://login.example.com' }).error).toBe('issuer');
    expect(createSsoBody(oidc).body).not.toHaveProperty('clientSecret');
  });
  it('JIT never offers an administrative role', () => {
    expect(createSsoBody({ ...saml, jitRole: 'admin' }).error).toBe('jitRole');
    expect(createSsoBody({ ...saml, jitRole: 'owner' }).error).toBe('jitRole');
  });
  it('rejects invalid domains and an empty name', () => {
    expect(createSsoBody({ ...saml, domains: 'not a domain' }).error).toBe('domains');
    expect(createSsoBody({ ...saml, domains: 'localhost' }).error).toBe('domains');
    expect(createSsoBody({ ...saml, name: ' ' }).error).toBe('name');
  });
  it('splits domain lists', () => {
    expect(splitDomains('A.com  b.com,,A.com')).toEqual(['a.com', 'b.com']);
  });
});

describe('SSO connection readers', () => {
  it('the TXT value exists only while a proof is pending', () => {
    const d = readDomains([
      {
        domain: 'a.com',
        status: 'pending',
        txtName: '_nuzm-sso.a.com',
        txtValue: 'nuzm-sso-verification=abc',
        verifiedAt: null,
      },
      {
        domain: 'b.com',
        status: 'verified',
        txtName: '_nuzm-sso.b.com',
        txtValue: null,
        verifiedAt: '2026-11-18T10:00:00Z',
      },
      { domain: 'broken' },
    ]);
    expect(d.map((x) => [x.domain, x.status, x.txtValue])).toEqual([
      ['a.com', 'pending', 'nuzm-sso-verification=abc'],
      ['b.com', 'verified', null],
    ]);
  });
  it('the public config is an allow-list: certificates and secrets never pass through', () => {
    const c = readPublicConfig({
      entityId: 'https://idp.example.com',
      ssoUrl: 'https://idp.example.com/sso',
      signingCertificates: 2,
      certificates: ['-----BEGIN CERTIFICATE-----'],
      clientSecret: 'x',
      vaultRef: 'vault://x',
    });
    expect(JSON.stringify(c)).not.toMatch(/CERTIFICATE|clientSecret|vault/);
    expect(c.signingCertificates).toBe(2);
  });
  it('enforcement is available only with an active connection, a verified domain and a successful test login', () => {
    const verified = readDomains([
      { domain: 'a.com', status: 'verified', txtName: '_nuzm-sso.a.com', txtValue: null },
    ]);
    const ok = { lastResult: { ok: true } };
    expect(canEnforce({ status: 'active', domains: verified, testLogin: ok })).toBe(true);
    expect(
      canEnforce({
        status: 'active',
        domains: verified,
        testLogin: { available: false, lastResult: null },
      }),
    ).toBe(false);
    expect(canEnforce({ status: 'pending_domain_proof', domains: verified, testLogin: ok })).toBe(
      false,
    );
    expect(canEnforce({ status: 'active', domains: [], testLogin: ok })).toBe(false);
    expect(testLoginSucceeded(undefined)).toBe(false);
  });
});
