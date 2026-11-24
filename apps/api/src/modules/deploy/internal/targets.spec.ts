import { describe, expect, it } from 'vitest';
import { builderTools } from '@nuzm/domain';
import {
  PRODUCT_TYPES,
  SIMULATED_STAGING_TARGET,
  StagingTargetRefused,
  TARGET_BY_PRODUCT_TYPE,
  assertStagingTargetUsable,
  decideTarget,
  productTypeOfBuilderType,
  type StagingTarget,
} from './targets';
import {
  PreviewDomainRefused,
  assertIsolatedPreviewDomain,
  dnsLabel,
  isTemporaryPreviewHost,
  registrableDomain,
  temporarySubdomain,
} from './preview-url';
import { RENEW_BEFORE_DAYS, canSwitchLive, planSsl, type SslInput } from './ssl-flow';
import {
  describeEnvBindings,
  envBindingsFingerprint,
  redactLogLine,
  validateEnvBindings,
} from './env-refs';

const real = (over: Partial<StagingTarget> = {}): StagingTarget => ({
  id: 'hosting:node-1',
  kind: 'static_hosting',
  provider: 'hosting_panel',
  verification: 'NOT VERIFIED',
  region: 'sa-riyadh',
  previewDomain: 'nuzm-staging.example',
  approvalRef: 'HG-05:2026-12-01',
  evidenceRef: null,
  ...over,
});

describe('project type → target mapping', () => {
  it('covers exactly the 14 product types of the builder planner (no drift)', () => {
    expect([...PRODUCT_TYPES]).toEqual([...builderTools.planning.PRODUCT_TYPES]);
    expect(Object.keys(TARGET_BY_PRODUCT_TYPE).sort()).toEqual([...PRODUCT_TYPES].sort());
  });
  it('only static types are deployable (simulated); every server type needs an isolated runtime', () => {
    const sim = PRODUCT_TYPES.filter((t) => TARGET_BY_PRODUCT_TYPE[t].readiness === 'simulated');
    expect(sim.sort()).toEqual(['docs', 'landing', 'webapp', 'website']);
    for (const t of ['ecommerce', 'saas', 'erp', 'crm', 'fullstack', 'api', 'auth'] as const) {
      expect(TARGET_BY_PRODUCT_TYPE[t].kind).toBe('isolated_runtime');
      expect(TARGET_BY_PRODUCT_TYPE[t].blockers).toContain('S04-runtime');
      expect(decideTarget(t)?.allowed).toBe(false);
    }
  });
  it('shared hosting (HestiaCP) is never the target of server code, databases or store apps', () => {
    for (const t of PRODUCT_TYPES) {
      const r = TARGET_BY_PRODUCT_TYPE[t];
      if (r.kind === 'static_hosting' && r.readiness === 'simulated')
        expect(r.publishes).toMatch(/static/);
    }
    expect(TARGET_BY_PRODUCT_TYPE.database.kind).toBe('managed_database');
    expect(TARGET_BY_PRODUCT_TYPE.mobile.kind).toBe('store_distribution');
    expect(TARGET_BY_PRODUCT_TYPE.mobile.blockers).toEqual(['store-HG']);
    expect(TARGET_BY_PRODUCT_TYPE.flutter.readiness).toBe('not_yet');
  });
  it('inherited object members are not product types (fails closed, no TypeError)', () => {
    for (const t of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'])
      expect(decideTarget(t)).toBeNull();
    expect(productTypeOfBuilderType('__proto__')).toBeNull();
    expect(productTypeOfBuilderType('constructor')).toBeNull();
    expect(productTypeOfBuilderType('webapp')).toBe('webapp');
  });
  it('an unknown type is refused, not guessed; a refusal names its blockers', () => {
    expect(decideTarget('quantum')).toBeNull();
    expect(decideTarget('api')?.message).toMatch(/not deployable yet.*S04-runtime/);
  });
});

describe('staging target gate', () => {
  it('the simulated target works for static types only', () => {
    expect(() => assertStagingTargetUsable(SIMULATED_STAGING_TARGET, 'website')).not.toThrow();
    expect(() => assertStagingTargetUsable(SIMULATED_STAGING_TARGET, 'webapp')).not.toThrow();
    expect(() => assertStagingTargetUsable(SIMULATED_STAGING_TARGET, 'api')).toThrow(
      StagingTargetRefused,
    );
  });
  it('a real hosting target needs the recorded HG-05 approval and a preview domain', () => {
    expect(() => assertStagingTargetUsable(real({ approvalRef: null }), 'website')).toThrow(
      /HG-05/,
    );
    expect(() => assertStagingTargetUsable(real({ previewDomain: null }), 'website')).toThrow(
      /preview domain/,
    );
    expect(() => assertStagingTargetUsable(real(), 'website')).not.toThrow();
  });
  it('the approval reference must be well formed (any string no longer unlocks a real target); a real node cannot be labelled SIMULATED', () => {
    for (const bad of ['yes', 'ok', 'HG-05', 'HG-05:', 'HG-07:2026-12-01', 'x'.repeat(70)])
      expect(() => assertStagingTargetUsable(real({ approvalRef: bad }), 'website')).toThrow(
        /approval reference/,
      );
    expect(() =>
      assertStagingTargetUsable(real({ approvalRef: 'HG-06:2026-12-01' }), 'website'),
    ).not.toThrow();
    expect(() => assertStagingTargetUsable(real({ verification: 'SIMULATED' }), 'website')).toThrow(
      /cannot be labelled SIMULATED/,
    );
  });
  it('LIVE-VERIFIED needs evidence; a runtime target is refused while its project types are not deployable', () => {
    expect(() =>
      assertStagingTargetUsable(real({ verification: 'LIVE-VERIFIED' }), 'website'),
    ).toThrow(/evidence/);
    expect(() =>
      assertStagingTargetUsable(
        real({ verification: 'LIVE-VERIFIED', evidenceRef: 'docs/reports/live-1.md' }),
        'website',
      ),
    ).not.toThrow();
    expect(() =>
      assertStagingTargetUsable(
        real({ kind: 'isolated_runtime', provider: 'isolated_runtime' }),
        'api',
      ),
    ).toThrow(/not deployable yet.*S04-runtime/);
  });
  it('a hosting target cannot receive a project that needs another kind', () => {
    expect(() => assertStagingTargetUsable(real({ kind: 'managed_database' }), 'website')).toThrow(
      /needs static_hosting/,
    );
  });
});

describe('preview URLs and temporary subdomains (ADR-060)', () => {
  it('a simulated target yields an .invalid host that can never resolve', () => {
    const p = temporarySubdomain({
      siteName: 'Acme Shop',
      deploymentId: 'd1',
      previewDomain: null,
    });
    expect(p.simulated).toBe(true);
    expect(p.host).toMatch(/^acme-shop-[0-9a-f]{16}\.staging\.nuzm\.invalid$/);
  });
  it('is stable per deployment, different across deployments, within the 63-char label limit', () => {
    const a = temporarySubdomain({
      siteName: 'x'.repeat(200),
      deploymentId: 'd1',
      previewDomain: 'nuzm-staging.example',
    });
    const b = temporarySubdomain({
      siteName: 'x'.repeat(200),
      deploymentId: 'd1',
      previewDomain: 'nuzm-staging.example',
    });
    const c = temporarySubdomain({
      siteName: 'x'.repeat(200),
      deploymentId: 'd2',
      previewDomain: 'nuzm-staging.example',
    });
    expect(a).toEqual(b);
    expect(a.host).not.toBe(c.host);
    expect(a.label.length).toBeLessThanOrEqual(63);
    expect(isTemporaryPreviewHost(a.host, 'nuzm-staging.example')).toBe(true);
  });
  it('the tag is 64 bits; with a server key the host cannot be derived from the deployment id alone', () => {
    const a = temporarySubdomain({
      siteName: 's',
      deploymentId: 'd1',
      previewDomain: 'nuzm-staging.example',
    });
    const k1 = temporarySubdomain({
      siteName: 's',
      deploymentId: 'd1',
      previewDomain: 'nuzm-staging.example',
      tagKey: 'key-one',
    });
    const k2 = temporarySubdomain({
      siteName: 's',
      deploymentId: 'd1',
      previewDomain: 'nuzm-staging.example',
      tagKey: 'key-two',
    });
    expect(a.label).toMatch(/^s-[0-9a-f]{16}$/);
    expect(new Set([a.host, k1.host, k2.host]).size).toBe(3);
    expect(k1).toEqual(
      temporarySubdomain({
        siteName: 's',
        deploymentId: 'd1',
        previewDomain: 'nuzm-staging.example',
        tagKey: 'key-one',
      }),
    );
    expect(isTemporaryPreviewHost(k1.host, 'nuzm-staging.example')).toBe(true);
  });
  it('refuses a preview domain that shares a registrable domain with the console or API', () => {
    const prot = ['console.nuzm.sa', 'api.nuzm.sa'];
    expect(() => assertIsolatedPreviewDomain('preview.nuzm.sa', prot)).toThrow(
      PreviewDomainRefused,
    );
    expect(() => assertIsolatedPreviewDomain('nuzm.sa', prot)).toThrow(PreviewDomainRefused);
    expect(() => assertIsolatedPreviewDomain('nuzm-preview.example', prot)).not.toThrow();
    expect(() => assertIsolatedPreviewDomain('x.localhost', prot)).toThrow(/registrable/);
    expect(() => assertIsolatedPreviewDomain('not a host', prot)).toThrow(/valid host/);
    expect(registrableDomain('a.b.nuzm.com.sa')).toBe('nuzm.com.sa');
  });
  it('host matching is exact: lookalike suffixes and extra labels are not preview hosts', () => {
    const d = 'nuzm-staging.example';
    expect(isTemporaryPreviewHost(`evil.${d}`, d)).toBe(false); // no 8-hex tag
    expect(isTemporaryPreviewHost(`a-1234abcd1234abcd.evil-${d}`, d)).toBe(false);
    expect(isTemporaryPreviewHost(`x.a-1234abcd1234abcd.${d}`, d)).toBe(false);
    expect(isTemporaryPreviewHost(`a-1234abcd1234abcd.${d}`, d)).toBe(true);
    expect(dnsLabel('  ../etc/passwd  ')).toBe('etc-passwd');
    expect(dnsLabel('!!!')).toBe('site');
  });
});

describe('SSL configuration flow', () => {
  const base: SslInput = {
    hostKind: 'custom',
    host: 'shop.example.sa',
    simulated: false,
    hg06Approved: true,
    dnsVerified: true,
    cert: { state: 'none', notAfter: null, failures: 0 },
    now: '2026-12-01T00:00:00Z',
  };
  it('a temporary host needs no certificate of its own (wildcard at the edge); real needs HG-06', () => {
    expect(
      planSsl({ ...base, hostKind: 'temporary', simulated: true, hg06Approved: false }).state,
    ).toBe('not_required');
    expect(planSsl({ ...base, hostKind: 'temporary', hg06Approved: false }).action).toEqual({
      kind: 'blocked',
      blocker: 'HG-06',
    });
  });
  it('custom domain: DNS first, then issue, wait, retry with backoff, renew before expiry', () => {
    expect(planSsl({ ...base, dnsVerified: false }).action.kind).toBe('show_dns_records');
    expect(
      planSsl({ ...base, dnsVerified: false, cert: { state: 'none', notAfter: null, failures: 1 } })
        .action.kind,
    ).toBe('verify_dns');
    expect(planSsl(base).action).toEqual({ kind: 'issue_managed', domains: ['shop.example.sa'] });
    expect(
      planSsl({ ...base, cert: { state: 'issuing', notAfter: null, failures: 0 } }).action.kind,
    ).toBe('wait');
    const f1 = planSsl({ ...base, cert: { state: 'failed', notAfter: null, failures: 1 } }).action;
    const f9 = planSsl({ ...base, cert: { state: 'failed', notAfter: null, failures: 9 } }).action;
    expect(f1).toMatchObject({ kind: 'retry_issue', afterSeconds: 60 });
    expect(f9).toMatchObject({ kind: 'retry_issue', afterSeconds: 7200 });
    const soon = new Date(
      Date.parse(base.now) + (RENEW_BEFORE_DAYS - 1) * 86_400_000,
    ).toISOString();
    const later = new Date(Date.parse(base.now) + 60 * 86_400_000).toISOString();
    expect(planSsl({ ...base, cert: { state: 'active', notAfter: soon, failures: 0 } }).state).toBe(
      'expiring',
    );
    expect(
      planSsl({ ...base, cert: { state: 'active', notAfter: later, failures: 0 } }).state,
    ).toBe('active');
    expect(
      planSsl({ ...base, cert: { state: 'active', notAfter: '2026-11-01T00:00:00Z', failures: 0 } })
        .state,
    ).toBe('failed');
  });
  it('real custom domains are blocked without HG-06; customer certificates are unsupported; labels never say verified', () => {
    expect(planSsl({ ...base, hg06Approved: false }).action).toEqual({
      kind: 'blocked',
      blocker: 'HG-06',
    });
    expect(planSsl({ ...base, customCertificateRequested: true }).action).toEqual({
      kind: 'blocked',
      blocker: 'unsupported_custom_certificate',
    });
    expect(planSsl(base).label).toBe('NOT VERIFIED');
    expect(planSsl({ ...base, simulated: true }).label).toBe('SIMULATED');
  });
  it('a custom domain switches live only with an active certificate', () => {
    expect(canSwitchLive(planSsl(base), 'custom')).toBe(false);
    expect(
      canSwitchLive(
        planSsl({
          ...base,
          cert: { state: 'active', notAfter: '2027-06-01T00:00:00Z', failures: 0 },
        }),
        'custom',
      ),
    ).toBe(true);
    expect(
      canSwitchLive(planSsl({ ...base, hostKind: 'temporary', simulated: true }), 'temporary'),
    ).toBe(true);
  });
});

describe('environment variables are references, never values', () => {
  it('accepts vault references on a runtime target and echoes names only', () => {
    const r = validateEnvBindings(
      [{ name: 'STRIPE_KEY', ref: 'vault://orgs/acme/stripe-key' }],
      'isolated_runtime',
    );
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(describeEnvBindings(r.bindings)).toEqual([
        { name: 'STRIPE_KEY', ref: 'vault://orgs/acme/stripe-key' },
      ]);
  });
  it('rejects pasted secrets without echoing them', () => {
    const secret = ['sk', 'live_abcdefghijklmnopqrstuvwx'].join('-');
    const r = validateEnvBindings([{ name: 'API_KEY', ref: secret }], 'isolated_runtime');
    expect(r).toEqual({
      ok: false,
      problems: [{ code: 'looks_like_secret_value', name: 'API_KEY' }],
    });
    expect(JSON.stringify(r)).not.toContain(secret);
    const pw = validateEnvBindings(
      [{ name: 'DB', ref: 'postgres://u:hunter2@db/x' }],
      'isolated_runtime',
    );
    expect(JSON.stringify(pw)).not.toContain('hunter2');
  });
  it('rejects bad names, reserved names, duplicates and non-vault refs', () => {
    const r = validateEnvBindings(
      [
        { name: 'lower', ref: 'vault://a/b/c' },
        { name: 'NODE_OPTIONS', ref: 'vault://a/b/c' },
        { name: 'NUZM_X', ref: 'vault://a/b/c' },
        { name: 'A', ref: 'vault://a/b/c' },
        { name: 'A', ref: 'vault://a/b/c' },
        { name: 'B', ref: 'https://example.com/x' },
      ],
      'isolated_runtime',
    );
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.problems.map((p) => p.code)).toEqual([
        'invalid_name',
        'reserved_name',
        'reserved_name',
        'duplicate_name',
        'not_a_vault_ref',
      ]);
  });
  it('a static site has no runtime: only explicit PUBLIC_ build variables are accepted', () => {
    expect(
      validateEnvBindings([{ name: 'DB_URL', ref: 'vault://a/b/c' }], 'static_hosting'),
    ).toMatchObject({ ok: false });
    expect(
      validateEnvBindings(
        [{ name: 'PUBLIC_SITE', ref: 'vault://a/b/c', public: true }],
        'static_hosting',
      ),
    ).toMatchObject({ ok: true });
    expect(
      validateEnvBindings([{ name: 'PUBLIC_SITE', ref: 'vault://a/b/c' }], 'static_hosting'),
    ).toMatchObject({ ok: false });
  });
  it('the fingerprint is order independent', () => {
    const a = [
      { name: 'A', ref: 'vault://x/y/z' },
      { name: 'B', ref: 'vault://x/y/w' },
    ];
    expect(envBindingsFingerprint(a)).toBe(envBindingsFingerprint([...a].reverse()));
  });
  it('log redaction removes secret-looking assignments, bearer tokens, URL credentials and key blocks (idempotent)', () => {
    const lines = [
      ['DATABASE_', 'PASSWORD', '=', 'hunter', '2 started'].join(''),
      ['export STRIPE_', 'SECRET_KEY=', '"sk_', 'live_abc"'].join(''),
      'Authorization: Bearer abcdefghijklmnop',
      ['connecting to postgres://user', ':pa', '55@db.internal/app'].join(''),
      ['key sk', '-abcdefghijklmnopqrstuvwxyz used'].join(''),
      [
        '-----BEGIN ',
        'RSA PRIVATE KEY-----',
        '\nMIIEvQ\n',
        '-----END ',
        'RSA PRIVATE KEY-----',
      ].join(''),
    ];
    for (const l of lines) {
      const out = redactLogLine(l);
      expect(out).not.toMatch(/hunter2|sk_live_abc|abcdefghijklmnop|pa55|MIIEvQ|sk-abcdefgh/);
      expect(redactLogLine(out)).toBe(out);
    }
    expect(redactLogLine('built 12 files in 3s')).toBe('built 12 files in 3s');
  });
});
