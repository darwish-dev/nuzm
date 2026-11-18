import type { Db } from '@nuzm/platform';
import type { SsoConnectionService } from '../enterprise';
import type { AlertService } from './alerts.service';
import type { MetricsService } from './metrics.service';
import { httpProbe, type Probe, type ProbeRunner } from './probes.service';
import type { TechnicalReconciliationService } from './technical-reconciliation.service';

/**
 * Periodic M12 jobs in the API process, the same pattern and the same caveat as ADR-017 (billing scheduler): SSO domain proofs, probes, alert evaluation and
 * the technical reconciliations. Off by default (`OPS_SCHEDULER_INTERVAL_SECONDS=0`). A step that fails does not stop the others; every step is idempotent.
 * TR runs happen at most once per `OPS_TR_EVERY_HOURS` (default 24). The financial RC runs are scheduled by finrec (billing scheduler), not here.
 */
export class OpsScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastTr = 0;

  constructor(
    private readonly db: Db,
    private readonly sso: Pick<SsoConnectionService, 'verifyPendingDomains'>,
    private readonly probes: Pick<ProbeRunner, 'runAll'>,
    private readonly metrics: Pick<MetricsService, 'collect'>,
    private readonly alerts: Pick<AlertService, 'evaluate'>,
    private readonly tr: Pick<TechnicalReconciliationService, 'runAll'>,
    private readonly probeList: () => Probe[] = () => defaultProbes(),
    private readonly log: (m: string, extra?: Record<string, unknown>) => void = (m, extra) =>
      console.log(JSON.stringify({ ops_scheduler: m, ...extra })),
  ) {}

  static intervalFromEnv(env: NodeJS.ProcessEnv = process.env): number {
    const n = Number(env.OPS_SCHEDULER_INTERVAL_SECONDS ?? 0);
    if (!Number.isFinite(n) || n < 0)
      throw new Error('OPS_SCHEDULER_INTERVAL_SECONDS must be >= 0');
    return n === 0 ? 0 : Math.max(5, Math.floor(n));
  }

  async tick(now = new Date()): Promise<Record<string, unknown> | null> {
    // No advisory lock: every step is idempotent (SSO proofs are claimed under a unique index, TR rows are append-only per run, alert evaluation is state-based), so two instances ticking at once only duplicate work.
    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | { error: string }> => {
      try {
        return await fn();
      } catch (e) {
        this.log('step_failed', { step: name, error: (e as Error).message.slice(0, 200) });
        return { error: (e as Error).message.slice(0, 200) };
      }
    };
    const out: Record<string, unknown> = {};
    out.ssoDomains = await step('sso_domains', () => this.sso.verifyPendingDomains());
    out.probes = await step('probes', async () => this.probes.runAll(this.probeList()));
    out.alerts = await step('alerts', async () =>
      this.alerts.evaluate(await this.metrics.collect(), now),
    );
    if (now.getTime() - this.lastTr >= Number(process.env.OPS_TR_EVERY_HOURS ?? 24) * 3_600_000) {
      out.tr = await step('tr', async () =>
        (await this.tr.runAll(null)).map((r) => ({
          type: r.type,
          findings: r.findings.length,
          mode: r.mode,
        })),
      );
      this.lastTr = now.getTime();
    }
    return out;
  }

  start(everySeconds: number): void {
    if (this.timer || everySeconds <= 0) return;
    const run = async () => {
      if (this.running) return;
      this.running = true;
      try {
        this.log('tick', (await this.tick()) ?? {});
      } catch (e) {
        this.log('tick_failed', { error: (e as Error).message.slice(0, 200) });
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => void run(), everySeconds * 1000);
    this.timer.unref();
    this.log('started', { everySeconds });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Probes that need no credentials. The others (quote, provisioning-mock, payment-sandbox, DNS change) are registered by the environment that owns the credentials. */
export function defaultProbes(env: NodeJS.ProcessEnv = process.env): Probe[] {
  const base = env.OPS_PROBE_BASE_URL;
  if (!base) return [];
  const mode =
    env.OPS_PROBE_MODE === 'live'
      ? 'live'
      : env.OPS_PROBE_MODE === 'sandbox'
        ? 'sandbox'
        : 'fixture';
  return [httpProbe('login', `${base.replace(/\/$/, '')}/v1/auth/oidc/login`, [302], mode)];
}
