import {
  buildCapabilityRegistry,
  reconcileDiscovery,
  type DiscoveryReconciliation,
  type HealthSnapshot,
  type RegistryEntry,
} from '@nuzm/adapter-model';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { GatewayService } from './gateway.service';
import { isUuid, type AiConfig, type Row } from './model';
import type { ModelProviderService } from './provider.service';
import type { ModelAdapterRegistry } from './registry';

/**
 * Read models for the provider administration console (S-AG4): the capability registry, provider health and the usage report, plus model discovery (live-gated).
 * Everything here is READ-ONLY except `discoverModels`, which sends nothing but a model-listing request and only when the owner has opened the live gate for the provider.
 * The HTTP routes that expose these are a contract request (`docs/parallel/sessions/CONTRACT-1-provider-insights.md`): until the Master applies the spec, they are service-level only.
 */
export type UsageGroupBy = 'provider' | 'model' | 'day';
export interface UsageReportQuery {
  from: Date;
  to: Date;
  groupBy: UsageGroupBy;
  providerCode?: string;
  orgId?: string;
}
export interface UsageReportRow {
  providerCode: string;
  /** present for `model` and `day` grouping of models */
  modelRef: string | null;
  /** UTC day `YYYY-MM-DD`, present for `day` grouping */
  day: string | null;
  calls: number;
  okCalls: number;
  errorCalls: number;
  /** calls whose token counts were estimated because the provider reported none */
  estimatedCalls: number;
  /** integer strings: token and money columns can exceed 2^53 */
  tokensIn: string;
  tokensOut: string;
  credits: string;
  /** the provider's own price of these calls in minor units of `costCurrency` (our COST, not what customers paid); `null` when the group mixes currencies (`costCurrency` is then `MIXED`) */
  costMinor: string | null;
  costCurrency: string | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
}
export interface UsageReport {
  from: string;
  to: string;
  groupBy: UsageGroupBy;
  rows: UsageReportRow[];
  /** true when the row cap cut the result: narrow the range or the filter */
  truncated: boolean;
}
const MAX_RANGE_MS = 366 * 24 * 3600_000;
export const USAGE_REPORT_ROW_CAP = 1_000;

export interface DiscoveryResult extends DiscoveryReconciliation {
  providerCode: string;
  /** always true: this was a request to the vendor, so it is labelled as such. The result is NOT a capability verification. */
  live: true;
  checkedAt: string;
}

export class ProviderInsightsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly providers: ModelProviderService,
    private readonly registry: ModelAdapterRegistry,
    private readonly gateway: GatewayService,
    private readonly cfg: AiConfig,
  ) {}

  /** Every model of every configured provider with a registered adapter, with what the router may rely on and what is still pending evidence. */
  async capabilityRegistry(): Promise<{ items: RegistryEntry[] }> {
    const { items } = await this.providers.list();
    const evidence = await this.providers.verifiedCapabilities();
    const inputs = items.flatMap((p) => {
      const adapter = this.registry.get(p.code);
      return adapter
        ? [
            {
              providerCode: p.code,
              providerId: p.id,
              contractVersion: adapter.contractVersion,
              enabled: p.enabled,
              models: adapter.models(),
              rateCard: p.rateCard.models,
              evidence,
            },
          ]
        : [];
    });
    return { items: buildCapabilityRegistry(inputs) };
  }

  /** Rolling-window health of this process (in memory: it starts empty after a restart and does not merge several API instances). */
  health(): { scope: 'process'; items: HealthSnapshot[] } {
    return { scope: 'process', items: this.gateway.providerHealth() };
  }

  /** Aggregated usage from the append-only `ai.model_usage` rows (platform read scope). Totals are integers; nothing is estimated here. */
  async usageReport(q: UsageReportQuery): Promise<UsageReport> {
    if (
      !(q.from instanceof Date) ||
      !(q.to instanceof Date) ||
      Number.isNaN(+q.from) ||
      Number.isNaN(+q.to)
    )
      throw new ProblemException('validation_failed', 'from and to must be dates');
    if (q.to <= q.from) throw new ProblemException('validation_failed', 'to must be after from');
    if (q.to.getTime() - q.from.getTime() > MAX_RANGE_MS)
      throw new ProblemException('validation_failed', 'the range may not exceed 366 days');
    if (!['provider', 'model', 'day'].includes(q.groupBy))
      throw new ProblemException('validation_failed', 'groupBy must be provider, model or day');
    if (q.providerCode !== undefined && !/^[a-z][a-z0-9-]{0,62}$/.test(q.providerCode))
      throw new ProblemException('validation_failed', 'providerCode is malformed');
    if (q.orgId !== undefined && !isUuid(q.orgId))
      throw new ProblemException('validation_failed', 'orgId must be a uuid');

    const params: unknown[] = [q.from.toISOString(), q.to.toISOString()];
    let where = `created_at >= $1 AND created_at < $2`;
    if (q.providerCode) where += ` AND provider_code = $${params.push(q.providerCode)}`;
    if (q.orgId) where += ` AND org_id = $${params.push(q.orgId)}`;
    const model = q.groupBy === 'provider' ? `NULL::text` : `model_ref`;
    const day =
      q.groupBy === 'day'
        ? `to_char((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD')`
        : `NULL::text`;
    const dayExpr = `(created_at AT TIME ZONE 'UTC')::date`;
    const groups = [
      'provider_code',
      ...(q.groupBy === 'provider' ? [] : ['model_ref']),
      ...(q.groupBy === 'day' ? [dayExpr] : []),
    ];
    const order = [
      ...(q.groupBy === 'day' ? [`${dayExpr} DESC`] : []),
      'provider_code',
      ...(q.groupBy === 'provider' ? [] : ['model_ref']),
    ];
    const sql = `
      SELECT provider_code, ${model} AS model_ref, ${day} AS day,
             count(DISTINCT cost_currency)::int AS currencies, max(cost_currency) AS cost_currency,
             count(*)::int AS calls,
             (count(*) FILTER (WHERE outcome = 'ok'))::int AS ok_calls,
             (count(*) FILTER (WHERE outcome <> 'ok'))::int AS error_calls,
             (count(*) FILTER (WHERE estimated))::int AS estimated_calls,
             sum(tokens_in)::text AS tokens_in, sum(tokens_out)::text AS tokens_out,
             sum(credits)::text AS credits, sum(cost_minor)::text AS cost_minor,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE outcome = 'ok' AND latency_ms IS NOT NULL) AS p50,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE outcome = 'ok' AND latency_ms IS NOT NULL) AS p95
        FROM ai.model_usage
       WHERE ${where}
       GROUP BY ${groups.join(', ')}
       ORDER BY ${order.join(', ')}
       LIMIT ${USAGE_REPORT_ROW_CAP + 1}`;
    const rows = (await this.db.withPlatformScope(
      async (c) => (await c.query(sql, params)).rows,
    )) as Row[];
    const truncated = rows.length > USAGE_REPORT_ROW_CAP;
    return {
      from: q.from.toISOString(),
      to: q.to.toISOString(),
      groupBy: q.groupBy,
      truncated,
      rows: rows.slice(0, USAGE_REPORT_ROW_CAP).map((r) => ({
        providerCode: r.provider_code as string,
        modelRef: (r.model_ref as string | null) ?? null,
        day: (r.day as string | null) ?? null,
        calls: r.calls as number,
        okCalls: r.ok_calls as number,
        errorCalls: r.error_calls as number,
        estimatedCalls: r.estimated_calls as number,
        tokensIn: r.tokens_in as string,
        tokensOut: r.tokens_out as string,
        credits: r.credits as string,
        // calls that cost nothing (errors) carry no currency; two currencies in one group cannot be added up, so the money is withheld
        costMinor: (r.currencies as number) > 1 ? null : (r.cost_minor as string),
        costCurrency:
          (r.currencies as number) > 1
            ? 'MIXED'
            : ((r.cost_currency as string | null)?.trim() ?? null),
        p50LatencyMs: r.p50 === null || r.p50 === undefined ? null : Number(r.p50),
        p95LatencyMs: r.p95 === null || r.p95 === undefined ? null : Number(r.p95),
      })),
    };
  }

  /**
   * Ask the provider which models its key can see and reconcile with what the adapter declares. A LIVE, read-only request (no prompt, nothing billed): refused unless
   * the owner has listed the provider in `AI_LIVE_PROVIDERS` (D3), never in production (D-12), and the adapter itself checks the gate again before the key is read.
   * A model the adapter does not declare is reported and never offered. The result is not capability evidence.
   */
  async discoverModels(actor: string, providerId: string): Promise<DiscoveryResult> {
    if (process.env.NODE_ENV === 'production')
      throw new ProblemException(
        'unsupported_capability',
        'model discovery is not available in this profile: the production vault is not decided yet (D-12)',
      );
    const { items } = await this.providers.list();
    const p = items.find((x) => x.id === providerId);
    if (!p) throw new ProblemException('not_found');
    const adapter = this.registry.get(p.code);
    if (!adapter?.discoverModels)
      throw new ProblemException('unsupported_capability', 'this provider has no model discovery');
    if (!this.cfg.liveProviders?.includes(p.code))
      throw new ProblemException(
        'unsupported_capability',
        "live calls to this provider are not approved in this environment yet (credentials, data terms and residency need the owner's approval, S-AG4)",
      );
    let found;
    try {
      found = await adapter.discoverModels({ callId: `discover:${p.code}:${Date.now()}` });
    } catch (e) {
      await this.audit.record({
        action: 'ai.provider.models_discovered',
        actorUserId: actor,
        actorType: 'user',
        resource: { type: 'model_provider', id: p.id },
        outcome: 'failure',
        detail: { code: p.code, error: (e as { code?: string }).code ?? 'error' },
      });
      throw new ProblemException(
        'service_unavailable',
        'the provider did not list its models (check the key and the live gate)',
      );
    }
    const rec = reconcileDiscovery(adapter.models(), found);
    await this.audit.record({
      action: 'ai.provider.models_discovered',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'model_provider', id: p.id },
      outcome: 'success',
      detail: {
        code: p.code,
        confirmed: rec.confirmed.length,
        unlistedByVendor: rec.unlistedByVendor.length,
        notDeclared: rec.notDeclared.length,
      },
    });
    return { providerCode: p.code, live: true, checkedAt: new Date().toISOString(), ...rec };
  }
}
