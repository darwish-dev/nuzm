import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DNS_OPTIONS,
  chunkTxt,
  normalizeName,
  validateChangeSet,
  validateRecordInput,
  type DnsChangeInput,
  type DnsRecord,
  type DnsRecordInput,
} from './index';

const Z = 'example.com';
const opts = { protectedTargetSuffixes: ['sites.nuzm-hosting.test'] };
const one = (record: DnsRecordInput, existing: DnsRecord[] = [], o = {}) =>
  validateChangeSet(Z, existing, [{ op: 'create', record }], { ...opts, ...o });

// AC-M07-05: >= 40 valid and >= 40 invalid fixtures
const VALID: [string, DnsRecordInput][] = [
  ['A apex', { name: '@', type: 'A', ttl: 300, value: '203.0.113.10' }],
  ['A www', { name: 'www', type: 'A', ttl: 3600, value: '198.51.100.7' }],
  ['A default ttl', { name: 'api', type: 'A', value: '192.0.2.1' }],
  ['A fqdn owner', { name: 'shop.example.com', type: 'A', ttl: 60, value: '192.0.2.2' }],
  ['A wildcard', { name: '*', type: 'A', ttl: 600, value: '192.0.2.3' }],
  ['A wildcard sub', { name: '*.apps', type: 'A', ttl: 600, value: '192.0.2.4' }],
  ['A private rfc1918 allowed', { name: 'intra', type: 'A', ttl: 600, value: '10.0.0.5' }],
  ['A max ttl', { name: 'long', type: 'A', ttl: 86400, value: '192.0.2.5' }],
  ['AAAA apex', { name: '@', type: 'AAAA', ttl: 300, value: '2001:db8::1' }],
  [
    'AAAA full',
    { name: 'v6', type: 'AAAA', ttl: 300, value: '2001:0db8:0000:0000:0000:0000:0000:0002' },
  ],
  ['AAAA upper', { name: 'v6b', type: 'AAAA', ttl: 300, value: '2001:DB8::3' }],
  ['CNAME www', { name: 'www', type: 'CNAME', ttl: 300, value: 'target.example.net' }],
  ['CNAME trailing dot', { name: 'blog', type: 'CNAME', ttl: 300, value: 'blog.example.net.' }],
  [
    'CNAME underscore',
    { name: '_dmarc-alias', type: 'CNAME', ttl: 300, value: 'dmarc.example.net' },
  ],
  ['CNAME idn target', { name: 'idn', type: 'CNAME', ttl: 300, value: 'مثال.السعودية' }],
  [
    'MX basic',
    { name: '@', type: 'MX', ttl: 3600, value: { priority: 10, host: 'mail.example.net' } },
  ],
  [
    'MX prio 0',
    { name: '@', type: 'MX', ttl: 3600, value: { priority: 0, host: 'mx0.example.net' } },
  ],
  [
    'MX prio 65535',
    { name: 'mail', type: 'MX', ttl: 3600, value: { priority: 65535, host: 'mx.example.net.' } },
  ],
  ['TXT spf', { name: '@', type: 'TXT', ttl: 3600, value: 'v=spf1 include:_spf.example.net ~all' }],
  [
    'TXT dkim long',
    {
      name: 's1._domainkey',
      type: 'TXT',
      ttl: 3600,
      value: 'v=DKIM1; k=rsa; p=' + 'A'.repeat(400),
    },
  ],
  ['TXT with quotes', { name: 'q', type: 'TXT', ttl: 3600, value: 'he said "hi"' }],
  ['TXT unicode', { name: 'u', type: 'TXT', ttl: 3600, value: 'مرحبا' }],
  ['TXT dmarc', { name: '_dmarc', type: 'TXT', ttl: 3600, value: 'v=DMARC1; p=none' }],
  [
    'TXT verification',
    { name: '@', type: 'TXT', ttl: 300, value: 'google-site-verification=abc123' },
  ],
  [
    'SRV basic',
    {
      name: '_sip._tcp',
      type: 'SRV',
      ttl: 3600,
      value: { priority: 10, weight: 5, port: 5060, target: 'sip.example.net' },
    },
  ],
  [
    'SRV null target',
    {
      name: '_xmpp._tcp',
      type: 'SRV',
      ttl: 3600,
      value: { priority: 0, weight: 0, port: 0, target: '.' },
    },
  ],
  [
    'SRV zero weight',
    {
      name: '_ldap._tcp',
      type: 'SRV',
      ttl: 3600,
      value: { priority: 1, weight: 0, port: 389, target: 'ldap.example.net' },
    },
  ],
  [
    'CAA issue',
    {
      name: '@',
      type: 'CAA',
      ttl: 3600,
      value: { flags: 0, tag: 'issue', value: 'letsencrypt.org' },
    },
  ],
  [
    'CAA issuewild',
    {
      name: '@',
      type: 'CAA',
      ttl: 3600,
      value: { flags: 0, tag: 'issuewild', value: 'letsencrypt.org' },
    },
  ],
  [
    'CAA iodef mailto',
    {
      name: '@',
      type: 'CAA',
      ttl: 3600,
      value: { flags: 0, tag: 'iodef', value: 'mailto:sec@example.com' },
    },
  ],
  [
    'CAA iodef https',
    {
      name: '@',
      type: 'CAA',
      ttl: 3600,
      value: { flags: 128, tag: 'iodef', value: 'https://example.com/caa' },
    },
  ],
  [
    'CAA issue none',
    { name: '@', type: 'CAA', ttl: 3600, value: { flags: 0, tag: 'issue', value: '' } },
  ],
  [
    'CAA with params',
    {
      name: '@',
      type: 'CAA',
      ttl: 3600,
      value: { flags: 0, tag: 'issue', value: 'ca.example.net; account=123' },
    },
  ],
  ['NS delegation', { name: 'sub', type: 'NS', ttl: 3600, value: 'ns1.example.net' }],
  ['NS delegation 2', { name: 'dev.team', type: 'NS', ttl: 3600, value: 'ns2.example.net.' }],
  ['lower type accepted', { name: 'lc', type: 'a', ttl: 300, value: '192.0.2.9' }],
  ['IDN owner', { name: 'مثال', type: 'A', ttl: 300, value: '192.0.2.10' }],
  ['uppercase owner', { name: 'WWW', type: 'A', ttl: 300, value: '192.0.2.11' }],
  ['trailing dot owner', { name: 'host.example.com.', type: 'A', ttl: 300, value: '192.0.2.12' }],
  ['numeric label', { name: '123', type: 'A', ttl: 300, value: '192.0.2.13' }],
  ['hyphen label', { name: 'my-host', type: 'A', ttl: 300, value: '192.0.2.14' }],
  ['63 char label', { name: 'a'.repeat(63), type: 'A', ttl: 300, value: '192.0.2.15' }],
  ['deep name', { name: 'a.b.c.d.e', type: 'A', ttl: 300, value: '192.0.2.16' }],
  ['txt 255 exact', { name: 't255', type: 'TXT', ttl: 300, value: 'x'.repeat(255) }],
  ['txt 256 chunked', { name: 't256', type: 'TXT', ttl: 300, value: 'x'.repeat(256) }],
  [
    'MX to ip-like label host',
    { name: 'mx9', type: 'MX', ttl: 300, value: { priority: 5, host: 'mx9.example.org' } },
  ],
];
const INVALID: [string, DnsRecordInput, string][] = [
  ['bad type', { name: 'x', type: 'ALIAS', ttl: 300, value: 'a.b' }, 'invalid_type'],
  ['empty type', { name: 'x', type: '', ttl: 300, value: '1.1.1.1' }, 'invalid_type'],
  ['ttl too low', { name: 'x', type: 'A', ttl: 59, value: '192.0.2.1' }, 'invalid_ttl'],
  ['ttl too high', { name: 'x', type: 'A', ttl: 86401, value: '192.0.2.1' }, 'invalid_ttl'],
  ['ttl float', { name: 'x', type: 'A', ttl: 300.5, value: '192.0.2.1' }, 'invalid_ttl'],
  ['ttl negative', { name: 'x', type: 'A', ttl: -1, value: '192.0.2.1' }, 'invalid_ttl'],
  [
    'ttl string',
    { name: 'x', type: 'A', ttl: '300' as unknown as number, value: '192.0.2.1' },
    'invalid_ttl',
  ],
  ['A not ip', { name: 'x', type: 'A', ttl: 300, value: 'example.org' }, 'invalid_value'],
  ['A octet range', { name: 'x', type: 'A', ttl: 300, value: '256.1.1.1' }, 'invalid_value'],
  ['A too short', { name: 'x', type: 'A', ttl: 300, value: '1.2.3' }, 'invalid_value'],
  ['A v6 in A', { name: 'x', type: 'A', ttl: 300, value: '2001:db8::1' }, 'invalid_value'],
  ['A object', { name: 'x', type: 'A', ttl: 300, value: { ip: '1.1.1.1' } }, 'invalid_value'],
  ['A loopback', { name: 'x', type: 'A', ttl: 300, value: '127.0.0.1' }, 'unsafe_value'],
  ['A metadata', { name: 'x', type: 'A', ttl: 300, value: '169.254.169.254' }, 'unsafe_value'],
  ['A unspecified', { name: 'x', type: 'A', ttl: 300, value: '0.0.0.0' }, 'unsafe_value'],
  ['A multicast', { name: 'x', type: 'A', ttl: 300, value: '224.0.0.1' }, 'unsafe_value'],
  ['AAAA v4', { name: 'x', type: 'AAAA', ttl: 300, value: '192.0.2.1' }, 'invalid_value'],
  ['AAAA garbage', { name: 'x', type: 'AAAA', ttl: 300, value: 'zzzz::1' }, 'invalid_value'],
  ['AAAA loopback', { name: 'x', type: 'AAAA', ttl: 300, value: '::1' }, 'unsafe_value'],
  ['AAAA link-local', { name: 'x', type: 'AAAA', ttl: 300, value: 'fe80::1' }, 'unsafe_value'],
  [
    'AAAA mapped metadata',
    { name: 'x', type: 'AAAA', ttl: 300, value: '::ffff:169.254.169.254' },
    'unsafe_value',
  ],
  [
    'CNAME at apex',
    { name: '@', type: 'CNAME', ttl: 300, value: 'a.example.net' },
    'cname_at_apex',
  ],
  [
    'CNAME fqdn apex',
    { name: 'example.com', type: 'CNAME', ttl: 300, value: 'a.example.net' },
    'cname_at_apex',
  ],
  [
    'CNAME url value',
    { name: 'x', type: 'CNAME', ttl: 300, value: 'https://evil.example/' },
    'invalid_value',
  ],
  [
    'CNAME spaces',
    { name: 'x', type: 'CNAME', ttl: 300, value: 'a b.example.net' },
    'invalid_value',
  ],
  [
    'CNAME ip value ok-shaped but newline',
    { name: 'x', type: 'CNAME', ttl: 300, value: 'a.example.net\nIN A 1.1.1.1' },
    'invalid_value',
  ],
  ['CNAME empty', { name: 'x', type: 'CNAME', ttl: 300, value: '' }, 'invalid_value'],
  [
    'CNAME to nuzm hosting',
    { name: 'www', type: 'CNAME', ttl: 300, value: 'abc123.sites.nuzm-hosting.test' },
    'protected_target',
  ],
  [
    'MX no priority',
    { name: '@', type: 'MX', ttl: 300, value: { host: 'mail.example.net' } },
    'invalid_value',
  ],
  [
    'MX priority too big',
    { name: '@', type: 'MX', ttl: 300, value: { priority: 65536, host: 'mail.example.net' } },
    'invalid_value',
  ],
  [
    'MX priority negative',
    { name: '@', type: 'MX', ttl: 300, value: { priority: -1, host: 'mail.example.net' } },
    'invalid_value',
  ],
  [
    'MX bad host',
    { name: '@', type: 'MX', ttl: 300, value: { priority: 10, host: 'mail example' } },
    'invalid_value',
  ],
  [
    'MX string value',
    { name: '@', type: 'MX', ttl: 300, value: '10 mail.example.net' },
    'invalid_value',
  ],
  [
    'MX to nuzm hosting',
    { name: '@', type: 'MX', ttl: 300, value: { priority: 10, host: 'x.sites.nuzm-hosting.test' } },
    'protected_target',
  ],
  ['TXT empty', { name: 'x', type: 'TXT', ttl: 300, value: '' }, 'invalid_value'],
  ['TXT too long', { name: 'x', type: 'TXT', ttl: 300, value: 'x'.repeat(4097) }, 'invalid_value'],
  ['TXT newline', { name: 'x', type: 'TXT', ttl: 300, value: 'a\nb' }, 'unsafe_value'],
  ['TXT NUL', { name: 'x', type: 'TXT', ttl: 300, value: 'a\u0000b' }, 'unsafe_value'],
  [
    'TXT number',
    { name: 'x', type: 'TXT', ttl: 300, value: 5 as unknown as string },
    'invalid_value',
  ],
  [
    'SRV missing port',
    {
      name: '_a._tcp',
      type: 'SRV',
      ttl: 300,
      value: { priority: 1, weight: 1, target: 'a.example.net' },
    },
    'invalid_value',
  ],
  [
    'SRV port too big',
    {
      name: '_a._tcp',
      type: 'SRV',
      ttl: 300,
      value: { priority: 1, weight: 1, port: 70000, target: 'a.example.net' },
    },
    'invalid_value',
  ],
  [
    'SRV bad target',
    {
      name: '_a._tcp',
      type: 'SRV',
      ttl: 300,
      value: { priority: 1, weight: 1, port: 80, target: 'bad target' },
    },
    'invalid_value',
  ],
  [
    'SRV weight negative',
    {
      name: '_a._tcp',
      type: 'SRV',
      ttl: 300,
      value: { priority: 1, weight: -1, port: 80, target: 'a.example.net' },
    },
    'invalid_value',
  ],
  [
    'CAA bad flags',
    { name: '@', type: 'CAA', ttl: 300, value: { flags: 1, tag: 'issue', value: 'ca.example' } },
    'invalid_value',
  ],
  [
    'CAA bad tag',
    { name: '@', type: 'CAA', ttl: 300, value: { flags: 0, tag: 'foo', value: 'ca.example' } },
    'invalid_value',
  ],
  [
    'CAA iodef not url',
    {
      name: '@',
      type: 'CAA',
      ttl: 300,
      value: { flags: 0, tag: 'iodef', value: 'sec@example.com' },
    },
    'invalid_value',
  ],
  [
    'CAA issue injection',
    {
      name: '@',
      type: 'CAA',
      ttl: 300,
      value: { flags: 0, tag: 'issue', value: 'ca.example"; rm -rf' },
    },
    'invalid_value',
  ],
  ['NS at apex', { name: '@', type: 'NS', ttl: 300, value: 'ns1.example.net' }, 'ns_at_apex'],
  ['NS bad host', { name: 'sub', type: 'NS', ttl: 300, value: '1.2.3.4 ' }, 'invalid_value'],
  ['name with space', { name: 'a b', type: 'A', ttl: 300, value: '192.0.2.1' }, 'invalid_name'],
  ['name empty', { name: '', type: 'A', ttl: 300, value: '192.0.2.1' }, 'invalid_name'],
  ['name slash', { name: 'a/b', type: 'A', ttl: 300, value: '192.0.2.1' }, 'invalid_name'],
  [
    'name 64-char label',
    { name: 'a'.repeat(64), type: 'A', ttl: 300, value: '192.0.2.1' },
    'invalid_name',
  ],
  [
    'name leading hyphen',
    { name: '-bad', type: 'A', ttl: 300, value: '192.0.2.1' },
    'invalid_name',
  ],
  [
    'name trailing hyphen',
    { name: 'bad-', type: 'A', ttl: 300, value: '192.0.2.1' },
    'invalid_name',
  ],
  ['name empty label', { name: 'a..b', type: 'A', ttl: 300, value: '192.0.2.1' }, 'invalid_name'],
  ['name control char', { name: 'a\tb', type: 'A', ttl: 300, value: '192.0.2.1' }, 'invalid_name'],
  ['name wildcard mid', { name: 'a.*.b', type: 'A', ttl: 300, value: '192.0.2.1' }, 'invalid_name'],
  [
    'name not a string',
    { name: 7 as unknown as string, type: 'A', ttl: 300, value: '192.0.2.1' },
    'invalid_name',
  ],
  [
    'name too long',
    { name: Array(60).fill('abcd').join('.'), type: 'A', ttl: 300, value: '192.0.2.1' },
    'invalid_name',
  ],
  [
    'acme challenge by user',
    { name: '_acme-challenge', type: 'TXT', ttl: 300, value: 'token' },
    'reserved_name',
  ],
  [
    'acme challenge sub by user',
    { name: '_acme-challenge.www', type: 'TXT', ttl: 300, value: 'token' },
    'reserved_name',
  ],
];

describe('record validation (AC-M07-05)', () => {
  it('has at least 40 valid and 40 invalid fixtures', () => {
    expect(VALID.length).toBeGreaterThanOrEqual(40);
    expect(INVALID.length).toBeGreaterThanOrEqual(40);
  });
  it.each(VALID)('accepts %s', (_n, rec) => {
    const r = one(rec);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.resulting).toHaveLength(1);
  });
  it.each(INVALID)('rejects %s', (_n, rec, code) => {
    const r = one(rec);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain(code);
    expect(r.errors[0]!.index).toBe(0);
  });
});

describe('normalization', () => {
  it('relative lower-case punycode names', () => {
    expect(normalizeName('WWW.Example.COM.', Z)).toBe('www');
    expect(normalizeName('example.com', Z)).toBe('@');
    expect(normalizeName('مثال', Z)).toBe('xn--mgbh0fb');
    expect(normalizeName('a b', Z)).toBeNull();
  });
  it('IDN owner is stored as punycode', () => {
    const r = validateRecordInput(Z, { name: 'مثال', type: 'A', value: '192.0.2.1' }, 0, {
      ...DEFAULT_DNS_OPTIONS,
      ...opts,
    });
    expect(r.record?.name).toBe('xn--mgbh0fb');
  });
  it('TXT is chunked at 255 bytes on character boundaries', () => {
    expect(chunkTxt('x'.repeat(255))).toHaveLength(1);
    expect(chunkTxt('x'.repeat(256))).toHaveLength(2);
    expect(chunkTxt('x'.repeat(600)).map((c) => c.length)).toEqual([255, 255, 90]);
    const ar = chunkTxt('م'.repeat(200)); // 2 bytes each
    expect(ar.every((c) => Buffer.byteLength(c) <= 255)).toBe(true);
    expect(ar.join('')).toBe('م'.repeat(200));
  });
});

describe('change-set rules', () => {
  const cur = (name: string, type: DnsRecord['type'], value: unknown): DnsRecord => ({
    name,
    type,
    ttl: 300,
    value,
    managedBy: 'user',
  });
  it('CNAME may not share a name with another record (existing or in the same set)', () => {
    const r = validateChangeSet(
      Z,
      [cur('www', 'A', '192.0.2.1')],
      [{ op: 'create', record: { name: 'www', type: 'CNAME', value: 'a.example.net' } }],
    );
    expect(r.errors.map((e) => e.code)).toContain('cname_conflict');
    const r2 = validateChangeSet(
      Z,
      [],
      [
        { op: 'create', record: { name: 'w', type: 'CNAME', value: 'a.example.net' } },
        { op: 'create', record: { name: 'w', type: 'TXT', value: 'x' } },
      ],
    );
    expect(r2.ok).toBe(false);
  });
  it('is judged by its outcome: delete A then create CNAME is valid', () => {
    const r = validateChangeSet(
      Z,
      [cur('www', 'A', '192.0.2.1')],
      [
        { op: 'delete', match: { name: 'www', type: 'A' } },
        { op: 'create', record: { name: 'www', type: 'CNAME', value: 'a.example.net' } },
      ],
    );
    expect(r.ok).toBe(true);
    expect(r.resulting).toHaveLength(1);
  });
  it('duplicates and missing targets are errors with the change index', () => {
    const r = validateChangeSet(
      Z,
      [cur('a', 'A', '192.0.2.1')],
      [
        { op: 'create', record: { name: 'b', type: 'A', value: '192.0.2.2' } },
        { op: 'create', record: { name: 'a', type: 'A', value: '192.0.2.1' } },
        {
          op: 'update',
          match: { name: 'zz', type: 'A' },
          record: { name: 'zz', type: 'A', value: '192.0.2.3' },
        },
        { op: 'delete', match: { name: 'nope', type: 'TXT' } },
      ],
    );
    expect(r.errors.map((e) => [e.index, e.code])).toEqual([
      [1, 'duplicate_record'],
      [2, 'record_not_found'],
      [3, 'record_not_found'],
    ]);
  });
  it('multiple A records at one name (round robin) are fine', () => {
    const r = validateChangeSet(
      Z,
      [cur('a', 'A', '192.0.2.1')],
      [{ op: 'create', record: { name: 'a', type: 'A', value: '192.0.2.2' } }],
    );
    expect(r.ok).toBe(true);
  });
  it('enforces the records-per-zone quota on the resulting set', () => {
    const existing = Array.from({ length: 5 }, (_, i) => cur(`h${i}`, 'A', `192.0.2.${i + 1}`));
    const r = validateChangeSet(
      Z,
      existing,
      [{ op: 'create', record: { name: 'extra', type: 'A', value: '192.0.2.99' } }],
      { maxRecords: 5 },
    );
    expect(r.errors.map((e) => e.code)).toEqual(['quota_exceeded']);
  });
  it('only the linkage writer may write _acme-challenge and Nuzm hosting targets', () => {
    const changes: DnsChangeInput[] = [
      { op: 'create', record: { name: '_acme-challenge', type: 'TXT', value: 'tok' } },
      { op: 'create', record: { name: 'www', type: 'CNAME', value: 'x.sites.nuzm-hosting.test' } },
    ];
    expect(validateChangeSet(Z, [], changes, opts).ok).toBe(false);
    const r = validateChangeSet(Z, [], changes, { ...opts, writer: 'linkage' });
    expect(r.ok).toBe(true);
    expect(r.resulting.every((x) => x.managedBy === 'linkage')).toBe(true);
  });
  it('a user cannot edit or delete linkage-managed records', () => {
    const managed: DnsRecord = {
      name: 'www',
      type: 'CNAME',
      ttl: 300,
      value: 'x.sites.nuzm-hosting.test',
      managedBy: 'linkage',
    };
    const r = validateChangeSet(
      Z,
      [managed],
      [{ op: 'delete', match: { name: 'www', type: 'CNAME' } }],
      opts,
    );
    expect(r.errors.map((e) => e.code)).toEqual(['reserved_name']);
  });
  it('rejects unknown ops and garbage entries without throwing', () => {
    const r = validateChangeSet(Z, [], [{ op: 'nuke' } as never, null as never]);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(2);
  });
});
