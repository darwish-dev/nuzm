import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../common/audit';
import { ProblemException } from '../../common/errors';

export const LV_JOBS = [
  { jobId: 'live-verify-alibaba', provider: 'alibaba', gate: 'HG-05-01' },
  { jobId: 'live-verify-huawei', provider: 'huawei', gate: 'HG-05-02' },
  { jobId: 'live-verify-contabo', provider: 'contabo', gate: 'HG-05-03' },
] as const;
const STATUSES = ['NOT RUN', 'NOT VERIFIED', 'LIVE-VERIFIED', 'FAIL'] as const;
type Row = Record<string, unknown>;

/**
 * Live-verification register (M05 §5, UI-M05-15). It RECORDS what a human-triggered run reported; there is deliberately no operation that
 * starts a run. `LIVE-VERIFIED` is accepted only with the owner's gate evidence id, ≥ 1 evidence id and zero residual resources (also a DB CHECK).
 */
export class LiveVerificationService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  async list() {
    return this.db.withPlatformScope(async (c) => {
      const runs = (
        await c.query<Row>(
          `SELECT * FROM cloud.live_verification_runs ORDER BY created_at DESC, id DESC LIMIT 100`,
        )
      ).rows;
      const jobs = LV_JOBS.map((j) => {
        const mine = runs.filter((r) => r.job_id === j.jobId);
        const last = mine[0];
        return {
          jobId: j.jobId,
          provider: j.provider,
          gate: j.gate,
          gateStatus: mine.some((r) => r.gate_evidence_id != null) ? 'GRANTED' : 'PENDING',
          label: (last?.status as string | undefined) ?? 'NOT RUN',
          lastRunAt: last ? (last.created_at as Date).toISOString() : null,
        };
      });
      return {
        jobs,
        runs: runs.map((r) => ({
          id: r.id as string,
          jobId: r.job_id as string,
          status: r.status as string,
          reason: r.reason as string,
          steps: r.steps as unknown[],
          evidenceIds: r.evidence_ids as string[],
          gateEvidenceId: (r.gate_evidence_id as string | null) ?? null,
          spendCapMinor: r.spend_cap_minor == null ? null : String(r.spend_cap_minor),
          currency: r.currency == null ? null : String(r.currency).trim(),
          residualResources: r.residual_resources as number,
          createdAt: (r.created_at as Date).toISOString(),
        })),
      };
    });
  }

  async record(actorUserId: string, b: unknown) {
    if (!b || typeof b !== 'object' || Array.isArray(b))
      throw new ProblemException('validation_failed', 'a JSON object body is required');
    const x = b as Record<string, unknown>;
    const job = LV_JOBS.find((j) => j.jobId === x.jobId);
    if (!job)
      throw new ProblemException(
        'validation_failed',
        `jobId must be one of ${LV_JOBS.map((j) => j.jobId).join(', ')}`,
      );
    if (typeof x.status !== 'string' || !(STATUSES as readonly string[]).includes(x.status))
      throw new ProblemException(
        'validation_failed',
        `status must be one of ${STATUSES.join(', ')}`,
      );
    if (typeof x.reason !== 'string' || x.reason.length < 1 || x.reason.length > 1000)
      throw new ProblemException('validation_failed', 'reason is required (1..1000)');
    const ids = Array.isArray(x.evidenceIds) ? (x.evidenceIds as unknown[]) : [];
    if (!ids.every((e) => typeof e === 'string' && /^[A-Za-z0-9._:-]{3,120}$/.test(e)))
      throw new ProblemException('validation_failed', 'evidenceIds must be evidence index ids');
    const steps = Array.isArray(x.steps) ? x.steps : [];
    const gateEvidence = typeof x.gateEvidenceId === 'string' ? x.gateEvidenceId : null;
    const residual = Number(x.residualResources ?? 0);
    if (!Number.isInteger(residual) || residual < 0)
      throw new ProblemException(
        'validation_failed',
        'residualResources must be a non-negative integer',
      );
    if (x.status === 'LIVE-VERIFIED' && (!gateEvidence || ids.length === 0 || residual !== 0))
      throw new ProblemException(
        'validation_failed',
        'LIVE-VERIFIED needs the owner gate evidence id, at least one evidence id and zero residual resources',
      );
    const spend = x.spendCapMinor == null ? null : String(x.spendCapMinor);
    if (spend !== null && !/^\d{1,16}$/.test(spend))
      throw new ProblemException('validation_failed', 'spendCapMinor must be an integer string');
    const currency = x.currency == null ? null : String(x.currency);
    if (
      (spend === null) !== (currency === null) ||
      (currency !== null && !/^[A-Z]{3}$/.test(currency))
    )
      throw new ProblemException(
        'validation_failed',
        'spendCapMinor and currency go together (ISO 4217)',
      );
    const id = uuidv7();
    await this.db.withPlatformScope(async (c) => {
      await c.query(
        `INSERT INTO cloud.live_verification_runs (id, job_id, provider_key, gate, gate_evidence_id, status, reason, steps, evidence_ids, spend_cap_minor, currency, residual_resources, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)`,
        [
          id,
          job.jobId,
          job.provider,
          job.gate,
          gateEvidence,
          x.status,
          x.reason,
          JSON.stringify(steps),
          ids,
          spend,
          currency,
          residual,
          actorUserId,
        ],
      );
    });
    await this.audit.record({
      action: 'cloud.live_verification.recorded',
      actorUserId,
      outcome: 'success',
      detail: { jobId: job.jobId, status: x.status, residualResources: residual },
    });
    return { id, jobId: job.jobId, status: x.status };
  }
}
