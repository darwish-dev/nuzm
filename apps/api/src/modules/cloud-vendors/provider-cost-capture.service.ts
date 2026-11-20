import { isSupported, type ProviderCostRecord } from '@nuzm/adapter-contracts';
import {
  closedWindow,
  parseManualCosts,
  toBillLines,
  toCostRows,
  type Attribution,
  type BillLine,
  type Fx,
} from '@nuzm/adapter-costs';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../common/audit';
import { ProblemException } from '../../common/errors';
import { AdapterRegistry, type AdapterEntry } from '../cloud';
import { ProviderCostService } from '../metering';
import { UUID } from '@nuzm/domain';

type Row = Record<string, unknown>;

export interface CostListFilter {
  providerAccountId?: string;
  period?: string; // YYYY-MM
  limit?: number;
  cursor?: string;
}

/**
 * Provider cost capture (M05 S23 task 22, FR-CLD): adapters' `fetchBilling` → `metering.provider_cost_records` through the M02
 * `ProviderCostService` (dedupe on the line reference, ledger accrual Dr 5100 / Cr 2400). Only CLOSED billing periods are captured; provider
 * currency is kept (SAR conversion is recorded in `evidenceRef`); a record whose instance is not one of our resources stays unattributed and
 * RC-04 reports it as `unattributed_cost` (an orphan resource or a charge we did not cause). Every result built from fixtures is NOT VERIFIED.
 */
export class ProviderCostCapture {
  constructor(
    private readonly db: Db,
    private readonly registry: AdapterRegistry,
    private readonly costs: ProviderCostService,
    private readonly audit: AuditSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** provider reference (instance id) → our resource/org, from `cloud.resources` when that table exists (S17); otherwise everything is unattributed. */
  private async attributions(accountId: string, refs: string[]): Promise<Map<string, Attribution>> {
    const out = new Map<string, Attribution>();
    if (!refs.length) return out;
    await this.db.withPlatformScope(async (c) => {
      const has =
        (await c.query(`SELECT to_regclass('cloud.resources') IS NOT NULL AS ok`)).rows[0]?.ok ===
        true;
      if (!has) return;
      const rows = (
        await c.query<Row>(
          `SELECT id, org_id, provider_ref FROM cloud.resources WHERE provider_account_id = $1::uuid
              AND (provider_ref = ANY($2::text[]) OR split_part(provider_ref, '/', 2) = ANY($2::text[]))`,
          [accountId, refs],
        )
      ).rows;
      for (const r of rows) {
        const ref = String(r.provider_ref);
        const bare = ref.includes('/') ? ref.split('/')[1]! : ref;
        const a = { resourceId: String(r.id), orgId: String(r.org_id) };
        out.set(ref, a);
        out.set(bare, a);
      }
    });
    return out;
  }

  private async account(accountId: string) {
    if (!UUID.test(accountId)) throw new ProblemException('not_found');
    const r = (
      await this.db.withPlatformScope(
        async (c) =>
          (
            await c.query<Row>(
              `SELECT a.id, a.vault_ref, a.status, p.key AS provider_key, p.adapter_id FROM cloud.provider_accounts a JOIN cloud.providers p ON p.id = a.provider_id WHERE a.id = $1::uuid`,
              [accountId],
            )
          ).rows,
      )
    )[0];
    if (!r) throw new ProblemException('not_found');
    return r;
  }

  /** Fetch from the provider's billing API and record (idempotent). Rejects providers that have no billing capability. */
  async capture(
    accountId: string,
    period: { from: string; to: string },
    o: { actorUserId?: string; fx?: Fx } = {},
  ) {
    const acct = await this.account(accountId);
    const adapter = this.registry.compute(String(acct.adapter_id));
    if (!adapter)
      throw new ProblemException(
        'unsupported_capability',
        `no adapter is available for ${String(acct.provider_key)} in this deployment`,
      );
    if (!adapter.fetchBilling)
      throw new ProblemException(
        'unsupported_capability',
        'this provider has no billing API; use the manual import',
      );
    const ctx = this.registry.ctx(
      { id: accountId, vaultRef: String(acct.vault_ref) },
      `cost-capture-${accountId}`,
    );
    const caps = (await adapter.probe(ctx)).capabilities;
    if (!isSupported(caps, 'compute.billing-export'))
      throw new ProblemException(
        'unsupported_capability',
        'the probe did not mark compute.billing-export supported for this account',
      );
    const win = closedWindow(period, this.now());
    if (!win)
      return {
        captured: 0,
        inserted: 0,
        skipped: 'period is not closed (current-month provider data is "for reference only")',
      };
    const records = await adapter.fetchBilling(ctx, win);
    return this.record(accountId, records, 'api', o);
  }

  /** Manual import for providers without a billing API (Contabo): a CSV plus the evidence reference of the uploaded bill. */
  async importManual(
    accountId: string,
    csv: string,
    evidenceRef: string,
    o: { actorUserId?: string; fx?: Fx } = {},
  ) {
    await this.account(accountId);
    if (!/^[A-Za-z0-9._:/-]{3,200}$/.test(evidenceRef))
      throw new ProblemException(
        'validation_failed',
        'evidenceRef is required (the uploaded bill reference)',
      );
    let records: ProviderCostRecord[];
    try {
      records = parseManualCosts(csv);
    } catch (e) {
      throw new ProblemException('validation_failed', (e as Error).message);
    }
    return this.record(accountId, records, 'bill_import', { ...o, evidenceRef });
  }

  private async record(
    accountId: string,
    records: ProviderCostRecord[],
    source: 'api' | 'bill_import',
    o: { actorUserId?: string; fx?: Fx; evidenceRef?: string },
  ) {
    if (!records.length) return { captured: 0, inserted: 0 };
    const attrib = await this.attributions(accountId, [
      ...new Set(records.map((r) => r.providerRef).filter((x): x is string => !!x)),
    ]);
    const rows = toCostRows({
      providerAccountId: accountId,
      records,
      source,
      attribute: (r) => attrib.get(r) ?? null,
      capturedBy: o.actorUserId ?? null,
      ...(o.evidenceRef ? { evidenceRef: o.evidenceRef } : {}),
      ...(o.fx ? { fx: o.fx } : {}),
    });
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 400) {
      const chunk = rows.slice(i, i + 400).map((r) => ({
        providerAccountId: r.providerAccountId,
        providerLineRef: r.providerLineRef,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        meterOrSku: r.meterOrSku,
        quantity: r.quantity,
        costMinor: r.costMinor,
        currency: r.currency,
        source: r.source,
        ...(r.resourceId ? { resourceId: r.resourceId } : {}),
        ...(r.orgId ? { orgId: r.orgId } : {}),
        ...(r.evidenceRef ? { evidenceRef: r.evidenceRef } : {}),
      }));
      inserted += (await this.costs.record(chunk, o.actorUserId)).filter((x) => x.inserted).length;
    }
    await this.audit.record({
      action: 'cloud.provider_cost.captured',
      actorUserId: o.actorUserId,
      outcome: 'success',
      detail: {
        providerAccountId: accountId,
        source,
        records: rows.length,
        inserted,
        unattributed: rows.filter((r) => !r.orgId).length,
      },
    });
    return { captured: rows.length, inserted, unattributed: rows.filter((r) => !r.orgId).length };
  }

  /** RC-04 `Sources.bills`: what the providers' own billing APIs say for the period, as lines that carry the same references as the cost records. */
  billSource() {
    return async (from: string, to: string): Promise<BillLine[] | null> => {
      const accounts = await this.db.withPlatformScope(
        async (c) =>
          (
            await c.query<Row>(
              `SELECT a.id, p.adapter_id, a.vault_ref FROM cloud.provider_accounts a JOIN cloud.providers p ON p.id = a.provider_id WHERE a.status = 'active' AND p.kind = 'compute'`,
            )
          ).rows,
      );
      let any = false;
      const lines: BillLine[] = [];
      for (const a of accounts) {
        const adapter = this.registry.compute(String(a.adapter_id));
        if (
          !adapter?.fetchBilling ||
          (this.registry.entry(String(a.adapter_id)) as AdapterEntry | undefined)?.nonProductionOnly
        )
          continue;
        const ctx = this.registry.ctx(
          { id: String(a.id), vaultRef: String(a.vault_ref) },
          `rc04-${String(a.id)}`,
        );
        const win = closedWindow({ from: `${from}T00:00:00Z`, to: `${to}T00:00:00Z` }, this.now());
        if (!win) continue;
        any = true;
        lines.push(...toBillLines(String(a.id), await adapter.fetchBilling(ctx, win)));
      }
      return any ? lines : null; // null = "no bill source": RC-04 then states that it compared nothing
    };
  }

  /** Cost records for the admin console (UI-M05-14). Platform scope; amounts stay integer strings in the provider currency. */
  async list(f: CostListFilter) {
    const limit = Math.min(Math.max(Number(f.limit ?? 50) || 50, 1), 200);
    if (f.providerAccountId && !UUID.test(f.providerAccountId))
      throw new ProblemException('validation_failed', 'providerAccountId must be a UUID');
    if (f.period && !/^\d{4}-(0[1-9]|1[0-2])$/.test(f.period))
      throw new ProblemException('validation_failed', 'period must be YYYY-MM');
    let after: { at: string; id: string } | null = null;
    if (f.cursor) {
      try {
        const [at, id] = Buffer.from(f.cursor, 'base64url').toString('utf8').split('|');
        if (!at || !id || !UUID.test(id) || Number.isNaN(Date.parse(at))) throw new Error('bad');
        after = { at, id };
      } catch {
        throw new ProblemException('validation_failed', 'cursor is invalid');
      }
    }
    const where = `($1::text IS NULL OR k.provider_account_id = $1) AND ($2::text IS NULL OR to_char(k.period_start, 'YYYY-MM') = $2)`;
    return this.db.withPlatformScope(async (c) => {
      const rows = (
        await c.query<Row>(
          `SELECT k.id, k.provider_account_id, p.key AS provider_key, k.resource_id, k.org_id, k.period_start::text, k.period_end::text, k.meter_or_sku, k.quantity::text, k.cost_minor::text,
                  k.currency::text, k.source, k.provider_line_ref, k.captured_at
             FROM metering.provider_cost_records k
             LEFT JOIN cloud.provider_accounts a ON a.id::text = k.provider_account_id LEFT JOIN cloud.providers p ON p.id = a.provider_id
            WHERE ${where} AND ($3::timestamptz IS NULL OR (date_trunc('milliseconds', k.captured_at), k.id) < ($3::timestamptz, $4::uuid))
            ORDER BY date_trunc('milliseconds', k.captured_at) DESC, k.id DESC LIMIT ${limit + 1}`,
          [f.providerAccountId ?? null, f.period ?? null, after?.at ?? null, after?.id ?? null],
        )
      ).rows;
      const totals = (
        await c.query<Row>(
          `SELECT k.currency::text, sum(k.cost_minor)::text AS cost, count(*)::int AS records, count(*) FILTER (WHERE k.org_id IS NULL)::int AS unattributed
             FROM metering.provider_cost_records k WHERE ${where} GROUP BY k.currency ORDER BY k.currency`,
          [f.providerAccountId ?? null, f.period ?? null],
        )
      ).rows;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map((r) => ({
          id: r.id as string,
          providerAccountId: r.provider_account_id as string,
          providerKey: (r.provider_key as string | null) ?? null,
          resourceId: (r.resource_id as string | null) ?? null,
          orgId: (r.org_id as string | null) ?? null,
          periodStart: r.period_start as string,
          periodEnd: r.period_end as string,
          meterOrSku: r.meter_or_sku as string,
          quantity: r.quantity as string,
          costMinor: r.cost_minor as string,
          currency: r.currency as string,
          source: r.source as string,
          providerLineRef: r.provider_line_ref as string,
          capturedAt: (r.captured_at as Date).toISOString(),
        })),
        nextCursor:
          rows.length > limit && last
            ? Buffer.from(
                `${(last.captured_at as Date).toISOString()}|${last.id as string}`,
              ).toString('base64url')
            : null,
        totals: totals.map((t) => ({
          currency: t.currency as string,
          costMinor: t.cost as string,
          records: t.records as number,
          unattributed: t.unattributed as number,
        })),
      };
    });
  }
}
