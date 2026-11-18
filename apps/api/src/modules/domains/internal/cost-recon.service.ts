import { isSupported, type ProviderCostRecord } from '@nuzm/registrar-contracts';
import type { Db } from '@nuzm/platform';
import type { BillLine } from '../../finrec';
import type { Row } from './common';
import type { RegistrarAccessService } from './registrar-access.service';

const NAME = /([a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+)/i;

/**
 * Registrar statement → RC-04 bill lines (M07 S31 task 3). The cost of each order is captured exactly once at confirmation (`metering.provider_cost_records`,
 * line ref `domain-order:<id>`); here the registrar's own transaction list (`fetchBilling`) is turned into bill lines and each is matched to the order it paid
 * for (domain name + action in the line description, succeeded orders only). A line that matches nothing keeps a vendor-based ref, so RC-04 reports it as
 * `bill_line_without_cost`; an order with no statement line is `cost_without_bill_line`; a different amount is `bill_amount_mismatch` (threshold D-31, default: any
 * non-zero variance). Statements are NOT stored as cost records (that would accrue the cost twice). Vendor statement semantics are NOT VERIFIED (HG-07-01, D-31).
 */
export class DomainCostReconService {
  constructor(
    private readonly db: Db,
    private readonly access: RegistrarAccessService,
  ) {}

  async billLines(from: string, to: string): Promise<BillLine[] | null> {
    const accounts = (await this.access.listAccounts()).filter(
      (a) =>
        a.enabled && a.registrarEnabled && isSupported(a.capabilities, 'registrar.billing-export'),
    );
    if (accounts.length === 0) return null;
    const out: BillLine[] = [];
    for (const a of accounts) {
      const acc = this.access.accessFor(a, 'rc-04');
      if (!acc?.adapter.fetchBilling) continue;
      const rows: ProviderCostRecord[] = await acc.adapter.fetchBilling(acc.ctx, {
        from: `${from}T00:00:00.000Z`,
        to: `${to}T23:59:59.999Z`,
      });
      for (const r of rows) {
        const order = await this.match(a.id, r);
        out.push({
          providerAccountId: a.id,
          lineRef: order ? `domain-order:${order}` : `statement:${r.providerRef ?? r.periodStart}`,
          periodStart: r.periodStart.slice(0, 10),
          amountMinor: r.amountMinor,
          currency: r.currency,
        });
      }
    }
    return out;
  }

  private async match(accountId: string, r: ProviderCostRecord): Promise<string | null> {
    const name = NAME.exec(r.description)?.[1]?.toLowerCase();
    if (!name) return null;
    const type = /renew/i.test(r.description)
      ? 'renewal'
      : /transfer/i.test(r.description)
        ? 'transfer_in'
        : 'register';
    const row = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id FROM domains.domain_orders WHERE registrar_account_id=$1 AND name=$2 AND type=$3 AND state='succeeded' ORDER BY created_at DESC LIMIT 1`,
            [accountId, name, type],
          )
        ).rows[0] as Row | undefined,
    );
    return row ? (row.id as string) : null;
  }
}
