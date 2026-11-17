import { v7 as uuidv7 } from 'uuid';
import type { PoolClient } from 'pg';

export type SubmissionState =
  'generated' | 'stamped' | 'queued' | 'submitted' | 'cleared' | 'reported' | 'rejected' | 'error';

/**
 * Append one state row for a document (the table is append-only; the current state is the latest row, and the database checks every
 * transition against the previous row). Two writers racing for the same next row collide on (document_id, seq): the loser gets a unique
 * violation (23505) and must treat it as "someone else moved it".
 */
export async function appendSubmission(
  c: PoolClient,
  orgId: string,
  documentId: string,
  state: SubmissionState,
  o: {
    attempt?: number;
    nextAttemptAt?: Date | null;
    deadLetter?: boolean;
    response?: Record<string, unknown>;
    now?: Date;
  } = {},
): Promise<string> {
  const id = uuidv7();
  await c.query(
    `INSERT INTO invoicing.zatca_submissions (id, org_id, document_id, seq, state, attempt, next_attempt_at, dead_letter, response, created_at)
     VALUES ($1,$2,$3,(SELECT coalesce(max(seq),0)+1 FROM invoicing.zatca_submissions WHERE document_id = $3),$4,$5,$6,$7,$8,$9)`,
    [
      id,
      orgId,
      documentId,
      state,
      o.attempt ?? 0,
      o.nextAttemptAt ?? null,
      o.deadLetter ?? false,
      JSON.stringify(o.response ?? {}),
      o.now ?? new Date(),
    ],
  );
  return id;
}
