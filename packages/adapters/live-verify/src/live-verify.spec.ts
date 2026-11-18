import { describe, expect, it } from 'vitest';
import { MockComputeAdapter } from '@nuzm/adapter-mock-compute';
import { buildRegionReport } from './region-report';
import { runLiveVerification, type LvOptions } from './runner';

const mk = (over: Partial<LvOptions> = {}): LvOptions => {
  const adapter = new MockComputeAdapter();
  return {
    jobId: 'unit',
    adapter,
    ctx: {
      providerAccountId: 'a',
      credentialRef: 'vault://dev/mock/x',
      traceId: 't',
      deadlineMs: 1000,
    },
    target: {
      providerRegionId: 'mock-eu-1',
      planRef: 'mock.small',
      imageRef: 'mock-ubuntu',
      estimatedCostMinor: 100,
      currency: 'SAR',
      sshPublicKey: 'ssh-ed25519 AAAA test',
    },
    trigger: { hgId: 'HG-05-01', evidenceId: 'EV-TEST-1', spendCapMinor: 1000, currency: 'SAR' },
    sleep: async () => {},
    ...over,
  };
};

describe('live-verify runner', () => {
  it('does nothing without an owner trigger (agents never trigger live runs)', async () => {
    const r = await runLiveVerification(mk({ trigger: undefined }));
    expect(r.status).toBe('NOT RUN');
    expect(r.steps).toEqual([]);
  });
  it('refuses when the estimated cost exceeds the spend cap', async () => {
    const r = await runLiveVerification(
      mk({ target: { ...mk().target, estimatedCostMinor: 5000 } }),
    );
    expect(r.status).toBe('NOT RUN');
  });
  it('a complete run over MOCK evidence passes every step but is labelled NOT VERIFIED, with zero residue', async () => {
    const o = mk();
    const r = await runLiveVerification(o);
    expect(r.steps.filter((s) => s.status === 'fail')).toEqual([]);
    expect(r.exercised).toEqual(
      expect.arrayContaining(['compute.provision', 'compute.delete', 'compute.action.stop']),
    );
    expect(r.residualResources).toBe(0);
    expect(r.status).toBe('NOT VERIFIED');
    expect((o.adapter as MockComputeAdapter).billableCount()).toBe(0);
  });
  it('a failing delete leaves residue → FAIL and the owner is paged', async () => {
    const o = mk();
    (o.adapter as MockComputeAdapter).inject({ op: 'delete', kind: 'outage', times: 100 });
    const r = await runLiveVerification(o);
    expect(r.status).toBe('FAIL');
    expect(r.pageOwner).toBe(true);
  });
});

describe('verified-region report', () => {
  const region = (kind: 'live' | 'fixture', verified: boolean) => ({
    providerRegionId: 'me-central-1',
    countryCode: 'SA',
    verifiedAt: verified ? '2026-11-18T00:00:00Z' : null,
    evidence: [{ kind, capturedAt: '2026-11-18T00:00:00Z', summary: 'listed' }],
  });
  it('without HG evidence the report is NOT VERIFIED and lists no verified region', () => {
    const r = buildRegionReport({
      provider: 'alibaba',
      adapterId: 'alibaba-ecs',
      accountLabel: 'none',
      date: '2026-11-18',
      gate: 'HG-05-01',
      regions: [],
    });
    expect(r.status).toBe('NOT VERIFIED');
    expect(r.json.saudiArabia).toBe('NOT VERIFIED');
  });
  it('fixture evidence never verifies Saudi even with a gate id', () => {
    const r = buildRegionReport({
      provider: 'alibaba',
      adapterId: 'alibaba-ecs',
      accountLabel: 'x',
      date: '2026-11-18',
      gate: 'HG-05-01',
      hgEvidence: 'HG-05-01:E1',
      regions: [region('fixture', true)],
    });
    expect(r.status).toBe('NOT VERIFIED');
    expect(r.json.verifiedRegions).toEqual([]);
  });
  it('live evidence plus a gate id verifies (logic test only; no live evidence exists)', () => {
    const r = buildRegionReport({
      provider: 'alibaba',
      adapterId: 'alibaba-ecs',
      accountLabel: 'x',
      date: '2026-11-18',
      gate: 'HG-05-01',
      hgEvidence: 'HG-05-01:E1',
      regions: [region('live', true)],
    });
    expect(r.status).toBe('LIVE-VERIFIED');
    expect(r.json.saudiArabia).toBe('verified');
  });
});
