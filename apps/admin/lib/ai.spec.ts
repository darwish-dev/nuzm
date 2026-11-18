import { describe, expect, it } from 'vitest';
import {
  anyBreach,
  attestBody,
  blockers,
  breached,
  configureBody,
  configureFormOf,
  enableBlock,
  isDevReference,
  killSwitchBody,
  metricDelta,
  metricText,
  parseQuality,
  parseRateCard,
  rateCardRows,
  requestBlock,
  runFilters,
  runRows,
  runTone,
  termsOf,
  type ConfigureForm,
  type ProviderRow,
} from './ai';

const RATE = { models: { 'm-1': { creditsPerMillionInput: '10', creditsPerMillionOutput: '30' } } };
const row = (o: Partial<ProviderRow> = {}): ProviderRow => ({
  id: 'p1',
  code: 'some-provider',
  adapter: 'some-adapter',
  displayName: 'Some provider',
  region: 'sa-central',
  dataTerms: { attested: true, retainsPrompts: false, trainsOnData: false },
  attestationRef: 'HG-09-01/ref-1',
  vaultRef: null,
  rateCardVersion: '1',
  rateCard: RATE,
  enabled: false,
  enableRequestedBy: 'alice',
  enabledBy: null,
  adapterRegistered: true,
  version: 1,
  ...o,
});
const me = (id: string, ...perms: string[]) => ({ id, can: (p: string) => perms.includes(p) });

describe('provider data terms and rate card', () => {
  it('data terms: only what is stated is known; the rest is "unknown"', () => {
    expect(termsOf(row())).toEqual({ attested: true, retainsPrompts: false, trainsOnData: false });
    expect(termsOf(row({ dataTerms: {} }))).toEqual({
      attested: false,
      retainsPrompts: 'unknown',
      trainsOnData: 'unknown',
    });
    expect(
      termsOf(
        row({ dataTerms: { attested: 'yes', retainsPrompts: 'maybe', processingRegion: 'x' } }),
      ),
    ).toEqual({
      attested: false,
      retainsPrompts: 'unknown',
      trainsOnData: 'unknown',
      processingRegion: 'x',
    });
  });
  it('reads the rate card defensively and sorts by model', () => {
    expect(
      rateCardRows({
        rateCard: {
          models: {
            b: { creditsPerMillionInput: '1', creditsPerMillionOutput: '2' },
            a: { creditsPerMillionInput: 5 },
          },
        },
      }),
    ).toEqual([
      { model: 'a', input: '—', output: '—' },
      { model: 'b', input: '1', output: '2' },
    ]);
    expect(rateCardRows({ rateCard: {} })).toEqual([]);
    expect(rateCardRows({})).toEqual([]);
    expect(rateCardRows({ rateCard: { models: [] } })).toEqual([]);
  });
  it('dev references are recognised by code', () => {
    expect(isDevReference('mock-chat')).toBe(true);
    expect(isDevReference('local-x')).toBe(true);
    expect(isDevReference('acme')).toBe(false);
  });
});

describe('enabling rules', () => {
  it('a fully prepared provider has no blockers; each missing precondition is listed', () => {
    expect(blockers(row())).toEqual([]);
    expect(blockers(row({ adapterRegistered: false }))).toEqual(['adapter_not_registered']);
    expect(blockers(row({ rateCard: { models: {} } }))).toEqual(['no_rate_card']);
    expect(blockers(row({ dataTerms: { attested: false } }))).toEqual(['not_attested']);
    expect(blockers(row({ attestationRef: null }))).toEqual(['not_attested']);
    expect(blockers(row({ enableRequestedBy: null }))).toEqual(['not_requested']);
  });
  it('a dev reference needs no attestation and no request', () => {
    expect(
      blockers(
        row({ code: 'mock-chat', dataTerms: {}, attestationRef: null, enableRequestedBy: null }),
      ),
    ).toEqual([]);
  });
  it('requesting is possible before a request exists, never before attestation', () => {
    expect(requestBlock(row({ enableRequestedBy: null }))).toEqual([]);
    expect(requestBlock(row({ dataTerms: {}, enableRequestedBy: null }))).toEqual(['not_attested']);
  });
  it('enable: permission, two-person rule, then blockers', () => {
    expect(enableBlock(row(), me('bob'))).toBe('no_permission');
    expect(enableBlock(row(), me('alice', 'admin:ai:approve'))).toBe('two_person');
    expect(enableBlock(row(), me('bob', 'admin:ai:approve'))).toBeNull();
    expect(enableBlock(row({ enableRequestedBy: null }), me('bob', 'admin:ai:approve'))).toBe(
      'blocked',
    );
    // the dev references are exempt from the second person
    expect(
      enableBlock(
        row({ code: 'mock-chat', enableRequestedBy: 'alice' }),
        me('alice', 'admin:ai:approve'),
      ),
    ).toBeNull();
  });
});

describe('configure body', () => {
  const f: ConfigureForm = {
    code: 'acme-ai',
    adapter: 'acme',
    displayName: 'Acme AI',
    region: 'sa-central',
    vaultRef: 'vault://ai/acme',
    rateCardVersion: '2',
    rateCard: JSON.stringify(RATE),
    egress: 'api.acme.example, models.acme.example',
  };
  it('builds the action body with a vault reference, never a secret', () => {
    expect(configureBody(f).body).toEqual({
      action: 'configure',
      code: 'acme-ai',
      adapter: 'acme',
      displayName: 'Acme AI',
      region: 'sa-central',
      vaultRef: 'vault://ai/acme',
      rateCard: RATE,
      rateCardVersion: '2',
      egressAllow: ['api.acme.example', 'models.acme.example'],
    });
    expect(JSON.stringify(configureBody(f).body)).not.toMatch(/secret|password|apiKey|token/i);
  });
  it('refuses anything that is not a vault reference (credential values are never sent)', () => {
    for (const v of ['sk-live-abc123', 'https://x', 'vault:/x', 'vault://']) {
      expect(configureBody({ ...f, vaultRef: v }).error).toBe('vault');
    }
    expect(configureBody({ ...f, vaultRef: '' }).body).not.toHaveProperty('vaultRef');
  });
  it('validates each field', () => {
    expect(configureBody({ ...f, code: 'Bad Code' }).error).toBe('code');
    expect(configureBody({ ...f, adapter: '1x' }).error).toBe('adapter');
    expect(configureBody({ ...f, displayName: ' ' }).error).toBe('displayName');
    expect(configureBody({ ...f, region: 'x' }).error).toBe('region');
    expect(configureBody({ ...f, egress: 'ok.example, NOT A HOST' }).error).toBe('egress');
    expect(configureBody({ ...f, rateCard: '{bad' }).error).toBe('rateCard');
  });
  it('rate cards need integer-string prices per million tokens', () => {
    expect(parseRateCard('')).toEqual({ models: {} });
    expect(
      parseRateCard(
        '{"models":{"m":{"creditsPerMillionInput":"1.5","creditsPerMillionOutput":"2"}}}',
      ),
    ).toBeNull();
    expect(
      parseRateCard('{"models":{"m":{"creditsPerMillionInput":1,"creditsPerMillionOutput":"2"}}}'),
    ).toBeNull();
    expect(parseRateCard('{"models":[]}')).toBeNull();
    expect(parseRateCard('[]')).toBeNull();
  });
  it('an existing row prefills everything except the egress list', () => {
    const form = configureFormOf(row({ vaultRef: 'vault://a/b' }));
    expect(form).toMatchObject({ code: 'some-provider', vaultRef: 'vault://a/b', egress: '' });
    expect(JSON.parse(form.rateCard)).toEqual(RATE);
    expect(configureFormOf(null).rateCardVersion).toBe('1');
  });
});

describe('attestation and kill switch bodies', () => {
  it('attestation needs a reference and an explicit answer for each term', () => {
    expect(
      attestBody('p1', { ref: 'HG-09-01/x', retains: 'false', trains: 'unknown' }).body,
    ).toEqual({
      action: 'attest',
      id: 'p1',
      attestationRef: 'HG-09-01/x',
      dataTerms: { retainsPrompts: false, trainsOnData: 'unknown' },
    });
    expect(attestBody('p1', { ref: 'ab', retains: 'false', trains: 'false' }).error).toBe('ref');
    expect(attestBody('p1', { ref: 'abc', retains: '', trains: 'false' }).error).toBe('terms');
  });
  it('kill switch is global without an organization, or for one valid organization id', () => {
    expect(killSwitchBody(true, '')).toEqual({ action: 'kill_switch', on: true });
    expect(killSwitchBody(false, ' 0194A1B2-1111-7222-8333-444455556666 ')).toEqual({
      action: 'kill_switch',
      on: false,
      orgId: '0194a1b2-1111-7222-8333-444455556666',
    });
    expect(killSwitchBody(true, 'not-a-uuid')).toBeNull();
  });
});

describe('run oversight rows', () => {
  it('keeps metadata only and drops malformed rows', () => {
    const rows = runRows([
      {
        id: 'r1',
        orgId: 'o1',
        sessionId: 's1',
        projectId: null,
        kind: 'website',
        state: 'failed',
        tokensIn: 10,
        tokensOut: 20,
        spentCredits: '7',
        modelRef: 'mock/m',
        dataRegion: 'sa-central',
        errorCode: 'budget_exceeded',
        createdAt: '2027-01-01T00:00:00Z',
        finishedAt: null,
        prompt: 'SECRET PROMPT',
        output: 'SECRET OUTPUT',
      },
      { kind: 'x' },
      'nope',
    ]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
    expect(rows[0]).toMatchObject({ id: 'r1', spentCredits: '7', errorCode: 'budget_exceeded' });
  });
  it('tones and filters', () => {
    expect(runTone('succeeded')).toBe('success');
    expect(runTone('budget_exceeded')).toBe('danger');
    expect(runTone('waiting_approval')).toBe('warn');
    expect(runTone('cancelled')).toBeUndefined();
    expect(runFilters({ orgId: '0194A1B2-1111-7222-8333-444455556666', state: 'failed' })).toEqual({
      orgId: '0194a1b2-1111-7222-8333-444455556666',
      state: 'failed',
      invalidOrg: false,
    });
    expect(runFilters({ orgId: 'x', state: 'weird' })).toEqual({ invalidOrg: true });
    expect(runFilters({})).toEqual({ invalidOrg: false });
  });
});

describe('quality reports', () => {
  const raw = {
    thresholds: { htmlErrorFreeSites: 0.95, a11yScore: 90, junk: 'x' },
    reports: [
      {
        id: 'old',
        createdAt: '2027-01-01T00:00:00Z',
        model: 'mock-model',
        modelQuality: 'NOT VERIFIED',
        sites: 40,
        metrics: { htmlErrorFreeSites: 0.9, requirementCoverage: 1 },
        breaches: ['htmlErrorFreeSites'],
      },
      {
        id: 'new',
        createdAt: '2027-02-01T00:00:00Z',
        model: 'mock-model',
        sites: 40,
        metrics: { htmlErrorFreeSites: 1, requirementCoverage: 0.95, bogus: 3 },
        breaches: [],
      },
      { createdAt: 'no id' },
    ],
  };
  it('reads defensively: newest first, unknown metrics dropped, missing quality is NOT VERIFIED', () => {
    const q = parseQuality(raw);
    expect(q.thresholds).toEqual({ htmlErrorFreeSites: 0.95, a11yScore: 90 });
    expect(q.reports.map((r) => r.id)).toEqual(['new', 'old']);
    expect(q.reports[0]!.modelQuality).toBe('NOT VERIFIED');
    expect(q.reports[0]!.metrics).toEqual({ htmlErrorFreeSites: 1, requirementCoverage: 0.95 });
    expect(parseQuality(null)).toEqual({ thresholds: {}, reports: [] });
    expect(parseQuality({ reports: 'x' }).reports).toEqual([]);
  });
  it('breaches are the harness verdict; a breach anywhere raises the warning', () => {
    const q = parseQuality(raw);
    expect(breached(q.reports[1]!, 'htmlErrorFreeSites')).toBe(true);
    expect(breached(q.reports[0]!, 'htmlErrorFreeSites')).toBe(false);
    expect(anyBreach(q)).toBe(true);
    expect(anyBreach({ thresholds: {}, reports: [q.reports[0]!] })).toBe(false);
  });
  it('formats metrics and the change against the previous report; a missing side gives no delta', () => {
    const q = parseQuality(raw);
    expect(metricText(1)).toBe('1');
    expect(metricText(0.9512)).toBe('0.95');
    expect(metricText(undefined)).toBeNull();
    expect(metricDelta(q.reports, 0, 'htmlErrorFreeSites')).toBe('+0.1');
    expect(metricDelta(q.reports, 0, 'requirementCoverage')).toBe('-0.05');
    expect(metricDelta(q.reports, 0, 'a11yScore')).toBeNull();
    expect(metricDelta(q.reports, 1, 'htmlErrorFreeSites')).toBeNull();
  });
});
