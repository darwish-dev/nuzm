import { describe, expect, it } from 'vitest';
import {
  budgetBody,
  budgetForm,
  budgetsIfMatch,
  byCreditsDesc,
  groupDigits,
  modelRows,
  parseCap,
  parseThresholds,
  parseTopUpCredits,
  projectRows,
  projectsWithoutCap,
} from './ai';

describe('credit display', () => {
  it('groups digits without floats, including values beyond 2^53', () => {
    expect(groupDigits('0')).toBe('0');
    expect(groupDigits('999')).toBe('999');
    expect(groupDigits('1000')).toBe('1,000');
    expect(groupDigits('9007199254740993')).toBe('9,007,199,254,740,993');
    expect(groupDigits('-1234')).toBe('-1,234');
  });
  it('reads loosely typed usage rows defensively', () => {
    expect(
      modelRows([
        { modelRef: 'mock-chat/m1', calls: 3, tokensIn: '10', tokensOut: '20', credits: '5' },
        { calls: 'x', credits: 12 },
        'nope',
        null,
      ]),
    ).toEqual([
      { modelRef: 'mock-chat/m1', calls: 3, tokensIn: '10', tokensOut: '20', credits: '5' },
      { modelRef: '—', calls: 0, tokensIn: '0', tokensOut: '0', credits: '0' },
    ]);
    expect(projectRows([{ projectId: null, calls: 1, credits: '7' }, { projectId: 'p1' }])).toEqual(
      [
        { projectId: null, calls: 1, credits: '7' },
        { projectId: 'p1', calls: 0, credits: '0' },
      ],
    );
  });
  it('sorts by credits with exact integer comparison', () => {
    const rows = [
      { credits: '9' },
      { credits: '9007199254740993' },
      { credits: '9007199254740992' },
    ];
    expect(byCreditsDesc(rows).map((r) => r.credits)).toEqual([
      '9007199254740993',
      '9007199254740992',
      '9',
    ]);
  });
});

describe('top-up quote input', () => {
  it('accepts positive integers only', () => {
    expect(parseTopUpCredits(' 1000 ')).toBe('1000');
    for (const bad of ['', '0', '01', '1.5', '1e3', '-5', '１٢', '1'.repeat(16)])
      expect(parseTopUpCredits(bad)).toBeNull();
  });
});

describe('caps and thresholds', () => {
  it('a cap is empty (no cap), or a non-negative integer within the limit', () => {
    expect(parseCap('')).toBeNull();
    expect(parseCap(' 0 ')).toBe(0);
    expect(parseCap('250000')).toBe(250000);
    expect(parseCap('1000000000000')).toBe(1e12);
    expect(parseCap('1000000000001')).toBeUndefined();
    expect(parseCap('-1')).toBeUndefined();
    expect(parseCap('1.5')).toBeUndefined();
    expect(parseCap('abc')).toBeUndefined();
    expect(parseCap('366', 365)).toBeUndefined();
  });
  it('thresholds are 1..6 distinct integers between 1 and 100, sorted', () => {
    expect(parseThresholds('80, 50,100')).toEqual([50, 80, 100]);
    expect(parseThresholds('')).toBeNull();
    expect(parseThresholds('0, 50')).toBeNull();
    expect(parseThresholds('101')).toBeNull();
    expect(parseThresholds('50, 50')).toBeNull();
    expect(parseThresholds('1,2,3,4,5,6,7')).toBeNull();
    expect(parseThresholds('5.5')).toBeNull();
  });
});

describe('budgets form', () => {
  const doc = {
    dailyCredits: 100,
    runMaxCredits: null,
    runMaxTokens: 5000,
    totalCredits: null,
    totalTokens: null,
    alertThresholds: [60, 90],
    logBodies: false,
    bodyRetentionDays: null,
    autoApplyLowRisk: false,
  };
  it('loads the API document into form text and back into the same body', () => {
    const f = budgetForm(doc, [{ projectId: 'p1', totalCredits: 40, totalTokens: null }]);
    expect(f.caps.dailyCredits).toBe('100');
    expect(f.caps.runMaxCredits).toBe('');
    expect(f.thresholds).toBe('60, 90');
    expect(budgetBody(f).body).toEqual({
      org: { ...doc },
      projects: [{ projectId: 'p1', totalCredits: 40, totalTokens: null }],
    });
  });
  it('a never-set budget shows the default thresholds and no caps', () => {
    const f = budgetForm({}, []);
    expect(f.thresholds).toBe('50, 80, 100');
    expect(budgetBody(f).body?.org.dailyCredits).toBeNull();
  });
  it('prompt-body logging needs a retention period of at least one day; it is dropped when logging is off', () => {
    const f = budgetForm(doc, []);
    expect(budgetBody({ ...f, logBodies: true }).error).toBe('retention');
    expect(budgetBody({ ...f, logBodies: true, retentionDays: '0' }).error).toBe('retention');
    expect(budgetBody({ ...f, logBodies: true, retentionDays: '400' }).error).toBe('retention');
    expect(budgetBody({ ...f, logBodies: true, retentionDays: '30' }).body?.org).toMatchObject({
      logBodies: true,
      bodyRetentionDays: 30,
    });
    expect(budgetBody({ ...f, logBodies: false, retentionDays: '30' }).body?.org).toMatchObject({
      logBodies: false,
      bodyRetentionDays: null,
    });
  });
  it('reports the first invalid field', () => {
    const f = budgetForm(doc, [{ projectId: 'p1' }]);
    expect(budgetBody({ ...f, caps: { ...f.caps, totalCredits: '-3' } }).error).toBe('cap');
    expect(budgetBody({ ...f, thresholds: 'x' }).error).toBe('thresholds');
    expect(
      budgetBody({ ...f, projects: [{ projectId: 'p1', totalCredits: '1.5', totalTokens: '' }] })
        .error,
    ).toBe('projectCap');
  });
  it('auto-apply is carried as asked', () => {
    expect(budgetBody({ ...budgetForm(doc, []), autoApply: true }).body?.org.autoApplyLowRisk).toBe(
      true,
    );
  });
  it('sends the budget version as a quoted ETag; "0" means never set', () => {
    expect(budgetsIfMatch(0)).toBe('"0"');
    expect(budgetsIfMatch(7)).toBe('"7"');
  });
  it('offers only projects without a cap row', () => {
    const rows = [{ projectId: 'a', totalCredits: '', totalTokens: '' }];
    expect(
      projectsWithoutCap(
        [
          { id: 'a', name: 'A' },
          { id: 'b', name: 'B' },
        ],
        rows,
      ),
    ).toEqual([{ id: 'b', name: 'B' }]);
  });
});
