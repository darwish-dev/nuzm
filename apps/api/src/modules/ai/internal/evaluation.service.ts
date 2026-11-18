import { v7 as uuidv7 } from 'uuid';
import {
  EVAL_THRESHOLDS,
  mockGenerator,
  runEvaluation,
  type EvalReport,
  type SiteGenerator,
} from '@nuzm/domain';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import type { AiConfig, Row } from './model';

/**
 * Evaluation harness runner and results (M09 S41.5). A run stores its report as an `ai.artifacts` row of type `evaluation_report` (M10 moves evaluations to `ai.evaluations`).
 * The shipped generator is the scripted mock: its report is stamped `modelQuality: NOT VERIFIED`. A real-model run needs HG-09-01/D-18 and the owner-approved thresholds.
 */
export class EvaluationService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly cfg: AiConfig,
  ) {}
  async run(
    orgId: string,
    o: { model: string; generator?: SiteGenerator; verifiedModel?: boolean },
  ): Promise<{ artifactId: string; report: EvalReport }> {
    const report = runEvaluation(o.generator ?? mockGenerator, {
      model: o.model,
      ...(o.verifiedModel ? { verifiedModel: true } : {}),
    });
    const id = uuidv7();
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `INSERT INTO ai.artifacts (id, org_id, type, payload, data_region) VALUES ($1,$2,'evaluation_report',$3,$4)`,
        [id, orgId, JSON.stringify(report), this.cfg.dataRegion],
      ),
    );
    await this.audit.record({
      action: 'ai.evaluation.completed',
      actorType: 'system',
      orgId,
      resource: { type: 'ai_artifact', id },
      outcome: report.breaches.length ? 'failure' : 'success',
      detail: { model: report.model, modelQuality: report.modelQuality, breaches: report.breaches },
    });
    return { artifactId: id, report };
  }
  /** Platform view: thresholds and the latest reports (metrics only; per-site rows are not returned). */
  async quality() {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, created_at, payload FROM ai.artifacts WHERE type='evaluation_report' ORDER BY created_at DESC LIMIT 50`,
          )
        ).rows as Row[],
    );
    return {
      thresholds: EVAL_THRESHOLDS,
      reports: rows.map((r) => {
        const p = r.payload as EvalReport;
        const metrics = Object.fromEntries(
          Object.entries(p.metrics).filter(([, v]) => typeof v === 'number'),
        ) as Record<string, number>;
        return {
          id: r.id as string,
          createdAt: new Date(r.created_at as string).toISOString(),
          model: p.model,
          modelQuality: p.modelQuality,
          sites: p.sites,
          metrics,
          breaches: p.breaches,
          notes: p.notes,
        };
      }),
    };
  }
}
