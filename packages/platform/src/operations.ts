import type { PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import {
  DEFAULT_RETRY,
  assertTransition,
  backoffSeconds,
  isCancellable,
  isTerminal,
  shouldRetry,
  type OperationState,
  type RetryPolicy,
} from '@nuzm/domain';
import type { Db } from './db';
import { PlatformError } from './errors';
import { enqueue } from './outbox';

export interface Operation {
  id: string;
  org_id: string;
  kind: string;
  state: OperationState;
  resource_kind: string | null;
  resource_id: string | null;
  input: unknown;
  result: unknown;
  error: unknown;
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  cancel_requested: boolean;
  trace_id: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface NewOperation {
  /** Pre-assigned id (M05: the idempotency token of a provider call is derived from the operation id, so it must exist before the row does). */
  id?: string;
  kind: string;
  input?: unknown;
  resourceKind?: string;
  resourceId?: string;
  createdBy?: string;
  traceId?: string;
  idempotencyKey?: string;
  maxAttempts?: number;
}

export interface ClaimedOperation {
  id: string;
  orgId: string;
  kind: string;
  previousState: OperationState;
  attempts: number;
}

const COLS = `id, org_id, kind, state, resource_kind, resource_id, input, result, error, attempts, max_attempts,
  next_run_at, lease_owner, lease_expires_at, cancel_requested, trace_id, created_at, updated_at, version`;

/** Durable operations: lease-based claiming, retry with backoff, cancellation, reconcile hand-off. */
export class OperationsService {
  constructor(
    private readonly db: Db,
    private readonly retry: RetryPolicy = DEFAULT_RETRY,
  ) {}

  async create(orgId: string, n: NewOperation): Promise<Operation> {
    return this.db.withOrg(orgId, async (c) => {
      const id = n.id ?? uuidv7();
      const { rows } = await c.query<Operation>(
        `INSERT INTO platform.operations (id, org_id, kind, input, resource_kind, resource_id, created_by, trace_id, idempotency_key, max_attempts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${COLS}`,
        [
          id,
          orgId,
          n.kind,
          JSON.stringify(n.input ?? {}),
          n.resourceKind ?? null,
          n.resourceId ?? null,
          n.createdBy ?? null,
          n.traceId ?? null,
          n.idempotencyKey ?? null,
          n.maxAttempts ?? this.retry.maxAttempts,
        ],
      );
      await enqueue(c, orgId, 'operation.created', { operationId: id, kind: n.kind });
      return rows[0]!;
    });
  }

  /** Returns null for an operation of another org (RLS hides it): callers answer 404, never 403. */
  async get(orgId: string, id: string): Promise<Operation | null> {
    return this.db.withOrg(orgId, async (c) => {
      const { rows } = await c.query<Operation>(
        `SELECT ${COLS} FROM platform.operations WHERE id = $1`,
        [id],
      );
      return rows[0] ?? null;
    });
  }

  async list(orgId: string, opts: { limit?: number; before?: string } = {}): Promise<Operation[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    return this.db.withOrg(orgId, async (c) => {
      const { rows } = await c.query<Operation>(
        `SELECT ${COLS} FROM platform.operations WHERE ($2::uuid IS NULL OR id < $2) ORDER BY id DESC LIMIT $1`,
        [limit, opts.before ?? null],
      );
      return rows;
    });
  }

  async steps(
    orgId: string,
    id: string,
  ): Promise<
    {
      seq: number;
      name: string;
      state: string;
      startedAt: string | null;
      finishedAt: string | null;
    }[]
  > {
    return this.db.withOrg(orgId, async (c) =>
      (
        await c.query(
          `SELECT seq, name, state, started_at, finished_at FROM platform.operation_steps WHERE operation_id=$1 ORDER BY seq`,
          [id],
        )
      ).rows.map((r) => ({
        seq: r.seq,
        name: r.name,
        state: r.state,
        startedAt: r.started_at?.toISOString() ?? null,
        finishedAt: r.finished_at?.toISOString() ?? null,
      })),
    );
  }

  /**
   * Claim due operations across orgs under the audited claim scope. Reclaims expired leases: a
   * `waiting_provider` operation whose worker vanished becomes `needs_reconcile` (the provider-side
   * outcome is unknown, so the reconciler must look before anything is retried).
   */
  async claimDue(
    workerId: string,
    opts: {
      batch?: number;
      leaseSeconds?: number;
      kinds?: readonly string[];
      onlyPending?: boolean;
    } = {},
  ): Promise<ClaimedOperation[]> {
    const batch = opts.batch ?? 10;
    const lease = opts.leaseSeconds ?? 60;
    return this.db.withWorkerClaim(async (c) => {
      const { rows } = await c.query<{
        id: string;
        org_id: string;
        kind: string;
        state: OperationState;
        attempts: number;
        cancel_requested: boolean;
      }>(
        `SELECT id, org_id, kind, state, attempts, cancel_requested FROM platform.operations
          WHERE next_run_at <= now()
            AND ( state = 'pending'
               OR (state IN ('running','waiting_provider','needs_reconcile') AND (lease_expires_at IS NULL OR lease_expires_at < now())) )
            AND ($2::text[] IS NULL OR kind = ANY($2::text[]))
            AND (NOT $3::boolean OR state = 'pending')
          ORDER BY next_run_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [batch, opts.kinds ? [...opts.kinds] : null, opts.onlyPending === true],
      );
      const claimed: ClaimedOperation[] = [];
      for (const r of rows) {
        if (r.cancel_requested) {
          assertTransition(r.state, 'cancelled');
          await c.query(
            `UPDATE platform.operations SET state='cancelled', lease_owner=NULL, lease_expires_at=NULL, updated_at=now(), version=version+1 WHERE id=$1`,
            [r.id],
          );
          await enqueue(c, r.org_id, 'operation.state_changed', {
            operationId: r.id,
            from: r.state,
            to: 'cancelled',
          });
          continue;
        }
        const next: OperationState =
          r.state === 'waiting_provider'
            ? 'needs_reconcile'
            : r.state === 'needs_reconcile'
              ? 'needs_reconcile'
              : 'running';
        if (r.state !== next) assertTransition(r.state, next);
        await c.query(
          `UPDATE platform.operations
              SET state=$2, attempts=attempts+1, lease_owner=$3, lease_expires_at=now()+make_interval(secs=>$4),
                  updated_at=now(), version=version+1
            WHERE id=$1`,
          [r.id, next, workerId, lease],
        );
        await enqueue(c, r.org_id, 'operation.state_changed', {
          operationId: r.id,
          from: r.state,
          to: next,
        });
        claimed.push({
          id: r.id,
          orgId: r.org_id,
          kind: r.kind,
          previousState: r.state,
          attempts: r.attempts + 1,
        });
      }
      return claimed;
    });
  }

  /**
   * Claim ONE known operation under its organization's scope (no cross-organization role needed): `pending`, or `running` with an expired lease, becomes
   * `running` with a lease. Returns null when it is not claimable (finished, leased by another worker, cancelled or not due). Used by in-process
   * executors that already know the id (compliance requests, ADR-017); the cross-organization `claimDue` stays with the worker role.
   */
  async claimById(
    orgId: string,
    id: string,
    workerId: string,
    opts: { leaseSeconds?: number } = {},
  ): Promise<ClaimedOperation | null> {
    const lease = opts.leaseSeconds ?? 60;
    return this.db.withOrg(orgId, async (c) => {
      const { rows } = await c.query<{
        id: string;
        org_id: string;
        kind: string;
        state: OperationState;
        attempts: number;
      }>(
        `UPDATE platform.operations
            SET state='running', attempts=attempts+1, lease_owner=$2, lease_expires_at=now()+make_interval(secs=>$3), updated_at=now(), version=version+1
          WHERE id=$1 AND next_run_at <= now() AND cancel_requested = false
            AND (state='pending' OR (state='running' AND (lease_expires_at IS NULL OR lease_expires_at < now())))
        RETURNING id, org_id, kind, attempts, (SELECT state FROM platform.operations o WHERE o.id=$1) AS state`,
        [id, workerId, lease],
      );
      const r = rows[0];
      if (!r) return null;
      await enqueue(c, orgId, 'operation.state_changed', {
        operationId: id,
        from: r.state,
        to: 'running',
      });
      return {
        id: r.id,
        orgId: r.org_id,
        kind: r.kind,
        previousState: r.state,
        attempts: r.attempts,
      };
    });
  }

  /**
   * Take the lease of ONE `needs_reconcile` operation for the reconciler (no state change, no attempt counted: an observation is not an execution).
   * Returns false when it is not parked for reconciliation or another worker holds a live lease.
   */
  async claimReconcile(
    orgId: string,
    id: string,
    workerId: string,
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
        [id, workerId, leaseSeconds],
      );
      return true;
    });
  }

  /** Give the lease of a still-`needs_reconcile` operation back (the reconciler looked, could not decide yet, and the next cycle must be able to claim it). */
  async releaseLease(orgId: string, id: string, workerId: string): Promise<void> {
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `UPDATE platform.operations SET lease_owner = NULL, lease_expires_at = NULL WHERE id = $1 AND lease_owner = $2 AND state = 'needs_reconcile'`,
        [id, workerId],
      ),
    );
  }

  private async mutate(
    orgId: string,
    id: string,
    workerId: string,
    to: OperationState,
    set: (c: PoolClient, op: Operation) => Promise<{ sql: string; params: unknown[] }>,
  ): Promise<Operation> {
    return this.db.withOrg(orgId, async (c) => {
      const { rows } = await c.query<Operation>(
        `SELECT ${COLS} FROM platform.operations WHERE id=$1 FOR UPDATE`,
        [id],
      );
      const op = rows[0];
      if (!op) throw new PlatformError('not_found', 'operation not found');
      if (op.lease_owner !== workerId)
        throw new PlatformError('lease_lost', 'operation is not leased by this worker');
      assertTransition(op.state, to);
      const { sql, params } = await set(c, op);
      const upd = await c.query<Operation>(
        `UPDATE platform.operations SET ${sql}, state=$${params.length + 2}, updated_at=now(), version=version+1 WHERE id=$1 RETURNING ${COLS}`,
        [id, ...params, to],
      );
      await enqueue(c, orgId, 'operation.state_changed', { operationId: id, from: op.state, to });
      return upd.rows[0]!;
    });
  }

  async heartbeat(orgId: string, id: string, workerId: string, leaseSeconds = 60): Promise<void> {
    const n = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE platform.operations SET lease_expires_at = now() + make_interval(secs=>$3)
          WHERE id=$1 AND lease_owner=$2 AND state IN ('running','waiting_provider','needs_reconcile')`,
            [id, workerId, leaseSeconds],
          )
        ).rowCount,
    );
    if (!n) throw new PlatformError('lease_lost', 'cannot heartbeat: lease not held');
  }

  succeed(orgId: string, id: string, workerId: string, result: unknown): Promise<Operation> {
    return this.mutate(orgId, id, workerId, 'succeeded', async () => ({
      sql: `result=$2, lease_owner=NULL, lease_expires_at=NULL`,
      params: [JSON.stringify(result ?? null)],
    }));
  }

  /** Provider outcome is uncertain: park for the reconciler; never retry blind. */
  markNeedsReconcile(
    orgId: string,
    id: string,
    workerId: string,
    reason: string,
  ): Promise<Operation> {
    return this.mutate(orgId, id, workerId, 'needs_reconcile', async () => ({
      sql: `error=$2, lease_owner=NULL, lease_expires_at=NULL, next_run_at=now()`,
      params: [JSON.stringify({ reason })],
    }));
  }

  /** `needs_reconcile` → `running` under the SAME lease: the reconciler proved what happened and re-enters the workflow (M05). */
  resumeFromReconcile(orgId: string, id: string, workerId: string): Promise<Operation> {
    return this.mutate(orgId, id, workerId, 'running', async () => ({
      sql: `error=NULL, lease_expires_at=now()+make_interval(secs=>120)`,
      params: [],
    }));
  }

  /** Terminal failure now (a DEFINITIVE provider/policy outcome: retrying cannot help), bypassing the retry policy. */
  failPermanently(orgId: string, id: string, workerId: string, error: unknown): Promise<Operation> {
    return this.mutate(orgId, id, workerId, 'failed', async () => ({
      sql: `error=$2, lease_owner=NULL, lease_expires_at=NULL`,
      params: [JSON.stringify(error ?? null)],
    }));
  }

  /**
   * Put a RUNNING operation back to `pending` due at `runAt` WITHOUT counting a failure (a durable pause: a workflow delay or a step retry backoff, M11).
   * The lease is released; whoever claims it next resumes from the owner's persisted state.
   */
  defer(orgId: string, id: string, workerId: string, runAt: Date): Promise<Operation> {
    return this.mutate(orgId, id, workerId, 'pending', async () => ({
      sql: `lease_owner=NULL, lease_expires_at=NULL, next_run_at=$2, attempts=GREATEST(attempts-1, 0)`,
      params: [runAt.toISOString()],
    }));
  }

  /** A running operation whose owner saw `cancel_requested` and stopped: the terminal `cancelled` state (M11 executions). */
  finishCancelled(orgId: string, id: string, workerId: string): Promise<Operation> {
    return this.mutate(orgId, id, workerId, 'cancelled', async () => ({
      sql: `lease_owner=NULL, lease_expires_at=NULL`,
      params: [],
    }));
  }

  /** Fail: retry with backoff while attempts remain, else terminal `failed`. */
  async fail(orgId: string, id: string, workerId: string, error: unknown): Promise<Operation> {
    const current = await this.get(orgId, id);
    if (!current) throw new PlatformError('not_found', 'operation not found');
    const retryable = shouldRetry(current.attempts, {
      ...this.retry,
      maxAttempts: current.max_attempts,
    });
    if (retryable) {
      const delay = backoffSeconds(Math.max(current.attempts, 1), this.retry);
      return this.mutate(orgId, id, workerId, 'pending', async () => ({
        sql: `error=$2, lease_owner=NULL, lease_expires_at=NULL, next_run_at=now()+make_interval(secs=>$3)`,
        params: [JSON.stringify(error ?? null), delay],
      }));
    }
    return this.mutate(orgId, id, workerId, 'failed', async () => ({
      sql: `error=$2, lease_owner=NULL, lease_expires_at=NULL`,
      params: [JSON.stringify(error ?? null)],
    }));
  }

  /**
   * Cancellation (docs/04: 409 on non-cancellable). `pending` cancels immediately; an in-flight
   * operation is flagged and the worker finishes the transition (202 Accepted semantics).
   */
  async requestCancel(
    orgId: string,
    id: string,
  ): Promise<{ state: OperationState; accepted: 'cancelled' | 'cancelling' }> {
    return this.db.withOrg(orgId, async (c) => {
      const { rows } = await c.query<Operation>(
        `SELECT ${COLS} FROM platform.operations WHERE id=$1 FOR UPDATE`,
        [id],
      );
      const op = rows[0];
      if (!op) throw new PlatformError('not_found', 'operation not found');
      if (!isCancellable(op.state))
        throw new PlatformError('operation_not_cancellable', `operation is ${op.state}`);
      if (op.state === 'pending') {
        await c.query(
          `UPDATE platform.operations SET state='cancelled', cancel_requested=true, updated_at=now(), version=version+1 WHERE id=$1`,
          [id],
        );
        await enqueue(c, orgId, 'operation.state_changed', {
          operationId: id,
          from: 'pending',
          to: 'cancelled',
        });
        return { state: 'cancelled' as const, accepted: 'cancelled' as const };
      }
      await c.query(
        `UPDATE platform.operations SET cancel_requested=true, updated_at=now(), version=version+1 WHERE id=$1`,
        [id],
      );
      return { state: op.state, accepted: 'cancelling' as const };
    });
  }

  static isDone(state: OperationState): boolean {
    return isTerminal(state);
  }
}
