import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

/**
 * Enterprise OIDC relying party (one per SSO connection): authorization code + PKCE (S256), state, nonce, issuer and JWKS validation.
 * Pure of storage: the caller keeps `login` (state/nonce/verifier) in a sealed, short-lived cookie bound to the browser (as the platform sign-in does).
 * Network is injected, so the unit tests need no server and JWKS rotation is testable.
 */
export type OidcErrorCode =
  | 'state_mismatch'
  | 'idp_error'
  | 'token_exchange_failed'
  | 'id_token_missing'
  | 'id_token_invalid'
  | 'nonce_mismatch'
  | 'issuer_mismatch'
  | 'email_missing'
  | 'discovery_invalid';

export class OidcError extends Error {
  constructor(
    readonly code: OidcErrorCode,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export interface OidcConnectionConfig {
  issuer: string;
  clientId: string;
  /** Resolved from the vault reference by the caller; never persisted. */
  clientSecret: string;
}
export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}
export interface OidcNetwork {
  discovery(issuer: string): Promise<OidcDiscovery>;
  tokenRequest(endpoint: string, form: URLSearchParams): Promise<{ id_token?: string }>;
  /** Key resolver for the IdP's JWKS (jose `createRemoteJWKSet` in production; handles `kid` rotation). */
  keys(jwksUri: string): JWTVerifyGetKey;
}

export interface OidcLogin {
  state: string;
  nonce: string;
  verifier: string;
}
export interface OidcClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  groups: string[];
  issuer: string;
}

const b64u = (b: Buffer) => b.toString('base64url');
/** RS/PS/ES only: no `none`, no HMAC (which would let a client secret-holder forge tokens). */
export const OIDC_ALLOWED_ALGS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
];
export const OIDC_CLOCK_TOLERANCE_SECONDS = 120;

export class EnterpriseOidc {
  constructor(private readonly net: OidcNetwork) {}

  private async meta(cfg: OidcConnectionConfig): Promise<OidcDiscovery> {
    const m = await this.net.discovery(cfg.issuer);
    if (m.issuer !== cfg.issuer)
      throw new OidcError('discovery_invalid', 'the discovery document names a different issuer');
    for (const u of [m.authorization_endpoint, m.token_endpoint, m.jwks_uri])
      if (!u.startsWith('https://'))
        throw new OidcError('discovery_invalid', 'IdP endpoints must be https');
    return m;
  }

  async authorizationRequest(
    cfg: OidcConnectionConfig,
    redirectUri: string,
  ): Promise<{ url: string; login: OidcLogin }> {
    const m = await this.meta(cfg);
    const login: OidcLogin = {
      state: b64u(randomBytes(24)),
      nonce: b64u(randomBytes(24)),
      verifier: b64u(randomBytes(32)),
    };
    const u = new URL(m.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      state: login.state,
      nonce: login.nonce,
      code_challenge: b64u(createHash('sha256').update(login.verifier).digest()),
      code_challenge_method: 'S256',
    }).toString();
    return { url: u.toString(), login };
  }

  async handleCallback(
    cfg: OidcConnectionConfig,
    redirectUri: string,
    login: OidcLogin,
    params: { code?: string; state?: string; error?: string },
  ): Promise<OidcClaims> {
    if (!params.state || params.state !== login.state) throw new OidcError('state_mismatch');
    if (params.error || !params.code) throw new OidcError('idp_error');
    const m = await this.meta(cfg);
    let body: { id_token?: string };
    try {
      body = await this.net.tokenRequest(
        m.token_endpoint,
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: params.code,
          redirect_uri: redirectUri,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          code_verifier: login.verifier,
        }),
      );
    } catch {
      throw new OidcError('token_exchange_failed');
    }
    if (!body.id_token) throw new OidcError('id_token_missing');
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(body.id_token, this.net.keys(m.jwks_uri), {
        issuer: m.issuer,
        audience: cfg.clientId,
        algorithms: OIDC_ALLOWED_ALGS,
        clockTolerance: OIDC_CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['exp', 'iat', 'sub'],
      }));
    } catch (e) {
      const msg = (e as { code?: string }).code ?? '';
      if (
        msg === 'ERR_JWT_CLAIM_VALIDATION_FAILED' &&
        String((e as { claim?: string }).claim) === 'iss'
      )
        throw new OidcError('issuer_mismatch');
      throw new OidcError('id_token_invalid', msg || undefined);
    }
    if (payload.nonce !== login.nonce) throw new OidcError('nonce_mismatch');
    if (typeof payload.email !== 'string' || !payload.email.includes('@'))
      throw new OidcError('email_missing');
    const groups = Array.isArray(payload.groups)
      ? payload.groups.filter((g): g is string => typeof g === 'string')
      : [];
    return {
      sub: payload.sub!,
      email: payload.email.trim().toLowerCase(),
      emailVerified: payload.email_verified === true,
      name: typeof payload.name === 'string' ? payload.name : null,
      groups,
      issuer: m.issuer,
    };
  }
}
