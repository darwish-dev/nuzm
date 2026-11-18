import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import type { AutomationConfig, Row } from './model';

export type Notify = (orgId: string, kind: string, params: Record<string, unknown>) => Promise<void>;

/**
 * Abuse rules for workflows (M11 S52): an execution SPIKE (one workflow starting too many executions per minute: also what a workflow that triggers itself looks like), a high
 * 4xx share of its HTTP results, and over-deep trigger chains. A hit PAUSES the workflow (the organization can resume it; an administrator pause it cannot lift), opens a case for the
 * admin console and tells the people who manage automation. The rules read only this module's tables.
 */
export class AbuseService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly cfg: AutomationConfig,
    private readonly notify: Notify = async () => undefined,
  ) {}

  /** Pause + case + audit + notice. Idempotent: an already-paused workflow is left alone and opens no second case. */
  async pause(orgId: string, workflowId: string, kind: 'execution_spike' | 'high_4xx_rate' | 'recursion' | 'connector_failures', details: Record<string, unknown>): Promise<boolean> {
    const paused = await this.db.withOrg(orgId, async (c) => {
      const r = await c.query(`UPDATE automation.workflows SET status = 'paused', paused_at = now(), paused_reason = $2, next_run_at = NULL WHERE id = $1 AND org_id = $3 AND status = 'active' RETURNING id`, [workflowId, `anomaly: ${kind}`, orgId]);
      if (!r.rowCount) return false;
      await c.query(`INSERT INTO automation.anomaly_cases (id, org_id, workflow_id, kind, details) VALUES ($1,$2,$3,$4,$5)`, [uuidv7(), orgId, workflowId, kind, JSON.stringify(details)]);
      return true;
    });
    if (!paused) return false;
    await this.audit.record({ action: 'workflow.workflow.auto_paused', actorType: 'system', orgId, resource: { type: 'workflow', id: workflowId }, outcome: 'failure', detail: { kind, ...details } });
    await this.notify(orgId, 'automation.workflow_paused', { workflowId, reason: kind }).catch(() => undefined);
    return true;
  }

  /** Spike rule: more than `spikePerMinute` executions of ONE workflow created in the last minute. */
  async checkSpikes(now = new Date()): Promise<number> {
    const hot = await this.db.withPlatformScope(async (c) =>
      (
        await c.query(
          `SELECT e.org_id, e.workflow_id, count(*)::int n FROM automation.executions e JOIN automation.workflows w ON w.id = e.workflow_id AND w.status = 'active'
            WHERE e.created_at > $1::timestamptz - interval '1 minute' GROUP BY e.org_id, e.workflow_id HAVING count(*) > $2`,
          [now, this.cfg.spikePerMinute],
        )
      ).rows as Row[],
    );
    let n = 0;
    for (const h of hot) if (await this.pause(h.org_id, h.workflow_id, 'execution_spike', { executionsLastMinute: h.n, threshold: this.cfg.spikePerMinute })) n++;
    return n;
  }

  /** 4xx rule: of the last `rateWindow` HTTP-type step attempts of a workflow, more than `http4xxRate` failed with a 4xx. */
  async check4xx(): Promise<number> {
    const cands = await this.db.withPlatformScope(async (c) =>
      (await c.query(`SELECT DISTINCT e.org_id, e.workflow_id FROM automation.executions e JOIN automation.workflows w ON w.id = e.workflow_id AND w.status = 'active' WHERE e.created_at > now() - interval '15 minutes'`)).rows as Row[],
    );
    let n = 0;
    for (const w of cands) {
      const rows = await this.db.withOrg(w.org_id, async (c) =>
        (
          await c.query(
            `SELECT s.error->>'code' AS code FROM automation.execution_steps s JOIN automation.executions e ON e.id = s.execution_id
              WHERE e.workflow_id = $1 AND s.step_type IN ('http_request','nuzm_api') AND s.status IN ('succeeded','failed') ORDER BY s.started_at DESC LIMIT $2`,
            [w.workflow_id, this.cfg.rateWindow],
          )
        ).rows as Row[],
      );
      if (rows.length < this.cfg.rateWindow) continue;
      const bad = rows.filter((r) => r.code === 'http_4xx').length;
      if (bad / rows.length > this.cfg.http4xxRate && (await this.pause(w.org_id, w.workflow_id, 'high_4xx_rate', { window: rows.length, clientErrors: bad }))) n++;
    }
    return n;
  }

  /** A chain deeper than the limit is refused and recorded (a workflow that keeps triggering workflows that trigger it). */
  async recordRecursion(orgId: string, workflowId: string, depth: number): Promise<void> {
    await this.pause(orgId, workflowId, 'recursion', { depth, max: this.cfg.maxChainDepth });
  }
}
