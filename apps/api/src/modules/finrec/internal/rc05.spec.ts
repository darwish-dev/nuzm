import { describe, expect, it } from 'vitest';
import { rc05, type Ctx } from './reconcilers';

/**
 * M12 AC-M12-12 (RC-05 injected discrepancies). A scripted database client stands in for the e-invoicing tables: this is a FIXTURE test (NOT VERIFIED
 * against a ZATCA environment; HG-03-03). It proves the reconciler classifies each injected case and stays silent on clean data.
 */
const old = new Date(Date.now() - 100 * 3_600_000);
const row = (id: string, state: string | null, over: Record<string, unknown> = {}) => ({
  source_type: 'invoice',
  id,
  org_id: 'org-1',
  number_text: `INV-${id}`,
  issued_at: old,
  doc_id: state === null && over.doc_id === undefined ? null : `doc-${id}`,
  stamped_at: old,
  state,
  dead: false,
  ...over,
});
const ctx = (
  rows: unknown[],
  mode: 'off' | 'sandbox' | 'simulation' = 'sandbox',
  generateFrom: Date | null = new Date('2026-01-01'),
): Ctx =>
  ({
    c: { query: async (sql: string) => (sql.includes('FROM (SELECT') ? { rows } : { rows: [] }) },
    from: '2026-11-01',
    to: '2026-11-30',
    toExclusive: '2026-12-01',
    tolerance: { rc03Bps: 0, rc04Bps: 0 },
    sources: { settlements: async () => null, bills: async () => null },
    zatca: { mode, generateFrom, profile: { reportingWindowHours: 24, synthetic: true } as never },
  }) as unknown as Ctx;

describe('RC-05 e-invoices vs issued documents (fixtures)', () => {
  it('detects every injected discrepancy: unsubmitted, rejected, dead-lettered, not cleared in the window', async () => {
    const r = await rc05(
      ctx([
        row('a', null),
        row('b', 'rejected'),
        row('c', 'error', { dead: true }),
        row('d', 'pending'),
        row('e', 'cleared'),
        row('f', 'reported'),
      ]),
    );
    expect(r.breaks.map((b) => `${b.key.split(':')[1]}:${b.kind}`).sort()).toEqual([
      'a:no_einvoice',
      'b:rejected',
      'c:dead_letter',
      'd:not_cleared_in_window',
    ]);
    expect(r.checked).toBe(6);
  });
  it('clean data produces no breaks; a recent pending document is inside the window', async () => {
    const recent = new Date(Date.now() - 2 * 3_600_000);
    const r = await rc05(
      ctx([row('e', 'cleared'), row('g', 'pending', { stamped_at: recent, issued_at: recent })]),
    );
    expect(r.breaks).toEqual([]);
  });
  it('is explicit about what it did not compare: e-invoicing off, or no cutover date', async () => {
    expect((await rc05(ctx([row('a', null)], 'off'))).summary).toMatchObject({ skipped: true });
    expect((await rc05(ctx([row('a', null)], 'sandbox', null))).summary).toMatchObject({
      skipped: true,
    });
  });
});
