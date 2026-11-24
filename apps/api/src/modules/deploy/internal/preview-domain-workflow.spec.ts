import { describe, expect, it } from 'vitest';
import {
  SimulatedDns,
  SimulatedRouting,
  SimulatedTls,
  validatePreviewDomain,
  type PreviewDomainInput,
} from './preview-domain-workflow';
import { temporarySubdomain } from './preview-url';

const PD = 'previews.pv-sim.test';
const PROTECTED = ['console.nuzm-sim.test', 'api.nuzm-sim.test'];
const NOW = new Date('2026-12-01T00:00:00Z');
const host = temporarySubdomain({
  siteName: 'staging',
  deploymentId: 'dep-0001',
  previewDomain: PD,
  protectedDomains: PROTECTED,
}).host;
const good = (over: Partial<PreviewDomainInput> = {}): PreviewDomainInput => ({
  previewDomain: PD,
  protectedDomains: PROTECTED,
  nodeAddresses: ['203.0.113.10'],
  dns: new SimulatedDns({ wildcardFor: PD, address: '203.0.113.10' }),
  tls: new SimulatedTls({ names: [`*.${PD}`], notAfter: '2027-02-01T00:00:00Z', trusted: true }),
  routing: new SimulatedRouting(new Set([host])),
  sample: { siteName: 'staging', deploymentId: 'dep-0001' },
  origin: 'SIMULATED',
  now: () => NOW,
  ...over,
});
const by = (r: Awaited<ReturnType<typeof validatePreviewDomain>>, id: string) =>
  r.checks.find((c) => c.id === id)!;

describe('validatePreviewDomain', () => {
  it('everything present and right: all five checks pass (SIMULATED report)', async () => {
    const r = await validatePreviewDomain(good());
    expect(r.checks.map((c) => c.status)).toEqual(['PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
    expect(r).toMatchObject({ allPass: true, next: null, origin: 'SIMULATED' });
  });
  it('NOTHING exists yet (B-DOMAIN open): every check is NOT VERIFIED with what is needed, never a pass', async () => {
    const r = await validatePreviewDomain({
      previewDomain: null,
      protectedDomains: PROTECTED,
      origin: 'REAL',
    });
    expect(r.checks.every((c) => c.status === 'NOT VERIFIED')).toBe(true);
    expect(r.allPass).toBe(false);
    expect(r.next).toBe('config');
    expect(by(r, 'config').needs[0]).toContain('B-DOMAIN');
  });
  it('domain configured but no DNS, certificate or routing ports: config and cookies pass, the rest say what is missing', async () => {
    const r = await validatePreviewDomain({
      previewDomain: PD,
      protectedDomains: PROTECTED,
      origin: 'REAL',
    });
    expect(by(r, 'config').status).toBe('PASS');
    expect(by(r, 'cookies').status).toBe('PASS');
    for (const id of ['wildcard_dns', 'wildcard_tls', 'routing'])
      expect(by(r, id).status).toBe('NOT VERIFIED');
    expect(r.next).toBe('wildcard_dns');
    expect(r.allPass).toBe(false);
  });
  it('a preview domain under the console registrable domain is refused (ADR-060) and cookies cannot pass', async () => {
    const r = await validatePreviewDomain(good({ previewDomain: 'previews.nuzm-sim.test' }));
    expect(by(r, 'config').status).toBe('FAIL');
    expect(by(r, 'cookies').status).toBe('NOT VERIFIED');
    expect(r.allPass).toBe(false);
  });
  it('a single DNS record is not a wildcard', async () => {
    const r = await validatePreviewDomain(
      good({ dns: new SimulatedDns({ address: '203.0.113.10', single: [host] }) }),
    );
    expect(by(r, 'wildcard_dns')).toMatchObject({ status: 'FAIL' });
    expect(by(r, 'wildcard_dns').detail).toContain('wildcard record is missing');
  });
  it('a wildcard that points somewhere else fails', async () => {
    const r = await validatePreviewDomain(
      good({ dns: new SimulatedDns({ wildcardFor: PD, address: '198.51.100.7' }) }),
    );
    expect(by(r, 'wildcard_dns').status).toBe('FAIL');
  });
  it('certificate problems: not trusted, wrong names, too close to expiry, handshake failure', async () => {
    const t = (c: ConstructorParameters<typeof SimulatedTls>[0]) =>
      validatePreviewDomain(good({ tls: new SimulatedTls(c) }));
    expect(
      by(
        await t({ names: [`*.${PD}`], notAfter: '2027-02-01T00:00:00Z', trusted: false }),
        'wildcard_tls',
      ).detail,
    ).toContain('trusted root');
    expect(
      by(
        await t({ names: [`x.${PD}`], notAfter: '2027-02-01T00:00:00Z', trusted: true }),
        'wildcard_tls',
      ).detail,
    ).toContain('does not cover');
    expect(
      by(
        await t({ names: [`*.${PD}`], notAfter: '2026-12-05T00:00:00Z', trusted: true }),
        'wildcard_tls',
      ).detail,
    ).toContain('expires in 4 days');
    expect(by(await t(null), 'wildcard_tls').detail).toContain('handshake failed');
  });
  it('routing: a catch-all that serves unknown labels fails; no sample deployment keeps it NOT VERIFIED', async () => {
    const catchAll = await validatePreviewDomain(
      good({ routing: new SimulatedRouting(new Set([host]), true) }),
    );
    expect(by(catchAll, 'routing').status).toBe('FAIL');
    const { sample: _s, ...noSample } = good();
    const r = await validatePreviewDomain(noSample);
    expect(by(r, 'routing').status).toBe('NOT VERIFIED');
  });
  it('the temporary host of the sample deployment must answer 200', async () => {
    const r = await validatePreviewDomain(good({ routing: new SimulatedRouting(new Set()) }));
    expect(by(r, 'routing').status).toBe('FAIL');
  });
});
