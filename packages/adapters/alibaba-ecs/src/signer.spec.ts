import { describe, expect, it } from 'vitest';
import { canonicalQuery, pctEncode, sha256Hex, signV3 } from './signer';

describe('ACS3-HMAC-SHA256 signer', () => {
  it("reproduces the documentation's worked example (RunInstances, cn-shanghai) exactly", () => {
    // Inputs and expected values are the ones printed on
    // https://www.alibabacloud.com/help/en/sdk/product-overview/v3-request-structure-and-signature (read 2026-11-18)
    const s = signV3({
      method: 'POST',
      host: 'ecs.cn-shanghai.aliyuncs.com',
      action: 'RunInstances',
      version: '2014-05-26',
      query: {
        ImageId: 'win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd',
        RegionId: 'cn-shanghai',
      },
      date: '2023-10-26T10:22:32Z',
      nonce: '3156853299f313e23d1673dc12e1703d',
      accessKeyId: 'YourAccessKeyId',
      accessKeySecret: 'YourAccessKeySecret',
    });
    expect(s.canonicalRequest).toBe(
      [
        'POST',
        '/',
        'ImageId=win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd&RegionId=cn-shanghai',
        'host:ecs.cn-shanghai.aliyuncs.com',
        'x-acs-action:RunInstances',
        'x-acs-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-acs-date:2023-10-26T10:22:32Z',
        'x-acs-signature-nonce:3156853299f313e23d1673dc12e1703d',
        'x-acs-version:2014-05-26',
        '',
        'host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version',
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ].join('\n'),
    );
    expect(sha256Hex(s.canonicalRequest)).toBe(
      '7ea06492da5221eba5297e897ce16e55f964061054b7695beedaac1145b1e259',
    );
    expect(s.headers.authorization).toBe(
      'ACS3-HMAC-SHA256 Credential=YourAccessKeyId,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0',
    );
  });

  it('percent-encodes per RFC 3986 and sorts parameters', () => {
    expect(pctEncode("a b*c!'()~-_.")).toBe('a%20b%2Ac%21%27%28%29~-_.');
    expect(canonicalQuery({ 'Tag.1.Key': 'k', Action: 'x y', Tag: 'é' })).toBe(
      'Action=x%20y&Tag=%C3%A9&Tag.1.Key=k',
    );
  });
});
