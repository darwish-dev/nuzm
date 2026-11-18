import { createHash } from 'node:crypto';
import type { Db } from '@nuzm/platform';
import { nextCronRun, verifySignature } from '@nuzm/domain';
import { ProblemException } from '../../../common/errors';
import type { SecretStore } from '../../../common/secrets';
import type { AbuseService } from './abuse.service';
import type { ExecutionService } from './execution.service';
import { isAllowedTopic, type AutomationConfig, type Row, type Trigger } from './model';

/**
 * How executions start besides a manual POST: schedule (cron in UTC or an IANA zone), the inbound webhook (secret URL token + HMAC signature + timestamp window + dedupe by event id)
 * and platform events (outbox topics on the allow-list). Every path ends in `ExecutionService.enqueue`, so deduplication, the feature flag and the paused/disabled rules are the same
 * everywhere; a duplicate trigger (same schedule slot, same event id, same delivery id) yields the ORIGINAL execution and no second one.
 */
export class TriggerService {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    private readonly executions: ExecutionService,
    private readonly abuse: AbuseService,
    private readonly cfg: AutomationConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Fire every due schedule once per slot (the slot is the dedupe key, so several API instances cannot double fire) and move `next_run_at` on. */
  async fireSchedules(): Promise<number> {
    const now = this.now();
    const due = await this.db.withPlatformScope(async (c) => (await c.query(`SELECT id, org_id, triggers, next_run_at FROM automation.workflows WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= $1 ORDER BY next_run_at LIMIT 100`, [now])).rows as Row[]);
    let fired = 0;
    for (const w of due) {
      const t = (w.triggers as Trigger[]).find((x) => x.type === 'schedule');
      const slot = (w.next_run_at as Date).toISOString();
      if (t) {
        try {
          const e = await this.executions.enqueue(w.org_id, { workflowId: w.id, trigger: 'schedule', triggerRef: slot, dedupeKey: `schedule:${slot}`, input: { scheduledFor: slot, cron: t.cron } });
          if (e.created) {
            await this.executions.ensureOperation(w.org_id, e.id);
            fired++;
          }
        } catch {
          /* feature off or not runnable: the slot is skipped, the schedule moves on */
        }
      }
      const next = t ? nextCronRun(t.cron!, now, t.timezone ?? 'UTC') : null;
      await this.db.withOrg(w.org_id, (c) => c.query(`UPDATE automation.workflows SET next_run_at = $2 WHERE id = $1 AND next_run_at <= $3`, [w.id, next, now]));
    }
    return fired;
  }

  /** Inbound webhook. Unknown token = 404 (no oracle); a bad/expired signature = 401 `invalid_signature`; a repeated event id = the original execution. */
  async inbound(token: string, header: string | undefined, rawBody: string, eventId: string | undefined): Promise<{ executionId: string; duplicate: boolean }> {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw new ProblemException('not_found');
    if (Buffer.byteLength(rawBody) > this.cfg.inboundBodyMaxBytes) throw new ProblemException('validation_failed', 'the body is too large');
    const hash = createHash('sha256').update(token).digest('hex');
    const wf = (await this.db.withPlatformScope(async (c) => (await c.query(`SELECT id, org_id, webhook_secret_ref FROM automation.workflows WHERE webhook_token_hash = $1`, [hash])).rows[0])) as Row | undefined;
    if (!wf) throw new ProblemException('not_found');
    const secret = await this.secrets.get(wf.webhook_secret_ref);
    const v = verifySignature(header, rawBody, [secret], Math.floor(this.now().getTime() / 1000));
    if (!v.ok) throw new ProblemException('invalid_signature', v.reason);
    if (typeof eventId !== 'string' || eventId.length < 1 || eventId.length > 200) throw new ProblemException('validation_failed', 'X-Nuzm-Event-Id is required');
    let input: unknown = {};
    if (rawBody.length > 0) {
      try {
        input = JSON.parse(rawBody);
      } catch {
        throw new ProblemException('validation_failed', 'the body must be JSON');
      }
    }
    const e = await this.executions.enqueue(wf.org_id, { workflowId: wf.id, trigger: 'webhook', triggerRef: eventId, dedupeKey: `webhook:${eventId}`, input: typeof input === 'object' && input !== null && !Array.isArray(input) ? input : { value: input } });
    if (e.created) await this.executions.ensureOperation(wf.org_id, e.id);
    return { executionId: e.id, duplicate: !e.created };
  }

  /** Platform event (called by the outbox consumer with the verified org of the event): one execution per matching active workflow, deduped by the event id. */
  async platformEvent(orgId: string, topic: string, eventId: string, payload: unknown): Promise<number> {
    if (!isAllowedTopic(topic)) return 0;
    const wfs = await this.db.withOrg(orgId, async (c) => (await c.query(`SELECT id, triggers FROM automation.workflows WHERE org_id = $1 AND status = 'active'`, [orgId])).rows as Row[]);
    const depthIn = Number((payload as { automationDepth?: unknown } | null)?.automationDepth ?? 0);
    let n = 0;
    for (const w of wfs) {
      if (!(w.triggers as Trigger[]).some((t) => t.type === 'platform_event' && t.topic === topic)) continue;
      if (depthIn + 1 > this.cfg.maxChainDepth) {
        await this.abuse.recordRecursion(orgId, w.id, depthIn + 1);
        continue;
      }
      const e = await this.executions.enqueue(orgId, { workflowId: w.id, trigger: 'platform_event', triggerRef: eventId, dedupeKey: `event:${topic}:${eventId}`, input: { topic, eventId, payload }, depth: depthIn + 1 }).catch(() => null);
      if (e?.created) {
        await this.executions.ensureOperation(orgId, e.id);
        n++;
      }
    }
    return n;
  }
}
