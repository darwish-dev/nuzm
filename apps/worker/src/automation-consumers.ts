import { uuidv7, type Db } from '@nuzm/platform';

/**
 * Outbox consumers of the automation module (M11 S51/S52), run by the worker under the `nuzm_worker` role INSIDE the event's own organization (`Db.withOrg(row.org_id)`: the
 * org comes from the verified outbox row, never from the payload). SQL only: the idempotent insert is `automation.enqueue_execution` (unique on org + workflow + dedupe key), so a redelivered
 * event creates nothing new; the API process attaches the durable operation and runs the execution on its next tick. Two effects per event topic:
 *   1. every ACTIVE workflow of the organization with a `platform_event` trigger for the topic gets ONE execution (dedupe key `event:<topic>:<eventId>`);
 *   2. every ACTIVE outbound webhook endpoint subscribed to the topic gets ONE delivery row (unique per endpoint + event); the API process signs and sends it.
 * Only the allow-listed topics are consumed (docs/05 §5 + M11); anything else is ignored. A chain deeper than `AUTOMATION_MAX_CHAIN_DEPTH` is skipped (the API-side abuse rules pause the workflow).
 */
export const AUTOMATION_TOPICS = ['invoice.issued', 'ai.run.completed', 'site.deployed', 'domain.registered', 'payment.succeeded', 'payment.failed', 'org.created', 'resource.state_changed'] as const;
const MAX_DEPTH = () => Number(process.env.AUTOMATION_MAX_CHAIN_DEPTH ?? 5);

export function automationConsumer(db: Db, log: (m: string, x?: Record<string, unknown>) => void = () => undefined) {
  return async (topic: string, payload: unknown, meta: { eventId: string; orgId: string }): Promise<{ executions: number; deliveries: number }> => {
    if (!(AUTOMATION_TOPICS as readonly string[]).includes(topic)) return { executions: 0, deliveries: 0 };
    const depthIn = Number((payload as { automationDepth?: unknown } | null)?.automationDepth ?? 0);
    return db.withOrg(meta.orgId, async (c) => {
      let executions = 0;
      let deliveries = 0;
      const wfs = (await c.query(`SELECT id, triggers FROM automation.workflows WHERE org_id = $1 AND status = 'active'`, [meta.orgId])).rows as { id: string; triggers: { type: string; topic?: string }[] }[];
      for (const w of wfs) {
        if (!w.triggers.some((t) => t.type === 'platform_event' && t.topic === topic)) continue;
        if (depthIn + 1 > MAX_DEPTH()) {
          log('automation_chain_too_deep', { workflowId: w.id, depth: depthIn + 1 });
          continue;
        }
        await c.query('SAVEPOINT ev');
        try {
          const r = await c.query(`SELECT * FROM automation.enqueue_execution($1,$2,$3,'platform_event',$4,$5,$6,NULL,$7)`, [uuidv7(), meta.orgId, w.id, meta.eventId, `event:${topic}:${meta.eventId}`, JSON.stringify({ topic, eventId: meta.eventId, payload }), depthIn + 1]);
          if (r.rows[0]?.created) executions++;
          await c.query('RELEASE SAVEPOINT ev');
        } catch (e) {
          // feature off, workflow paused meanwhile, ...: this workflow is skipped, the others still run
          await c.query('ROLLBACK TO SAVEPOINT ev');
          log('automation_trigger_skipped', { workflowId: w.id, reason: (e as { hint?: string }).hint ?? 'error' });
        }
      }
      const eps = (await c.query(`SELECT id FROM automation.webhook_endpoints WHERE org_id = $1 AND status = 'active' AND $2 = ANY(events)`, [meta.orgId, topic])).rows as { id: string }[];
      const envelope = JSON.stringify({ id: meta.eventId, type: topic, createdAt: new Date().toISOString(), orgId: meta.orgId, data: payload });
      for (const e of eps) {
        const r = await c.query(`INSERT INTO automation.webhook_deliveries (id, org_id, endpoint_id, event_id, topic, attempt, status, payload, next_attempt_at) VALUES ($1,$2,$3,$4,$5,0,'pending',$6,now()) ON CONFLICT DO NOTHING`, [uuidv7(), meta.orgId, e.id, meta.eventId, topic, envelope]);
        deliveries += r.rowCount ?? 0;
      }
      return { executions, deliveries };
    });
  };
}
