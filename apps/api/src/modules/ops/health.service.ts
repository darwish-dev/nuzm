import type { Db } from '@nuzm/platform';
import type { MetricsService } from './metrics.service';

export interface HealthReport {
  generatedAt: string;
  status: 'ok' | 'degraded' | 'down';
  components: {
    key: string;
    status: 'ok' | 'degraded' | 'down' | 'unknown';
    detail: Record<string, unknown>;
  }[];
  queues: { outboxLagSeconds: number; operationsByState: Record<string, number> };
  reconcilers: {
    financialLastRunAt: string | null;
    technicalLastRunAt: string | null;
    openFinancialBreaks: number;
  };
  providers: { openIncidents: number };
  probes: { key: string; ok: boolean; mode: string; ranAt: string }[];
  sloBurn: {
    sloKey: string;
    objective: number;
    unit: string;
    measured: number | null;
    status: 'within' | 'burning' | 'not_measured';
    basis: string;
  }[];
  alerts: { firing: number; acknowledged: number; silenced: number };
}

/** GET /v1/admin/operations/health. Anything that is not measured is reported as `unknown` / `not_measured`, never as healthy. Probe fixtures never count as availability. */
export class HealthService {
  constructor(
    private readonly db: Db,
    private readonly metrics: MetricsService,
  ) {}

  async report(): Promise<HealthReport> {
    const t0 = Date.now();
    const m = await this.metrics.collect();
    const dbMs = Date.now() - t0;
    const ops = await this.db.withWorkerClaim(
      async (c) =>
        (
          await c.query<{ state: string; n: number }>(
            `SELECT state, count(*)::int AS n FROM platform.operations GROUP BY state`,
          )
        ).rows,
    );
    const out = await this.db.withPlatformScope(async (c) => {
      const fin = (
        await c.query<{ t: Date | null }>(
          `SELECT max(completed_at) AS t FROM finrec.reconciliation_runs WHERE status = 'completed'`,
        )
      ).rows[0]!.t;
      const tech = (
        await c.query<{ t: Date | null }>(
          `SELECT max(run_at) AS t FROM cloud.resource_reconciliations`,
        )
      ).rows[0]!.t;
      const probes = (
        await c.query<{ probe_key: string; ok: boolean; mode: string; ran_at: Date }>(
          `SELECT DISTINCT ON (probe_key) probe_key, ok, mode, ran_at FROM ops.probe_runs ORDER BY probe_key, ran_at DESC`,
        )
      ).rows;
      const alerts = (
        await c.query<{ state: string; n: number }>(
          `SELECT state, count(*)::int AS n FROM ops.alerts GROUP BY state`,
        )
      ).rows;
      const slos = (
        await c.query<{
          slo_key: string;
          objective: string;
          unit: string;
          basis: string;
          window_days: number;
        }>(
          `SELECT slo_key, objective, unit, basis, window_days FROM ops.slo_definitions WHERE slo_key = 'api.availability'`,
        )
      ).rows;
      const avail = (
        await c.query<{ ok: number; total: number }>(
          `SELECT count(*) FILTER (WHERE ok)::int AS ok, count(*)::int AS total FROM ops.probe_runs WHERE mode <> 'fixture' AND probe_key = 'login' AND ran_at > now() - interval '30 days'`,
        )
      ).rows[0]!;
      return { fin, tech, probes, alerts, slos, avail };
    });
    const lag = m['queue.max_lag_seconds'] ?? 0;
    const components: HealthReport['components'] = [
      { key: 'database', status: dbMs < 2000 ? 'ok' : 'degraded', detail: { roundTripMs: dbMs } },
      { key: 'outbox', status: lag > 300 ? 'degraded' : 'ok', detail: { lagSeconds: lag } },
      {
        key: 'reconciliation',
        status: (m['reconciliation.hours_since_last_run'] ?? 9999) > 26 ? 'degraded' : 'ok',
        detail: { hoursSinceLastRun: m['reconciliation.hours_since_last_run'] },
      },
      {
        key: 'probes',
        status:
          out.probes.length === 0 ? 'unknown' : out.probes.every((p) => p.ok) ? 'ok' : 'degraded',
        detail: { configured: out.probes.length },
      },
    ];
    const status = components.some((c) => c.status === 'down')
      ? 'down'
      : components.some((c) => c.status === 'degraded')
        ? 'degraded'
        : 'ok';
    const cnt = (s: string) => out.alerts.find((a) => a.state === s)?.n ?? 0;
    return {
      generatedAt: new Date().toISOString(),
      status,
      components,
      queues: {
        outboxLagSeconds: lag,
        operationsByState: Object.fromEntries(ops.map((o) => [o.state, o.n])),
      },
      reconcilers: {
        financialLastRunAt: out.fin?.toISOString() ?? null,
        technicalLastRunAt: out.tech?.toISOString() ?? null,
        openFinancialBreaks: m['reconciliation.open_breaks'] ?? 0,
      },
      providers: { openIncidents: m['provider.open_incidents'] ?? 0 },
      probes: out.probes.map((p) => ({
        key: p.probe_key,
        ok: p.ok,
        mode: p.mode,
        ranAt: p.ran_at.toISOString(),
      })),
      sloBurn: out.slos.map((s) => {
        const measured =
          out.avail.total > 0 ? Math.round((out.avail.ok / out.avail.total) * 10_000) / 100 : null;
        return {
          sloKey: s.slo_key,
          objective: Number(s.objective),
          unit: s.unit,
          measured,
          status:
            measured === null
              ? 'not_measured'
              : measured >= Number(s.objective)
                ? 'within'
                : 'burning',
          basis:
            'login probe runs in sandbox/live mode over 30 days (an approximation of availability; request-level SLI is NOT VERIFIED)',
        };
      }),
      alerts: {
        firing: cnt('firing'),
        acknowledged: cnt('acknowledged'),
        silenced: cnt('silenced'),
      },
    };
  }
}
