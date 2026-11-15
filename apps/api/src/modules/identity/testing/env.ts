import { randomBytes } from 'node:crypto';

/** Test-only OIDC/session env. Values are fakes; nothing here is a credential. */
export function applyTestIdentityEnv(
  issuer = 'http://127.0.0.1:1',
  overrides: Record<string, string> = {},
) {
  Object.assign(process.env, {
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: 'nuzm-test-client',
    OIDC_CLIENT_SECRET: 'test-client-secret-not-real',
    OIDC_REDIRECT_URI: 'http://127.0.0.1:4000/v1/auth/oidc/callback',
    RETURN_TO_ORIGINS: 'http://127.0.0.1:3000',
    DEFAULT_RETURN_TO: '/',
    SESSION_SEAL_KEY: randomBytes(32).toString('base64'),
    ...overrides,
  });
}
