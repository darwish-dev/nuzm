import { describe, expect, it } from 'vitest';
import { isBlockedAddress } from './ssrf';

describe('isBlockedAddress: IPv6 spellings of a non-public IPv4 are judged by the embedded address (DEFECT-2)', () => {
  it.each([
    '::7f00:1', // IPv4-compatible 127.0.0.1
    '::127.0.0.1',
    '::a9fe:a9fe', // 169.254.169.254
    '::10.0.0.1',
    '::ffff:7f00:1', // mapped
    '::ffff:127.0.0.1',
    '::ffff:0:7f00:1', // SIIT
    '::ffff:0:a00:1',
    '2002:7f00:1::', // 6to4 of 127.0.0.1
    '2002:a9fe:a9fe::1',
    '2002:0a00:0001::',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
    '100::1', // discard-only
    '64:ff9b::7f00:1', // NAT64
    '0064:ff9b::1',
    '[::1]',
    '::',
    'fe80::1',
    'fec0::1',
    'fd00:ec2::254',
    'ff02::1',
    '2001:db8::1',
    '[::ffff:7f00:1]',
    '::FFFF:7F00:1',
    '0:0:0:0:0:0:7f00:1',
    '::ffff:127.0.0.1%eth0',
  ])('%s is blocked', (a) => expect(isBlockedAddress(a)).toBe(true));
  it.each([
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:808:808', // mapped public IPv4 8.8.8.8
    '::808:808',
    '::ffff:0:808:808',
    '2002:808:808::1',
    '8.8.8.8',
  ])('%s is public', (a) => expect(isBlockedAddress(a)).toBe(false));
  it('fails closed on anything that is not an IP literal or cannot be read', () => {
    for (const a of ['', 'example.com', '1:2:3:4:5:6:7:8:9', ':::', '1::2::3', '::g'])
      expect(isBlockedAddress(a)).toBe(true);
  });
});
