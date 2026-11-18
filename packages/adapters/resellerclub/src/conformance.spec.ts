import { afterAll, describe, expect, it } from 'vitest';
import { FetchHttpClient, type ContactSet } from '@nuzm/registrar-contracts';
import {
  MemoryVault,
  runRegistrarConformance,
  type RegistrarSubject,
} from '@nuzm/registrar-conformance';
import { ResellerClubAdapter } from './adapter';
import { startResellerClubMock } from './mock-server';

const contact = (email: string) => ({
  firstName: 'Test',
  lastName: 'Person',
  email,
  phone: '+966500000000',
  address: { street: 'King Fahd Rd', city: 'Riyadh', postalCode: '12211', country: 'SA' },
});
const CANARY = 'canary.person@example.invalid';
const contacts: ContactSet = {
  registrant: contact(CANARY),
  admin: contact(CANARY),
  tech: contact(CANARY),
  billing: contact(CANARY),
};
afterAll(() => undefined);

async function make(): Promise<{ subject: RegistrarSubject; close: () => Promise<void> }> {
  const mock = await startResellerClubMock();
  const vault = new MemoryVault().set('vault://test/resellerclub', mock.credentials);
  const adapter = new ResellerClubAdapter({
    baseUrl: mock.url,
    domainCheckUrl: mock.url,
    http: new FetchHttpClient({
      adapterId: 'resellerclub',
      hosts: ['127.0.0.1'],
      allowLoopback: true,
    }),
    vault,
    evidenceKind: 'mock',
    currency: 'USD',
    defaultNameservers: ['ns1.example.net', 'ns2.example.net'],
  });
  let n = 0;
  mock.controls.seedTaken('taken-name.com');
  return {
    subject: {
      adapter,
      ctx: {
        providerAccountId: 'acct-rc',
        credentialRef: 'vault://test/resellerclub',
        traceId: 't',
        deadlineMs: 2000,
      },
      controls: mock.controls,
      vault,
      evidenceKind: 'mock',
      fixture: {
        tld: 'com',
        freeName: 'free-name.com',
        takenName: 'taken-name.com',
        contacts,
        canaryEmail: CANARY,
      },
      secrets: Object.values(mock.credentials).filter((v) => v.length > 5),
      nextName: () => `conf-${Date.now().toString(36)}-${++n}.com`,
    },
    close: mock.close,
  };
}

describe('ResellerClub adapter: registrar conformance kit against the local mock (NOT VERIFIED vs vendor)', () => {
  it('passes every applicable case (AC-M07-01, mock evidence only)', async () => {
    const report = await runRegistrarConformance(make);
    const failed = report.results.filter((r) => r.status === 'fail');
    expect(failed, JSON.stringify(failed, null, 1)).toEqual([]);
    expect(report.liveStatus).toBe('NOT VERIFIED');
    // DNS and webhooks are documented as unsupported for this vendor: those cases are skipped, not faked
    expect(report.results.filter((r) => r.status === 'skipped').map((r) => r.id)).toEqual([
      'R15',
      'R16',
    ]);
  });
  it('unsupported operations answer failed/unsupported and never claim success', async () => {
    const { subject, close } = await make();
    try {
      const a = await subject.adapter.setAutoRenew(subject.ctx, 'x.com', true);
      expect(a.status).toBe('failed');
      expect(a.error?.category).toBe('unsupported');
      const c = await subject.adapter.setContacts(subject.ctx, 'x.com', contacts);
      expect(c.error?.category).toBe('unsupported');
      const p = await subject.adapter.probe(subject.ctx);
      expect(p.capabilities['registrar.dns']).toBe('unsupported');
      expect(p.capabilities['registrar.webhooks']).toBe('unsupported');
      expect(p.capabilities['registrar.find-by-token']).toBe('supported');
    } finally {
      await close();
    }
  });
  it('treats ccTLDs as restricted (conservative) and prices come from the cost API as integer minor units', async () => {
    const { subject, close } = await make();
    try {
      const t = await subject.adapter.supportedTlds(subject.ctx);
      expect(t.find((x) => x.tld === 'ae')?.restricted).toBe(true);
      expect(t.find((x) => x.tld === 'com')?.prices?.register).toEqual({
        amountMinor: '850',
        currency: 'USD',
      });
      expect(t.some((x) => x.tld === 'sa')).toBe(false);
    } finally {
      await close();
    }
  });
});
