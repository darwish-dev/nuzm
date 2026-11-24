import { afterAll, describe, expect, it, vi } from 'vitest';

// the kit runs every case against a mock with real client deadlines (about 5 s alone): the 5 s default flakes when the whole workspace runs its tests in parallel
vi.setConfig({ testTimeout: 30_000 });
import { FetchHttpClient, type ContactSet } from '@nuzm/registrar-contracts';
import {
  MemoryVault,
  runRegistrarConformance,
  type RegistrarSubject,
} from '@nuzm/registrar-conformance';
import { DynadotAdapter } from './adapter';
import { startDynadotMock } from './mock-server';

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
  const mock = await startDynadotMock();
  const vault = new MemoryVault().set('vault://test/dynadot', mock.credentials);
  const adapter = new DynadotAdapter({
    baseUrl: mock.url,
    http: new FetchHttpClient({
      adapterId: 'dynadot',
      hosts: ['127.0.0.1'],
      allowLoopback: true,
    }),
    vault,
    evidenceKind: 'mock',
    currency: 'USD',
  });
  let n = 0;
  mock.controls.seedTaken('taken-name.com');
  return {
    subject: {
      adapter,
      ctx: {
        providerAccountId: 'acct-dyn',
        credentialRef: 'vault://test/dynadot',
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

describe('Dynadot adapter: registrar conformance kit against the local mock (NOT VERIFIED vs vendor)', () => {
  it('passes every applicable case (AC-M07-01, mock evidence only)', async () => {
    const report = await runRegistrarConformance(make);
    const failed = report.results.filter((r) => r.status === 'fail');
    expect(failed, JSON.stringify(failed, null, 1)).toEqual([]);
    expect(report.liveStatus).toBe('NOT VERIFIED');
    // DNS, webhooks and billing export are not offered by the Legacy API: those cases are skipped, not faked
    expect(report.results.filter((r) => r.status === 'skipped').map((r) => r.id)).toEqual([
      'R15',
      'R16',
      'R17',
    ]);
  });
  it('declares what the Legacy API cannot do as unsupported and never claims success', async () => {
    const { subject, close } = await make();
    try {
      const c = await subject.adapter.setContacts(subject.ctx, 'x.com', contacts);
      expect(c.status).toBe('failed');
      expect(c.error?.category).toBe('unsupported');
      const p = await subject.adapter.probe(subject.ctx);
      expect(p.capabilities['registrar.dns']).toBe('unsupported');
      expect(p.capabilities['registrar.webhooks']).toBe('unsupported');
      expect(p.capabilities['registrar.billing-export']).toBe('unsupported');
      expect(p.capabilities['registrar.search']).toBe('supported');
      expect(p.capabilities['registrar.auth-code']).toBe('supported');
      expect(p.capabilities['registrar.find-by-token']).toBe('supported');
    } finally {
      await close();
    }
  });
  it('treats a TLD with registry restrictions as restricted; prices are integer minor units; no .sa is claimed', async () => {
    const { subject, close } = await make();
    try {
      const t = await subject.adapter.supportedTlds(subject.ctx);
      expect(t.find((x) => x.tld === 'ae')?.restricted).toBe(true);
      expect(t.find((x) => x.tld === 'com')?.restricted).toBe(false);
      expect(t.find((x) => x.tld === 'com')?.prices?.register).toEqual({
        amountMinor: '1250',
        currency: 'USD',
      });
      expect(t.some((x) => x.tld === 'sa')).toBe(false);
    } finally {
      await close();
    }
  });
  it('the authorization code goes to the store and never into the result; the domain must be unlocked first', async () => {
    const { subject, close } = await make();
    try {
      const name = subject.nextName();
      const r = await subject.adapter.register(subject.ctx, {
        name,
        years: 1,
        contacts,
        privacy: false,
        autoRenew: false,
        idempotencyToken: 'a'.repeat(64),
      });
      expect(['succeeded', 'accepted']).toContain(r.status);
      const locked = await subject.adapter.authCode!(subject.ctx, name, subject.vault);
      expect(locked.status).toBe('failed'); // the vendor refuses while the domain is locked
      await subject.adapter.setLock(subject.ctx, name, false);
      const ok = await subject.adapter.authCode!(subject.ctx, name, subject.vault);
      expect(ok.status).toBe('succeeded');
      expect(JSON.stringify(ok)).not.toContain('MOCK-AUTH-CODE');
      const mat = await subject.vault.resolve(ok.data!.authCodeRef);
      expect(mat.fields.authCode).toBe('MOCK-AUTH-CODE-7731');
    } finally {
      await close();
    }
  });
  it('a bad key is a normalized auth failure that never leaks the key', async () => {
    const { subject, close } = await make();
    try {
      subject.vault.set('vault://test/bad', { apiKey: 'wrong-key-that-must-not-leak' });
      const r = await subject.adapter.probe({ ...subject.ctx, credentialRef: 'vault://test/bad' });
      expect(r.capabilities['registrar.search']).toBe('unknown');
      expect(JSON.stringify(r)).not.toContain('wrong-key-that-must-not-leak');
      const h = await subject.adapter.health({ ...subject.ctx, credentialRef: 'vault://test/bad' });
      expect(h.state).toBe('degraded');
    } finally {
      await close();
    }
  });
});
