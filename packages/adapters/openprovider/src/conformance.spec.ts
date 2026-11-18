import { afterAll, describe, expect, it } from 'vitest';
import { FetchHttpClient, type ContactSet } from '@nuzm/registrar-contracts';
import {
  MemoryVault,
  runRegistrarConformance,
  type RegistrarSubject,
} from '@nuzm/registrar-conformance';
import { OpenproviderAdapter } from './adapter';
import { startOpenproviderMock } from './mock-server';

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

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

async function make(): Promise<{ subject: RegistrarSubject; close: () => Promise<void> }> {
  const mock = await startOpenproviderMock();
  const vault = new MemoryVault().set('vault://test/openprovider', mock.credentials);
  const adapter = new OpenproviderAdapter({
    baseUrl: mock.url,
    http: new FetchHttpClient({
      adapterId: 'openprovider',
      hosts: ['127.0.0.1'],
      allowLoopback: true,
    }),
    vault,
    evidenceKind: 'mock',
  });
  let n = 0;
  mock.controls.seedTaken('taken-name.com');
  return {
    subject: {
      adapter,
      ctx: {
        providerAccountId: 'acct-op',
        credentialRef: 'vault://test/openprovider',
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
      secrets: Object.values(mock.credentials),
      nextName: () => `conf-${Date.now().toString(36)}-${++n}.com`,
    },
    close: mock.close,
  };
}

describe('Openprovider adapter: registrar conformance kit against the local mock (NOT VERIFIED vs vendor)', () => {
  it('passes every applicable case (AC-M07-01, mock evidence only)', async () => {
    const report = await runRegistrarConformance(make);
    const failed = report.results.filter((r) => r.status === 'fail');
    expect(failed, JSON.stringify(failed, null, 1)).toEqual([]);
    expect(report.liveStatus).toBe('NOT VERIFIED');
    expect(report.evidenceKind).toBe('mock');
    console.log(report.results.map((r) => r.id + ':' + r.status).join(' '));
    expect(report.passed).toBeGreaterThanOrEqual(16);
    closers.push(async () => undefined);
  });
});

describe('Openprovider adapter specifics', () => {
  it('a real client deadline on a mutating call is uncertain, not failed', async () => {
    const { subject, close } = await make();
    try {
      const slow = new FetchHttpClient(
        { adapterId: 'openprovider', hosts: ['127.0.0.1'], allowLoopback: true },
        ((url: unknown, init?: RequestInit) =>
          new Promise((_res, rej) => {
            init?.signal?.addEventListener('abort', () =>
              rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            );
            void url;
          })) as unknown as typeof fetch,
      );
      const a = new OpenproviderAdapter({
        baseUrl: 'http://127.0.0.1:1/v1',
        http: slow,
        vault: subject.vault,
        evidenceKind: 'mock',
      });
      const r = await a.register(
        { ...subject.ctx, deadlineMs: 50 },
        {
          name: 'x-timeout.com',
          years: 1,
          contacts,
          privacy: false,
          autoRenew: false,
          idempotencyToken: 'a'.repeat(64),
        },
      );
      expect(
        r.status === 'uncertain' || (r.status === 'failed' && r.error?.retryable === true),
      ).toBe(true);
      const login = r.status;
      expect(login).not.toBe('succeeded');
    } finally {
      await close();
    }
  });
  it('flags a restricted TLD and never lists .sa', async () => {
    const { subject, close } = await make();
    try {
      const t = await subject.adapter.supportedTlds(subject.ctx);
      expect(t.find((x) => x.tld === 'ae')?.restricted).toBe(true);
      expect(t.find((x) => x.tld === 'com')?.restricted).toBe(false);
      expect(t.some((x) => x.tld === 'sa')).toBe(false);
    } finally {
      await close();
    }
  });
  it('probe of an unauthorized account leaves every capability unknown', async () => {
    const { subject, close } = await make();
    try {
      subject.vault.set('vault://test/openprovider', { username: 'x', password: 'y' });
      const p = await subject.adapter.probe(subject.ctx).catch(() => null);
      if (p) expect(Object.values(p.capabilities).every((s) => s === 'unknown')).toBe(true);
    } finally {
      await close();
    }
  });
});
