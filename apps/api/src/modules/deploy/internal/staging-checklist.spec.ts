import { describe, expect, it } from 'vitest';
import {
  CHECKLIST_ROWS,
  SimulatedNodePort,
  checklistLiveEligible,
  runStagingChecklist,
} from './staging-checklist';
import { InMemoryArtifactTransport, UnavailableArtifactTransport } from './hosting-target';
import type { StagingTarget } from './targets';

const TARGET: StagingTarget = {
  id: 'hosting:staging-1',
  kind: 'static_hosting',
  provider: 'hosting_panel',
  verification: 'NOT VERIFIED',
  region: 'eu',
  previewDomain: 'previews.pv-sim.test',
  approvalRef: null,
  evidenceRef: null,
} as StagingTarget;
const REFS = { hg05Ref: 'HG-05:node-2026-12', hg06Ref: 'HG-06:panel-2026-12' };
const noSleep = async () => undefined;
const row = (r: Awaited<ReturnType<typeof runStagingChecklist>>, n: number) =>
  r.rows.find((x) => x.n === n)!;

describe('staging checklist, SIMULATED run', () => {
  it('has exactly the twelve rows of plan section 11, in order', () => {
    expect(CHECKLIST_ROWS.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
  it('rows 1 to 11 pass over stand-ins, row 12 stays NOT VERIFIED without a human attestation, everything is labelled SIMULATED', async () => {
    const r = await runStagingChecklist({ sleep: noSleep });
    expect(r.rows.map((x) => x.status)).toEqual([
      'PASS',
      'PASS',
      'PASS',
      'PASS',
      'PASS',
      'PASS',
      'PASS',
      'PASS',
      'PASS',
      'PASS',
      'PASS',
      'NOT VERIFIED',
    ]);
    expect(r.rows.every((x) => x.label === 'SIMULATED')).toBe(true);
    expect(r.status).toBe('NOT VERIFIED');
    expect(r.conclusion).toContain('Nothing here is LIVE-VERIFIED');
    expect(checklistLiveEligible(r)).toMatchObject({ eligible: false });
  });
  it('an attestation completes row 12; a negative one fails it', async () => {
    const att = { attestedBy: 'owner', nodeDeletedAtProvider: true, billWithinCap: true };
    expect(row(await runStagingChecklist({ sleep: noSleep, attestations: att }), 12).status).toBe(
      'PASS',
    );
    expect(
      row(
        await runStagingChecklist({
          sleep: noSleep,
          attestations: { ...att, billWithinCap: false },
        }),
        12,
      ).status,
    ).toBe('FAIL');
  });
  it('the rows CAN fail: a node that forgets the docroot on rebuild, leaky isolation, a wipe with leftovers', async () => {
    const forget = new SimulatedNodePort();
    forget.forgetDocrootOnRebuild = true;
    expect(row(await runStagingChecklist({ sleep: noSleep, node: forget }), 6).status).toBe('FAIL');
    const leaky = new SimulatedNodePort();
    leaky.leakyIsolation = true;
    expect(row(await runStagingChecklist({ sleep: noSleep, node: leaky }), 11).status).toBe('FAIL');
    const left = new SimulatedNodePort();
    left.leftoverFiles = 3;
    expect(row(await runStagingChecklist({ sleep: noSleep, node: left }), 12).detail).toContain(
      '3 item',
    );
  });
  it('a corrupting transport fails rows 3 and 10 loudly, not silently', async () => {
    const t = new InMemoryArtifactTransport();
    t.corruptNextPut = true;
    const r = await runStagingChecklist({ sleep: noSleep, transport: t });
    expect(row(r, 3).status).toBe('FAIL');
  });
  it('only= runs just those rows (and any site they need)', async () => {
    const r = await runStagingChecklist({ sleep: noSleep, only: [3, 4] });
    expect(r.rows.map((x) => x.n)).toEqual([3, 4]);
    expect(r.rows.every((x) => x.status === 'PASS')).toBe(true);
  });
});

describe('staging checklist, real mode REFUSES (nothing is created)', () => {
  const assertNothing = (r: Awaited<ReturnType<typeof runStagingChecklist>>) => {
    expect(r.status).toBe('BLOCKED');
    expect(r.rows).toHaveLength(12);
    expect(r.rows.every((x) => x.status === 'BLOCKED' && x.label === 'NOT VERIFIED')).toBe(true);
    expect(r.conclusion).toContain('Nothing was created');
  };
  it('without HG-05 / HG-06', async () => {
    assertNothing(await runStagingChecklist({ mode: 'real', target: TARGET }));
    const a = await runStagingChecklist({ mode: 'real', target: TARGET, hg05Ref: REFS.hg05Ref });
    assertNothing(a);
    expect(row(a, 1).detail).toContain('HG-06');
    const bad = await runStagingChecklist({
      mode: 'real',
      target: TARGET,
      hg05Ref: 'HG-05:x',
      hg06Ref: REFS.hg06Ref,
    });
    assertNothing(bad);
  });
  it('with both references but no node port', async () => {
    const r = await runStagingChecklist({
      mode: 'real',
      target: TARGET,
      ...REFS,
      protectedDomains: ['console.nuzm-sim.test'],
    });
    assertNothing(r);
    expect(row(r, 1).detail).toContain('no real node port');
  });
  it('with a node port but no real transport (unavailable or simulated): HOST-TRANSPORT blocker named', async () => {
    const node = new SimulatedNodePort();
    for (const transport of [
      undefined,
      new UnavailableArtifactTransport(),
      new InMemoryArtifactTransport(),
    ]) {
      const r = await runStagingChecklist({
        mode: 'real',
        target: TARGET,
        ...REFS,
        node,
        ...(transport ? { transport } : {}),
        protectedDomains: ['console.nuzm-sim.test'],
      });
      assertNothing(r);
      expect(row(r, 3).detail).toContain('HOST-TRANSPORT');
    }
  });
  it('a target without a preview domain stays blocked even with both references', async () => {
    assertNothing(
      await runStagingChecklist({
        mode: 'real',
        target: { ...TARGET, previewDomain: null } as StagingTarget,
        ...REFS,
      }),
    );
  });
});

describe('live eligibility', () => {
  it('a simulated record is never eligible; a forged "real" record with simulated labels is not either', async () => {
    const r = await runStagingChecklist({
      sleep: noSleep,
      attestations: { attestedBy: 'x', nodeDeletedAtProvider: true, billWithinCap: true },
    });
    expect(checklistLiveEligible(r).eligible).toBe(false);
    const forged = {
      ...r,
      mode: 'real' as const,
      target: { ...r.target, ...{ hg05Ref: REFS.hg05Ref, hg06Ref: REFS.hg06Ref } },
    };
    const v = checklistLiveEligible(forged);
    expect(v.eligible).toBe(false);
    expect(v.problems.some((p) => p.includes('labelled SIMULATED'))).toBe(true);
  });
  it('only a complete real record with every row LIVE-VERIFIED qualifies', async () => {
    const r = await runStagingChecklist({
      sleep: noSleep,
      attestations: { attestedBy: 'x', nodeDeletedAtProvider: true, billWithinCap: true },
    });
    const real = {
      ...r,
      mode: 'real' as const,
      target: { ...r.target, hg05Ref: REFS.hg05Ref, hg06Ref: REFS.hg06Ref },
      rows: r.rows.map((x) => ({ ...x, label: 'LIVE-VERIFIED' as const })),
    };
    expect(checklistLiveEligible(real)).toEqual({ eligible: true, problems: [] });
    expect(checklistLiveEligible({ ...real, rows: real.rows.slice(0, 11) }).eligible).toBe(false);
    expect(
      checklistLiveEligible({ ...real, target: { ...real.target, hg06Ref: null } }).eligible,
    ).toBe(false);
  });
});
