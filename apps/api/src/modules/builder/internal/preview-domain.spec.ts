import { describe, expect, it } from 'vitest';
import {
  certCovers,
  registrableDomain,
  renderEdgeConfig,
  runPreviewDomainValidation,
  validatePreviewDomainConfig,
  type DomainProbes,
  type PreviewDomainConfig,
} from './preview-domain';

const good: PreviewDomainConfig = {
  previewDomain: 'nuzm-preview.example',
  scheme: 'https',
  consoleOrigin: 'https://console.nuzm.sa',
  apiOrigin: 'https://api.nuzm.sa',
};
const codes = (c: PreviewDomainConfig) =>
  validatePreviewDomainConfig(c)
    .filter((p) => p.severity === 'error')
    .map((p) => p.code);

describe('registrable domain', () => {
  it('handles single- and multi-label public suffixes', () => {
    expect(registrableDomain('console.nuzm.sa')).toBe('nuzm.sa');
    expect(registrableDomain('a.b.nuzm.com.sa')).toBe('nuzm.com.sa');
    expect(registrableDomain('x.nuzm-preview.example')).toBe('nuzm-preview.example');
    expect(registrableDomain('nuzm.sa')).toBe('nuzm.sa');
  });
});

describe('preview domain configuration', () => {
  it('accepts a separate registrable domain (reserved TLD is a warning, never assumed real)', () => {
    expect(codes(good)).toEqual([]);
    expect(validatePreviewDomainConfig(good).map((p) => p.code)).toContain('reserved_tld');
    expect(
      validatePreviewDomainConfig({ ...good, previewDomain: 'nuzm-preview.net' }).map(
        (p) => p.code,
      ),
    ).not.toContain('reserved_tld');
  });
  it('refuses a preview domain under or equal to the console/API domain, or on the same registrable domain', () => {
    expect(codes({ ...good, previewDomain: 'preview.nuzm.sa' })).toEqual(
      expect.arrayContaining(['console_same_site', 'api_same_site']),
    );
    expect(codes({ ...good, previewDomain: 'console.nuzm.sa' })).toContain('console_related');
    expect(codes({ ...good, previewDomain: 'nuzm.sa' })).toContain('console_related');
    expect(
      codes({
        ...good,
        previewDomain: 'x.nuzm.com.sa',
        consoleOrigin: 'https://console.nuzm.com.sa',
        apiOrigin: 'https://api.other.example',
      }),
    ).toContain('console_same_site');
    // a preview domain that CONTAINS the console host
    expect(
      codes({
        ...good,
        previewDomain: 'nuzm-preview.example',
        consoleOrigin: 'https://app.nuzm-preview.example',
      }),
    ).toContain('console_related');
  });
  it('refuses malformed names and insecure schemes', () => {
    expect(codes({ ...good, previewDomain: '*.nuzm-preview.example' })).toContain('domain_form');
    expect(codes({ ...good, previewDomain: 'Nuzm-Preview.example' })).toContain('domain_form');
    expect(codes({ ...good, previewDomain: 'nuzm-preview.example:443' })).toContain('domain_form');
    expect(codes({ ...good, previewDomain: 'nuzm-preview.example.' })).toContain('domain_form');
    expect(codes({ ...good, previewDomain: '-bad.example' })).toContain('domain_labels');
    expect(codes({ ...good, previewDomain: 'localhostonly' })).toContain('domain_labels');
    expect(codes({ ...good, previewDomain: `${'a'.repeat(64)}.example` })).toContain(
      'domain_labels',
    );
    expect(
      codes({
        ...good,
        previewDomain: `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.example`,
      }),
    ).toContain('domain_length');
    expect(codes({ ...good, scheme: 'http' })).toContain('insecure_scheme');
    expect(
      codes({
        ...good,
        scheme: 'http',
        previewDomain: 'preview.localhost',
        consoleOrigin: 'http://localhost:3000',
        apiOrigin: 'http://127.0.0.1:4000',
      }),
    ).toEqual([]);
    expect(codes({ ...good, consoleOrigin: 'not a url' })).toContain('console_origin');
  });
});

describe('wildcard certificate coverage', () => {
  it('a wildcard covers exactly one label', () => {
    const host = `${'a'.repeat(32)}.nuzm-preview.example`;
    expect(certCovers(['*.nuzm-preview.example'], host)).toBe(true);
    expect(certCovers(['DNS:*.nuzm-preview.example'], host)).toBe(true);
    expect(certCovers(['*.example'], host)).toBe(false); // two labels deep
    expect(certCovers(['*.nuzm-preview.example'], `x.y.nuzm-preview.example`)).toBe(false);
    expect(certCovers(['*.nuzm-preview.example'], 'nuzm-preview.example')).toBe(false); // the apex is not covered
    expect(certCovers(['nuzm-preview.example'], host)).toBe(false);
    expect(certCovers(['*.com'], 'a.com')).toBe(false); // a wildcard over a bare TLD is never accepted
    expect(certCovers([host], host)).toBe(true);
    expect(certCovers([], host)).toBe(false);
  });
});

describe('edge configuration', () => {
  it('is generated from the same configuration, escapes the domain, and matches the token shape of the API', () => {
    const c = renderEdgeConfig(good);
    expect(c).toContain('server_name ~^(?<token>[a-z2-7]{32})\\.nuzm-preview\\.example$;');
    expect(c).toContain('proxy_pass http://preview-api.internal:4000/_preview/$token$request_uri;');
    expect(c).toContain('proxy_set_header Cookie "";');
    expect(c).toContain('proxy_set_header Authorization "";');
    expect(c).toContain('proxy_hide_header Set-Cookie;');
    expect(c).toContain('ssl_reject_handshake on;'); // an unrelated SNI gets no certificate
    expect(c).toContain('proxy_set_header Host $host;'); // the API binds the host to the token
  });
  it('refuses to render for an invalid configuration, hostile upstream or paths', () => {
    expect(() => renderEdgeConfig({ ...good, previewDomain: 'preview.nuzm.sa' })).toThrow(
      /refusing/,
    );
    expect(() => renderEdgeConfig({ ...good, upstream: 'x; rm -rf /' })).toThrow(/upstream/);
    expect(() => renderEdgeConfig(good, { certPath: '/etc/x;evil' })).toThrow(/paths/);
    expect(() => renderEdgeConfig(good, { keyPath: 'relative.key' })).toThrow(/paths/);
  });
});

describe('validation workflow: nothing is assumed, nothing is called by default', () => {
  it('with no probes every live check is NOT VERIFIED and the result is not "verified"', async () => {
    const r = await runPreviewDomainValidation(good);
    expect(r.checks.map((c) => `${c.id}:${c.status}`)).toEqual([
      'config:PASS',
      'dns:NOT VERIFIED',
      'tls:NOT VERIFIED',
      'isolation:NOT VERIFIED',
    ]);
    expect(r.verified).toBe(false);
  });
  it('an invalid configuration fails before any probe is called', async () => {
    let called = 0;
    const probe: DomainProbes = {
      resolve: async () => (called++, ['1.2.3.4']),
      tlsCertificate: async () => (called++, { sans: [], notAfter: '', chainOk: true }),
      get: async () => (called++, { status: 404, headers: {}, body: 'not found' }),
    };
    const r = await runPreviewDomainValidation(
      { ...good, previewDomain: 'preview.nuzm.sa' },
      probe,
    );
    expect(r.checks[0]!.status).toBe('FAIL');
    expect(called).toBe(0);
  });
  const NOW = new Date('2026-12-01T00:00:00Z');
  const ok: DomainProbes = {
    resolve: async () => ['203.0.113.7'],
    tlsCertificate: async () => ({
      sans: ['*.nuzm-preview.example'],
      notAfter: '2027-03-01T00:00:00Z',
      chainOk: true,
    }),
    get: async () => ({
      status: 404,
      headers: { 'content-type': 'text/plain' },
      body: 'not found',
    }),
  };
  it('all probes good -> LIVE-VERIFIED (only because the probes returned it)', async () => {
    const r = await runPreviewDomainValidation(good, ok, () => NOW);
    expect(r.checks.map((c) => c.status)).toEqual([
      'PASS',
      'LIVE-VERIFIED',
      'LIVE-VERIFIED',
      'LIVE-VERIFIED',
    ]);
    expect(r.verified).toBe(true);
  });
  it('detects: no wildcard DNS, wrong/expiring/untrusted certificate, cookies, CORS, reachable API paths', async () => {
    expect(
      (await runPreviewDomainValidation(good, { ...ok, resolve: async () => [] }, () => NOW))
        .checks[1]!.status,
    ).toBe('LIVE-FAILED');
    const tls = (
      c: Partial<{ sans: string[]; notAfter: string; chainOk: boolean }>,
    ): DomainProbes => ({
      ...ok,
      tlsCertificate: async () => ({
        sans: ['*.nuzm-preview.example'],
        notAfter: '2027-03-01T00:00:00Z',
        chainOk: true,
        ...c,
      }),
    });
    for (const c of [
      { sans: ['*.example'] },
      { notAfter: '2026-12-05T00:00:00Z' },
      { chainOk: false },
    ])
      expect((await runPreviewDomainValidation(good, tls(c), () => NOW)).checks[2]!.status).toBe(
        'LIVE-FAILED',
      );
    const get = (
      f: (u: string) => { status: number; headers: Record<string, string>; body: string },
    ): DomainProbes => ({ ...ok, get: async (u) => f(u) });
    const base = { status: 404, headers: {} as Record<string, string>, body: 'not found' };
    expect(
      (
        await runPreviewDomainValidation(
          good,
          get(() => ({ ...base, headers: { 'Set-Cookie': 'a=b' } })),
          () => NOW,
        )
      ).checks[3]!.detail,
    ).toContain('sets cookies');
    expect(
      (
        await runPreviewDomainValidation(
          good,
          get(() => ({ ...base, headers: { 'Access-Control-Allow-Origin': '*' } })),
          () => NOW,
        )
      ).checks[3]!.detail,
    ).toContain('CORS');
    expect(
      (
        await runPreviewDomainValidation(
          good,
          get((u) => (u.endsWith('/v1/me') ? { ...base, status: 401 } : base)),
          () => NOW,
        )
      ).checks[3]!.detail,
    ).toContain('/v1/me');
    expect(
      (
        await runPreviewDomainValidation(
          good,
          get(() => ({ ...base, body: '<html>nginx</html>' })),
          () => NOW,
        )
      ).checks[3]!.status,
    ).toBe('LIVE-FAILED');
    const boom: DomainProbes = {
      ...ok,
      get: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    expect((await runPreviewDomainValidation(good, boom, () => NOW)).checks[3]!.detail).toContain(
      'ECONNREFUSED',
    );
  });
  it('probes only ever target a random name under the preview domain, never a real token or another host', async () => {
    const hosts: string[] = [];
    const rec: DomainProbes = {
      resolve: async (h) => (hosts.push(h), ['1.1.1.1']),
      tlsCertificate: async (h) => (
        hosts.push(h),
        { sans: ['*.nuzm-preview.example'], notAfter: '2027-03-01T00:00:00Z', chainOk: true }
      ),
      get: async (u) => (
        hosts.push(new URL(u).hostname),
        { status: 404, headers: {}, body: 'not found' }
      ),
    };
    await runPreviewDomainValidation(good, rec, () => NOW);
    expect(hosts.length).toBe(5);
    expect(new Set(hosts).size).toBe(1);
    expect(hosts[0]).toMatch(/^[a-z2-7]{32}\.nuzm-preview\.example$/);
  });
});
