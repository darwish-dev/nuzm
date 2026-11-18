import type { DomainsKit } from './domains-kit';

/** Test hooks for the mock registrar statement (Openprovider mock `/transactions`): change what the vendor "billed". */
export const OpenproviderMockInject = {
  /** The vendor billed 0.50 more for `domainName` than the order cost captured. */
  changeAmount(k: DomainsKit, domainName: string): void {
    k.op.controls.mutateTransactions((t) => {
      const line = t.find((x) => x.subject === domainName);
      if (line) (line.total as { reseller: { price: number } }).reseller.price += 0.5;
    });
  },
  /** A charge on the statement that no order of ours explains. */
  extraLine(k: DomainsKit): void {
    k.op.controls.mutateTransactions((t) => {
      t.push({
        action: 'create',
        type: 'domain',
        subject: 'unknown-extra-charge.com',
        creation_date: new Date().toISOString(),
        reference_id: 999999,
        total: { reseller: { currency: 'EUR', price: 8.99 } },
      });
    });
  },
};
