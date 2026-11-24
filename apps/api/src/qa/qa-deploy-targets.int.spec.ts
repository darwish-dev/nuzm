import { describe, expect, it } from 'vitest';
import {
  SIMULATED_STAGING_TARGET,
  StagingTargetRefused,
  assertStagingTargetUsable,
  decideTarget,
  type StagingTarget,
} from '../modules/deploy';
// eslint-disable-next-line no-restricted-imports -- QA reads the pure preview-URL rules directly: they are not part of the deploy module's public index yet
import {
  assertIsolatedPreviewDomain,
  isTemporaryPreviewHost,
  temporarySubdomain,
  PreviewDomainRefused,
} from '../modules/deploy/internal/preview-url';

/**
 * Session 07 (QA), Phase 2 - independent review of the Session 06 staging-target model and preview URLs (pure code; no DB, no network, nothing is deployed).
 * Evidence class: SIMULATED / design-level. Says nothing about a real hosting node (NOT VERIFIED until HG-05/HG-06).
 */
const PROTECTED = ['console.nuzm.sa', 'admin.nuzm.sa', 'api.nuzm.sa', 'nuzm.sa'];
const real = (over: Partial<StagingTarget> = {}): StagingTarget => ({
  id: 't1',
  kind: 'static_hosting',
  provider: 'hosting_panel',
  verification: 'NOT VERIFIED',
  region: 'sa-central',
  previewDomain: 'nuzm-preview.example',
  approvalRef: 'HG-05:node-staging-1',
  evidenceRef: null,
  ...over,
});

describe('QA targets: a real target is never usable by accident', () => {
  it('refuses every real target without approval, preview domain, or (when LIVE-VERIFIED) evidence', () => {
    for (const [t, reason] of [
      [real({ approvalRef: null }), 'approval_missing'],
      [real({ approvalRef: '' }), 'approval_missing'],
      [real({ previewDomain: null }), 'preview_domain_missing'],
      [real({ verification: 'LIVE-VERIFIED', evidenceRef: null }), 'evidence_missing'],
    ] as const)
      expect(() => assertStagingTargetUsable(t, 'website')).toThrowError(
        expect.objectContaining({ reason }) as never,
      );
    expect(() => assertStagingTargetUsable(real(), 'website')).not.toThrow();
  });
  it('the isolated-runtime provider is never usable (Session 04 gate), and an in-memory target must be SIMULATED', () => {
    expect(() =>
      assertStagingTargetUsable(
        { ...real(), provider: 'isolated_runtime', kind: 'isolated_runtime' },
        'ecommerce',
      ),
    ).toThrow(StagingTargetRefused);
    expect(() =>
      assertStagingTargetUsable(
        { ...SIMULATED_STAGING_TARGET, verification: 'NOT VERIFIED' },
        'website',
      ),
    ).toThrow(StagingTargetRefused);
    expect(() => assertStagingTargetUsable(SIMULATED_STAGING_TARGET, 'website')).not.toThrow();
  });
  it('server-side product types are never deployable to shared hosting; unknown types are refused, not guessed', () => {
    for (const t of [
      'ecommerce',
      'saas',
      'erp',
      'crm',
      'fullstack',
      'api',
      'auth',
      'database',
      'mobile',
      'flutter',
      '',
    ])
      expect(decideTarget(t)?.allowed ?? false, t).toBe(false);
    for (const t of ['website', 'landing', 'docs', 'webapp'])
      expect(decideTarget(t)?.allowed, t).toBe(true);
    expect(() => assertStagingTargetUsable(real(), 'ecommerce')).toThrow(StagingTargetRefused);
    expect(() => assertStagingTargetUsable(real({ kind: 'isolated_runtime' }), 'website')).toThrow(
      StagingTargetRefused,
    );
  });
  it('DEFECT-12 (fixed by Session 06): inherited object names read as an UNKNOWN product type (null), never as a rule', () => {
    for (const t of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'])
      expect(decideTarget(t), t).toBeNull();
  });
  it('O-15 (fixed by Session 06): the approval reference must have the recorded format and a real hosting panel can never carry the SIMULATED label', () => {
    for (const bad of [
      'x',
      'approved',
      'HG-05',
      'HG-05-01',
      'HG-07:abcd',
      'hg-05:abcd',
      'HG-05:',
      'HG-05:ab',
      'HG-05: spaced value',
      'HG-05:a;b',
      'HG-06:' + 'a'.repeat(80),
      '../HG-05:abcd',
    ])
      expect(
        () => assertStagingTargetUsable(real({ approvalRef: bad }), 'website'),
        bad,
      ).toThrowError(expect.objectContaining({ reason: 'approval_malformed' }) as never);
    for (const ok of ['HG-05:node-staging-1', 'HG-06:2026-11-24.panel'])
      expect(
        () => assertStagingTargetUsable(real({ approvalRef: ok }), 'website'),
        ok,
      ).not.toThrow();
    expect(() =>
      assertStagingTargetUsable(real({ verification: 'SIMULATED' }), 'website'),
    ).toThrowError(expect.objectContaining({ reason: 'label_mismatch' }) as never);
  });
  it('CONCERN (remains): the format is checked, but nothing proves the referenced approval exists: the owner-signed record is outside the code (approval pack); a real target must not be registered without that record', () => {
    expect(() =>
      assertStagingTargetUsable(real({ approvalRef: 'HG-05:made-up-1234' }), 'website'),
    ).not.toThrow(); // documents the limit
  });
});

describe('QA preview URLs: isolated origin (ADR-060)', () => {
  it('refuses every domain that shares a registrable domain with the console, admin, API or marketing site, and every malformed host', () => {
    const bad = [
      'nuzm.sa',
      'NUZM.SA',
      'nuzm.sa.',
      ' nuzm.sa ',
      'preview.nuzm.sa',
      'a.b.console.nuzm.sa',
      'sa',
      'localhost',
      'x.localhost',
      'preview.invalid',
      '1.2.3.4',
      'a@nuzm-preview.example',
      'nuzm-preview.example:8443',
      '*.nuzm-preview.example',
      'nuzm preview.example',
      '',
      '.example.com',
      'a..example.com',
      `${'a'.repeat(64)}.example.com`,
    ];
    const leaked = bad.filter((d) => {
      try {
        assertIsolatedPreviewDomain(d, PROTECTED);
        return true;
      } catch (err) {
        return !(err instanceof PreviewDomainRefused);
      }
    });
    expect(leaked).toEqual([]);
    for (const ok of ['nuzm-preview.example', 'nuzm.example', 'previews.nuzm-user-content.com'])
      expect(() => assertIsolatedPreviewDomain(ok, PROTECTED)).not.toThrow();
  });
  it('the host is one origin per deployment: stable for one deployment, different for another, and always inside the 63-character label limit; hostile site names cannot inject dots, slashes or uppercase', () => {
    const a = temporarySubdomain({
      siteName: 'Shop',
      deploymentId: 'd-1',
      previewDomain: 'nuzm-preview.example',
      protectedDomains: PROTECTED,
    });
    expect(
      temporarySubdomain({
        siteName: 'Shop',
        deploymentId: 'd-1',
        previewDomain: 'nuzm-preview.example',
        protectedDomains: PROTECTED,
      }).host,
    ).toBe(a.host);
    expect(
      temporarySubdomain({
        siteName: 'Shop',
        deploymentId: 'd-2',
        previewDomain: 'nuzm-preview.example',
        protectedDomains: PROTECTED,
      }).host,
    ).not.toBe(a.host);
    for (const name of [
      'a.b.c',
      '../../etc',
      'evil.com/x',
      'ＡＢＣ',
      'متجر',
      'x'.repeat(300),
      '-x-',
      'A_B C',
      'console.nuzm.sa',
      '\u0000',
      'xn--a',
    ]) {
      const t = temporarySubdomain({
        siteName: name,
        deploymentId: 'd-9',
        previewDomain: 'nuzm-preview.example',
        protectedDomains: PROTECTED,
      });
      const label = t.host.slice(0, -'.nuzm-preview.example'.length);
      expect(label, name).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
      expect(label.length, name).toBeLessThanOrEqual(63);
      expect(t.url).toBe(`https://${t.host}/`);
      expect(isTemporaryPreviewHost(t.host, 'nuzm-preview.example')).toBe(true);
    }
  });
  it('the simulated preview can never resolve (.invalid) and is flagged', () => {
    const t = temporarySubdomain({ siteName: 'Shop', deploymentId: 'd-1', previewDomain: null });
    expect(t.simulated).toBe(true);
    expect(t.host.endsWith('.invalid')).toBe(true);
  });
  it('the serving edge match is exact: look-alike suffixes and bare or foreign labels are not preview hosts', () => {
    const d = 'nuzm-preview.example';
    for (const h of [
      'evil-nuzm-preview.example',
      'nuzm-preview.example',
      'shop-abcd1234.nuzm-preview.example.evil.com',
      'shop.nuzm-preview.example',
      'shop-ABCDEFGH.nuzm-preview.example',
      'a.b-abcd1234.nuzm-preview.example',
    ])
      expect(isTemporaryPreviewHost(h, d), h).toBe(false);
  });
  it('O-16 (fixed by Session 06): the tag is 64 bits; with a vault-held key it is an HMAC (stable per key, different per key and per deployment, not derivable from the deployment id alone)', () => {
    const mk = (extra: { tagKey?: string; deploymentId?: string } = {}) =>
      temporarySubdomain({
        siteName: 'Shop',
        deploymentId: extra.deploymentId ?? 'd-1',
        previewDomain: 'nuzm-preview.example',
        protectedDomains: PROTECTED,
        ...(extra.tagKey ? { tagKey: extra.tagKey } : {}),
      });
    const plain = mk();
    expect(/-[0-9a-f]{16}\./.test(plain.host)).toBe(true);
    const k1 = mk({ tagKey: 'test-only-key-one-0123456789' });
    const k2 = mk({ tagKey: 'test-only-key-two-0123456789' });
    expect(k1.host).toBe(mk({ tagKey: 'test-only-key-one-0123456789' }).host);
    expect(new Set([plain.host, k1.host, k2.host]).size).toBe(3);
    expect(mk({ tagKey: 'test-only-key-one-0123456789', deploymentId: 'd-2' }).host).not.toBe(
      k1.host,
    );
    // the longest site name still fits the 63-character label limit
    const long = temporarySubdomain({
      siteName: 'x'.repeat(300),
      deploymentId: 'd-1',
      previewDomain: 'nuzm-preview.example',
      protectedDomains: PROTECTED,
      tagKey: 'test-only-key-one-0123456789',
    });
    expect(long.host.split('.')[0]!.length).toBeLessThanOrEqual(63);
  });
});
