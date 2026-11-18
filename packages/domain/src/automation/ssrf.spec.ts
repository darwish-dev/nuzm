import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EGRESS,
  SafeHttpClient,
  SsrfError,
  checkUrl,
  isDeniedAddress,
  parseIPv6,
  resolvePublic,
  type Transport,
} from './ssrf';

const denied = (u: string) => {
  try {
    checkUrl(u);
    return false;
  } catch (e) {
    return e instanceof SsrfError;
  }
};

/** AC-M11-03: at least 40 payloads, none reaches an internal target. */
const URL_PAYLOADS = [
  'https://localhost/',
  'https://LOCALHOST/',
  'https://localhost./',
  'https://app.localhost/',
  'https://127.0.0.1/',
  'https://127.1/',
  'https://127.0.0.1.:443/',
  'https://2130706433/',
  'https://0x7f000001/',
  'https://0x7f.0x0.0x0.0x1/',
  'https://0177.0.0.1/',
  'https://017700000001/',
  'https://0/',
  'https://0.0.0.0/',
  'https://10.0.0.1/',
  'https://10.255.255.255/',
  'https://172.16.0.1/',
  'https://172.31.255.254/',
  'https://192.168.1.1/',
  'https://169.254.169.254/latest/meta-data/',
  'https://169.254.169.254.:443/',
  'https://100.100.100.200/',
  'https://100.64.0.1/',
  'https://metadata.google.internal/',
  'https://metadata/',
  'https://[::1]/',
  'https://[::]/',
  'https://[::ffff:127.0.0.1]/',
  'https://[::ffff:7f00:1]/',
  'https://[0:0:0:0:0:ffff:a00:1]/',
  'https://[fe80::1]/',
  'https://[fc00::1]/',
  'https://[fd00:ec2::254]/',
  'https://[64:ff9b::7f00:1]/',
  'https://[2002:7f00:1::1]/',
  'https://[::127.0.0.1]/',
  'https://internal.corp/',
  'https://db.cluster.local/',
  'https://printer.lan/',
  'https://svc.default.svc/',
  'https://127。0。0。1/',
  'https://%31%32%37.0.0.1/',
  'https://127.0.0.1:8080/',
  'https://example.com:22/',
  'https://user:pass@example.com/',
  'http://example.com/',
  'ftp://example.com/',
  'file:///etc/passwd',
  'gopher://example.com/',
  'javascript:alert(1)',
  'https://',
  '',
  'not a url',
  'https://exa mple.com/',
  'https://singlelabel/',
  'https://198.18.0.1/',
  'https://224.0.0.1/',
  'https://255.255.255.255/',
  'https://[ff02::1]/',
  'https://203.0.113.5/',
];

describe('SSRF: URL and address policy (AC-M11-03)', () => {
  it('denies every payload in the corpus', () => {
    expect(URL_PAYLOADS.length).toBeGreaterThanOrEqual(40);
    const leaked = URL_PAYLOADS.filter((u) => !denied(u));
    expect(leaked).toEqual([]);
  });
  it('a backslash cannot smuggle a second host: the parsed host is what is checked and resolved', () => {
    expect(checkUrl('https://evil.example.com\\@127.0.0.1/').host).toBe('evil.example.com');
  });
  it('allows ordinary public https URLs', () => {
    expect(() => checkUrl('https://api.example.com/hook?x=1')).not.toThrow();
    expect(() => checkUrl('https://api.example.com:8443/x')).not.toThrow();
    expect(() => checkUrl('https://93.184.216.34/')).not.toThrow();
    expect(() => checkUrl('https://[2606:4700:4700::1111]/')).not.toThrow();
  });
  it('classifies addresses', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.0.9',
      '169.254.1.1',
      '100.64.1.1',
      '0.1.2.3',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      '::ffff:10.0.0.1',
      '2001:db8::1',
      'garbage',
      '',
    ])
      expect(isDeniedAddress(a), a).toBe(true);
    for (const a of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8'])
      expect(isDeniedAddress(a), a).toBe(false);
  });
  it('parses IPv6 forms and rejects malformed ones', () => {
    expect(parseIPv6('::1')?.[15]).toBe(1);
    expect(parseIPv6('1:2:3:4:5:6:7:8')).not.toBeNull();
    expect(parseIPv6('1::2::3')).toBeNull();
    expect(parseIPv6('fe80::1%eth0')).toBeNull();
    expect(parseIPv6('1:2:3:4:5:6:7:8:9')).toBeNull();
  });
  it('honours an allow-list', () => {
    const p = { ...DEFAULT_EGRESS, allowHosts: ['api.example.com', '*.partner.test'] };
    expect(() => checkUrl('https://api.example.com/', p)).not.toThrow();
    expect(() => checkUrl('https://x.partner.test/', p)).not.toThrow();
    expect(() => checkUrl('https://other.example.com/', p)).toThrow(SsrfError);
  });
});

describe('SSRF: DNS rebinding, redirects, size, time', () => {
  const okTransport: Transport = async () => ({ status: 200, headers: {}, body: 'ok' });
  it('refuses a name that resolves to a private address, even when other answers are public', async () => {
    await expect(
      resolvePublic(checkUrl('https://rebind.example.com/'), async () => ['10.0.0.5']),
    ).rejects.toThrow(/non-public/);
    await expect(
      resolvePublic(checkUrl('https://rebind.example.com/'), async () => [
        '93.184.216.34',
        '127.0.0.1',
      ]),
    ).rejects.toThrow(/non-public/);
    await expect(
      resolvePublic(checkUrl('https://rebind.example.com/'), async () => [
        '::ffff:169.254.169.254',
      ]),
    ).rejects.toThrow(/non-public/);
    await expect(
      resolvePublic(checkUrl('https://nx.example.com/'), async () => []),
    ).rejects.toThrow(/did not resolve/);
  });
  it('connects to the vetted address and never resolves a second time (rebinding between check and use)', async () => {
    let lookups = 0;
    const seen: string[] = [];
    const c = new SafeHttpClient(
      DEFAULT_EGRESS,
      async () => (++lookups === 1 ? ['93.184.216.34'] : ['127.0.0.1']), // a second lookup would return loopback
      async (r) => {
        seen.push(r.ip);
        return { status: 200, headers: {}, body: 'x' };
      },
    );
    await c.request({ url: 'https://rebind.example.com/' });
    expect(lookups).toBe(1);
    expect(seen).toEqual(['93.184.216.34']);
  });
  it('re-validates every redirect hop from scratch', async () => {
    const hops = [
      'https://169.254.169.254/latest',
      'http://example.com/plain',
      'https://localhost/x',
      'https://[::1]/',
    ];
    for (const loc of hops) {
      const c = new SafeHttpClient(
        DEFAULT_EGRESS,
        async () => ['93.184.216.34'],
        async () => ({ status: 302, headers: { location: loc }, body: '' }),
      );
      await expect(c.request({ url: 'https://a.example.com/' }), loc).rejects.toBeInstanceOf(
        SsrfError,
      );
    }
    // a redirect to a name that resolves privately is caught by the per-hop resolution
    const c = new SafeHttpClient(
      DEFAULT_EGRESS,
      async (h) => (h === 'a.example.com' ? ['93.184.216.34'] : ['10.0.0.9']),
      async () => ({ status: 301, headers: { location: 'https://b.example.com/' }, body: '' }),
    );
    await expect(c.request({ url: 'https://a.example.com/' })).rejects.toThrow(/non-public/);
  });
  it('limits redirects and never replays a POST at another URL', async () => {
    let n = 0;
    const loop = new SafeHttpClient(
      DEFAULT_EGRESS,
      async () => ['93.184.216.34'],
      async () => ({
        status: 302,
        headers: { location: `https://a.example.com/${++n}` },
        body: '',
      }),
    );
    await expect(loop.request({ url: 'https://a.example.com/' })).rejects.toThrow(
      /too many redirects/,
    );
    const post = new SafeHttpClient(
      DEFAULT_EGRESS,
      async () => ['93.184.216.34'],
      async () => ({ status: 307, headers: { location: 'https://evil.example.net/' }, body: '' }),
    );
    const r = await post.request({ url: 'https://a.example.com/', method: 'POST', body: '{}' });
    expect(r.status).toBe(307);
    expect(r.finalUrl).toBe('https://a.example.com/');
  });
  it('caps the response at 5 MB', async () => {
    const big = new SafeHttpClient(
      DEFAULT_EGRESS,
      async () => ['93.184.216.34'],
      async () => ({ status: 200, headers: {}, body: 'x'.repeat(5 * 1024 * 1024 + 1) }),
    );
    await expect(big.request({ url: 'https://a.example.com/' })).rejects.toThrow(
      /larger than the cap/,
    );
    const fine = new SafeHttpClient(DEFAULT_EGRESS, async () => ['93.184.216.34'], okTransport);
    expect((await fine.request({ url: 'https://a.example.com/' })).body).toBe('ok');
  });
  it('enforces the 30 s deadline across hops', async () => {
    let t = 0;
    const c = new SafeHttpClient(
      DEFAULT_EGRESS,
      async () => ['93.184.216.34'],
      async () => {
        t += 31_000;
        return { status: 302, headers: { location: 'https://a.example.com/next' }, body: '' };
      },
      () => t,
    );
    await expect(c.request({ url: 'https://a.example.com/' })).rejects.toThrow(/timed out/);
  });
});
