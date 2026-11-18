import { describe, expect, it } from 'vitest';
import {
  breakerState,
  capabilityTone,
  capabilityView,
  classifyResource,
  costSummary,
  currencyDigits,
  effectiveJobLabel,
  effectiveRunLabel,
  emptyRule,
  evidenceKindTone,
  formatCost,
  isNegativeMinor,
  isPeriod,
  isUnattributed,
  isVaultRef,
  matchingRules,
  parseCountries,
  pollDelay,
  problemMessage,
  regionTone,
  regionVerification,
  runSkipped,
  runVariance,
  safeCredentialRef,
  showServerDetail,
  sortRules,
  splitOffers,
  toRuleBody,
  worstBreaker,
  type LvRun,
  type RoutingRuleDto,
} from './providers';

describe('vault references: the form accepts a reference, never a value', () => {
  it('accepts vault:// references only', () => {
    expect(isVaultRef('vault://providers/alibaba/prod')).toBe(true);
    expect(isVaultRef('  vault://a  ')).toBe(true);
    for (const bad of [
      '',
      ['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
      'sk_live_123',
      'https://vault/x',
      'vault://',
      'vault:// a b',
    ])
      expect(isVaultRef(bad), bad).toBe(false);
  });
  it('never returns anything that is not a vault reference for display', () => {
    expect(safeCredentialRef('vault://x/y')).toBe('vault://x/y');
    expect(safeCredentialRef('hunter2-secret-value')).toBeNull();
    expect(safeCredentialRef(undefined)).toBeNull();
  });
  it('hides the server explanation of a rejected credential only', () => {
    expect(showServerDetail('credential_value_rejected')).toBe(false);
    expect(showServerDetail('conflict')).toBe(true);
    expect(showServerDetail(undefined)).toBe(true);
  });
});

describe('problem codes map to localized messages', () => {
  it('known codes have their own text in both languages; unknown ones fall back to the status', () => {
    for (const l of ['en', 'ar'] as const) {
      const a = problemMessage(l, 'credential_value_rejected', 422);
      const b = problemMessage(l, 'unsupported_capability', 422);
      const c = problemMessage(l, 'adapter_not_available', 409);
      expect(new Set([a, b, c]).size).toBe(3);
      expect(problemMessage(l, 'never_heard_of_it', 404)).toBe(problemMessage(l, undefined, 404));
    }
    expect(problemMessage('en', 'credential_value_rejected', 422)).toMatch(/vault reference/);
    expect(problemMessage('en', undefined, 403)).toBe('You do not have access');
  });
});

describe('capability matrix: unknown is unsupported', () => {
  it('only an explicit supported is supported', () => {
    expect(capabilityView('supported')).toBe('supported');
    expect(capabilityView('unsupported')).toBe('unsupported');
    expect(capabilityView('unknown')).toBe('unsupported');
    expect(capabilityView('something_new')).toBe('unsupported');
  });
  it('supported is only green with probe evidence', () => {
    expect(capabilityTone({ state: 'supported', evidenceRef: 'ev-1' })).toBe('success');
    expect(capabilityTone({ state: 'supported', evidenceRef: null })).toBe('warn');
    expect(capabilityTone({ state: 'unknown', evidenceRef: 'ev-1' })).toBeUndefined();
  });
});

describe('regions: verified means live evidence', () => {
  const base = { evidenceRef: 'ev-1', verifiedAt: '2026-11-18T00:00:00Z' };
  it('live evidence is verified, fixture / mock / unknown evidence is NOT VERIFIED', () => {
    expect(regionVerification({ state: 'verified', evidenceKind: 'live', ...base })).toBe(
      'verified_live',
    );
    for (const kind of ['fixture', 'mock', null, undefined] as const)
      expect(
        regionVerification({ state: 'verified', evidenceKind: kind, ...base }),
        String(kind),
      ).toBe('not_verified');
  });
  it('live without a reference or a time is not verified either', () => {
    expect(
      regionVerification({
        state: 'verified',
        evidenceKind: 'live',
        evidenceRef: null,
        verifiedAt: base.verifiedAt,
      }),
    ).toBe('not_verified');
    expect(
      regionVerification({
        state: 'verified',
        evidenceKind: 'live',
        evidenceRef: 'x',
        verifiedAt: null,
      }),
    ).toBe('not_verified');
  });
  it('listed and withdrawn are never green; only live evidence kind is green', () => {
    expect(regionVerification({ state: 'listed', evidenceKind: 'live', ...base })).toBe('listed');
    expect(regionVerification({ state: 'withdrawn', evidenceKind: 'live', ...base })).toBe(
      'withdrawn',
    );
    expect(regionTone('not_verified')).toBe('warn');
    expect(regionTone('listed')).toBeUndefined();
    expect(evidenceKindTone('live')).toBe('success');
    expect(evidenceKindTone('fixture')).toBe('warn');
    expect(evidenceKindTone('mock')).toBe('warn');
  });
});

describe('circuit breaker', () => {
  it('reads only the state and treats anything else as unknown; worst state wins', () => {
    expect(breakerState({ state: 'open', failures: 3 })).toBe('open');
    expect(breakerState({ state: 'weird' })).toBe('unknown');
    expect(breakerState(null)).toBe('unknown');
    const acc = (b: unknown) => ({ health: { breaker: b as Record<string, unknown> } });
    expect(worstBreaker([acc({ state: 'closed' }), acc({ state: 'half_open' })])).toBe('half_open');
    expect(worstBreaker([acc({ state: 'closed' }), acc({ state: 'open' })])).toBe('open');
    expect(worstBreaker([])).toBe('unknown');
  });
});

describe('money: integer minor units, any currency, no floats', () => {
  it('formats by string arithmetic', () => {
    expect(formatCost('123456', 'CNY')).toBe('1,234.56 CNY');
    expect(formatCost('5', 'USD')).toBe('0.05 USD');
    expect(formatCost('-1250', 'EUR')).toBe('-12.50 EUR');
    expect(formatCost('1000', 'JPY')).toBe('1,000 JPY');
    expect(formatCost('12345', 'KWD')).toBe('12.345 KWD');
    expect(formatCost('99999999999999999999', 'SAR')).toBe('999,999,999,999,999,999.99 SAR');
    expect(formatCost('12.5', 'SAR')).toBe('12.5');
    expect(currencyDigits('SAR')).toBe(2);
  });
  it('sums totals without crossing currencies', () => {
    expect(
      costSummary([
        { currency: 'CNY', costMinor: '1', records: 3, unattributed: 1 },
        { currency: 'USD', costMinor: '2', records: 2, unattributed: 0 },
      ]),
    ).toEqual({ records: 5, unattributed: 1 });
    expect(isNegativeMinor('-5')).toBe(true);
    expect(isNegativeMinor('5')).toBe(false);
  });
  it('flags unattributed cost records', () => {
    expect(isUnattributed({ orgId: null, resourceId: 'r' })).toBe(true);
    expect(isUnattributed({ orgId: 'o', resourceId: null })).toBe(true);
    expect(isUnattributed({ orgId: 'o', resourceId: 'r' })).toBe(false);
  });
});

describe('RC-04', () => {
  it('variance: none, resolved, open; skipped comparisons are recognised', () => {
    expect(runVariance({ status: 'completed', breaksCount: 0, openBreaks: 0 })).toBe('none');
    expect(runVariance({ status: 'completed', breaksCount: 2, openBreaks: 0 })).toBe('resolved');
    expect(runVariance({ status: 'completed', breaksCount: 2, openBreaks: 1 })).toBe('open');
    expect(runVariance({ status: 'failed', breaksCount: 2, openBreaks: 1 })).toBe('none');
    expect(runSkipped({ skipped: true })).toBe(true);
    expect(runSkipped({ skipped: 'no provider bills' })).toBe(true);
    expect(runSkipped({})).toBe(false);
    expect(runSkipped(null)).toBe(false);
  });
});

describe('live verification labels never claim more than the evidence', () => {
  const run = (over: Partial<LvRun>): LvRun => ({
    id: 'r',
    jobId: 'live-verify-alibaba',
    status: 'LIVE-VERIFIED',
    reason: '',
    steps: [],
    evidenceIds: ['e1'],
    gateEvidenceId: 'g1',
    spendCapMinor: null,
    currency: null,
    residualResources: 0,
    createdAt: '2026-11-18T00:00:00Z',
    ...over,
  });
  it('LIVE-VERIFIED needs evidence ids and gate evidence', () => {
    expect(effectiveRunLabel(run({}))).toBe('LIVE-VERIFIED');
    expect(effectiveRunLabel(run({ evidenceIds: [] }))).toBe('NOT VERIFIED');
    expect(effectiveRunLabel(run({ gateEvidenceId: null }))).toBe('NOT VERIFIED');
    expect(effectiveRunLabel(run({ status: 'FAIL' }))).toBe('FAIL');
    expect(effectiveRunLabel(run({ status: 'NOT RUN' }))).toBe('NOT RUN');
    expect(effectiveRunLabel(run({ status: 'WHATEVER' as never }))).toBe('NOT VERIFIED');
  });
  it('a job is LIVE-VERIFIED only while its gate is granted', () => {
    expect(effectiveJobLabel({ label: 'LIVE-VERIFIED', gateStatus: 'GRANTED' })).toBe(
      'LIVE-VERIFIED',
    );
    expect(effectiveJobLabel({ label: 'LIVE-VERIFIED', gateStatus: 'PENDING' })).toBe(
      'NOT VERIFIED',
    );
    expect(effectiveJobLabel({ label: 'NOT RUN', gateStatus: 'PENDING' })).toBe('NOT RUN');
  });
});

describe('routing rule form', () => {
  const ok = { ...emptyRule(), ruleKey: 'sa.prefer.contabo', providerKey: 'contabo' };
  it('builds the API body', () => {
    const r = toRuleBody({
      ...ok,
      countries: 'sa, ae',
      geoGroups: ['gcc'],
      mode: 'automatic',
      note: ' n ',
    });
    expect(r).toEqual({
      body: {
        ruleKey: 'sa.prefer.contabo',
        priority: 100,
        match: { country: ['SA', 'AE'], geoGroup: ['gcc'], mode: 'automatic' },
        action: { type: 'prefer', providerKey: 'contabo' },
        enabled: true,
        note: 'n',
      },
    });
  });
  it('lists the invalid fields', () => {
    expect(toRuleBody({ ...emptyRule() })).toEqual({ invalid: ['ruleKey', 'target'] });
    const r = toRuleBody({ ...ok, priority: '1.5', countries: 'SAU', accountId: 'nope' });
    expect(r).toEqual({ invalid: ['priority', 'countries', 'accountId'] });
  });
  it('parses countries', () => {
    expect(parseCountries('sa; AE sa')).toEqual(['SA', 'AE']);
    expect(parseCountries('S')).toBeNull();
  });
  const rule = (o: Partial<RoutingRuleDto>): RoutingRuleDto => ({
    id: Math.random().toString(),
    ruleKey: 'k',
    version: 1,
    priority: 10,
    match: {},
    action: { type: 'prefer', providerKey: 'p' },
    enabled: true,
    ...o,
  });
  it('sorts by priority then key and previews matching enabled rules', () => {
    const rules = [
      rule({ ruleKey: 'b', priority: 5, match: { country: ['SA'] } }),
      rule({ ruleKey: 'a', priority: 5, match: { geoGroup: ['eu'] } }),
      rule({ ruleKey: 'c', priority: 1, enabled: false }),
      rule({ ruleKey: 'd', priority: 9, match: { mode: 'explicit' } }),
    ];
    expect(sortRules(rules).map((r) => r.ruleKey)).toEqual(['c', 'a', 'b', 'd']);
    expect(
      matchingRules(rules, { mode: 'automatic', country: 'sa' }).map((r) => r.ruleKey),
    ).toEqual(['b']);
    expect(
      matchingRules(rules, { mode: 'explicit', geoGroup: 'eu' }).map((r) => r.ruleKey),
    ).toEqual(['a', 'd']);
  });
  it('splits dry-run offers by eligibility', () => {
    const s = splitOffers([{ eligible: true }, { eligible: false, failures: ['residency'] }, {}]);
    expect(s.eligible).toHaveLength(2);
    expect(s.ineligible).toHaveLength(1);
  });
});

describe('operations classification and polling', () => {
  const now = new Date('2026-11-18T12:00:00Z');
  it('UNKNOWN needs reconciliation; old PROVISIONING / DELETING is stuck; young is in progress', () => {
    expect(classifyResource({ state: 'UNKNOWN', createdAt: '2026-11-18T11:59:00Z' }, now)).toBe(
      'needs_reconcile',
    );
    expect(
      classifyResource({ state: 'PROVISIONING', createdAt: '2026-11-18T11:00:00Z' }, now),
    ).toBe('stuck');
    expect(classifyResource({ state: 'DELETING', createdAt: '2026-11-18T11:50:00Z' }, now)).toBe(
      'in_progress',
    );
    expect(classifyResource({ state: 'PROVISIONING' }, now)).toBe('in_progress');
    expect(classifyResource({ state: 'ACTIVE', createdAt: '2020-01-01T00:00:00Z' }, now)).toBe(
      'settled',
    );
  });
  it('poll delay doubles to 8 s and stops after the budget', () => {
    expect([0, 1, 2, 3, 4, 10].map(pollDelay)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
    expect(pollDelay(100)).toBeNull();
  });
  it('periods', () => {
    expect(isPeriod('2026-11')).toBe(true);
    expect(isPeriod('2026-13')).toBe(false);
    expect(isPeriod('2026-1')).toBe(false);
  });
});
