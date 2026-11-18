import type { Db, OperationsService } from '@nuzm/platform';
import type { OpCtx, SiteWorkflow } from './site-workflow';
import { HOSTING_OP_KINDS, KIND } from './sites.service';
import { Deferred, NeedsReconcile, PermanentError } from './steps';
import type { SslService } from './ssl.service';

export type Handler = (o: OpCtx) => Promise<Record<string, unknown>>;
type Claimed = { id: string; orgId: string; kind: string };

/**
 * Executes `hosting.*` operations and the periodic sweeps (certificate renewal, quotas, usage, abuse, metering: registered by the services that own them).
 * It runs inside the API process like the billing and compliance schedulers (ADR-017): a request kicks its own operation once, `HOSTING_SCHEDULER_INTERVAL_SECONDS`
 * (> 0) starts the periodic tick (off by default). Claiming is atomic (`claimById`); the cross-organization `claimDue` of the worker role recovers lost kicks.
 * Failure policy: NeedsReconcile parks the operation (`needs_reconcile`, never retried blind); PermanentError ends it at once; anything else retries with backoff.
 */
export class HostingJobs {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly handlers = new Map<string, Handler>();
  private readonly sweeps: { name: string; run: () => Promise<unknown> }[] = [];
  constructor(
    private readonly ops: OperationsService,
    private readonly db: Db,
    private readonly workflow: SiteWorkflow,
    private readonly ssl: SslService,
    private readonly claimOps: OperationsService | null = null,
    private readonly workerId = `api-hosting-${process.pid}`,
    private readonly kickEnabled = process.env.HOSTING_KICK !== 'off',
  ) {
    this.handlers.set(KIND.create, (o) => this.workflow.create(o));
    this.handlers.set(KIND.delete, (o) => this.workflow.deleteSite(o));
    this.handlers.set(KIND.domain, (o) => this.workflow.bindDomain(o));
    this.handlers.set(KIND.ssl, (o) => this.workflow.issueCertificate(o));
    this.sweeps.push({ name: 'ssl', run: () => this.ssl.sweep() });
  }
  static intervalFromEnv(env: NodeJS.ProcessEnv = process.env): number {
    const n = Number(env.HOSTING_SCHEDULER_INTERVAL_SECONDS ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  register(kind: string, h: Handler) {
    this.handlers.set(kind, h);
  }
  registerSweep(name: string, run: () => Promise<unknown>) {
    this.sweeps.push({ name, run });
  }

  async runDue(batch = 10): Promise<{ ran: number; failed: number; parked: number }> {
    const out = { ran: 0, failed: 0, parked: 0 };
    const claimed: Claimed[] = this.claimOps
      ? await this.claimOps.claimDue(this.workerId, { batch, kinds: HOSTING_OP_KINDS })
      : [];
    await this.execute(claimed, out);
    return out;
  }
  async runOne(orgId: string, operationId: string) {
    const out = { ran: 0, failed: 0, parked: 0 };
    const one = await this.ops.claimById(orgId, operationId, this.workerId);
    if (one) await this.execute([one], out);
    return out;
  }
  async runSweeps(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const s of this.sweeps)
      out[s.name] = await s.run().catch((e) => ({ error: (e as Error).message.slice(0, 200) }));
    return out;
  }

  private async execute(claimed: Claimed[], out: { ran: number; failed: number; parked: number }) {
    for (const c of claimed) {
      const handler = this.handlers.get(c.kind);
      try {
        const op = await this.ops.get(c.orgId, c.id);
        if (!op || !handler) throw new PermanentError(`no handler for ${c.kind}`);
        const result = await handler({
          orgId: c.orgId,
          operationId: c.id,
          input: (op.input ?? {}) as Record<string, unknown>,
          attempts: op.attempts,
        });
        await this.ops.succeed(c.orgId, c.id, this.workerId, result);
        out.ran++;
      } catch (e) {
        if (e instanceof Deferred) {
          out.parked++;
          await this.db
            .withOrg(c.orgId, (cl) =>
              cl.query(
                `UPDATE platform.operations SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL, next_run_at = $2, attempts = GREATEST(attempts - 1, 0), updated_at = now(), version = version + 1 WHERE id = $1 AND lease_owner = $3`,
                [c.id, e.until, this.workerId],
              ),
            )
            .catch(() => undefined);
          continue;
        }
        if (e instanceof NeedsReconcile) {
          out.parked++;
          await this.ops
            .markNeedsReconcile(c.orgId, c.id, this.workerId, e.message.slice(0, 200))
            .catch(() => undefined);
          continue;
        }
        out.failed++;
        const message = (e as Error).message.slice(0, 300);
        const permanent = e instanceof PermanentError;
        if (permanent)
          await this.db
            .withOrg(c.orgId, (cl) =>
              cl.query(`UPDATE platform.operations SET max_attempts = attempts WHERE id = $1`, [
                c.id,
              ]),
            )
            .catch(() => undefined);
        const failed = await this.ops
          .fail(c.orgId, c.id, this.workerId, {
            message,
            code: permanent ? (e as PermanentError).code : 'error',
          })
          .catch(() => null);
        if (failed?.state === 'failed' && c.kind === KIND.create) {
          const op = await this.ops.get(c.orgId, c.id);
          await this.workflow
            .createFailed(c.orgId, (op!.input as { siteId: string }).siteId, message)
            .catch(() => undefined);
        }
      }
    }
  }

  kick(orgId: string, operationId: string) {
    if (!this.kickEnabled) return;
    setImmediate(() => void this.runOne(orgId, operationId).catch(() => undefined));
  }
  start(intervalSeconds: number) {
    if (this.timer || intervalSeconds <= 0) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.runDue()
        .then(() => this.runSweeps())
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
