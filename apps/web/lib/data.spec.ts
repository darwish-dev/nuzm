import { describe, expect, it } from 'vitest';
import {
  bucketUsage,
  canApplyAutomatically,
  dataError,
  databaseQuoteItem,
  detectPlaceholders,
  draftToPolicy,
  draftToRules,
  formatBytes,
  groupTemplates,
  ifMatch,
  inPlaceReady,
  isProtectiveReason,
  mailboxDomains,
  needsPublicConfirm,
  offerKey,
  parseCidrs,
  policyToDraft,
  previewDoc,
  problemOf,
  recordLine,
  recordSummary,
  shortChecksum,
  signedUrlBody,
  usagePercent,
  validResourceName,
  variableErrors,
  variablesFor,
  verificationOf,
  type DnsRecord,
  type PolicyDoc,
} from './data';

const res = (status: number, error?: unknown) => ({ response: { status }, error });

describe('problems and messages', () => {
  it('reads a problem body defensively', () => {
    expect(problemOf(res(422, { code: 'unsupported_capability', detail: 'x' }))).toMatchObject({
      status: 422,
      code: 'unsupported_capability',
      detail: 'x',
      throttled: false,
      fieldErrors: [],
    });
    expect(problemOf(res(500, 'nonsense')).code).toBeUndefined();
    expect(
      problemOf(res(422, { errors: [{ field: 'variables.n', message: 'required' }, 7] }))
        .fieldErrors,
    ).toEqual([{ field: 'variables.n', message: 'required' }]);
  });
  it('turns the data codes into plain text, in both languages', () => {
    for (const locale of ['ar', 'en'] as const) {
      const unsupported = dataError(
        locale,
        problemOf(
          res(422, { code: 'unsupported_capability', detail: 'version 99 is not offered' }),
        ),
      );
      expect(unsupported.text.length).toBeGreaterThan(10);
      expect(unsupported.detail).toBe('version 99 is not offered'); // the service's own reason is kept
      expect(
        dataError(locale, problemOf(res(403, { code: 'residency_denied', detail: 'internal' })))
          .detail,
      ).toBeUndefined();
      expect(dataError(locale, problemOf(res(409, { code: 'in_use' }))).text).not.toBe(
        dataError(locale, problemOf(res(409, { code: 'name_taken' }))).text,
      );
    }
    expect(
      dataError('en', problemOf(res(429, { code: 'rate_limited', throttled: true }))).text,
    ).toMatch(/paused/);
    expect(dataError('en', problemOf(res(429, { code: 'rate_limited' }))).text).toMatch(/Too many/);
    expect(dataError('en', problemOf(res(412))).text).toMatch(/changed elsewhere/);
    expect(dataError('en', problemOf(res(428))).text).toMatch(/Reload/);
  });
  it('sends the version as a quoted If-Match', () => {
    expect(ifMatch(3)).toBe('"3"');
    expect(ifMatch('abc')).toBe('"abc"');
  });
});

describe('database form', () => {
  it('builds exactly the quote item of the API', () => {
    expect(
      databaseQuoteItem({
        engine: 'postgresql',
        version: ' 16 ',
        planRef: 'p-1',
        storageGb: '20',
        region: '',
      }).item,
    ).toEqual({
      engine: 'postgresql',
      version: '16',
      planRef: 'p-1',
      storageGb: 20,
    });
    expect(
      databaseQuoteItem({
        engine: 'mysql',
        version: '8.4',
        planRef: 'p',
        storageGb: '5',
        region: 'r1',
      }).item?.region,
    ).toBe('r1');
  });
  it('names the first wrong field', () => {
    const base = {
      engine: 'redis' as const,
      version: '7',
      planRef: 'p',
      storageGb: '1',
      region: '',
    };
    expect(databaseQuoteItem({ ...base, version: 'latest' }).error).toBe('version');
    expect(databaseQuoteItem({ ...base, planRef: 'a b' }).error).toBe('plan');
    expect(databaseQuoteItem({ ...base, storageGb: '0' }).error).toBe('storage');
    expect(databaseQuoteItem({ ...base, storageGb: '1.5' }).error).toBe('storage');
  });
  it('keys a refused offer so it stays disabled until an option changes', () => {
    const a = databaseQuoteItem({
      engine: 'redis',
      version: '7',
      planRef: 'p',
      storageGb: '1',
      region: '',
    }).item!;
    const b = databaseQuoteItem({
      engine: 'redis',
      version: '8',
      planRef: 'p',
      storageGb: '1',
      region: '',
    }).item!;
    expect(offerKey(a)).toBe(offerKey({ ...a }));
    expect(offerKey(a)).not.toBe(offerKey(b));
  });
  it('accepts CIDR allow-lists but never the whole internet', () => {
    expect(parseCidrs('203.0.113.0/24\n10.0.0.0/8, 2001:db8::/32').list).toEqual([
      '203.0.113.0/24',
      '10.0.0.0/8',
      '2001:db8::/32',
    ]);
    expect(parseCidrs('203.0.113.0/24').error).toBeUndefined();
    expect(parseCidrs('').error).toBe('empty');
    expect(parseCidrs('0.0.0.0/0')).toMatchObject({ error: 'open', bad: '0.0.0.0/0' });
    expect(parseCidrs('10.0.0.0/8\n::/0').error).toBe('open');
    expect(parseCidrs('300.1.1.1/24').error).toBe('invalid');
    expect(parseCidrs('10.0.0.1').error).toBe('invalid');
    expect(parseCidrs('10.0.0.0/33').error).toBe('invalid');
    expect(parseCidrs('example.com/24').error).toBe('invalid');
  });
  it('validates names', () => {
    expect(validResourceName('my-db1')).toBe(true);
    expect(validResourceName('-bad')).toBe(false);
    expect(validResourceName('Upper')).toBe(false);
    expect(validResourceName('a')).toBe(false);
  });
  it('allows an in-place restore only after the exact name and the tick', () => {
    expect(inPlaceReady('orders', 'orders', true)).toBe(true);
    expect(inPlaceReady('orders', 'orders ', true)).toBe(true);
    expect(inPlaceReady('orders', 'order', true)).toBe(false);
    expect(inPlaceReady('orders', 'orders', false)).toBe(false);
  });
  it('summarizes a verification record', () => {
    expect(verificationOf(null)).toBeNull();
    expect(
      verificationOf({
        checkedAt: '2026-01-01T00:00:00Z',
        passed: false,
        tables: [{ match: true }, { match: false }],
      }),
    ).toEqual({
      checkedAt: '2026-01-01T00:00:00Z',
      passed: false,
      tablesTotal: 2,
      tablesMatched: 1,
    });
    expect(shortChecksum('sha256:0123456789abcdef0123')).toBe('0123456789ab');
    expect(shortChecksum(null)).toBeNull();
  });
});

describe('storage policy editor', () => {
  const doc: PolicyDoc = {
    version: 1,
    access: 'private',
    statements: [
      {
        effect: 'allow',
        actions: ['write', 'read'],
        prefix: 'logs/',
        principal: 'bucket-credentials',
      },
    ],
    cors: [
      {
        origins: ['https://a.example', 'https://b.example'],
        methods: ['GET', 'HEAD'],
        maxAgeSeconds: 600,
      },
    ],
  };
  it('round-trips the accepted subset (actions in canonical order)', () => {
    const r = draftToPolicy(policyToDraft(doc));
    expect(r.policy).toEqual({
      ...doc,
      statements: [{ ...doc.statements![0]!, actions: ['read', 'write'] }],
    });
  });
  it('omits cors when there are no rules and keeps statements', () => {
    expect(draftToPolicy({ access: 'private', statements: [], cors: [] }).policy).toEqual({
      version: 1,
      access: 'private',
      statements: [],
    });
  });
  it('refuses what the API refuses, naming the rule', () => {
    expect(
      draftToPolicy({ access: 'private', statements: [{ actions: [], prefix: '' }], cors: [] }),
    ).toEqual({ error: 'actions', index: 0 });
    expect(
      draftToPolicy({
        access: 'private',
        statements: [{ actions: ['read'], prefix: 'a/*' }],
        cors: [],
      }).error,
    ).toBe('prefix');
    expect(
      draftToPolicy({
        access: 'private',
        statements: [{ actions: ['read'], prefix: '/abs' }],
        cors: [],
      }).error,
    ).toBe('prefix');
    expect(
      draftToPolicy({
        access: 'private',
        statements: [],
        cors: [{ origins: 'not a url', methods: ['GET'], maxAge: '60' }],
      }).error,
    ).toBe('origins');
    expect(
      draftToPolicy({
        access: 'private',
        statements: [],
        cors: [{ origins: '*', methods: [], maxAge: '60' }],
      }).error,
    ).toBe('methods');
    expect(
      draftToPolicy({
        access: 'private',
        statements: [],
        cors: [{ origins: '*', methods: ['GET'], maxAge: '0' }],
      }).error,
    ).toBe('maxAge');
  });
  it('sends public-read only through the confirmation', () => {
    expect(needsPublicConfirm('public-read')).toBe(true);
    expect(needsPublicConfirm('private')).toBe(false);
  });
});

describe('lifecycle rules', () => {
  const caps = { expiry: true, abortMultipart: false, transition: false };
  it('never sends an action the provider did not report as supported', () => {
    const r = draftToRules(
      [
        {
          id: 'r1',
          prefix: 'tmp/',
          expireDays: '30',
          abortDays: '7',
          transitionDays: '10',
          transitionClass: 'cold',
        },
      ],
      caps,
    );
    expect(r.rules).toEqual([{ id: 'r1', prefix: 'tmp/', expireDays: 30 }]);
  });
  it('refuses duplicate ids, empty rules and bad numbers', () => {
    const d = {
      id: 'a',
      prefix: '',
      expireDays: '5',
      abortDays: '',
      transitionDays: '',
      transitionClass: '',
    };
    expect(draftToRules([d, d], caps).error).toBe('id');
    expect(draftToRules([{ ...d, expireDays: '' }], caps).error).toBe('empty');
    expect(draftToRules([{ ...d, expireDays: '-1' }], caps).error).toBe('days');
    expect(draftToRules([{ ...d, expireDays: '' }], { expiry: false }).error).toBe('empty');
    expect(
      draftToRules([{ ...d, expireDays: '', transitionDays: '3', transitionClass: '' }], {
        transition: true,
      }).error,
    ).toBe('days');
  });
});

describe('signed URLs and usage', () => {
  it('defaults to 900 s and caps at 7 days', () => {
    expect(signedUrlBody({ key: 'a/b.txt', method: 'GET', ttl: '' }).body).toEqual({
      key: 'a/b.txt',
      method: 'GET',
      ttlSeconds: 900,
    });
    expect(signedUrlBody({ key: 'k', method: 'PUT', ttl: '604800' }).body?.ttlSeconds).toBe(604800);
    expect(signedUrlBody({ key: 'k', method: 'GET', ttl: '604801' }).error).toBe('ttl');
    expect(signedUrlBody({ key: 'k', method: 'GET', ttl: '0' }).error).toBe('ttl');
    expect(signedUrlBody({ key: '', method: 'GET', ttl: '' }).error).toBe('key');
    expect(signedUrlBody({ key: 'a\nb', method: 'GET', ttl: '' }).error).toBe('key');
  });
  it('shows unavailable figures as null, never as zero', () => {
    expect(bucketUsage(null)).toEqual({ bytes: null, requests: null, egress: null, at: null });
    expect(
      bucketUsage({
        at: 't',
        bytesStored: 10,
        requests: 5,
        egressBytes: 0,
        available: { bytes: true, requests: false, egress: true },
      }),
    ).toEqual({ bytes: 10, requests: null, egress: 0, at: 't' });
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(usagePercent(50, 200)).toBe(25);
    expect(usagePercent(500, 200)).toBe(100);
    expect(usagePercent(null, 200)).toBeNull();
    expect(usagePercent(5, null)).toBeNull();
  });
});

describe('email domains', () => {
  const rec = (status: string, required = true, extra: Partial<DnsRecord> = {}): DnsRecord => ({
    type: 'TXT',
    name: 'n.example.com',
    value: 'v',
    purpose: 'spf',
    required,
    status,
    ...extra,
  });
  it('counts required records per status', () => {
    expect(
      recordSummary([
        rec('ok'),
        rec('ok'),
        rec('missing'),
        rec('conflict'),
        rec('unknown'),
        rec('missing', false),
      ]),
    ).toEqual({
      total: 5,
      ok: 2,
      conflict: 1,
      missing: 1,
      unknown: 1,
    });
  });
  it('writes a record as one pasteable line (MX with its priority)', () => {
    expect(recordLine(rec('ok'))).toBe('TXT n.example.com v');
    expect(recordLine(rec('ok', true, { type: 'MX', priority: 10, value: 'mx.example.net' }))).toBe(
      'MX n.example.com 10 mx.example.net',
    );
  });
  it('offers automatic apply only for a Nuzm DNS zone', () => {
    expect(canApplyAutomatically({ dnsZoneId: '00000000-0000-4000-8000-000000000001' })).toBe(true);
    expect(canApplyAutomatically({ dnsZoneId: null })).toBe(false);
    expect(canApplyAutomatically({})).toBe(false);
  });
  it('lists only verified mailbox domains for mailbox creation', () => {
    const ds = [
      { state: 'verified', purposes: ['mailbox'] },
      { state: 'verified', purposes: ['transactional'] },
      { state: 'partial', purposes: ['mailbox'] },
    ];
    expect(mailboxDomains(ds)).toEqual([ds[0]]);
  });
  it('treats hard bounces and complaints as protective', () => {
    expect(isProtectiveReason('bounce_hard')).toBe(true);
    expect(isProtectiveReason('complaint')).toBe(true);
    expect(isProtectiveReason('manual')).toBe(false);
    expect(isProtectiveReason('bounce_soft')).toBe(false);
  });
});

describe('templates', () => {
  it('detects the declared placeholders once each', () => {
    expect(
      detectPlaceholders('Hi {{ name }}', '<p>{{name}} {{ order_id }}</p>', '{{order_id}}'),
    ).toEqual(['name', 'order_id']);
    expect(detectPlaceholders('no vars', '{{ 9bad }}')).toEqual([]);
  });
  it('keeps what the user chose and defaults new variables to required text', () => {
    expect(
      variablesFor(['a', 'b'], {
        a: { type: 'number', required: false },
        gone: { type: 'string', required: true },
      }),
    ).toEqual({
      a: { type: 'number', required: false },
      b: { type: 'string', required: true },
    });
  });
  it('renders a preview in a locked-down page in the right direction', () => {
    const ar = previewDoc('<p>مرحبا</p>', 'ar');
    expect(ar).toContain('dir="rtl"');
    expect(ar).toContain("default-src 'none'");
    expect(ar).not.toContain('<script');
    expect(previewDoc('<p>x</p>', 'en')).toContain('dir="ltr"');
  });
  it('groups versions by key, newest first', () => {
    const g = groupTemplates([
      { key: 'a', version: 1 },
      { key: 'b', version: 1 },
      { key: 'a', version: 2 },
    ]);
    expect(g.map((x) => [x.key, x.versions.map((v) => v.version)])).toEqual([
      ['a', [2, 1]],
      ['b', [1]],
    ]);
  });
  it('maps 422 field errors to variable names', () => {
    const p = problemOf(
      res(422, { errors: [{ field: 'variables.name', message: 'required' }, { field: 'html' }] }),
    );
    expect(variableErrors(p)).toEqual({ name: 'required' });
  });
});
