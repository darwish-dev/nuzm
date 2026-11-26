import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { ProblemException } from '../../../common/errors';
import type { IdentityConfig } from './config';

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

export interface IdClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

const b64u = (b: Buffer) => b.toString('base64url');

/** Minimal OIDC relying party: authorization-code + PKCE (S256), nonce, signed-ID-token validation. */
export class OidcClient {
  private discovery?: { value: Discovery; at: number };
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly cfg: IdentityConfig) {}

  private async meta(): Promise<Discovery> {
    if (!this.cfg.issuer)
      throw new ProblemException(
        'service_unavailable',
        'single sign-on is not configured; use email and password',
      );
    if (this.discovery && Date.now() - this.discovery.at < 600_000) return this.discovery.value;
    try {
      const res = await fetch(
        `${this.cfg.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!res.ok) throw new Error(`discovery ${res.status}`);
      const value = (await res.json()) as Discovery;
      if (value.issuer !== this.cfg.issuer)
        throw new Error('issuer mismatch in discovery document');
      this.discovery = { value, at: Date.now() };
      this.jwks = createRemoteJWKSet(new URL(value.jwks_uri), { timeoutDuration: 5000 });
      return value;
    } catch {
      throw new ProblemException('service_unavailable', 'identity provider unreachable');
    }
  }

  async authorizationRequest(returnTo: string) {
    const m = await this.meta();
    const state = b64u(randomBytes(24));
    const nonce = b64u(randomBytes(24));
    const verifier = b64u(randomBytes(32));
    const challenge = b64u(createHash('sha256').update(verifier).digest());
    const u = new URL(m.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return { url: u.toString(), login: { state, nonce, verifier, returnTo } };
  }

  async exchange(code: string, verifier: string, nonce: string): Promise<IdClaims> {
    const m = await this.meta();
    let body: { id_token?: string };
    try {
      const res = await fetch(m.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.cfg.redirectUri,
          client_id: this.cfg.clientId,
          client_secret: this.cfg.clientSecret,
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.status >= 500)
        throw new ProblemException('service_unavailable', 'identity provider error');
      if (!res.ok) throw new ProblemException('oidc_token_invalid', 'code exchange rejected');
      body = (await res.json()) as { id_token?: string };
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      throw new ProblemException('service_unavailable', 'identity provider unreachable');
    }
    if (!body.id_token) throw new ProblemException('oidc_token_invalid', 'missing id_token');
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(body.id_token, this.jwks!, {
        issuer: m.issuer,
        audience: this.cfg.clientId,
        algorithms: ['RS256', 'ES256', 'PS256'],
      }));
    } catch {
      throw new ProblemException('oidc_token_invalid', 'id_token failed validation');
    }
    if (payload.nonce !== nonce) throw new ProblemException('oidc_token_invalid', 'nonce mismatch');
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string')
      throw new ProblemException('oidc_token_invalid', 'missing sub/email claims');
    return {
      sub: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      name: typeof payload.name === 'string' ? payload.name : undefined,
    };
  }
}
