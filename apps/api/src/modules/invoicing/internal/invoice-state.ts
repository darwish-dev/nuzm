/** Legal state machines (docs/11 §2). The database trigger enforces the same table; this is the single readable definition. */
export type InvoiceStatus = 'draft' | 'open' | 'partially_paid' | 'paid' | 'void' | 'uncollectible';
export type CreditNoteStatus = 'draft' | 'issued' | 'applied' | 'refunded';

export const INVOICE_TRANSITIONS: Readonly<Record<InvoiceStatus, readonly InvoiceStatus[]>> = {
  draft: ['open'],
  open: ['partially_paid', 'paid', 'void', 'uncollectible'],
  partially_paid: ['paid', 'uncollectible'],
  paid: [],
  void: [],
  uncollectible: [],
};
export const CREDIT_NOTE_TRANSITIONS: Readonly<
  Record<CreditNoteStatus, readonly CreditNoteStatus[]>
> = {
  draft: ['issued'],
  issued: ['applied', 'refunded'],
  applied: [],
  refunded: [],
};
export const canInvoiceTransition = (from: InvoiceStatus, to: InvoiceStatus) =>
  INVOICE_TRANSITIONS[from].includes(to);
export const canCreditNoteTransition = (from: CreditNoteStatus, to: CreditNoteStatus) =>
  CREDIT_NOTE_TRANSITIONS[from].includes(to);
/** A status in which the document is a live receivable: credit notes may still reference it. */
export const creditable = (s: InvoiceStatus) =>
  s === 'open' || s === 'partially_paid' || s === 'paid';
