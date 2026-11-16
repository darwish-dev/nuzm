import { describe, expect, it } from 'vitest';
import {
  CREDIT_NOTE_TRANSITIONS,
  INVOICE_TRANSITIONS,
  canCreditNoteTransition,
  canInvoiceTransition,
  creditable,
  type CreditNoteStatus,
  type InvoiceStatus,
} from './internal/invoice-state';

const INVOICE: InvoiceStatus[] = [
  'draft',
  'open',
  'partially_paid',
  'paid',
  'void',
  'uncollectible',
];
const NOTE: CreditNoteStatus[] = ['draft', 'issued', 'applied', 'refunded'];

describe('invoice state machine (docs/11 §2)', () => {
  const allowed = new Set([
    'draft>open',
    'open>partially_paid',
    'open>paid',
    'open>void',
    'open>uncollectible',
    'partially_paid>paid',
    'partially_paid>uncollectible',
  ]);
  it.each(INVOICE.flatMap((a) => INVOICE.map((b) => [a, b] as const)))('%s → %s', (a, b) =>
    expect(canInvoiceTransition(a, b)).toBe(allowed.has(`${a}>${b}`)),
  );
  it('paid, void and uncollectible are terminal; nothing returns to draft', () => {
    for (const s of ['paid', 'void', 'uncollectible'] as const)
      expect(INVOICE_TRANSITIONS[s]).toEqual([]);
    for (const s of INVOICE) expect(canInvoiceTransition(s, 'draft')).toBe(false);
  });
  it('only live receivables can be credited', () => {
    expect(INVOICE.filter(creditable)).toEqual(['open', 'partially_paid', 'paid']);
  });
});

describe('credit note state machine', () => {
  const allowed = new Set(['draft>issued', 'issued>applied', 'issued>refunded']);
  it.each(NOTE.flatMap((a) => NOTE.map((b) => [a, b] as const)))('%s → %s', (a, b) =>
    expect(canCreditNoteTransition(a, b)).toBe(allowed.has(`${a}>${b}`)),
  );
  it('applied and refunded are terminal', () => {
    expect(CREDIT_NOTE_TRANSITIONS.applied).toEqual([]);
    expect(CREDIT_NOTE_TRANSITIONS.refunded).toEqual([]);
  });
});
