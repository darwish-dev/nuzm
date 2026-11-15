import { createHash } from 'node:crypto';
import type { Db } from './db';
import { PlatformError } from './errors';

export interface StoredResponse {
  status: number;
  body: unknown;
}

export function requestHash(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${JSON.stringify(body ?? null)}`)
    .digest('hex');
}

/**
 * `Idempotency-Key` handling (docs/04 §1). Same key + same request → original response replayed and
 * the side effect runs once. Same key + different request → 422 idempotency_key_reuse. A concurrent
 * duplicate while the first is still executing → 409 idempotency_in_progress (client retries).
 * If the handler throws, the key is released so the client can retry.
 */
export class IdempotencyService {
  constructor(private readonly db: Db) {}

  async run(
    orgId: string,
    key: string,
    hash: string,
    exec: () => Promise<StoredResponse>,
  ): Promise<StoredResponse & { replayed: boolean }> {
    if (!key || key.length > 255)
      throw new PlatformError('validation_failed', 'Idempotency-Key must be 1..255 chars');

    const begin = await this.db.withOrg(orgId, async (c) => {
      await c.query(
        'DELETE FROM platform.idempotency_keys WHERE org_id = $1 AND key = $2 AND expires_at < now()',
        [orgId, key],
      );
      const ins = await c.query(
        `INSERT INTO platform.idempotency_keys (org_id, key, request_hash) VALUES ($1,$2,$3)
         ON CONFLICT (org_id, key) DO NOTHING RETURNING key`,
        [orgId, key, hash],
      );
      if (ins.rowCount) return { owner: true as const };
      const { rows } = await c.query<{
        request_hash: string;
        state: string;
        response_status: number | null;
        response_body: unknown;
      }>(
        'SELECT request_hash, state, response_status, response_body FROM platform.idempotency_keys WHERE org_id=$1 AND key=$2',
        [orgId, key],
      );
      return { owner: false as const, row: rows[0]! };
    });

    if (!begin.owner) {
      const { row } = begin;
      if (row.request_hash !== hash)
        throw new PlatformError(
          'idempotency_key_reuse',
          'Idempotency-Key was used with a different request',
        );
      if (row.state !== 'completed')
        throw new PlatformError(
          'idempotency_in_progress',
          'A request with this Idempotency-Key is still being processed',
        );
      return { status: row.response_status ?? 200, body: row.response_body, replayed: true };
    }

    try {
      const res = await exec();
      await this.db.withOrg(orgId, (c) =>
        c.query(
          `UPDATE platform.idempotency_keys SET state='completed', response_status=$3, response_body=$4
            WHERE org_id=$1 AND key=$2`,
          [orgId, key, res.status, JSON.stringify(res.body ?? null)],
        ),
      );
      return { ...res, replayed: false };
    } catch (e) {
      await this.db.withOrg(orgId, (c) =>
        c.query('DELETE FROM platform.idempotency_keys WHERE org_id=$1 AND key=$2', [orgId, key]),
      );
      throw e;
    }
  }
}
