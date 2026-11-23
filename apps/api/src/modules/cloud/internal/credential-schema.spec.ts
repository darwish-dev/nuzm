import { describe, expect, it } from 'vitest';
import { parseCredentials } from './credential-schema';

describe('parseCredentials', () => {
  it('accepts the exact field set of each vendor adapter and trims values', () => {
    expect(
      parseCredentials('alibaba', { accessKeyId: ' LTAI12345 ', accessKeySecret: 'secret-value' }),
    ).toEqual({
      accessKeyId: 'LTAI12345',
      accessKeySecret: 'secret-value',
    });
    expect(
      parseCredentials('contabo', {
        clientId: 'INT-1',
        clientSecret: 'cs-1',
        apiUser: 'a@b.co',
        apiPassword: 'pw-123',
      }),
    ).toMatchObject({ apiUser: 'a@b.co' });
  });
  it('Huawei: an AK/SK pair or an IAM user; a half-filled second set is dropped, an incomplete only-set is refused', () => {
    expect(
      parseCredentials('huawei', { accessKey: 'AK123', secretKey: 'SK123', iamUser: 'half' }),
    ).toEqual({
      accessKey: 'AK123',
      secretKey: 'SK123',
    });
    expect(
      parseCredentials('huawei', { iamUser: 'user1', iamPassword: 'pass-1', domainName: 'acct' }),
    ).toEqual({ iamUser: 'user1', iamPassword: 'pass-1', domainName: 'acct' });
    expect(() => parseCredentials('huawei', { accessKey: 'AK123' })).toThrow();
  });
  it('refuses unknown fields, non-strings, spaces, short values, other providers and non-objects — without echoing the value', () => {
    const secret = 'super secret with spaces';
    for (const bad of [
      { accessKeyId: 'LTAI123', accessKeySecret: secret },
      { accessKeyId: 'LTAI123', accessKeySecret: 'ok-secret', extra: 'x' },
      { accessKeyId: 'LTAI123', accessKeySecret: 12345678 },
      { accessKeyId: 'LT', accessKeySecret: 'ok-secret' },
      null,
      [],
      'nope',
    ]) {
      let msg = '';
      try {
        parseCredentials('alibaba', bad);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).not.toBe('');
      expect(msg).not.toContain(secret);
    }
    expect(() => parseCredentials('mock', {})).toThrow();
  });
});
