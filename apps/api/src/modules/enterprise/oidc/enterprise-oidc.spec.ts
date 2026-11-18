import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { describe, expect, it } from 'vitest';
import { EnterpriseOidc, OidcError, type OidcNetwork } from './enterprise-oidc';

const ISS = 'https://login.acme.example';
const cfg = { issuer: ISS, clientId: 'nuzm-client', clientSecret: 'test-only' };
const REDIRECT = 'https://api.nuzm.example/v1/auth/sso/oidc/callback';

async function keyPair(kid: string) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' } as JWK;
  return { privateKey, jwk, kid };
}

function harness() {
  const state = {
    jwks: [] as JWK[],
    idToken: '',
    tokenStatus: 'ok' as 'ok' | 'fail',
    issuerInDiscovery: ISS,
    httpEndpoint: false,
  };
  const net: OidcNetwork = {
    discovery: async () => ({
      issuer: state.issuerInDiscovery,
      authorization_endpoint: 'https://login.acme.example/authorize',
      token_endpoint: state.httpEndpoint
        ? 'http://login.acme.example/token'
        : 'https://login.acme.example/token',
      jwks_uri: 'https://login.acme.example/jwks',
    }),
    tokenRequest: async () => {
      if (state.tokenStatus === 'fail') throw new Error('400');
      return { id_token: state.idToken };
    },
    keys: () => createLocalJWKSet({ keys: state.jwks }), // re-created per call: a rotated set is seen at once
  };
  return { state, oidc: new EnterpriseOidc(net) };
}
const sign = async (
  k: Awaited<ReturnType<typeof keyPair>>,
  claims: Record<string, unknown>,
  o: { iss?: string; aud?: string; exp?: string | number; alg?: string } = {},
) =>
  new SignJWT({ email: 'bob@acme.example', ...claims })
    .setProtectedHeader({ alg: (o.alg as 'RS256') ?? 'RS256', kid: k.kid })
    .setSubject('user-1')
    .setIssuer(o.iss ?? ISS)
    .setAudience(o.aud ?? cfg.clientId)
    .setIssuedAt()
    .setExpirationTime(o.exp ?? '5m')
    .sign(k.privateKey);

const start = async (h: ReturnType<typeof harness>) =>
  (await h.oidc.authorizationRequest(cfg, REDIRECT)).login;
const code = (login: { state: string }) => ({ code: 'abc', state: login.state });
const rejects = async (p: Promise<unknown>, c: string) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(OidcError);
  expect((e as OidcError).code).toBe(c);
};

describe('enterprise OIDC (local test IdP, NOT VERIFIED against real IdPs)', () => {
  it('builds an authorization request with PKCE S256, state and nonce', async () => {
    const h = harness();
    const { url, login } = await h.oidc.authorizationRequest(cfg, REDIRECT);
    const u = new URL(url);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBe(login.state);
    expect(u.searchParams.get('nonce')).toBe(login.nonce);
    expect(u.searchParams.get('code_challenge')).not.toBe(login.verifier);
  });
  it('accepts a valid ID token', async () => {
    const h = harness();
    const k = await keyPair('k1');
    h.state.jwks = [k.jwk];
    const login = await start(h);
    h.state.idToken = await sign(k, { nonce: login.nonce, groups: ['eng'], email_verified: true });
    const c = await h.oidc.handleCallback(cfg, REDIRECT, login, code(login));
    expect(c).toMatchObject({
      email: 'bob@acme.example',
      sub: 'user-1',
      groups: ['eng'],
      emailVerified: true,
    });
  });
  it('rejects a bad state, an IdP error and a missing code', async () => {
    const h = harness();
    const login = await start(h);
    await rejects(
      h.oidc.handleCallback(cfg, REDIRECT, login, { code: 'x', state: 'other' }),
      'state_mismatch',
    );
    await rejects(
      h.oidc.handleCallback(cfg, REDIRECT, login, { state: login.state, error: 'access_denied' }),
      'idp_error',
    );
    await rejects(h.oidc.handleCallback(cfg, REDIRECT, login, { state: login.state }), 'idp_error');
  });
  it('rejects a wrong nonce, a wrong issuer, a wrong audience and an expired token', async () => {
    const h = harness();
    const k = await keyPair('k1');
    h.state.jwks = [k.jwk];
    const login = await start(h);
    h.state.idToken = await sign(k, { nonce: 'not-mine' });
    await rejects(h.oidc.handleCallback(cfg, REDIRECT, login, code(login)), 'nonce_mismatch');
    h.state.idToken = await sign(k, { nonce: login.nonce }, { iss: 'https://evil.example' });
    await rejects(h.oidc.handleCallback(cfg, REDIRECT, login, code(login)), 'issuer_mismatch');
    h.state.idToken = await sign(k, { nonce: login.nonce }, { aud: 'someone-else' });
    await rejects(h.oidc.handleCallback(cfg, REDIRECT, login, code(login)), 'id_token_invalid');
    h.state.idToken = await sign(
      k,
      { nonce: login.nonce },
      { exp: Math.floor(Date.now() / 1000) - 600 },
    );
    await rejects(h.oidc.handleCallback(cfg, REDIRECT, login, code(login)), 'id_token_invalid');
  });
  it('rejects a token signed by an unknown key, a downgraded algorithm and alg=none', async () => {
    const h = harness();
    const k = await keyPair('k1');
    const rogue = await keyPair('k1'); // same kid, different key
    h.state.jwks = [k.jwk];
    const login = await start(h);
    h.state.idToken = await sign(rogue, { nonce: login.nonce });
    await rejects(h.oidc.handleCallback(cfg, REDIRECT, login, code(login)), 'id_token_invalid');
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ iss: ISS, aud: cfg.clientId, sub: 'x', email: 'a@b.c', nonce: login.nonce, exp: 9999999999, iat: 1 })).toString('base64url')}.`;
    h.state.idToken = none;
    await rejects(h.oidc.handleCallback(cfg, REDIRECT, login, code(login)), 'id_token_invalid');
    const hs = await new SignJWT({ email: 'a@b.c', nonce: login.nonce })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setSubject('x')
      .setIssuer(ISS)
      .setAudience(cfg.clientId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('0123456789abcdef0123456789abcdef'));
    h.state.idToken = hs;
    await rejects(h.oidc.handleCallback(cfg, REDIRECT, login, code(login)), 'id_token_invalid');
  });
  it('follows JWKS rotation: a token signed with a newly published key verifies, a retired key does not', async () => {
    const h = harness();
    const k1 = await keyPair('k1');
    const k2 = await keyPair('k2');
    h.state.jwks = [k1.jwk];
    const login = await start(h);
    h.state.idToken = await sign(k2, { nonce: login.nonce });
    await rejects(h.oidc.handleCallback(cfg, REDIRECT, login, code(login)), 'id_token_invalid'); // not published yet
    h.state.jwks = [k1.jwk, k2.jwk]; // rotation: new key published
    await expect(h.oidc.handleCallback(cfg, REDIRECT, login, code(login))).resolves.toMatchObject({
      email: 'bob@acme.example',
    });
    h.state.jwks = [k2.jwk]; // old key retired
    h.state.idToken = await sign(k1, { nonce: login.nonce });
    await rejects(h.oidc.handleCallback(cfg, REDIRECT, login, code(login)), 'id_token_invalid');
  });
  it('rejects discovery documents with another issuer or plain-http endpoints, and token endpoint failures', async () => {
    const h = harness();
    const k = await keyPair('k1');
    h.state.jwks = [k.jwk];
    h.state.issuerInDiscovery = 'https://evil.example';
    await rejects(h.oidc.authorizationRequest(cfg, REDIRECT), 'discovery_invalid');
    h.state.issuerInDiscovery = ISS;
    h.state.httpEndpoint = true;
    await rejects(h.oidc.authorizationRequest(cfg, REDIRECT), 'discovery_invalid');
    h.state.httpEndpoint = false;
    const login = await start(h);
    h.state.tokenStatus = 'fail';
    await rejects(
      h.oidc.handleCallback(cfg, REDIRECT, login, code(login)),
      'token_exchange_failed',
    );
  });
  it('requires an email claim', async () => {
    const h = harness();
    const k = await keyPair('k1');
    h.state.jwks = [k.jwk];
    const login = await start(h);
    h.state.idToken = await sign(k, { nonce: login.nonce, email: 'no-at-sign' });
    await rejects(h.oidc.handleCallback(cfg, REDIRECT, login, code(login)), 'email_missing');
  });
});
