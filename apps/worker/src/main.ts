import {
  AuditIntegrity,
  Db,
  HmacCheckpointSigner,
  OperationsService,
  OutboxRelay,
  eventId,
} from '@nuzm/platform';
import { makeAuditJob } from './audit-job';
import { runLoop } from './loop';

/**
 * Worker composition (S02). Runs the outbox relay and the operations claim loop under the
 * least-privilege `nuzm_worker` role. No operation handlers or event subscribers are registered yet:
 * consumers (audit sink, notifications, metering, provider workflows) register in S04 and M02+.
 * Unhandled operations are NOT claimed here until a handler exists, so nothing is silently dropped.
 */
const url = process.env.WORKER_DATABASE_URL;
if (!url) {
  console.error('WORKER_DATABASE_URL is required (use the nuzm_worker role)');
  process.exit(2);
}

const db = new Db(url);
const relay = new OutboxRelay(db, { batch: 50, lockSeconds: 60 });
const operations = new OperationsService(db);
const ac = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => ac.abort());

const subscribers = new Map<
  string,
  (payload: unknown, meta: { eventId: string; orgId: string }) => Promise<void>
>();
void operations; // handlers arrive with the first operation kinds (M05+)

const log = (m: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ worker: m, ...extra }));

// Audit integrity: verify chains + sign checkpoints. Disabled (loudly) when no signing key is configured.
const auditJob = process.env.AUDIT_CHECKPOINT_KEY
  ? makeAuditJob(new AuditIntegrity(db, HmacCheckpointSigner.fromEnv()), {
      everyMs: Number(process.env.AUDIT_VERIFY_INTERVAL_SECONDS ?? 300) * 1000,
      log,
      onBroken: (broken) =>
        console.error(JSON.stringify({ worker: 'AUDIT_CHAIN_BROKEN', chains: broken })),
    })
  : (log('audit_job_disabled', { reason: 'AUDIT_CHECKPOINT_KEY not set' }), null);

void runLoop(
  async () => {
    await auditJob?.();
    const r = await relay.runOnce(async (row) => {
      const handler = subscribers.get(row.topic);
      // Unknown topic: acknowledge after logging so the outbox does not grow unbounded before
      // subscribers exist. Once a topic has a subscriber, failures retry (at-least-once).
      if (handler) await handler(row.payload, { eventId: eventId(row), orgId: row.org_id });
      else log('no_subscriber', { topic: row.topic, id: row.id });
    });
    if (r.delivered || r.failed) log('outbox_batch', r);
  },
  { intervalMs: 1000, signal: ac.signal, onError: (e) => console.error('worker tick failed', e) },
).then(async () => {
  await db.close();
  log('stopped');
});
log('started');
