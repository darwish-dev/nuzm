import type { PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';

/** Records an operation step (platform.operation_steps) so the operation timeline shows reserve → place → provision → inspect → persist → finalize. */
export async function recordStep(
  c: PoolClient,
  orgId: string,
  operationId: string,
  name: string,
  state: 'running' | 'succeeded' | 'failed' | 'skipped',
  detail: Record<string, unknown> = {},
): Promise<void> {
  const existing = (
    await c.query(`SELECT id FROM platform.operation_steps WHERE operation_id = $1 AND name = $2`, [
      operationId,
      name,
    ])
  ).rows[0];
  if (existing) {
    await c.query(
      `UPDATE platform.operation_steps SET state = $2, detail = $3,
         finished_at = CASE WHEN $2 IN ('succeeded','failed','skipped') THEN now() ELSE finished_at END WHERE id = $1`,
      [existing.id, state, JSON.stringify(detail)],
    );
    return;
  }
  const seq = Number(
    (
      await c.query(
        `SELECT coalesce(max(seq), 0) + 1 AS n FROM platform.operation_steps WHERE operation_id = $1`,
        [operationId],
      )
    ).rows[0]!.n,
  );
  await c.query(
    `INSERT INTO platform.operation_steps (id, org_id, operation_id, seq, name, state, detail, started_at, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now(), CASE WHEN $6 IN ('succeeded','failed','skipped') THEN now() ELSE NULL END)`,
    [uuidv7(), orgId, operationId, seq, name, state, JSON.stringify(detail)],
  );
}
