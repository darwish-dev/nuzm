import type { OperationsService, Db } from '@nuzm/platform';
import type { AbuseService } from './abuse.service';
import type { ExecutionEngine } from './engine';
import type { ExecutionService } from './execution.service';
import type { Row } from './model';
import type { TriggerService } from './trigger.service';
import type { WebhookEndpointService } from './webhook-endpoint.service';

/**
 * Background work of the automation module inside the API process (ADR-017): `AUTOMATION_SCHEDULER_INTERVAL_SECONDS` (> 0; off by default) starts a tick that
 * fires due schedules, attaches operations to `queued` executions that lost theirs, runs what is runnable (pending, due, or whose lease expired: a dead worker), settles
 * executions whose operation was cancelled through `/v1/operations/{id}/cancellation`, dispatches due webhook deliveries, and evaluates the abuse rules. Tests call `tick` directly.
 */
export class AutomationJobs {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  autoKick = process.env.AUTOMATION_KICK !== 'off';
  constructor(
    private readonly db: Db,
    private readonly ops: OperationsService,
    private readonly engine: ExecutionEngine,
    private readonly executions: ExecutionService,
    private readonly triggers: TriggerService,
    private readonly webhooks: WebhookEndpointService,
    private readonly abuse: AbuseService,
  ) {}
  static intervalFromEnv(env: NodeJS.ProcessEnv = process.env): number {
    const n = Number(env.AUTOMATION_SCHEDULER_INTERVAL_SECONDS ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  start(seconds: number) {
    if (this.timer || seconds <= 0) return;
    this.timer = setInterval(() => void this.tick().catch((e) => process.stderr.write(JSON.stringify({ automation_tick_error: (e as Error).message }) + '\n')), seconds * 1000);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  /** Fire-and-forget run right after the API accepted a manual execution. */
  kick(orgId: string, executionId: string) {
    if (!this.autoKick) return;
    setImmediate(() => void this.engine.runOne(orgId, executionId).catch((e) => process.stderr.write(JSON.stringify({ automation_run_error: (e as Error).message }) + '\n')));
  }

  async tick(): Promise<{ scheduled: number; attached: number; ran: number; settled: number; deliveries: number; paused: number }> {
    if (this.busy) return { scheduled: 0, attached: 0, ran: 0, settled: 0, deliveries: 0, paused: 0 };
    this.busy = true;
    try {
      const scheduled = await this.triggers.fireSchedules();
      const open = await this.db.withPlatformScope(async (c) =>
        (await c.query(`SELECT id, org_id, operation_id, status FROM automation.executions WHERE status IN ('queued','running','waiting') ORDER BY created_at LIMIT 200`)).rows as Row[],
      );
      let attached = 0;
      let ran = 0;
      let settled = 0;
      for (const e of open) {
        if (!e.operation_id) {
          await this.executions.ensureOperation(e.org_id, e.id);
          attached++;
        }
        const op = await this.ops.get(e.org_id, e.operation_id ?? (await this.executions.ensureOperation(e.org_id, e.id)));
        if (!op) continue;
        if (op.state === 'cancelled') {
          await this.db.withOrg(e.org_id, (c) => c.query(`UPDATE automation.executions SET status = 'cancelled', finished_at = now(), error = '{"code":"cancelled"}' WHERE id = $1 AND status NOT IN ('succeeded','failed','cancelled')`, [e.id]));
          settled++;
        } else if (op.state === 'pending' || op.state === 'running') {
          const r = await this.engine.runOne(e.org_id, e.id);
          if (r !== 'not_claimed') ran++;
        }
      }
      const deliveries = (await this.webhooks.dispatchDue()).delivered;
      const paused = (await this.abuse.checkSpikes()) + (await this.abuse.check4xx());
      return { scheduled, attached, ran, settled, deliveries, paused };
    } finally {
      this.busy = false;
    }
  }
}
