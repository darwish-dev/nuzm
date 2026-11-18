import type { Db } from '@nuzm/platform';
import type { Metrics } from './alerts.service';

/**
 * Metrics the alert rules read. Only what the database can answer is computed here; `api.error_rate_5m` comes from the telemetry pipeline and
 * `zatca.oldest_pending_hours` from the e-invoicing queue: until those feeds are wired the metric is ABSENT and its rule is NOT EVALUATED (never "ok").
 */
export class MetricsService {
  constructor(private readonly db: Db) {}

  async collect(): Promise<Metrics> {
    const m: Metrics = {};
    await this.db.withWorkerClaim(async (c) => {
      const lag = await c.query<{ s: string | null }>(
        `SELECT extract(epoch FROM now() - min(created_at)) AS s FROM platform.outbox WHERE published_at IS NULL`,
      );
      m['queue.max_lag_seconds'] = Math.round(Number(lag.rows[0]?.s ?? 0));
    });
    await this.db.withPlatformScope(async (c) => {
      const rec = await c.query<{ h: string | null }>(
        `SELECT extract(epoch FROM now() - max(created_at)) / 3600 AS h FROM finrec.reconciliation_runs`,
      );
      m['reconciliation.hours_since_last_run'] =
        rec.rows[0]?.h === null || rec.rows[0]?.h === undefined
          ? 9999
          : Math.round(Number(rec.rows[0].h) * 10) / 10;
      m['reconciliation.open_breaks'] = Number(
        (
          await c.query(
            `SELECT count(*)::int AS n FROM finrec.reconciliation_items WHERE status <> 'resolved'`,
          )
        ).rows[0]!.n,
      );
      m['provider.open_incidents'] = Number(
        (
          await c.query(
            `SELECT count(*)::int AS n FROM ops.provider_incidents WHERE status <> 'resolved'`,
          )
        ).rows[0]!.n,
      );
      const dr = await c.query<{ d: string | null }>(
        `SELECT extract(epoch FROM now() - max(restored_at)) / 86400 AS d FROM ops.recovery_exercises WHERE scope = 'control_plane_db' AND environment <> 'local'`,
      );
      m['dr.days_since_exercise'] =
        dr.rows[0]?.d === null || dr.rows[0]?.d === undefined
          ? 9999
          : Math.round(Number(dr.rows[0].d));
      const probes = await c.query<{ probe_key: string; ok: boolean }>(
        `SELECT probe_key, ok FROM (SELECT probe_key, ok, row_number() OVER (PARTITION BY probe_key ORDER BY ran_at DESC) rn FROM ops.probe_runs WHERE mode <> 'fixture') x WHERE rn <= 5 ORDER BY probe_key, rn`,
      );
      const byKey = new Map<string, boolean[]>();
      for (const r of probes.rows)
        byKey.set(r.probe_key, [...(byKey.get(r.probe_key) ?? []), r.ok]);
      if (byKey.size) {
        let worst = 0;
        for (const oks of byKey.values()) {
          let n = 0;
          for (const ok of oks) {
            if (ok) break;
            n++;
          }
          worst = Math.max(worst, n);
        }
        m['probe.consecutive_failures'] = worst;
      }
    });
    return m;
  }
}
