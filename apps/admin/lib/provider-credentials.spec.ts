import { describe, expect, it } from 'vitest';
import { CREDENTIAL_PROVIDERS, credentialsBody, kindsOf } from './provider-credentials';

describe('provider credential fields', () => {
  it('covers the three compute vendors; Huawei has two key kinds', () => {
    expect(CREDENTIAL_PROVIDERS.sort()).toEqual(['alibaba', 'contabo', 'huawei']);
    expect(kindsOf('huawei').map((k) => k.id)).toEqual(['keypair', 'iam']);
    expect(kindsOf('unknown')).toEqual([]);
  });
  it('builds the body of the chosen kind only, trimmed', () => {
    expect(
      credentialsBody('huawei', 'iam', {
        iamUser: ' user1 ',
        iamPassword: 'pass-1234',
        domainName: 'acct',
        accessKey: 'ignored-AK',
      }),
    ).toEqual({ iamUser: 'user1', iamPassword: 'pass-1234', domainName: 'acct' });
  });
  it('refuses an empty field, a space inside a value and an unknown kind', () => {
    expect(credentialsBody('alibaba', 'keypair', { accessKeyId: 'LTAI123' })).toBeNull();
    expect(
      credentialsBody('alibaba', 'keypair', { accessKeyId: 'LTAI123', accessKeySecret: 'a b c' }),
    ).toBeNull();
    expect(credentialsBody('alibaba', 'iam', {})).toBeNull();
  });
});
