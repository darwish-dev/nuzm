import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';

type Row = Record<string, unknown>;
const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);

/** What the register may say about a control. Never a verdict: only what exists. */
export type ControlStatus = 'not_mapped' | 'mapped' | 'evidence_collected' | 'reviewed';
export interface ControlDto {
  controlId: string;
  title: string;
  description: string;
  frameworks: { framework: string; version: string; ref: string }[];
  applicability: 'to_confirm' | 'applicable' | 'not_applicable';
  ownerRole: string;
  implementation: { status: string; modules: string[]; milestone: string };
  evidenceSpec: Record<string, unknown>[];
  reviewCadenceDays: number;
  claimsCompliance: false;
  status: ControlStatus;
  mappings: {
    id: string;
    module: string;
    feature: string;
    evidenceRequirement: string;
    createdAt: string;
  }[];
  evidence: {
    total: number;
    automated: number;
    latestAutomated: { collector: string; collectedAt: string; ok: boolean | null } | null;
    latestReview: {
      reviewerRole: string | null;
      attestedBy: string;
      at: string;
      overdue: boolean;
    } | null;
  };
}

export class ControlsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(q: {
    status?: string;
    applicability?: string;
    ownerRole?: string;
    framework?: string;
    controlId?: string;
  }): Promise<{ items: ControlDto[]; nextCursor: null }> {
    const STATUSES = ['not_mapped', 'mapped', 'evidence_collected', 'reviewed'];
    if (q.status !== undefined && !STATUSES.includes(q.status))
      throw new ProblemException(
        'validation_failed',
        `status must be one of ${STATUSES.join(', ')}`,
      );
    if (
      q.applicability !== undefined &&
      !['to_confirm', 'applicable', 'not_applicable'].includes(q.applicability)
    )
      throw new ProblemException(
        'validation_failed',
        'applicability must be to_confirm, applicable or not_applicable',
      );
    const now = this.clock();
    const items = await this.db.withPlatformScope(async (c) => {
      const cat = (await c.query(`SELECT * FROM compliance.control_catalog ORDER BY control_id`))
        .rows;
      const maps = (
        await c.query(`SELECT * FROM compliance.control_mappings ORDER BY created_at, id`)
      ).rows;
      const ev = (
        await c.query(
          `SELECT control_id, type, collector, collected_at, attested_by, summary FROM compliance.evidence_items ORDER BY collected_at, id`,
        )
      ).rows;
      return cat.map((r): ControlDto => {
        const m = maps.filter((x) => x.control_id === r.control_id);
        const e = ev.filter((x) => x.control_id === r.control_id);
        const auto = e.filter((x) => x.type === 'automated');
        const lastAuto = auto[auto.length - 1];
        const reviews = e.filter((x) => x.type === 'attestation');
        const lastReview = reviews[reviews.length - 1];
        const cadence = r.review_cadence_days as number;
        const status: ControlStatus = lastReview
          ? 'reviewed'
          : e.length > 0
            ? 'evidence_collected'
            : m.length > 0
              ? 'mapped'
              : 'not_mapped';
        return {
          controlId: r.control_id,
          title: r.title,
          description: r.description,
          frameworks: r.frameworks,
          applicability: r.applicability,
          ownerRole: r.owner_role,
          implementation: r.implementation,
          evidenceSpec: r.evidence_spec,
          reviewCadenceDays: cadence,
          claimsCompliance: false,
          status,
          mappings: m.map((x: Row) => ({
            id: x.id as string,
            module: x.module as string,
            feature: x.feature as string,
            evidenceRequirement: x.evidence_requirement as string,
            createdAt: iso(x.created_at)!,
          })),
          evidence: {
            total: e.length,
            automated: auto.length,
            latestAutomated: lastAuto
              ? {
                  collector: lastAuto.collector as string,
                  collectedAt: iso(lastAuto.collected_at)!,
                  ok: ((lastAuto.summary as { ok?: boolean }).ok ?? null) as boolean | null,
                }
              : null,
            latestReview: lastReview
              ? {
                  reviewerRole: ((lastReview.summary as { attesterRole?: string }).attesterRole ??
                    null) as string | null,
                  attestedBy: lastReview.attested_by as string,
                  at: iso(lastReview.collected_at)!,
                  overdue:
                    now.getTime() - (lastReview.collected_at as Date).getTime() >
                    cadence * 86_400_000,
                }
              : null,
          },
        };
      });
    });
    return {
      items: items.filter(
        (x) =>
          (!q.controlId || x.controlId === q.controlId) &&
          (!q.status || x.status === q.status) &&
          (!q.applicability || x.applicability === q.applicability) &&
          (!q.ownerRole || x.ownerRole === q.ownerRole) &&
          (!q.framework || x.frameworks.some((f) => f.framework === q.framework)),
      ),
      nextCursor: null,
    };
  }

  /** Map a control to a module feature. Append-only (a mapping is never edited); the same triple again replays. */
  async map(
    actor: string,
    key: string,
    body: Record<string, unknown>,
  ): Promise<{ mapping: Record<string, unknown>; created: boolean }> {
    const errors: { field: string; message: string }[] = [];
    const s = (k: string, re: RegExp | null, lo: number, hi: number) => {
      const v = body[k];
      if (
        typeof v !== 'string' ||
        v.trim().length < lo ||
        v.trim().length > hi ||
        (re && !re.test(v.trim()))
      ) {
        errors.push({
          field: k,
          message: `must be ${lo}..${hi} characters${re ? ' in the expected format' : ''}`,
        });
        return '';
      }
      return v.trim();
    };
    const controlId = s('controlId', /^CTL-[A-Z]{2,6}-[0-9]{3}$/, 7, 20);
    const module = s('module', /^[a-z][a-z0-9_-]{1,40}$/, 2, 41);
    const feature = s('feature', null, 1, 120);
    const requirement = s('evidenceRequirement', null, 1, 300);
    if (errors.length) throw new ProblemException('validation_failed', 'invalid mapping', errors);
    return this.db.withPlatformScope(async (c) => {
      if (
        !(
          await c.query(`SELECT 1 FROM compliance.control_catalog WHERE control_id = $1`, [
            controlId,
          ])
        ).rowCount
      )
        throw new ProblemException('not_found', 'control not found');
      const existing = (
        await c.query(
          `SELECT * FROM compliance.control_mappings WHERE (created_by = $1 AND idempotency_key = $2) OR (control_id = $3 AND module = $4 AND feature = $5)`,
          [actor, key, controlId, module, feature],
        )
      ).rows[0];
      const view = (r: Row) => ({
        id: r.id,
        controlId: r.control_id,
        module: r.module,
        feature: r.feature,
        evidenceRequirement: r.evidence_requirement,
        createdBy: r.created_by,
        createdAt: iso(r.created_at),
      });
      if (existing) {
        if (
          existing.control_id !== controlId ||
          existing.module !== module ||
          existing.feature !== feature
        )
          throw new ProblemException(
            'idempotency_key_reuse',
            'this Idempotency-Key was used with a different mapping',
          );
        return { mapping: view(existing), created: false };
      }
      const id = uuidv7();
      const row = (
        await c.query(
          `INSERT INTO compliance.control_mappings (id, control_id, module, feature, evidence_requirement, idempotency_key, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [id, controlId, module, feature, requirement, key, actor],
        )
      ).rows[0]!;
      await this.audit.record({
        action: 'compliance.control.mapping_changed',
        actorUserId: actor,
        resource: { type: 'control_mapping', id },
        outcome: 'success',
        after: { controlId, module, feature },
      });
      return { mapping: view(row), created: true };
    });
  }
}
