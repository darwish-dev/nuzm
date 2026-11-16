import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { recipes, type LedgerPostingService } from '../../billing';

export interface ProviderCostInput {
  providerAccountId: string;
  providerLineRef: string;
  periodStart: string;
  periodEnd: string;
  meterOrSku: string;
  quantity: string;
  costMinor: string | number | bigint;
  currency: string;
  source: 'api' | 'bill_import';
  resourceId?: string;
  orgId?: string;
  evidenceRef?: string;
}

/**
 * Provider cost capture (docs/12 §8): what the providers charge Nuzm, never shown to customers. Records are deduped on the
 * provider's own line reference and each NEW cost is accrued in the ledger (Dr 5100 / Cr 2400 on the provider sub-ledger).
 * The accrual is idempotent per line, so a retry after a crash completes it. docs/04 defines no HTTP endpoint for import
 * (UI-M02-16 is served by this service; the endpoint is a spec gap listed in the S06 report).
 */
export class ProviderCostService {
  constructor(
    private readonly db: Db,
    private readonly ledger: LedgerPostingService,
    private readonly audit: AuditSink,
  ) {}

  async record(inputs: ProviderCostInput[], actorUserId?: string) {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 500)
      throw new ProblemException('validation_failed', 'records must be 1..500 items');
    const rows = inputs.map((r, i) => {
      const bad = (m: string) => new ProblemException('validation_failed', `records[${i}]: ${m}`);
      if (!/^[a-z0-9][a-z0-9_.-]{1,60}$/i.test(r.providerAccountId ?? ''))
        throw bad('providerAccountId is invalid');
      if (
        typeof r.providerLineRef !== 'string' ||
        r.providerLineRef.length < 1 ||
        r.providerLineRef.length > 200
      )
        throw bad('providerLineRef is required');
      if (r.source !== 'api' && r.source !== 'bill_import')
        throw bad('source must be api or bill_import');
      if (r.source === 'bill_import' && !r.evidenceRef)
        throw bad('a bill import needs an evidenceRef (the uploaded bill)');
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(r.periodStart) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(r.periodEnd) ||
        r.periodEnd < r.periodStart
      )
        throw bad('period dates must be YYYY-MM-DD with periodEnd >= periodStart');
      if (!/^\d{1,16}(\.\d{1,8})?$/.test(r.quantity))
        throw bad('quantity must be a non-negative decimal');
      return {
        ...r,
        costMinor: recipes.parseMinor(r.costMinor, 'costMinor'),
        currency: recipes.parseCurrency(r.currency),
        capturedBy: actorUserId ?? null,
      };
    });
    const out = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query<{ id: string; inserted: boolean }>(
            'SELECT * FROM metering.record_provider_cost($1::jsonb)',
            [JSON.stringify(rows)],
          )
        ).rows,
    );
    // accrue every record (idempotent): a crash between the insert and the accrual is completed on retry
    for (const [i, r] of rows.entries()) {
      await this.ledger.post(
        recipes.providerCostAccrual({
          providerAccountId: r.providerAccountId,
          amountMinor: r.costMinor,
          currency: r.currency,
          costRecordId: out[i]!.id,
          description: `Provider cost ${r.providerAccountId} ${r.providerLineRef}`,
        }),
        `cost:${r.providerAccountId}:${r.providerLineRef}`,
        actorUserId,
      );
    }
    await this.audit.record({
      action: 'metering.provider_cost.recorded',
      actorUserId,
      outcome: 'success',
      detail: { records: rows.length, inserted: out.filter((o) => o.inserted).length },
    });
    return out.map((o, i) => ({
      id: o.id,
      inserted: o.inserted,
      providerLineRef: rows[i]!.providerLineRef,
    }));
  }

  /** Margin per org and month (finance): latest rating run's revenue vs attributed provider cost. */
  async margin(filter: { orgId?: string } = {}) {
    return this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT org_id, period_start::text, currency, revenue_minor::text, cost_minor::text, margin_minor::text FROM metering.v_margin
            WHERE ($1::uuid IS NULL OR org_id = $1) ORDER BY period_start, org_id NULLS LAST`,
            [filter.orgId ?? null],
          )
        ).rows,
    );
  }
}
