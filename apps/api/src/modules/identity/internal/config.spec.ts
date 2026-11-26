import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { loadIdentityConfig } from './config';
import { OidcClient } from './oidc';

it('supports production password authentication without a fake identity provider', async () => {
  const config = loadIdentityConfig({
    NODE_ENV: 'production',
    AUTH_OIDC_ENABLED: 'false',
    SESSION_SEAL_KEY: randomBytes(32).toString('base64'),
  });
  expect(config.secureCookies).toBe(true);
  expect(config.scryptLogN).toBe(17);
  await expect(new OidcClient(config).authorizationRequest('/console')).rejects.toMatchObject({
    code: 'service_unavailable',
  });
});

it('still requires the seal key and complete configuration when OIDC is enabled', () => {
  expect(() => loadIdentityConfig({ AUTH_OIDC_ENABLED: 'false' })).toThrow('SESSION_SEAL_KEY');
  expect(() =>
    loadIdentityConfig({ SESSION_SEAL_KEY: randomBytes(32).toString('base64') }),
  ).toThrow('OIDC_ISSUER');
});
