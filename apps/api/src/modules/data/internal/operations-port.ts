import { assertTransition } from '@nuzm/domain';
import { enqueue, type Db, type Operation, type OperationsService } from '@nuzm/platform';

/**
 * The operations API M08 relies on. The first block is the base `OperationsService`; the second block (`claimReconcile`, `releaseLease`,
 * `resumeFromReconcile`, `failPermanently`) is the extension M05 added in its own branch (assumptions doc U-05): here it is implemented over the
 * same tables with the same state machine so that M08 is testable alone. When M05 lands, `DataOperations` shrinks to a pass-through.
 */
export class DataOperations {
  constructor(
    readonly base: OperationsService,
    private readonly db: Db,
  ) {}
  create(orgId: string, n: Parameters<OperationsService['create']>[1]) {
    return this.base.create(orgId, n);
  }
  get(orgId: string, id: string) {
    return this.base.get(orgId, id);
  }
  claimById(orgId: string, id: string, worker: string) {
    return this.base.claimById(orgId, id, worker);
  }
  heartbeat(orgId: string, id: string, worker: string) {
    return this.base.heartbeat(orgId, id, worker);
  }
  succeed(orgId: string, id: string, worker: string, result: unknown) {
    return this.base.succeed(orgId, id, worker, result);
  }
  markNeedsReconcile(orgId: string, id: string, worker: string, reason: string) {
    return this.base.markNeedsReconcile(orgId, id, worker, reason);
  }
  fail(orgId: string, id: string, worker: string, error: unknown) {
    return this.base.fail(orgId, id, worker, error);
  }

  async claimReconcile(
    orgId: string,
    id: string,
    worker: string,
    leaseSeconds = 30,
  ): Promise<boolean> {
    return this.db.withOrg(orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT id FROM platform.operations WHERE id = $1 AND state = 'needs_reconcile' AND (lease_owner IS NULL OR lease_expires_at < now()) FOR UPDATE SKIP LOCKED`,
        [id],
      );
      if (!rows[0]) return false;
      await c.query(
        `UPDATE platform.operations SET lease_owner = $2, lease_expires_at = now() + make_interval(secs => $3), updated_at = now(), version = version + 1 WHERE id = $1`,
        [id, worker, leaseSeconds],
      );
      return true;
    });
  }
  async releaseLease(orgId: string, id: string, worker: string): Promise<void> {
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `UPDATE platform.operations SET lease_owner = NULL, lease_expires_at = NULL WHERE id = $1 AND lease_owner = $2 AND state = 'needs_reconcile'`,
        [id, worker],
      ),
    );
  }
  /** `needs_reconcile` → `running` under the SAME lease: the reconciler proved what happened and re-enters the workflow. */
  resumeFromReconcile(orgId: string, id: string, worker: string): Promise<Operation> {
    return this.move(
      orgId,
      id,
      worker,
      'running',
      `error=NULL, lease_expires_at=now()+make_interval(secs=>120)`,
      [],
    );
  }
  /** Terminal failure now: a DEFINITIVE outcome that a retry cannot change. */
  failPermanently(orgId: string, id: string, worker: string, error: unknown): Promise<Operation> {
    return this.move(
      orgId,
      id,
      worker,
      'failed',
      `error=$2, lease_owner=NULL, lease_expires_at=NULL`,
      [JSON.stringify(error ?? null)],
    );
  }
  private move(
    orgId: string,
    id: string,
    worker: string,
    to: 'running' | 'failed',
    set: string,
    params: unknown[],
  ): Promise<Operation> {
    return this.db.withOrg(orgId, async (c) => {
      const cur = (
        await c.query(`SELECT state, lease_owner FROM platform.operations WHERE id=$1 FOR UPDATE`, [
          id,
        ])
      ).rows[0] as
        { state: Parameters<typeof assertTransition>[0]; lease_owner: string | null } | undefined;
      if (!cur) throw new Error('operation not found');
      if (cur.lease_owner !== worker) throw new Error('lease_lost');
      assertTransition(cur.state, to);
      const upd = await c.query<Operation>(
        `UPDATE platform.operations SET ${set}, state=$${params.length + 2}, updated_at=now(), version=version+1 WHERE id=$1 RETURNING *`,
        [id, ...params, to],
      );
      await enqueue(c, orgId, 'operation.state_changed', { operationId: id, from: cur.state, to });
      return upd.rows[0]!;
    });
  }
}
