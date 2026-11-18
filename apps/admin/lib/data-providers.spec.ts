import { describe, expect, it } from 'vitest';
import {
  capabilitySummary,
  configureBody,
  enableBlock,
  isDevReference,
  probeOf,
  validAdr,
  verifiedAtIso,
  type ProviderRow,
} from './data-providers';

const row = (o: Partial<ProviderRow> = {}): ProviderRow => ({
  id: 'p1',
  service: 'database',
  family: 'f',
  providerCode: 'some-provider',
  environment: 'production',
  enabled: false,
  blockers: [],
  version: 1,
  ...o,
});
const me = (...perms: string[]) => ({ id: 'me', can: (p: string) => perms.includes(p) });

describe('dev-reference rows', () => {
  it('are recognised by code or environment', () => {
    expect(isDevReference(row({ providerCode: 'mock-database', environment: 'local' }))).toBe(true);
    expect(isDevReference(row({ providerCode: 'local-x', environment: 'staging' }))).toBe(true);
    expect(isDevReference(row({ environment: 'local' }))).toBe(true);
    expect(isDevReference(row())).toBe(false);
  });
});

describe('probe evidence', () => {
  it('reads the stored probe and counts supported capabilities', () => {
    const p = probeOf({
      probedAt: 't',
      passed: true,
      evidenceKinds: ['live'],
      capabilities: { b: 'supported', a: 'unsupported' },
    });
    expect(p).toEqual({
      probedAt: 't',
      passed: true,
      evidenceKinds: ['live'],
      capabilities: [
        ['a', 'unsupported'],
        ['b', 'supported'],
      ],
    });
    expect(capabilitySummary(p!.capabilities)).toEqual({ supported: 1, total: 2 });
    expect(probeOf(null)).toBeNull();
    expect(probeOf({})?.passed).toBe(false);
  });
});

describe('configure body', () => {
  const f = {
    service: 'object-storage',
    family: 'fam',
    providerCode: 'prov',
    account: '',
    environment: 'staging',
    adrRef: '',
    config: '',
  };
  it('builds the action body; credentials are vault references only', () => {
    expect(
      configureBody({
        ...f,
        config: '{"credentialRef":"vault://x/y","versions":{"postgresql":["16"]}}',
        adrRef: 'ADR-050',
      }).body,
    ).toEqual({
      action: 'configure',
      service: 'object-storage',
      family: 'fam',
      providerCode: 'prov',
      providerAccountId: null,
      environment: 'staging',
      adrRef: 'ADR-050',
      config: { credentialRef: 'vault://x/y', versions: { postgresql: ['16'] } },
    });
  });
  it('refuses secrets, bad vault references and bad JSON', () => {
    expect(configureBody({ ...f, config: '{"apiKey":"abc"}' }).error).toBe('secret');
    expect(configureBody({ ...f, config: '{"password":"abc"}' }).error).toBe('secret');
    expect(configureBody({ ...f, config: '{"credentialRef":"abc"}' }).error).toBe('vault');
    expect(configureBody({ ...f, config: '[1]' }).error).toBe('config');
    expect(configureBody({ ...f, config: '{oops' }).error).toBe('config');
    expect(configureBody({ ...f, adrRef: 'ADR-5' }).error).toBe('adr');
  });
  it('keeps dev-reference codes on the local environment and only them', () => {
    expect(
      configureBody({ ...f, providerCode: 'mock-database', environment: 'staging' }).error,
    ).toBe('environment');
    expect(configureBody({ ...f, providerCode: 'prov', environment: 'local' }).error).toBe(
      'environment',
    );
    expect(
      configureBody({ ...f, providerCode: 'mock-database', environment: 'local' }).body,
    ).toBeDefined();
  });
  it('carries the id when editing', () => {
    expect(configureBody({ ...f, id: 'abc' }).body?.id).toBe('abc');
  });
});

describe('ADR and evidence time', () => {
  it('validates the ADR format', () => {
    expect(validAdr('ADR-050')).toBe(true);
    expect(validAdr('adr-050')).toBe(false);
    expect(validAdr('ADR-5')).toBe(false);
  });
  it('rejects empty, invalid and future times', () => {
    const now = Date.parse('2026-11-18T12:00:00Z');
    expect(verifiedAtIso('', now)).toBeNull();
    expect(verifiedAtIso('nope', now)).toBeNull();
    expect(verifiedAtIso('2026-11-20T00:00:00Z', now)).toBeNull();
    expect(verifiedAtIso('2026-11-17T08:30:00Z', now)).toBe('2026-11-17T08:30:00.000Z');
  });
});

describe('who may enable', () => {
  const ok = { blockers: [] as string[] };
  it('needs the approve permission', () => {
    expect(enableBlock(row(ok), me('admin:data:manage'))).toBe('no_permission');
  });
  it('is the two-person rule: the requester cannot enable outside local', () => {
    expect(enableBlock(row({ ...ok, requestedBy: 'me' }), me('admin:data:approve'))).toBe(
      'two_person',
    );
    expect(enableBlock(row({ ...ok, requestedBy: 'other' }), me('admin:data:approve'))).toBeNull();
    expect(
      enableBlock(
        row({ ...ok, requestedBy: 'me', environment: 'local' }),
        me('admin:data:approve'),
      ),
    ).toBeNull();
  });
  it('is blocked by every blocker except the second-approver one (the person is the second approver)', () => {
    expect(
      enableBlock(
        row({ blockers: ['second_approver_missing'], requestedBy: 'other' }),
        me('admin:data:approve'),
      ),
    ).toBeNull();
    expect(enableBlock(row({ blockers: ['adr_not_accepted'] }), me('admin:data:approve'))).toBe(
      'blocked',
    );
    expect(
      enableBlock(
        row({ blockers: ['enable_not_requested'], environment: 'local' }),
        me('admin:data:approve'),
      ),
    ).toBeNull();
    expect(enableBlock(row({ blockers: ['enable_not_requested'] }), me('admin:data:approve'))).toBe(
      'blocked',
    );
  });
});
