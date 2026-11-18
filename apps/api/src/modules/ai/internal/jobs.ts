import type { Db } from '@nuzm/platform';
import type { BudgetService } from './budget.service';
import type { RunService } from './run.service';

/** Runs the ai module's background work inside the API process (ADR-017): a request kicks its operation right after answering, `AI_SCHEDULER_INTERVAL_SECONDS` (> 0) starts a periodic tick. */
export class AiJobs {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  autoKick = process.env.AI_KICK !== 'off';
  private readonly extra: { name: string; run: () => Promise<number> }[] = [];
  constructor(
    private readonly db: Db,
    private readonly runs: RunService,
    private readonly budgets: BudgetService,
  ) {
    this.runs.setKicker((o, id) => this.kick(o, id));
  }
  static intervalFromEnv(env: NodeJS.ProcessEnv = process.env): number {
    const n = Number(env.AI_SCHEDULER_INTERVAL_SECONDS ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  addTask(name: string, run: () => Promise<number>) {
    this.extra.push({ name, run });
  }
  kick(orgId: string, operationId: string) {
    if (!this.autoKick) return;
    setImmediate(
      () =>
        void this.runs
          .runOne(orgId, operationId)
          .catch((e) =>
            process.stderr.write(JSON.stringify({ ai_run_error: (e as Error).message }) + '\n'),
          ),
    );
  }
  start(seconds: number) {
    if (this.timer || seconds <= 0) return;
    this.timer = setInterval(
      () =>
        void this.tick().catch((e) =>
          process.stderr.write(JSON.stringify({ ai_tick_error: (e as Error).message }) + '\n'),
        ),
      seconds * 1000,
    );
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  async tick(): Promise<Record<string, number>> {
    if (this.busy) return {};
    this.busy = true;
    try {
      const out: Record<string, number> = {};
      const t = await this.runs.tick();
      out.runs = t.ran;
      out.approvalsExpired = t.expired;
      out.reservationsSwept = await this.budgets.sweepExpired();
      for (const x of this.extra) out[x.name] = await x.run().catch(() => -1);
      void this.db;
      return out;
    } finally {
      this.busy = false;
    }
  }
}
