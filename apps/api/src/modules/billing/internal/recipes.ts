import { ProblemException } from '../../../common/errors';

/**
 * Typed posting recipes (docs/11 §3.1). A recipe is a PURE function from business parameters to one balanced
 * ledger transaction; it never touches the database. Only LedgerPostingService (through billing.post) writes
 * postings. Amounts are integer minor units carried as strings (JSON-safe, no floats anywhere).
 */
export interface AccountRef {
  code: string;
  /** true = per-organization sub-account of the transaction's org; false = platform account. */
  org: boolean;
  /** provider_account / psp_account / publisher id for sub-ledgered platform accounts (1100, 1300, 2400, 2600, 5100). */
  subledger?: string;
}
export interface PostingLine {
  account: AccountRef;
  direction: 'debit' | 'credit';
  amountMinor: string;
  currency: string;
  dimensions?: Record<string, unknown>;
  /** The account balance (on its normal side) may not go negative after this transaction. */
  nonNegative?: boolean;
}
export interface Built {
  kind: string;
  /** null = platform-level transaction (no organization). */
  orgId: string | null;
  description: string;
  sourceEventId?: string;
  postings: PostingLine[];
  /** True when the transaction touches the org's wallet (2100): triggers the projection refresh. */
  affectsWallet: boolean;
  reversesId?: string;
}

const MAX_MINOR = 4_611_686_018_427_387_904n; // 2^62: far below bigint overflow even when summed
export type Minor = bigint | number | string;

/** Strictly positive integer minor units, as a decimal string. */
export function parseMinor(v: Minor, what = 'amount'): string {
  let n: bigint;
  try {
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) throw new Error('not a safe integer');
      n = BigInt(v);
    } else if (typeof v === 'string') {
      if (!/^\d{1,19}$/.test(v)) throw new Error('not an integer string');
      n = BigInt(v);
    } else n = v;
  } catch {
    throw new ProblemException(
      'validation_failed',
      `${what} must be an integer number of minor units`,
    );
  }
  if (n <= 0n || n > MAX_MINOR)
    throw new ProblemException(
      'validation_failed',
      `${what} must be a positive integer within range`,
    );
  return n.toString();
}
const nonNegativeMinor = (v: Minor, what: string) =>
  v === 0 || v === 0n || v === '0' ? '0' : parseMinor(v, what);

export function parseCurrency(c: string): string {
  if (!/^[A-Z]{3}$/.test(c))
    throw new ProblemException('validation_failed', 'currency must be an ISO 4217 code');
  return c;
}
const text = (s: string, what: string, max = 500) => {
  const t = typeof s === 'string' ? s.trim() : '';
  if (t.length < 1 || t.length > max)
    throw new ProblemException('validation_failed', `${what} must be 1..${max} characters`);
  return t;
};

/** Σdebits = Σcredits per currency (the database re-checks this at COMMIT). Throws validation_failed otherwise. */
export function assertBalanced(postings: PostingLine[]): void {
  const sums = new Map<string, bigint>();
  for (const p of postings) {
    const d =
      (sums.get(p.currency) ?? 0n) +
      (p.direction === 'debit' ? BigInt(p.amountMinor) : -BigInt(p.amountMinor));
    sums.set(p.currency, d);
  }
  for (const [cur, d] of sums)
    if (d !== 0n)
      throw new ProblemException('validation_failed', `postings do not balance in ${cur}`);
  if (postings.length < 2)
    throw new ProblemException('validation_failed', 'a transaction needs at least two postings');
}

/** Promotional / admin credit grant: Dr 4900 discounts → Cr 2100 customer wallet. (D-25: expiry is optional metadata.) */
export function creditGrant(p: {
  orgId: string;
  amountMinor: Minor;
  currency: string;
  reason: string;
  grantId?: string;
  expiresAt?: string | null;
}): Built {
  const amount = parseMinor(p.amountMinor);
  const currency = parseCurrency(p.currency);
  const dimensions = {
    ...(p.grantId ? { grant_id: p.grantId } : {}),
    ...(p.expiresAt ? { expires_at: p.expiresAt } : {}),
  };
  return {
    kind: 'credit_grant',
    orgId: p.orgId,
    description: text(p.reason, 'reason'),
    sourceEventId: p.grantId,
    affectsWallet: true,
    postings: [
      {
        account: { code: '4900', org: false },
        direction: 'debit',
        amountMinor: amount,
        currency,
        dimensions,
      },
      {
        account: { code: '2100', org: true },
        direction: 'credit',
        amountMinor: amount,
        currency,
        dimensions,
      },
    ],
  };
}

function consume(
  kind: string,
  p: {
    orgId: string;
    netMinor: Minor;
    vatMinor?: Minor;
    currency: string;
    meterId?: string;
    resourceId?: string;
    projectId?: string;
    description?: string;
    sourceEventId?: string;
  },
): Built {
  const net = parseMinor(p.netMinor, 'net amount');
  const vat = p.vatMinor === undefined ? '0' : nonNegativeMinor(p.vatMinor, 'vat amount');
  const currency = parseCurrency(p.currency);
  const gross = (BigInt(net) + BigInt(vat)).toString();
  const dimensions = {
    ...(p.meterId ? { meter_id: p.meterId } : {}),
    ...(p.resourceId ? { resource_id: p.resourceId } : {}),
    ...(p.projectId ? { project_id: p.projectId } : {}),
  };
  const postings: PostingLine[] = [
    {
      account: { code: '2100', org: true },
      direction: 'debit',
      amountMinor: gross,
      currency,
      dimensions,
      nonNegative: true,
    },
    {
      account: { code: '4100', org: false },
      direction: 'credit',
      amountMinor: net,
      currency,
      dimensions,
    },
  ];
  // VAT-at-consumption (docs/11 §3.1) is a configurable policy [VERIFY, D-25]; vat 0 means "not applied here".
  if (vat !== '0')
    postings.push({
      account: { code: '2300', org: false },
      direction: 'credit',
      amountMinor: vat,
      currency,
      dimensions,
    });
  return {
    kind,
    orgId: p.orgId,
    description: p.description ?? (p.meterId ? `Usage ${p.meterId}` : 'Wallet consumption'),
    sourceEventId: p.sourceEventId,
    affectsWallet: true,
    postings,
  };
}
/** Wallet consume: Dr 2100 wallet → Cr 4100 usage revenue (+ 2300 VAT output). Cannot overdraw the wallet. */
export const walletConsume = (p: Parameters<typeof consume>[1]): Built =>
  consume('wallet_consume', p);
/** Usage charge in wallet-debit mode (rated usage paid from prepaid credits). Same postings, meter id required. */
export const usageChargeWallet = (p: Parameters<typeof consume>[1] & { meterId: string }): Built =>
  consume('usage_charge_wallet', p);

/** Provider cost accrual (platform level): Dr 5100 cost of revenue → Cr 2400 provider payables. */
export function providerCostAccrual(p: {
  providerAccountId: string;
  amountMinor: Minor;
  currency: string;
  costRecordId?: string;
  description?: string;
}): Built {
  const amount = parseMinor(p.amountMinor);
  const currency = parseCurrency(p.currency);
  const sub = text(p.providerAccountId, 'providerAccountId', 100);
  const dimensions = {
    provider_account_id: sub,
    ...(p.costRecordId ? { cost_record_id: p.costRecordId } : {}),
  };
  return {
    kind: 'provider_cost_accrual',
    orgId: null,
    description: p.description ?? 'Provider cost accrual',
    sourceEventId: p.costRecordId,
    affectsWallet: false,
    postings: [
      {
        account: { code: '5100', org: false, subledger: sub },
        direction: 'debit',
        amountMinor: amount,
        currency,
        dimensions,
      },
      {
        account: { code: '2400', org: false, subledger: sub },
        direction: 'credit',
        amountMinor: amount,
        currency,
        dimensions,
      },
    ],
  };
}

/** Admin adjustment with explicit approved lines (two-person approval is enforced by the caller, S07). */
export function adjustment(p: {
  orgId: string | null;
  lines: PostingLine[];
  reason: string;
  sourceEventId?: string;
}): Built {
  if (!Array.isArray(p.lines) || p.lines.length < 2)
    throw new ProblemException('validation_failed', 'an adjustment needs at least two lines');
  const postings = p.lines.map((l) => ({
    ...l,
    amountMinor: parseMinor(l.amountMinor, 'line amount'),
    currency: parseCurrency(l.currency),
  }));
  assertBalanced(postings);
  return {
    kind: 'adjustment',
    orgId: p.orgId,
    description: text(p.reason, 'reason'),
    sourceEventId: p.sourceEventId,
    affectsWallet: postings.some((l) => l.account.code === '2100'),
    postings,
  };
}

/**
 * Reversal of an existing transaction: every posting with its direction flipped, referencing the original. Debits to the
 * customer wallet keep the overdraw guard (a reversal may not drive a wallet negative).
 */
export function reversal(p: {
  orgId: string | null;
  originalId: string;
  original: PostingLine[];
  reason: string;
}): Built {
  const postings: PostingLine[] = p.original.map((l) => {
    const direction = l.direction === 'debit' ? 'credit' : 'debit';
    return {
      account: l.account,
      direction,
      amountMinor: l.amountMinor,
      currency: l.currency,
      dimensions: { ...(l.dimensions ?? {}), reverses: p.originalId },
      ...(l.account.code === '2100' && direction === 'debit' ? { nonNegative: true } : {}),
    };
  });
  assertBalanced(postings);
  return {
    kind: 'reversal',
    orgId: p.orgId,
    description: text(p.reason, 'reason'),
    reversesId: p.originalId,
    affectsWallet: postings.some((l) => l.account.code === '2100'),
    postings,
  };
}

/** Recipes owned by M03 (payments/invoicing): registered now so callers fail loudly instead of improvising postings. */
const m03 = (name: string) => (): never => {
  throw new ProblemException(
    'recipe_not_implemented',
    `${name} is implemented in M03 (payments & invoicing)`,
  );
};
export const paymentCaptured = m03('payment captured');
export const refund = m03('refund');
export const walletTopUp = m03('wallet top-up');

export type RevenueAccount = '4100' | '4200' | '4300' | '4400';
export interface DocumentRecipeLine {
  revenueAccount: RevenueAccount;
  netMinor: Minor;
  taxMinor: Minor;
}
interface DocumentRecipe {
  orgId: string;
  documentId: string;
  invoiceId: string;
  entityId: string;
  currency: string;
  /** Human document number, for the description only. */
  number: string;
  lines: DocumentRecipeLine[];
}

function totals(lines: DocumentRecipeLine[]) {
  if (!Array.isArray(lines) || lines.length < 1)
    throw new ProblemException('validation_failed', 'a document needs at least one line');
  const byAccount = new Map<RevenueAccount, bigint>();
  let tax = 0n;
  for (const l of lines) {
    if (!['4100', '4200', '4300', '4400'].includes(l.revenueAccount))
      throw new ProblemException(
        'validation_failed',
        `unknown revenue account ${String(l.revenueAccount)}`,
      );
    const net = BigInt(nonNegativeMinor(l.netMinor, 'line net'));
    byAccount.set(l.revenueAccount, (byAccount.get(l.revenueAccount) ?? 0n) + net);
    tax += BigInt(nonNegativeMinor(l.taxMinor, 'line tax'));
  }
  const net = [...byAccount.values()].reduce((a, b) => a + b, 0n);
  if (net + tax <= 0n)
    throw new ProblemException('validation_failed', 'a document must have a positive total');
  return { byAccount, net, tax, gross: net + tax };
}

/**
 * Invoice issued (docs/11 §3.1): Dr 1200 receivable (net + VAT) → Cr 4xxx revenue (net, per revenue account) + Cr 2300 VAT output.
 * One transaction per invoice, idempotent on the invoice id; "rated usage itself posts nothing until invoiced".
 */
export function invoiceIssued(p: DocumentRecipe): Built {
  const t = totals(p.lines);
  const currency = parseCurrency(p.currency);
  const dimensions = { invoice_id: p.invoiceId, billing_entity_id: p.entityId };
  const postings: PostingLine[] = [
    {
      account: { code: '1200', org: true },
      direction: 'debit',
      amountMinor: t.gross.toString(),
      currency,
      dimensions,
    },
    ...[...t.byAccount.entries()]
      .filter(([, n]) => n > 0n)
      .map(([code, n]): PostingLine => ({
        account: { code, org: false },
        direction: 'credit',
        amountMinor: n.toString(),
        currency,
        dimensions,
      })),
  ];
  if (t.tax > 0n)
    postings.push({
      account: { code: '2300', org: false },
      direction: 'credit',
      amountMinor: t.tax.toString(),
      currency,
      dimensions,
    });
  assertBalanced(postings);
  return {
    kind: 'invoice_issued',
    orgId: p.orgId,
    description: text(`Invoice ${p.number}`, 'description'),
    sourceEventId: p.invoiceId,
    affectsWallet: false,
    postings,
  };
}

/**
 * Credit note (docs/11 §3.1): Dr 4xxx revenue (net) + Dr 2300 VAT output → Cr 1200 receivable (net + VAT). Never edits the invoice
 * postings: it reverses their effect with its own transaction, referencing the invoice in the dimensions.
 */
export function creditNote(p: DocumentRecipe): Built {
  const t = totals(p.lines);
  const currency = parseCurrency(p.currency);
  const dimensions = {
    invoice_id: p.invoiceId,
    credit_note_id: p.documentId,
    billing_entity_id: p.entityId,
  };
  const postings: PostingLine[] = [
    ...[...t.byAccount.entries()]
      .filter(([, n]) => n > 0n)
      .map(([code, n]): PostingLine => ({
        account: { code, org: false },
        direction: 'debit',
        amountMinor: n.toString(),
        currency,
        dimensions,
      })),
  ];
  if (t.tax > 0n)
    postings.push({
      account: { code: '2300', org: false },
      direction: 'debit',
      amountMinor: t.tax.toString(),
      currency,
      dimensions,
    });
  postings.push({
    account: { code: '1200', org: true },
    direction: 'credit',
    amountMinor: t.gross.toString(),
    currency,
    dimensions,
  });
  assertBalanced(postings);
  return {
    kind: 'credit_note',
    orgId: p.orgId,
    description: text(`Credit note ${p.number}`, 'description'),
    sourceEventId: p.documentId,
    affectsWallet: false,
    postings,
  };
}
