import { describe, expect, it } from 'vitest';
import { classifyIpLiteral, EgressPolicy, parseIpv4Loose, parseIpv6 } from './egress';

const DNS: Record<string, string[]> = {
  'npm-mirror.nuzm.internal': ['203.0.113.9'.replace('203.0.113', '93.184.216')],
  'git.nuzm.internal': ['93.184.216.40'],
  'rebind.nuzm.internal': ['10.0.0.5'],
  'models.nuzm.internal': ['93.184.216.50', '10.1.1.1'],
  'approved.example.com': ['93.184.216.77'],
};
const policy = (extra: string[] = []) =>
  new EgressPolicy(
    [{ host: 'npm-mirror.nuzm.internal', ports: [443], purpose: 'package_mirror' }, { host: 'git.nuzm.internal', ports: [443], purpose: 'nuzm_git' }, { host: 'rebind.nuzm.internal', ports: [443], purpose: 'model_gateway' }, { host: 'models.nuzm.internal', ports: [443], purpose: 'model_gateway' }],
    async (h) => {
      if (!DNS[h]) throw new Error('NXDOMAIN');
      return DNS[h]!;
    },
    () => 1_000_000,
  );
void policy;
const p = policy();
const deny = async (url: string, control?: string) => {
  const d = await p.decide(url);
  expect(d.allow, url).toBe(false);
  if (control) expect(d.control, url).toBe(control);
};

describe('IP literal parsing (every spelling a libc accepts)', () => {
  it.each([
    ['127.0.0.1', 0x7f000001], ['127.1', 0x7f000001], ['2130706433', 0x7f000001], ['0x7f000001', 0x7f000001], ['0177.0.0.1', 0x7f000001], ['0x7f.1', 0x7f000001],
    ['017700000001', 0x7f000001], ['10.1', 0x0a000001], ['169.254.169.254', 0xa9fea9fe], ['0', 0],
  ])('%s', (s, v) => expect(parseIpv4Loose(s)).toBe(v));
  it('rejects non-addresses', () => {
    for (const s of ['256.1.1.1', '1.2.3.4.5', 'a.b', '', '1..2', '0x', '08.1']) expect(parseIpv4Loose(s), s).toBeNull();
  });
  it('parses IPv6 including embedded IPv4 and zones', () => {
    expect(parseIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIpv6('[fe80::1%eth0]')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('not-ip')).toBeNull();
  });
});

describe('egress policy: default deny, no bypass (proxy-bypass attempts of the escape suite)', () => {
  it('allows exactly the allow-listed host on its port and pins the resolved address', async () => {
    const d = await p.decide('https://npm-mirror.nuzm.internal/lodash');
    expect(d).toMatchObject({ allow: true, control: 'allowlist', pinnedIp: '93.184.216.9' });
    await deny('https://npm-mirror.nuzm.internal:8443/x', 'port_denied');
    await deny('http://npm-mirror.nuzm.internal:80/x', 'port_denied');
  });
  it.each([
    'https://example.com/', 'https://registry.npmjs.org/', 'https://github.com/x', 'https://evil.example/exfil?d=abc', 'http://allowed.example/',
  ])('an unlisted host is denied by default: %s', (u) => deny(u, 'default_deny'));
  it.each([
    'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://017700000001/', 'http://0/', 'http://0.0.0.0/',
    'http://10.0.0.1/', 'http://172.16.5.5/', 'http://192.168.1.1/', 'http://100.64.0.1/', 'http://[::1]/', 'http://[::]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/',
    'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::]/', 'http://[::127.0.0.1]/', 'http://224.0.0.1/', 'http://240.0.0.1/',
  ])('a private, loopback or reserved IP literal in any spelling is denied: %s', (u) => deny(u));
  it.each(['http://169.254.169.254/latest/meta-data/', 'http://[fd00:ec2::254]/', 'http://100.100.100.200/', 'http://168.63.129.16/', 'http://2852039166/', 'http://0xa9fea9fe/', 'http://metadata.google.internal/', 'http://instance-data/', 'http://kubernetes.default.svc/'])(
    'cloud metadata endpoints are denied: %s',
    (u) => deny(u, 'metadata_endpoint'),
  );
  it('a public IP literal is not accepted either: names only', async () => deny('https://93.184.216.34/', 'default_deny'));
  it.each(['file:///etc/passwd', 'gopher://x/', 'ftp://x/', 'ws://npm-mirror.nuzm.internal/', 'javascript:alert(1)', 'data:text/plain,x'])('non-http(s) scheme denied: %s', (u) => deny(u));
  it.each(['https://npm-mirror.nuzm.internal@evil.example/', 'https://user:pw@npm-mirror.nuzm.internal/', 'https://evil.example#@npm-mirror.nuzm.internal/', 'https://evil.example\\@npm-mirror.nuzm.internal/'])(
    'userinfo and authority tricks are denied: %s',
    (u) => deny(u),
  );
  it('look-alike names are denied: trailing dot is normalised, sub-domains and prefixes are not the allowed host, IDN homographs are punycoded', async () => {
    expect((await p.decide('https://npm-mirror.nuzm.internal./x')).allow).toBe(true); // the same host
    expect((await p.decide('https://NPM-MIRROR.NUZM.INTERNAL/x')).allow).toBe(true);
    for (const u of ['https://x.npm-mirror.nuzm.internal/', 'https://npm-mirror.nuzm.internal.evil.example/', 'https://npm-mirror-nuzm.internal/', 'https://npm-mirror.nuzm.internal%2eevil.example/', 'https://npm-mirror.nuzm.internаl/']) await deny(u, 'default_deny');
  });
  it('DNS rebinding: an allowed name that resolves to a private address is denied; one that mixes public and private is denied', async () => {
    await deny('https://rebind.nuzm.internal/', 'resolved_private');
    await deny('https://models.nuzm.internal/', 'resolved_private');
  });
  it('a name that does not resolve is denied', async () => {
    const q = new EgressPolicy([{ host: 'ghost.nuzm.internal', ports: [443], purpose: 'nuzm_git' }], async () => { throw new Error('NXDOMAIN'); });
    expect((await q.decide('https://ghost.nuzm.internal/')).control).toBe('resolution_failed');
  });
  it('redirects are re-checked on every hop: an allowed origin that redirects to the metadata service or an internal host is denied', async () => {
    const ok = await p.decideRedirectChain('https://npm-mirror.nuzm.internal/a', ['https://git.nuzm.internal/b']);
    expect(ok.allow).toBe(true);
    for (const hop of ['http://169.254.169.254/latest', 'http://127.0.0.1:2375/containers', 'https://evil.example/', '//evil.example/', 'file:///etc/passwd']) {
      const d = await p.decideRedirectChain('https://npm-mirror.nuzm.internal/a', [hop]);
      expect(d.allow, hop).toBe(false);
    }
    expect((await p.decideRedirectChain('https://npm-mirror.nuzm.internal/a', Array(6).fill('https://git.nuzm.internal/x'))).allow).toBe(false);
  });
  it('an egress approval allows ONE host:port for a limited time and nothing else', async () => {
    const approved = [{ host: 'approved.example.com', port: 443, until: 2_000_000 }];
    expect((await p.decide('https://approved.example.com/x', approved)).allow).toBe(true);
    expect((await p.decide('https://approved.example.com:8443/x', approved)).allow).toBe(false);
    expect((await p.decide('https://other.example.com/', approved)).allow).toBe(false);
    expect((await p.decide('https://approved.example.com/x', [{ host: 'approved.example.com', port: 443, until: 999_999 }])).allow).toBe(false); // expired
  });
  it('DNS exfiltration and tunnelling: only exact allow-listed names are answered; sub-domains of an allowed host and long/encoded labels are NXDOMAIN', () => {
    expect(p.decideDns('npm-mirror.nuzm.internal').answer).toBe(true);
    for (const n of ['c2VjcmV0.npm-mirror.nuzm.internal', 'x.evil.example', 'a'.repeat(64) + '.example.com', ('a'.repeat(60) + '.').repeat(5) + 'example.com', 'TXT.evil.example', 'nuzm.internal'])
      expect(p.decideDns(n).answer, n).toBe(false);
  });
  it('classifyIpLiteral says public for public addresses', () => {
    expect(classifyIpLiteral('93.184.216.34')).toMatchObject({ literal: true, blocked: null });
    expect(classifyIpLiteral('2606:2800:220:1::1')).toMatchObject({ literal: true, blocked: null });
    expect(classifyIpLiteral('example.com')).toEqual({ literal: false });
  });
});
