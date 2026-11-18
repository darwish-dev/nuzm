import { ProblemException } from '../../../common/errors';
import { recipes } from '../../billing';

type Built = recipes.Built;
const base = (
  orgId: string,
  amountMinor: bigint,
  currency: string,
  kind: string,
  description: string,
  sourceEventId: string,
) => {
  if (amountMinor <= 0n)
    throw new ProblemException('validation_failed', 'a domain order must cost something');
  return {
    orgId,
    amount: recipes.parseMinor(amountMinor, 'order amount'),
    currency: recipes.parseCurrency(currency),
    kind,
    description,
    sourceEventId,
  };
};

/**
 * Domain order recipes (docs/11 §3.1; quote → authorize → record → reconcile). Funds are RESERVED up front by moving them from the customer wallet (2100) to the
 * organization's deferred-revenue account (2200); the sale is RECOGNISED only after the registrar confirmed (Dr 2200 → Cr 4300 domain revenue + Cr 2300 VAT);
 * a definitive failure RELEASES the reservation with the mirror entry (ledgers are append-only: corrections are reversing entries, never edits).
 * Every posting is keyed by the domain order id, so a repeated callback or a reconciler re-run posts zero additional rows.
 */
export function authorize(
  orgId: string,
  orderId: string,
  amountMinor: bigint,
  currency: string,
  description: string,
): Built {
  const b = base(
    orgId,
    amountMinor,
    currency,
    'domain_authorize',
    description,
    `domain-order:${orderId}:authorize`,
  );
  const dim = { domain_order_id: orderId };
  return {
    kind: b.kind,
    orgId,
    description: b.description,
    sourceEventId: b.sourceEventId,
    affectsWallet: true,
    postings: [
      {
        account: { code: '2100', org: true },
        direction: 'debit',
        amountMinor: b.amount,
        currency: b.currency,
        dimensions: dim,
        nonNegative: true,
      },
      {
        account: { code: '2200', org: true },
        direction: 'credit',
        amountMinor: b.amount,
        currency: b.currency,
        dimensions: dim,
      },
    ],
  };
}
export function release(
  orgId: string,
  orderId: string,
  amountMinor: bigint,
  currency: string,
  description: string,
): Built {
  const b = base(
    orgId,
    amountMinor,
    currency,
    'domain_release',
    description,
    `domain-order:${orderId}:release`,
  );
  const dim = { domain_order_id: orderId };
  return {
    kind: b.kind,
    orgId,
    description: b.description,
    sourceEventId: b.sourceEventId,
    affectsWallet: true,
    postings: [
      {
        account: { code: '2200', org: true },
        direction: 'debit',
        amountMinor: b.amount,
        currency: b.currency,
        dimensions: dim,
        nonNegative: true,
      },
      {
        account: { code: '2100', org: true },
        direction: 'credit',
        amountMinor: b.amount,
        currency: b.currency,
        dimensions: dim,
      },
    ],
  };
}
export function record(
  orgId: string,
  orderId: string,
  netMinor: bigint,
  vatMinor: bigint,
  currency: string,
  description: string,
): Built {
  const total = netMinor + vatMinor;
  const b = base(
    orgId,
    total,
    currency,
    'domain_sale',
    description,
    `domain-order:${orderId}:record`,
  );
  const dim = { domain_order_id: orderId };
  const postings: Built['postings'] = [
    {
      account: { code: '2200', org: true },
      direction: 'debit',
      amountMinor: b.amount,
      currency: b.currency,
      dimensions: dim,
      nonNegative: true,
    },
    {
      account: { code: '4300', org: false },
      direction: 'credit',
      amountMinor: recipes.parseMinor(netMinor, 'net'),
      currency: b.currency,
      dimensions: dim,
    },
  ];
  if (vatMinor > 0n)
    postings.push({
      account: { code: '2300', org: false },
      direction: 'credit',
      amountMinor: recipes.parseMinor(vatMinor, 'vat'),
      currency: b.currency,
      dimensions: dim,
    });
  return {
    kind: b.kind,
    orgId,
    description: b.description,
    sourceEventId: b.sourceEventId,
    affectsWallet: false,
    postings,
  };
}
