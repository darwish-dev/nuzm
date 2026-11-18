import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sdkDate, signSdkHmacSha256 } from './signer';

describe('SDK-HMAC-SHA256 signer', () => {
  it("reproduces the hashed canonical request of the documentation's worked example (VPC list, GET)", () => {
    // https://support.huaweicloud.com/intl/en-us/devg-apisign/api-sign-algorithm-002.html (read 2026-11-18)
    const s = signSdkHmacSha256({
      method: 'GET',
      path: '/v1/77b6a44cba5143ab91d13ab9a8ff44fd/vpcs',
      query: { limit: '2', marker: '13551d6b-755d-4757-b956-536f674975c0' },
      host: 'service.region.example.com',
      body: '',
      date: '20191115T033655Z',
      accessKey: 'QTWA***KYUC',
      secretKey: 'MFyf***VmHc', // masked in the documentation: the printed signature cannot be reproduced
    });
    expect(s.canonicalRequest).toBe(
      [
        'GET',
        '/v1/77b6a44cba5143ab91d13ab9a8ff44fd/vpcs/',
        'limit=2&marker=13551d6b-755d-4757-b956-536f674975c0',
        'content-type:application/json',
        'host:service.region.example.com',
        'x-sdk-date:20191115T033655Z',
        '',
        'content-type;host;x-sdk-date',
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ].join('\n'),
    );
    expect(s.hashedCanonicalRequest).toBe(
      'b25362e603ee30f4f25e7858e8a7160fd36e803bb2dfe206278659d71a9bcd7a',
    );
    // independent recomputation of the remaining steps (algorithm text, not a vendor vector)
    const sts = `SDK-HMAC-SHA256\n20191115T033655Z\n${createHash('sha256').update(s.canonicalRequest).digest('hex')}`;
    const sig = createHmac('sha256', 'MFyf***VmHc').update(sts).digest('hex');
    expect(s.headers.authorization).toBe(
      `SDK-HMAC-SHA256 Access=QTWA***KYUC, SignedHeaders=content-type;host;x-sdk-date, Signature=${sig}`,
    );
  });

  it('formats X-Sdk-Date as YYYYMMDDTHHMMSSZ', () => {
    expect(sdkDate(Date.parse('2019-11-15T03:36:55.123Z'))).toBe('20191115T033655Z');
  });
});
