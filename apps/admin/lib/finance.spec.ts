import { describe, expect, it } from 'vitest';
import {
  barRows,
  bpsToPercent,
  humanize,
  isDateOnly,
  itemTone,
  nextZatcaStep,
  reportCell,
  runTone,
  splitRemaining,
  submissionTone,
  toMinor,
  validRange,
  windowSummary,
} from './finance';

describe('toMinor: integer minor units by string arithmetic', () => {
  it.each([
    ['115', '11500'],
    ['1.5', '150'],
    ['0.01', '1'],
    ['  20.00 ', '2000'],
  ])('%s → %s', (i, o) => expect(toMinor(i)).toBe(o));
  it.each(['0', '0.00', '-1', '1.234', 'abc', '', '1e3', '1,5'])('%s is refused', (i) =>
    expect(toMinor(i)).toBeNull(),
  );
});

describe('dates and ranges', () => {
  it('rejects impossible dates', () => {
    expect(isDateOnly('2026-02-30')).toBe(false);
    expect(isDateOnly('2026-11-17')).toBe(true);
  });
  it('limits a range to 400 days and requires from <= to', () => {
    expect(validRange('2026-01-01', '2026-02-01')).toBe(true);
    expect(validRange('2026-02-01', '2026-01-01')).toBe(false);
    expect(validRange('2025-01-01', '2026-02-05')).toBe(true); // exactly 400 days
    expect(validRange('2025-01-01', '2026-02-06')).toBe(false); // 401
    expect(validRange('2025-01-01', '2026-02-05x')).toBe(false);
  });
});

describe('e-invoicing onboarding', () => {
  it('offers the step after the last completed one, in order', () => {
    expect(nextZatcaStep('not_started')).toBe('csr');
    expect(nextZatcaStep('csr')).toBe('compliance_csid');
    expect(nextZatcaStep('compliance_csid')).toBe('compliance_checks');
    expect(nextZatcaStep('compliance_checks')).toBe('production_csid');
    expect(nextZatcaStep('production_csid')).toBeNull();
    expect(nextZatcaStep('something-else')).toBeNull();
  });
});

describe('tones', () => {
  it('marks failures, dead letters and SLA breaches as danger', () => {
    expect(submissionTone('error', true)).toBe('danger');
    expect(submissionTone('rejected', false)).toBe('danger');
    expect(submissionTone('cleared', false)).toBe('success');
    expect(submissionTone('queued', false)).toBe('warn');
    expect(runTone('failed')).toBe('danger');
    expect(runTone('completed')).toBe('success');
    expect(itemTone('open', true)).toBe('danger');
    expect(itemTone('resolved', true)).toBe('success');
  });
});

describe('reporting-window gauge', () => {
  it('counts only rows with a clock and splits ok / alert / breached', () => {
    const s = windowSummary([
      { windowRemainingSeconds: null, windowAlert: false, windowBreached: false },
      { windowRemainingSeconds: 80_000, windowAlert: false, windowBreached: false },
      { windowRemainingSeconds: 30_000, windowAlert: true, windowBreached: false },
      { windowRemainingSeconds: 0, windowAlert: true, windowBreached: true },
      { windowRemainingSeconds: 70_000, windowAlert: false, windowBreached: false },
    ]);
    expect(s).toMatchObject({ total: 4, ok: 2, alert: 1, breached: 1 });
    expect(s.percentOk).toBe(50);
  });
  it('is full when nothing has a clock', () => {
    expect(windowSummary([]).percentOk).toBe(100);
  });
  it('splits remaining seconds', () => {
    expect(splitRemaining(3_725)).toEqual({ hours: 1, minutes: 2 });
    expect(splitRemaining(-5)).toEqual({ hours: 0, minutes: 0 });
  });
});

describe('report values', () => {
  it('shows *Minor values and money columns as money, Bps as a percentage, booleans as booleans', () => {
    expect(reportCell('revenueMinor', undefined, '1250')).toEqual({ kind: 'money', minor: '1250' });
    expect(reportCell('x', 'money', '-300')).toEqual({ kind: 'money', minor: '-300' });
    expect(reportCell('marginBps', 'int', '1250')).toEqual({ kind: 'bps', value: '1250' });
    expect(reportCell('matchesLedger', undefined, true)).toEqual({ kind: 'bool', value: true });
    expect(reportCell('planKey', 'text', null)).toEqual({ kind: 'text', value: '—' });
    expect(reportCell('invoiceNumber', 'text', '2026')).toEqual({ kind: 'text', value: '2026' });
  });
  it('converts basis points without floating point', () => {
    expect(bpsToPercent('1250')).toBe('12.5');
    expect(bpsToPercent('5')).toBe('0.05');
    expect(bpsToPercent('10000')).toBe('100');
    expect(bpsToPercent('-250')).toBe('-2.5');
  });
  it('draws bars for the first money column, scaled by BigInt, never above 1', () => {
    const rows = [
      { product: 'a', revenueMinor: '1000' },
      { product: 'b', revenueMinor: '250' },
      { product: 'c', revenueMinor: '-500' },
      { product: 'd', revenueMinor: 'n/a' },
    ];
    const bars = barRows(
      [
        { key: 'product', kind: 'text' },
        { key: 'revenueMinor', kind: 'money' },
      ],
      rows,
    );
    expect(bars.map((b) => [b.labelKey, b.ratio])).toEqual([
      ['a', 1],
      ['b', 0.25],
      ['c', 0.5],
    ]);
    expect(barRows([{ key: 'x', kind: 'text' }], rows)).toEqual([]);
  });
  it('handles amounts beyond 2^53 exactly', () => {
    const [b] = barRows(
      [{ key: 'm', kind: 'money' }],
      [{ m: '90071992547409930' }, { m: '45035996273704965' }],
    );
    expect(b?.ratio).toBe(1);
  });
  it('humanizes a key with no translation', () => {
    expect(humanize('days1to30Minor')).toBe('Days1to30 Minor');
    expect(humanize('openAtRiskMinor')).toBe('Open At Risk Minor');
  });
});
