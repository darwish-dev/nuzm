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
      const id = uuidv7();
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

  /**
   * Claim due operations across orgs under the audited claim scope. Reclaims expired leases: a
   * `waiting_provider` operation whose worker vanished becomes `needs_reconcile` (the provider-side
   * outcome is unknown, so the reconciler must look before anything is retried).
   */
  async claimDue(
    workerId: string,
    opts: { batch?: number; leaseSeconds?: number } = {},
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
          ORDER BY next_run_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [batch],
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
