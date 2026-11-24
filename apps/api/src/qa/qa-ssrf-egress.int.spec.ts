import { describe, expect, it } from 'vitest';
import { isBlockedAddress, safeFetch, SsrfError, type SafeFetchDeps } from '@nuzm/domain';
import {
  EgressPolicy,
  classifyIpLiteral,
  DEFAULT_ALLOW,
} from '../modules/appbuilder/internal/sandbox/egress';

/**
 * Session 07 (QA) - independent adversarial tests of the two network-egress decision points that exist today:
 *   (1) `safeFetch`/`isBlockedAddress` (domain, used by the URL fetcher of AI runs: customer-supplied URLs), and
 *   (2) `EgressPolicy` (sandbox proxy policy, M10 section 9; pure, resolver injected).
 * Pure, offline: no network, no DNS. A "differential" test asserts both implementations agree that an address is non-public.
 * `it.fails` marks a DEFECT in code owned by another session (see docs/parallel/sessions/DEFECT-*.md): it states the secure expectation, is expected to fail today and
 * starts failing the day the defect is fixed (then remove the marker). Nothing is weakened.
 */

// Addresses that must never be reachable from a customer-supplied URL or generated code (canonical spellings; what a resolver returns).
const NON_PUBLIC_CANONICAL: [string, string][] = [
  ['0.0.0.0', 'this-network'],
  ['0.1.2.3', 'this-network'],
  ['10.0.0.1', 'rfc1918'],
  ['10.255.255.255', 'rfc1918'],
  ['100.64.0.1', 'cgnat'],
  ['100.127.255.254', 'cgnat'],
  ['127.0.0.1', 'loopback'],
  ['127.255.255.254', 'loopback'],
  ['169.254.169.254', 'metadata'],
  ['169.254.170.2', 'ecs metadata'],
  ['172.16.0.1', 'rfc1918'],
  ['172.31.255.255', 'rfc1918'],
  ['192.0.0.1', 'ietf'],
  ['192.0.2.1', 'doc'],
  ['192.168.1.1', 'rfc1918'],
  ['198.18.0.1', 'benchmark'],
  ['198.19.255.255', 'benchmark'],
  ['198.51.100.7', 'doc'],
  ['203.0.113.9', 'doc'],
  ['224.0.0.1', 'multicast'],
  ['239.255.255.255', 'multicast'],
  ['240.0.0.1', 'reserved'],
  ['255.255.255.255', 'broadcast'],
  ['::', 'unspecified'],
  ['::1', 'loopback'],
  ['::ffff:127.0.0.1', 'mapped loopback'],
  ['::ffff:7f00:1', 'mapped loopback (hex)'],
  ['::ffff:10.0.0.1', 'mapped private'],
  ['::ffff:a9fe:a9fe', 'mapped metadata'],
  ['fc00::1', 'ula'],
  ['fd00:ec2::254', 'aws metadata v6'],
  ['fe80::1', 'link-local'],
  ['fec0::1', 'site-local'],
  ['ff02::1', 'multicast'],
  ['2001:db8::1', 'documentation'],
  ['64:ff9b::7f00:1', 'nat64 loopback'],
];
// Public addresses that must stay reachable (a policy that blocks everything is not "secure", it is broken).
const PUBLIC: string[] = [
  '93.184.216.34',
  '8.8.8.8',
  '1.1.1.1',
  '172.15.255.255',
  '172.32.0.1',
  '100.63.255.255',
  '100.128.0.1',
  '198.17.255.255',
  '198.20.0.1',
  '223.255.255.255',
  '2606:4700:4700::1111',
  '2a00:1450:4001:81b::200e',
];

describe('QA: isBlockedAddress (customer URL fetcher) - resolved addresses', () => {
  it.each(NON_PUBLIC_CANONICAL)('blocks %s (%s)', (a) => {
    expect(isBlockedAddress(a)).toBe(true);
  });
  it.each(PUBLIC)('allows the public address %s', (a) => {
    expect(isBlockedAddress(a)).toBe(false);
  });
  it.each([
    '',
    ' ',
    'localhost',
    'example.com',
    '1.2.3',
    '1.2.3.4.5',
    '999.1.1.1',
    '0x7f.0.0.1',
    'abc',
  ])('refuses a non-literal or malformed address %j (fail closed)', (a) => {
    expect(isBlockedAddress(a)).toBe(true);
  });
});

describe('QA: EgressPolicy classifyIpLiteral (sandbox) - resolved addresses', () => {
  it.each(NON_PUBLIC_CANONICAL)('blocks %s (%s)', (a) => {
    const c = classifyIpLiteral(a);
    expect(c.literal).toBe(true);
    if (c.literal) expect(c.blocked !== null || c.metadata).toBe(true);
  });
  it.each(PUBLIC)('allows the public address %s', (a) => {
    const c = classifyIpLiteral(a);
    expect(c.literal).toBe(true);
    if (c.literal) expect(c.blocked).toBeNull();
  });
});

describe('QA: both implementations agree on the blocked set (differential)', () => {
  it('agrees for every address of the corpus', () => {
    const disagreements: string[] = [];
    for (const [a] of NON_PUBLIC_CANONICAL) {
      const c = classifyIpLiteral(a);
      const e = c.literal && (c.blocked !== null || c.metadata);
      if (isBlockedAddress(a) !== e) disagreements.push(a);
    }
    expect(disagreements).toEqual([]);
  });
});

// IPv6 spellings of an IPv4 address that the URL fetcher's own list does not cover. A resolver (getaddrinfo) can return mapped or translated forms; the sandbox policy
// rejects every one, the customer URL fetcher only the `::ffff:` form. On Linux these ranges are normally unroutable, so this is defence in depth, not a proven exploit.
const V6_EMBEDDED_V4: [string, string][] = [
  ['::7f00:1', 'IPv4-compatible loopback'],
  ['::127.0.0.1', 'IPv4-compatible loopback (dotted)'],
  ['::a9fe:a9fe', 'IPv4-compatible metadata'],
  ['2002:7f00:1::', '6to4 loopback'],
  ['2002:a9fe:a9fe::1', '6to4 metadata'],
  ['2002:0a00:0001::', '6to4 10.0.0.1'],
  ['::ffff:0:7f00:1', 'SIIT loopback'],
  ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'Teredo'],
  ['100::1', 'discard-only prefix'],
];
// DEFECT-3 (Session 04, `egress.ts` `blockedV6`): the IPv4-mapped test reads groups 5 only (`::ffff:a.b.c.d`), so the SIIT form `::ffff:0:a.b.c.d` (group 4 = ffff) is not
// recognised; and the discard-only prefix 100::/64 (RFC 6666) is not listed. Both are unroutable on a normal host: LOW, defence in depth.
const SANDBOX_GAPS = new Set(['::ffff:0:7f00:1', '100::1']);
describe('QA: IPv4 embedded in an IPv6 address', () => {
  it.fails.each(V6_EMBEDDED_V4.filter(([a]) => SANDBOX_GAPS.has(a)))(
    'DEFECT-3: sandbox policy blocks %s (%s)',
    (a) => {
      const c = classifyIpLiteral(a);
      expect(c.literal).toBe(true);
      if (c.literal) expect(c.blocked !== null || c.metadata).toBe(true);
    },
  );
  it.each(V6_EMBEDDED_V4.filter(([a]) => !SANDBOX_GAPS.has(a)))(
    'sandbox policy blocks %s (%s)',
    (a) => {
      const c = classifyIpLiteral(a);
      expect(c.literal).toBe(true);
      if (c.literal) expect(c.blocked !== null || c.metadata).toBe(true);
    },
  );
  it.fails.each(V6_EMBEDDED_V4.filter(([a]) => !a.startsWith('100::')))(
    'DEFECT-2: customer URL fetcher blocks %s (%s)',
    (a) => {
      expect(isBlockedAddress(a)).toBe(true);
    },
  );
});

describe('QA: EgressPolicy.decide - URL level attacks (resolver injected)', () => {
  const resolverTo =
    (map: Record<string, string[]>) =>
    async (h: string): Promise<string[]> => {
      const v = map[h];
      if (!v) throw new Error('NXDOMAIN');
      return v;
    };
  const pub = '93.184.216.34';
  const policy = (map: Record<string, string[]> = {}, now = () => 1_000) =>
    new EgressPolicy(
      DEFAULT_ALLOW,
      resolverTo({ 'npm-mirror.nuzm.internal': [pub], 'models.nuzm.internal': [pub], ...map }),
      now,
    );

  it('allows an exact allow-listed host on its port and pins the resolved address', async () => {
    const d = await policy().decide('https://npm-mirror.nuzm.internal/left-pad');
    expect(d.allow).toBe(true);
    expect(d.pinnedIp).toBe(pub);
  });
  it.each([
    ['not a URL', 'default_deny'],
    ['ftp://npm-mirror.nuzm.internal/x', 'scheme_denied'],
    ['file:///etc/passwd', 'scheme_denied'],
    ['gopher://npm-mirror.nuzm.internal', 'scheme_denied'],
    ['javascript:alert(1)', 'scheme_denied'],
    ['data:text/plain,hi', 'scheme_denied'],
    ['https://user:pw@npm-mirror.nuzm.internal/', 'userinfo_denied'],
    ['https://user@npm-mirror.nuzm.internal/', 'userinfo_denied'],
    ['https://127.0.0.1/', 'ip_literal_private'],
    ['https://2130706433/', 'ip_literal_private'],
    ['https://0x7f000001/', 'ip_literal_private'],
    ['https://0177.0.0.1/', 'ip_literal_private'],
    ['https://127.1/', 'ip_literal_private'],
    ['https://[::1]/', 'ip_literal_private'],
    ['https://[::ffff:127.0.0.1]/', 'ip_literal_private'],
    ['https://[::ffff:7f00:1]/', 'ip_literal_private'],
    ['https://[fd00:ec2::254]/', 'metadata_endpoint'],
    ['https://169.254.169.254/latest/meta-data/', 'metadata_endpoint'],
    ['http://169.254.169.254/', 'metadata_endpoint'],
    ['https://metadata.google.internal/', 'metadata_endpoint'],
    ['https://metadata.google.internal./', 'metadata_endpoint'],
    ['https://kubernetes.default.svc/', 'metadata_endpoint'],
    ['https://8.8.8.8/', 'default_deny'],
    ['https://example.com/', 'default_deny'],
    ['https://evil.npm-mirror.nuzm.internal/', 'default_deny'],
    ['https://npm-mirror.nuzm.internal.evil.example/', 'default_deny'],
    ['https://npm-mirror.nuzm.internal@evil.example/', 'userinfo_denied'],
    ['https://evil.example#@npm-mirror.nuzm.internal/', 'default_deny'],
    ['https://npm-mirror.nuzm.internal:8443/', 'port_denied'],
    ['http://npm-mirror.nuzm.internal/', 'port_denied'],
    ['https://NPM-MIRROR.NUZM.INTERNAL:22/', 'port_denied'],
  ])('refuses %s (%s)', async (url, control) => {
    const d = await policy().decide(url);
    expect(d.allow).toBe(false);
    expect(d.control).toBe(control);
  });

  it('a trailing dot and upper case do not create a second spelling of an allowed host', async () => {
    expect((await policy().decide('https://NPM-Mirror.nuzm.internal./a')).allow).toBe(true);
  });

  it('refuses an allow-listed name that resolves (or rebinds) to a private, loopback or metadata address', async () => {
    for (const bad of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '::1',
      '::ffff:7f00:1',
      'fd00:ec2::254',
      '192.168.0.5',
    ]) {
      const d = await policy({ 'npm-mirror.nuzm.internal': [bad] }).decide(
        'https://npm-mirror.nuzm.internal/',
      );
      expect(d.allow, bad).toBe(false);
      expect(['resolved_private', 'metadata_endpoint']).toContain(d.control);
    }
  });
  it('one bad answer among several refuses the whole name (no "pick the good one")', async () => {
    const d = await policy({ 'npm-mirror.nuzm.internal': [pub, '127.0.0.1'] }).decide(
      'https://npm-mirror.nuzm.internal/',
    );
    expect(d.allow).toBe(false);
  });
  it('a resolver failure or an empty answer is a refusal', async () => {
    expect(
      (
        await new EgressPolicy(DEFAULT_ALLOW, async () => {
          throw new Error('x');
        }).decide('https://npm-mirror.nuzm.internal/')
      ).control,
    ).toBe('resolution_failed');
    expect(
      (
        await new EgressPolicy(DEFAULT_ALLOW, async () => []).decide(
          'https://npm-mirror.nuzm.internal/',
        )
      ).control,
    ).toBe('resolution_failed');
    expect(
      (
        await new EgressPolicy(DEFAULT_ALLOW, async () => ['not-an-ip']).decide(
          'https://npm-mirror.nuzm.internal/',
        )
      ).allow,
    ).toBe(false);
  });

  it('an approval is bound to the exact host and port and expires', async () => {
    const approved = [{ host: 'api.vendor.example', port: 443, until: 2_000 }];
    const p = policy({ 'api.vendor.example': [pub] }, () => 1_000);
    expect((await p.decide('https://api.vendor.example/x', approved)).allow).toBe(true);
    expect((await p.decide('https://api.vendor.example:8443/x', approved)).allow).toBe(false);
    expect((await p.decide('https://other.vendor.example/x', approved)).allow).toBe(false);
    expect((await p.decide('https://sub.api.vendor.example/x', approved)).allow).toBe(false);
    const later = policy({ 'api.vendor.example': [pub] }, () => 2_000);
    expect((await later.decide('https://api.vendor.example/x', approved)).allow).toBe(false);
  });
  it('an approval never overrides the private-address and metadata blocks', async () => {
    const p = policy({ 'internal.vendor.example': ['10.0.0.9'] }, () => 1);
    const d = await p.decide('https://internal.vendor.example/', [
      { host: 'internal.vendor.example', port: 443, until: 10 },
    ]);
    expect(d.allow).toBe(false);
    expect(d.control).toBe('resolved_private');
  });

  it('every redirect hop is decided again; a redirect to metadata, loopback or a scheme change is refused', async () => {
    const p = policy();
    for (const hop of [
      'https://169.254.169.254/latest',
      'http://127.0.0.1:8080/',
      'https://example.com/',
      'file:///etc/passwd',
      '//169.254.169.254/x',
    ]) {
      const d = await p.decideRedirectChain('https://npm-mirror.nuzm.internal/a', [hop]);
      expect(d.allow, hop).toBe(false);
    }
    const ok = await p.decideRedirectChain('https://npm-mirror.nuzm.internal/a', ['/b', '/c']);
    expect(ok.allow).toBe(true);
  });
  it('caps a redirect chain at five hops', async () => {
    const d = await policy().decideRedirectChain(
      'https://npm-mirror.nuzm.internal/a',
      Array(7).fill('/x'),
    );
    expect(d.allow).toBe(false);
    expect(d.control).toBe('redirect_denied');
  });

  it('DNS: only exact allow-listed names are answered, so a name under an allowed zone cannot carry data out', () => {
    const p = policy();
    expect(p.decideDns('npm-mirror.nuzm.internal').answer).toBe(true);
    expect(p.decideDns('NPM-MIRROR.nuzm.internal.').answer).toBe(true);
    for (const n of [
      'c2VjcmV0.npm-mirror.nuzm.internal',
      'nuzm.internal',
      'evil.example',
      `${'a'.repeat(64)}.nuzm.internal`,
      `${'a.'.repeat(130)}internal`,
      '',
    ])
      expect(p.decideDns(n).answer, n).toBe(false);
  });
});

describe('QA: safeFetch (customer URL fetcher) - policy', () => {
  type Hop = { status: number; location?: string };
  const make = (resolveMap: Record<string, string[]>, hops: Hop[]) => {
    const requests: { url: string; to: string }[] = [];
    let i = 0;
    const deps: SafeFetchDeps = {
      resolve: async (h) => resolveMap[h] ?? [],
      request: async (u, to) => {
        requests.push({ url: u.toString(), to });
        const h = hops[Math.min(i++, hops.length - 1)]!;
        return {
          status: h.status,
          headers: { get: (n) => (n.toLowerCase() === 'location' ? (h.location ?? null) : null) },
          readBody: async () => ({ bytes: new TextEncoder().encode('ok'), truncated: false }),
        };
      },
    };
    return { deps, requests };
  };
  const PUB = { 'public.example': ['93.184.216.34'] };
  const code = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return e instanceof SsrfError ? e.code : `other:${(e as Error).message}`;
    }
  };

  it('fetches a public page and connects to the vetted address', async () => {
    const { deps, requests } = make(PUB, [{ status: 200 }]);
    const r = await safeFetch('https://public.example/a', deps);
    expect(r.status).toBe(200);
    expect(requests[0]!.to).toBe('93.184.216.34');
  });
  it.each([
    ['ftp://public.example/', 'bad_url'],
    ['file:///etc/passwd', 'bad_url'],
    ['https://u:p@public.example/', 'bad_url'],
    ['https://public.example:8443/', 'bad_url'],
    ['https://public.example:22/', 'bad_url'],
    ['http://localhost/', 'blocked_address'],
    ['http://foo.localhost/', 'blocked_address'],
    ['http://db.internal/', 'blocked_address'],
    ['http://printer.local/', 'blocked_address'],
    ['http://127.0.0.1/', 'blocked_address'],
    ['http://2130706433/', 'blocked_address'],
    ['http://0x7f.1/', 'blocked_address'],
    ['http://[::1]/', 'blocked_address'],
    ['http://[::ffff:169.254.169.254]/', 'blocked_address'],
    ['http://169.254.169.254/latest/meta-data/', 'blocked_address'],
    ['http://unknown.example/', 'blocked_address'],
  ])('refuses %s before any request is made (%s)', async (url, c) => {
    const { deps, requests } = make(PUB, [{ status: 200 }]);
    expect(await code(safeFetch(url, deps))).toBe(c);
    expect(requests).toHaveLength(0);
  });
  it('refuses a name with ANY non-public answer (DNS rebinding resistant)', async () => {
    const { deps, requests } = make({ 'mixed.example': ['93.184.216.34', '10.0.0.5'] }, [
      { status: 200 },
    ]);
    expect(await code(safeFetch('https://mixed.example/', deps))).toBe('blocked_address');
    expect(requests).toHaveLength(0);
  });
  it('re-vets every redirect hop: public -> metadata is refused after the first request only', async () => {
    const { deps, requests } = make(PUB, [
      { status: 302, location: 'http://169.254.169.254/latest/meta-data/' },
      { status: 200 },
    ]);
    expect(await code(safeFetch('https://public.example/', deps))).toBe('blocked_address');
    expect(requests).toHaveLength(1);
  });
  it('re-vets a redirect to a name that resolves privately', async () => {
    const { deps } = make({ ...PUB, 'evil.example': ['10.0.0.8'] }, [
      { status: 301, location: 'https://evil.example/' },
      { status: 200 },
    ]);
    expect(await code(safeFetch('https://public.example/', deps))).toBe('blocked_address');
  });
  it('caps redirects, rejects a redirect without Location and a non-2xx status', async () => {
    expect(
      await code(
        safeFetch('https://public.example/', make(PUB, [{ status: 302, location: '/x' }]).deps),
      ),
    ).toBe('too_many_redirects');
    expect(
      await code(safeFetch('https://public.example/', make(PUB, [{ status: 302 }]).deps)),
    ).toBe('bad_status');
    expect(
      await code(safeFetch('https://public.example/', make(PUB, [{ status: 500 }]).deps)),
    ).toBe('bad_status');
  });
  it('caps the body size', async () => {
    const deps: SafeFetchDeps = {
      resolve: async () => ['93.184.216.34'],
      request: async () => ({
        status: 200,
        headers: { get: () => null },
        readBody: async (max) => ({ bytes: new Uint8Array(max), truncated: true }),
      }),
    };
    expect(await code(safeFetch('https://public.example/', deps))).toBe('too_large');
  });
  it('turns an aborted request into a timeout', async () => {
    const deps: SafeFetchDeps = {
      resolve: async () => ['93.184.216.34'],
      request: (_u, _to, signal) =>
        new Promise((_res, rej) =>
          signal.addEventListener('abort', () => rej(new Error('aborted'))),
        ),
    };
    expect(
      await code(
        safeFetch('https://public.example/', deps, {
          maxBytes: 10,
          timeoutMs: 20,
          maxRedirects: 3,
        }),
      ),
    ).toBe('timeout');
  });
});
