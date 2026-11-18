import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../common/audit';
import { ProblemException } from '../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../common/pagination';
import { fail, str, type Row } from './common';

export const SCOPES = [
  'control_plane_db',
  'object_storage',
  'hosting_site',
  'managed_db',
  'secrets_kms',
  'regional_loss_tabletop',
] as const;
export const TARGETS = { rpoSeconds: 900, rtoSeconds: 14_400 }; // D-30 accepted 2026-11-15
export interface RecoveryExerciseDto {
  id: string;
  scope: string;
  environment: string;
  startedAt: string;
  restoredAt: string;
  rpoSeconds: number;
  rtoSeconds: number;
  targetRpoSeconds: number;
  targetRtoSeconds: number;
  evidenceRefs: string[];
  result: 'pass' | 'fail';
  notes: string | null;
  recordedBy: string;
  createdAt: string;
}
const dto = (r: Row): RecoveryExerciseDto => ({
  id: r.id as string,
  scope: r.scope as string,
  environment: r.environment as string,
  startedAt: (r.started_at as Date).toISOString(),
  restoredAt: (r.restored_at as Date).toISOString(),
  rpoSeconds: r.rpo_seconds as number,
  rtoSeconds: r.rto_seconds as number,
  targetRpoSeconds: r.target_rpo_seconds as number,
  targetRtoSeconds: r.target_rto_seconds as number,
  evidenceRefs: r.evidence_refs as string[],
  result: r.result as 'pass' | 'fail',
  notes: (r.notes as string | null) ?? null,
  recordedBy: r.recorded_by as string,
  createdAt: (r.created_at as Date).toISOString(),
});

/**
 * DR exercise records (docs/04: POST/GET /v1/admin/recovery-exercises). MEASURED, not estimated: `rtoSeconds` must equal restoredAt - startedAt (to the second),
 * the result is derived from the targets (D-30) and a client-supplied result that disagrees is refused. Records are append-only. An exercise recorded in
 * `local` or `staging` is evidence for that environment only: the report never presents it as production DR.
 */
export class RecoveryExerciseService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  async list(q: {
    scope?: string;
    limit: number;
    cursor?: unknown;
  }): Promise<Page<RecoveryExerciseDto>> {
    if (q.scope && !(SCOPES as readonly string[]).includes(q.scope)) fail('scope', 'unknown scope');
    const cur = decodeCursor(q.cursor);
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query<Row>(
            `SELECT * FROM ops.recovery_exercises WHERE ($1::text IS NULL OR scope = $1) AND ($2::uuid IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
            [q.scope ?? null, cur, q.limit + 1],
          )
        ).rows,
    );
    return pageOf(rows.map(dto), q.limit);
  }

  async record(
    by: string,
    key: string,
    body: Row,
  ): Promise<{ created: boolean; exercise: RecoveryExerciseDto }> {
    const scope = (SCOPES as readonly string[]).includes(String(body.scope))
      ? (body.scope as string)
      : fail('scope', `scope must be one of ${SCOPES.join(', ')}`);
    const env = ['local', 'staging', 'production'].includes(String(body.environment))
      ? (body.environment as string)
      : fail('environment', 'environment must be local, staging or production');
    const date = (k: string) => {
      const v = body[k];
      const d = typeof v === 'string' ? new Date(v) : null;
      return d && !Number.isNaN(d.getTime()) ? d : fail(k, `${k} must be a date-time`);
    };
    const startedAt = date('startedAt');
    const restoredAt = date('restoredAt');
    if (restoredAt < startedAt) fail('restoredAt', 'restoredAt is before startedAt');
    if (restoredAt.getTime() > Date.now() + 60_000)
      fail('restoredAt', 'restoredAt is in the future');
    const rto = Math.round((restoredAt.getTime() - startedAt.getTime()) / 1000);
    if (body.rtoSeconds !== rto)
      throw new ProblemException(
        'validation_failed',
        'rtoSeconds must be the measured difference of the two timestamps (not an estimate)',
        [{ field: 'rtoSeconds', message: `expected ${rto}` }],
      );
    const rpo =
      Number.isInteger(body.rpoSeconds) && (body.rpoSeconds as number) >= 0
        ? (body.rpoSeconds as number)
        : fail(
            'rpoSeconds',
            'rpoSeconds must be a non-negative integer (the measured data-loss window)',
          );
    const ev =
      Array.isArray(body.evidenceRefs) &&
      body.evidenceRefs.length >= 1 &&
      body.evidenceRefs.length <= 20 &&
      body.evidenceRefs.every((x) => typeof x === 'string' && x.length >= 3 && x.length <= 300)
        ? (body.evidenceRefs as string[])
        : fail('evidenceRefs', '1 to 20 evidence references (paths, ids, hashes)');
    const notes = str(body, 'notes', 1, 2000, false) ?? null;
    const result = rpo <= TARGETS.rpoSeconds && rto <= TARGETS.rtoSeconds ? 'pass' : 'fail';
    if (body.result !== undefined && body.result !== result)
      throw new ProblemException(
        'validation_failed',
        `the result follows from the measured values and the D-30 targets: ${result}`,
        [{ field: 'result', message: `expected ${result}` }],
      );
    return this.db.withPlatformScope(async (c) => {
      const prior = (
        await c.query<Row>(
          `SELECT * FROM ops.recovery_exercises WHERE recorded_by = $1 AND idempotency_key = $2`,
          [by, key],
        )
      ).rows[0];
      if (prior) return { created: false, exercise: dto(prior) };
      const id = uuidv7();
      const row = (
        await c.query<Row>(
          `INSERT INTO ops.recovery_exercises (id, scope, started_at, restored_at, rpo_seconds, rto_seconds, target_rpo_seconds, target_rto_seconds, evidence_refs, result, environment, notes, recorded_by, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
          [
            id,
            scope,
            startedAt,
            restoredAt,
            rpo,
            rto,
            TARGETS.rpoSeconds,
            TARGETS.rtoSeconds,
            ev,
            result,
            env,
            notes,
            by,
            key,
          ],
        )
      ).rows[0]!;
      await this.audit.record({
        action: 'ops.recovery_exercise.recorded',
        actorUserId: by,
        resource: { type: 'recovery_exercise', id },
        outcome: 'success',
        after: { scope, environment: env, rpoSeconds: rpo, rtoSeconds: rto, result },
      });
      return { created: true, exercise: dto(row) };
    });
  }
}
