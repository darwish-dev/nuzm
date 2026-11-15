import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from './db';

export interface OutboxRow {
  id: string;
  org_id: string;
  topic: string;
  payload: unknown;
  attempts: number;
}

/** Write an event in the SAME transaction as the state change it describes (transactional outbox). */
export async function enqueue(
  c: PoolClient,
  orgId: string,
  topic: string,
  payload: unknown,
): Promise<string> {
  const id = uuidv7();
  await c.query('INSERT INTO platform.outbox (id, org_id, topic, payload) VALUES ($1,$2,$3,$4)', [
    id,
    orgId,
    topic,
    JSON.stringify(payload),
  ]);
  return id;
}

/** Stable event id for consumers to dedupe on (delivery is at-least-once). */
export function eventId(row: Pick<OutboxRow, 'id'>): string {
  return createHash('sha256').update(row.id).digest('hex').slice(0, 32);
}

export class OutboxRelay {
  constructor(
    private readonly db: Db,
    private readonly opts: { batch?: number; lockSeconds?: number } = {},
  ) {}

  /** Claim up to `batch` undelivered rows; claimed rows are invisible to other relays until the lock expires. */
  async claim(): Promise<OutboxRow[]> {
    const batch = this.opts.batch ?? 50;
    const lock = this.opts.lockSeconds ?? 60;
    return this.db.withWorkerClaim(async (c) => {
      const { rows } = await c.query<OutboxRow>(
        `WITH due AS (
           SELECT id FROM platform.outbox
            WHERE published_at IS NULL AND (lock_until IS NULL OR lock_until < now())
            ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
         UPDATE platform.outbox o
            SET lock_until = now() + make_interval(secs => $2), attempts = o.attempts + 1
           FROM due WHERE o.id = due.id
         RETURNING o.id, o.org_id, o.topic, o.payload, o.attempts`,
        [batch, lock],
      );
      return rows;
    });
  }

  async markPublished(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.db.withWorkerClaim((c) =>
      c.query(
        'UPDATE platform.outbox SET published_at = now(), lock_until = NULL WHERE id = ANY($1::uuid[])',
        [ids],
      ),
    );
  }

  /**
   * Deliver one batch. A handler failure leaves the row locked until `lockSeconds` elapse, then it is
   * redelivered: at-least-once. Handlers MUST be idempotent (dedupe on `eventId`).
   */
  async runOnce(
    handler: (row: OutboxRow) => Promise<void>,
  ): Promise<{ delivered: number; failed: number }> {
    const rows = await this.claim();
    const ok: string[] = [];
    let failed = 0;
    for (const row of rows) {
      try {
        await handler(row);
        ok.push(row.id);
      } catch {
        failed++;
      }
    }
    await this.markPublished(ok);
    return { delivered: ok.length, failed };
  }
}
