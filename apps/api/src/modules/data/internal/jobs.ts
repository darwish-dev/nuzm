import type { Db } from '@nuzm/platform';
import type { DatabaseFlow } from './database-flow';
import type { DatabaseService } from './database.service';
import type { DataMetering } from './metering';
import { DATA_OP_KINDS, type Row } from './model';

/** A periodic or background task of the data module (backups, retention, restore verification, ...). `run` returns how many things it did. */
export interface DataTask {
  name: string;
  run(now: Date): Promise<number>;
}

/**
 * Runs the data module's background work inside the API process (ADR-017): a request kicks its own operation right after answering 202, and
 * `DATA_SCHEDULER_INTERVAL_SECONDS` (> 0; off by default) starts a periodic tick that (1) re-runs due operations, (2) reconciles parked ones, and
 * (3) runs the registered tasks: scheduled backups, retention, restore verification, usage samplers. Claiming is atomic (`claimById`), so two processes
 * never run the same operation. Tests call `runOne`, `tick` and the tasks directly.
 */
export class DataJobs {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly tasks: DataTask[] = [];
  autoKick = process.env.DATA_KICK !== 'off';
  constructor(
    private readonly db: Db,
    private readonly flow: DatabaseFlow,
    private readonly databases: DatabaseService,
    private readonly metering: DataMetering,
  ) {
    this.databases.setKicker((o, id) => this.kick(o, id));
    this.tasks.push({ name: 'scheduled-backups', run: (n) => this.scheduledBackups(n) });
    this.tasks.push({ name: 'backup-retention', run: (n) => this.expireBackups(n) });
    this.tasks.push({
      name: 'usage-hourly',
      run: (n) => this.metering.sampleHour(new Date(n.getTime() - 3_600_000)),
    });
    this.tasks.push({
      name: 'usage-daily',
      run: (n) => this.metering.sampleDay(new Date(n.getTime() - 86_400_000)),
    });
  }
  static intervalFromEnv(env: NodeJS.ProcessEnv = process.env): number {
    const n = Number(env.DATA_SCHEDULER_INTERVAL_SECONDS ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  addTask(t: DataTask) {
    this.tasks.push(t);
  }
  start(seconds: number) {
    if (this.timer || seconds <= 0) return;
    this.timer = setInterval(
      () =>
        void this.tick().catch((e) =>
          process.stderr.write(JSON.stringify({ data_tick_error: (e as Error).message }) + '\n'),
        ),
      seconds * 1000,
    );
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  /** Fire-and-forget execution right after the API accepted the request. */
  kick(orgId: string, operationId: string) {
    if (!this.autoKick) return;
    setImmediate(
      () =>
        void this.flow
          .runOne(orgId, operationId)
          .catch((e) =>
            process.stderr.write(JSON.stringify({ data_op_error: (e as Error).message }) + '\n'),
          ),
    );
  }
  runOne(orgId: string, operationId: string) {
    return this.flow.runOne(orgId, operationId);
  }

  /**
   * Discovery goes through the module's OWN tables (operations are only listable per organization): rows that still wait for an operation to finish name
   * that operation. A pending/expired-lease operation is run; a parked (`needs_reconcile`) one is reconciled.
   */
  async tick(
    now = new Date(),
  ): Promise<{ ran: number; reconciled: number; tasks: Record<string, number> }> {
    if (this.busy) return { ran: 0, reconciled: 0, tasks: {} };
    this.busy = true;
    try {
      const open = await this.db.withPlatformScope(
        async (c) =>
          (
            await c.query(
              `SELECT org_id, operation_id FROM data.database_instances WHERE state IN ('provisioning','deleting','unknown') AND operation_id IS NOT NULL
               UNION SELECT org_id, operation_id FROM data.database_backups WHERE state = 'creating' AND operation_id IS NOT NULL
               UNION SELECT org_id, operation_id FROM data.storage_buckets WHERE state IN ('provisioning','deleting','unknown') AND operation_id IS NOT NULL
               UNION SELECT org_id, operation_id FROM data.database_restores WHERE state IN ('requested','running','needs_reconcile') AND operation_id IS NOT NULL
               LIMIT 200`,
            )
          ).rows as Row[],
      );
      let ran = 0;
      let reconciled = 0;
      for (const o of open) {
        const org = o.org_id as string;
        const id = o.operation_id as string;
        const op = await this.flow.ops.get(org, id);
        if (!op || !DATA_OP_KINDS.includes(op.kind)) continue;
        if (op.state === 'needs_reconcile') {
          if ((await this.flow.reconcile(org, id)) === 'resumed') reconciled++;
        } else if (op.state === 'pending' || op.state === 'running') {
          if (await this.flow.runOne(org, id)) ran++;
        }
      }
      const tasks: Record<string, number> = {};
      for (const t of this.tasks) {
        try {
          tasks[t.name] = await t.run(now);
        } catch (e) {
          tasks[t.name] = -1;
          process.stderr.write(
            JSON.stringify({ data_task_error: t.name, message: (e as Error).message }) + '\n',
          );
        }
      }
      return { ran, reconciled, tasks };
    } finally {
      this.busy = false;
    }
  }

  /** One scheduled backup per instance per interval bucket (deterministic key: a re-run in the same bucket writes nothing). */
  async scheduledBackups(now: Date): Promise<number> {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT * FROM data.database_instances WHERE state = 'running' AND engine <> 'redis' AND coalesce((backup_policy->>'enabled')::boolean, true) ORDER BY id`,
          )
        ).rows as Row[],
    );
    let n = 0;
    for (const r of rows) {
      const hours = Number((r.backup_policy as { intervalHours?: number }).intervalHours ?? 24);
      const bucket = Math.floor(now.getTime() / (hours * 3_600_000));
      const before = await this.db.withOrg(r.org_id as string, async (c) =>
        Number(
          (
            await c.query(`SELECT count(*) n FROM data.database_backups WHERE instance_id = $1`, [
              r.id,
            ])
          ).rows[0]!.n,
        ),
      );
      const b = await this.databases.enqueueBackup(
        r.org_id as string,
        null,
        r,
        'scheduled',
        `scheduled-${bucket}`,
      );
      const after = await this.db.withOrg(r.org_id as string, async (c) =>
        Number(
          (
            await c.query(`SELECT count(*) n FROM data.database_backups WHERE instance_id = $1`, [
              r.id,
            ])
          ).rows[0]!.n,
        ),
      );
      if (after > before) n++;
      void b;
    }
    return n;
  }
  /** Backups past `expires_at` become `expired` (retention is configuration: D-34). The artifact removal is the system bucket's lifecycle rule. */
  async expireBackups(now: Date): Promise<number> {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, org_id FROM data.database_backups WHERE state = 'available' AND expires_at IS NOT NULL AND expires_at < $1`,
            [now],
          )
        ).rows as Row[],
    );
    for (const r of rows)
      await this.db.withOrg(r.org_id as string, (c) =>
        c.query(
          `UPDATE data.database_backups SET state = 'expired' WHERE id = $1 AND state = 'available'`,
          [r.id],
        ),
      );
    return rows.length;
  }
}
