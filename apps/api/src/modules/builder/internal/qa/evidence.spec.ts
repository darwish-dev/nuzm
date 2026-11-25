import { describe, expect, it } from 'vitest';
import { buildWebsiteEvidence, validateWebsiteEvidence, type EvidenceInput } from './evidence';
import type { QaReport } from './types';

const gate = (
  g: string,
  over: Partial<QaReport['gates'][number]> = {},
): QaReport['gates'][number] => ({
  gate: g as never,
  status: 'pass',
  findings: [],
  metrics: {},
  durationMs: 1,
  ...over,
});
const report = (over: Partial<QaReport> = {}): QaReport => ({
  schema: 'nuzm.website-qa/1',
  rootHash: 'a'.repeat(64),
  fileCount: 21,
  totalBytes: 100,
  locales: ['ar', 'en'],
  pages: 10,
  gates: [
    gate('links'),
    gate('csp'),
    gate('size'),
    gate('completeness', { metrics: { pagesPerLocale: 'ar=5,en=5' } }),
    gate('a11y-axe'),
  ],
  counts: { errors: 0, warnings: 0 },
  passed: true,
  qualified: true,
  ...over,
});
const input = (over: Partial<EvidenceInput> = {}): EvidenceInput => ({
  id: 'ev-1',
  createdAt: '2026-11-24T00:00:00Z',
  brief: { id: 'brief-ar-1', locale: 'ar', text: 'مخبز في الرياض' },
  model: { id: 'mock-model', provider: 'mock', simulated: true },
  run: {
    id: 'run-1',
    state: 'succeeded',
    tokensIn: 100,
    tokensOut: 200,
    costMinor: 12,
    currency: 'SAR',
    durationMs: 5,
  },
  qa: report(),
  ...over,
});

describe('website evidence: a mock result is never promoted to a real one', () => {
  it('a simulated model stays SIMULATED even when the caller claims LIVE-VERIFIED', () => {
    const e = buildWebsiteEvidence(input({ claim: 'LIVE-VERIFIED', approvalRef: 'D-AG-LIVE-1' }));
    expect(e.label).toBe('SIMULATED');
    expect(e.notes.join(' ')).toContain('simulated model');
    expect(validateWebsiteEvidence(e)).toEqual([]);
  });
  it('a real model without a recorded approval is NOT VERIFIED, not LIVE-VERIFIED', () => {
    const e = buildWebsiteEvidence(
      input({ claim: 'LIVE-VERIFIED', model: { id: 'm', provider: 'p', simulated: false } }),
    );
    expect(e.label).toBe('NOT VERIFIED');
  });
  it('a real, approved run whose gates are not all green is NOT VERIFIED (axe skipped, a violation, four pages)', () => {
    const real = { id: 'm', provider: 'p', simulated: false };
    const claim = { claim: 'LIVE-VERIFIED' as const, approvalRef: 'AP-1', model: real };
    expect(
      buildWebsiteEvidence(
        input({
          ...claim,
          qa: report({ qualified: false, gates: [gate('a11y-axe', { status: 'skipped' })] }),
        }),
      ).label,
    ).toBe('NOT VERIFIED');
    const viol = report({
      gates: [
        gate('links'),
        gate('csp'),
        gate('size'),
        gate('completeness', { metrics: { pagesPerLocale: 'ar=5,en=5' } }),
        gate('a11y-axe', {
          status: 'fail',
          findings: [
            { gate: 'a11y-axe', code: 'x', severity: 'error', file: 'ar/index.html', message: 'm' },
          ],
        }),
      ],
      passed: false,
      qualified: false,
    });
    const ev = buildWebsiteEvidence(input({ ...claim, qa: viol }));
    expect(ev.label).toBe('NOT VERIFIED');
    expect(ev.acceptance.axeViolations).toEqual({ ar: 1, en: 0 });
    expect(
      buildWebsiteEvidence(
        input({
          ...claim,
          qa: report({
            gates: [
              gate('completeness', { metrics: { pagesPerLocale: 'ar=5,en=4' } }),
              gate('a11y-axe'),
            ],
          }),
        }),
      ).label,
    ).toBe('NOT VERIFIED');
  });
  it('a real, approved, fully green run is LIVE-VERIFIED and consistent', () => {
    const e = buildWebsiteEvidence(
      input({
        claim: 'LIVE-VERIFIED',
        approvalRef: 'AP-1',
        model: { id: 'm', provider: 'p', simulated: false },
      }),
    );
    expect(e.label).toBe('LIVE-VERIFIED');
    expect(e.acceptance).toMatchObject({
      minFivePagesPerLocale: true,
      axeRan: true,
      brokenLinks: 0,
      cspStrict: true,
      sizeWithinBudget: true,
      qualified: true,
    });
    expect(validateWebsiteEvidence(e)).toEqual([]);
  });
  it('the validator refuses hand-edited records: wrong label, unbound QA, float money, a secret', () => {
    const real = { id: 'm', provider: 'p', simulated: false };
    const ok = buildWebsiteEvidence(
      input({ claim: 'LIVE-VERIFIED', approvalRef: 'AP-1', model: real }),
    );
    expect(validateWebsiteEvidence({ ...ok, approvalRef: null })).toContain(
      'LIVE-VERIFIED without an owner approval reference',
    );
    expect(validateWebsiteEvidence({ ...ok, model: { ...real, simulated: true } })).toContain(
      'LIVE-VERIFIED with a simulated model',
    );
    expect(
      validateWebsiteEvidence({ ...ok, qa: { ...ok.qa, rootHash: 'b'.repeat(64) } }),
    ).toContain('the QA report is not bound to the artifact hash');
    expect(validateWebsiteEvidence({ ...ok, run: { ...ok.run, costMinor: 1.5 } }).join()).toContain(
      'integer',
    );
    expect(validateWebsiteEvidence({ ...ok, notes: ['key sk-abcdefghijklmnop'] }).join()).toContain(
      'secret',
    );
    const sim = buildWebsiteEvidence(input());
    expect(validateWebsiteEvidence({ ...sim, label: 'NOT VERIFIED' }).join()).toContain(
      "simulated model's record",
    );
  });
  it('records only the hash of the brief, and marks it synthetic', () => {
    const e = buildWebsiteEvidence(input());
    expect(JSON.stringify(e)).not.toContain('مخبز');
    expect(e.brief).toMatchObject({
      synthetic: true,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});
