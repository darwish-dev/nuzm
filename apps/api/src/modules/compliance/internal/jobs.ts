import type { Db, OperationsService } from '@nuzm/platform';
import { DSR_KIND, type DsrService } from './dsr/dsr.service';
import { EXPORT_KIND, type ExportService } from './exports/export.service';

/**
 * Executes compliance operations (`compliance.dsr`, `compliance.data_export`) and runs the SLA sweep. It runs inside the API process like the billing
 * scheduler (ADR-017): a request kicks its own operation once after it is made, and `DSR_SCHEDULER_INTERVAL_SECONDS` (> 0) starts a periodic tick (off by
 * default). Claiming is atomic (`claimById`: a single conditional UPDATE under the organization's scope), so a second process never runs the same operation.
 * The periodic tick finds work two ways: open data-subject requests (read under the admin scope from `compliance.dsr_requests`) and, when
 * `WORKER_DATABASE_URL` is configured, the cross-organization `claimDue` of the worker role for any compliance operation (this is what recovers an export
 * whose kick was lost). Without that URL a lost export kick is recovered by requesting it again (same Idempotency-Key replays it).
 */
export class ComplianceJobs {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(
    private readonly ops: OperationsService,
    private readonly dsr: DsrService,
    private readonly exports: ExportService,
    private readonly db: Db,
    /** The worker-role operations service for cross-organization discovery, or null. */
    private readonly claimOps: OperationsService | null = null,
    private readonly workerId = `api-compliance-${process.pid}`,
    private readonly kickEnabled = process.env.DSR_KICK !== 'off',
  ) {}

  static intervalFromEnv(env: NodeJS.ProcessEnv = process.env): number {
    const n = Number(env.DSR_SCHEDULER_INTERVAL_SECONDS ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** Find and run what is due. */
  async runDue(batch = 10): Promise<{ dsr: number; exports: number; failed: number }> {
    const out = { dsr: 0, exports: 0, failed: 0 };
    const claimed: Claimed[] = [];
    if (this.claimOps)
      claimed.push(
        ...(await this.claimOps.claimDue(this.workerId, { batch, kinds: [DSR_KIND, EXPORT_KIND] })),
      );
    const open = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT org_id, operation_id FROM compliance.dsr_requests WHERE closed_at IS NULL AND operation_id IS NOT NULL ORDER BY due_at LIMIT $1`,
            [batch],
          )
        ).rows as { org_id: string; operation_id: string }[],
    );
    for (const r of open) {
      if (claimed.some((x) => x.id === r.operation_id)) continue;
      const one = await this.ops.claimById(r.org_id, r.operation_id, this.workerId);
      if (one) claimed.push(one);
    }
    await this.execute(claimed, out);
    return out;
  }

  /** Run one known operation (the request that created it knows its id). */
  async runOne(orgId: string, operationId: string) {
    const out = { dsr: 0, exports: 0, failed: 0 };
    const one = await this.ops.claimById(orgId, operationId, this.workerId);
    if (one) await this.execute([one], out);
    return out;
  }

  private async execute(claimed: Claimed[], out: { dsr: number; exports: number; failed: number }) {
    for (const c of claimed) {
      try {
        const op = await this.ops.get(c.orgId, c.id);
        if (!op) continue;
        if (c.kind === DSR_KIND) {
          const status = await this.dsr.process(
            c.orgId,
            (op.input as { requestId: string }).requestId,
          );
          await this.ops.succeed(c.orgId, c.id, this.workerId, { status });
          out.dsr++;
        } else {
          const result = await this.exports.build({
            orgId: c.orgId,
            id: c.id,
            input: op.input as { scope: 'org' | 'user'; subjectRef: string | null },
          });
          await this.ops.succeed(c.orgId, c.id, this.workerId, result);
          out.exports++;
        }
      } catch (e) {
        out.failed++;
        await this.ops
          .fail(c.orgId, c.id, this.workerId, { message: (e as Error).message.slice(0, 300) })
          .catch(() => undefined);
      }
    }
  }

  /** One run shortly after a request is made (no wait for the next tick). */
  kick(target?: { orgId: string; operationId: string | null }) {
    if (!this.kickEnabled) return;
    setImmediate(
      () =>
        void (
          target?.operationId ? this.runOne(target.orgId, target.operationId) : this.runDue()
        ).catch(() => undefined),
    );
  }

  start(intervalSeconds: number) {
    if (this.timer || intervalSeconds <= 0) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.runDue()
        .then(() => this.dsr.sweep())
        .catch(() => undefined)
        .finally(() => (this.running = false));
    }, intervalSeconds * 1000);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
export type { Db };
type Claimed = { id: string; orgId: string; kind: string };
