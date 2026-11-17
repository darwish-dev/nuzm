import type { Db } from '@nuzm/platform';
import type { DunningRunResult, DunningService, SubscriptionService } from '../billing';
import type { PaymentService, RefundService } from '../payments';

/** Arbitrary but fixed: only one instance runs a billing tick at a time (everything is idempotent anyway; the lock avoids wasted work). */
export const BILLING_SCHEDULER_LOCK = 7300002;

export interface TickResult {
  subscriptions: { renewed: number; settled: number; failed: number } | { error: string };
  dunning: DunningRunResult | { error: string };
  paymentEvents: number | { error: string };
  refunds: number | { error: string };
}

/**
 * The periodic billing jobs (ADR-017, proposed): renew subscriptions, run dunning, process stored-but-unprocessed PSP events, re-check pending
 * refunds. A step that fails does not stop the others. Every step is idempotent and safe to repeat, so a missed tick or two ticks at once cannot
 * double-charge or double-notify; the advisory lock only avoids doing the same work twice.
 */
export class BillingScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly subs: Pick<SubscriptionService, 'runDue'>,
    private readonly dunning: Pick<DunningService, 'run'>,
    private readonly payments: Pick<PaymentService, 'processPending'>,
    private readonly refunds: Pick<RefundService, 'processPending'>,
    private readonly log: (m: string, extra?: Record<string, unknown>) => void = (m, extra) =>
      console.log(JSON.stringify({ scheduler: m, ...extra })),
  ) {}

  static intervalFromEnv(env: NodeJS.ProcessEnv = process.env): number {
    const n = Number(env.BILLING_SCHEDULER_INTERVAL_SECONDS ?? 0);
    if (!Number.isFinite(n) || n < 0)
      throw new Error('BILLING_SCHEDULER_INTERVAL_SECONDS must be >= 0');
    return n === 0 ? 0 : Math.max(5, Math.floor(n));
  }

  /** One pass of all jobs. Returns null when another instance holds the lock (nothing was done). */
  async tick(now = new Date()): Promise<TickResult | null> {
    return this.db.withoutScope(async (c) => {
      const got = (
        await c.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock($1) AS ok`, [
          BILLING_SCHEDULER_LOCK,
        ])
      ).rows[0]!.ok;
      if (!got) return null;
      const step = async <T>(
        name: string,
        fn: () => Promise<T>,
      ): Promise<T | { error: string }> => {
        try {
          return await fn();
        } catch (e) {
          this.log('step_failed', { step: name, error: (e as Error).message.slice(0, 200) });
          return { error: (e as Error).message.slice(0, 200) };
        }
      };
      const subscriptions = await step('subscriptions', () => this.subs.runDue(now));
      const dunning = await step('dunning', () => this.dunning.run(now));
      const paymentEvents = await step('payment_events', () =>
        this.payments.processPending(50, now),
      );
      const refunds = await step('refunds', () => this.refunds.processPending(50, 30, now));
      return { subscriptions, dunning, paymentEvents, refunds };
    });
  }

  start(everySeconds: number): void {
    if (this.timer || everySeconds <= 0) return;
    const run = async () => {
      if (this.running) return;
      this.running = true;
      try {
        const r = await this.tick();
        if (r) this.log('tick', { ...r });
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
