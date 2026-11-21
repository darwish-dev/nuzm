import {
  AuditIntegrity,
  Db,
  HmacCheckpointSigner,
  OperationsService,
  OutboxRelay,
  eventId,
} from '@nuzm/platform';
import { resolveKnowledgeStore } from '@nuzm/adapter-knowledge-store';
import { canariesFromEnv } from '@nuzm/domain';
import { initTelemetry, withSpan } from '@nuzm/telemetry';
import { makeAuditJob } from './audit-job';
import { automationConsumer, AUTOMATION_TOPICS } from './automation-consumers';
import { walletProjector } from './billing-consumers';
import { KnowledgeIngestService } from './knowledge/ingest-service';
import { makePartitionJob, usageIngestor } from './metering-consumers';
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

initTelemetry({ serviceName: 'nuzm-worker' });
const db = new Db(url);
const relay = new OutboxRelay(db, { batch: 50, lockSeconds: 60 });
const operations = new OperationsService(db);
const ac = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => ac.abort());

const subscribers = new Map<
  string,
  (payload: unknown, meta: { eventId: string; orgId: string }) => Promise<void>
>();
subscribers.set('ledger.posted', walletProjector(db)); // wallet projection (M02)
subscribers.set(
  'usage.recorded',
  usageIngestor(db, (m, x) => console.log(JSON.stringify({ worker: m, ...x }))),
); // metering ingest (M02)
// M11 (appended): platform-event workflow triggers and outbound webhook deliveries
const automation = automationConsumer(db, (m, x) =>
  console.log(JSON.stringify({ worker: m, ...x })),
);
for (const t of AUTOMATION_TOPICS)
  if (!subscribers.has(t))
    subscribers.set(t, (payload, meta) => automation(t, payload, meta).then(() => undefined));
void operations; // handlers arrive with the first operation kinds (M05+)

const log = (m: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ worker: m, ...extra }));
const partitions = makePartitionJob(db, { everyMs: 6 * 3600_000, log });

// Audit integrity: verify chains + sign checkpoints. Disabled (loudly) when no signing key is configured.
const auditJob = process.env.AUDIT_CHECKPOINT_KEY
  ? makeAuditJob(new AuditIntegrity(db, HmacCheckpointSigner.fromEnv()), {
      everyMs: Number(process.env.AUDIT_VERIFY_INTERVAL_SECONDS ?? 300) * 1000,
      log,
      onBroken: (broken) =>
        console.error(JSON.stringify({ worker: 'AUDIT_CHAIN_BROKEN', chains: broken })),
    })
  : (log('audit_job_disabled', { reason: 'AUDIT_CHECKPOINT_KEY not set' }), null);

// AI Intelligence Center ingestion (S-K2a, ADR-065). OFF unless KNOWLEDGE_INGEST_ENABLED=true AND an object store resolves. In production the store resolves only with
// a complete S3 configuration, vault-resolved credentials and a human attestation (D-42); until then this worker claims nothing and says why.
const knowledgeStore =
  process.env.KNOWLEDGE_INGEST_ENABLED === 'true'
    ? resolveKnowledgeStore(
        process.env /* production credentials: a vault resolver arrives with D-42 */,
      )
    : null;
const knowledge = knowledgeStore?.store
  ? new KnowledgeIngestService(db, knowledgeStore.store, {
      log,
      canaries: canariesFromEnv(),
      detect: process.env.KNOWLEDGE_DETECT_ENABLED === 'true', // S-K2b project detection stage: off until accepted
      components: process.env.KNOWLEDGE_COMPONENTS_ENABLED === 'true', // S-K2c component and architecture stage: off until accepted (needs detect)
      design: process.env.KNOWLEDGE_DESIGN_ENABLED === 'true', // S-K4 design analysis stage: off until accepted (needs components)
      sandbox: {
        threads: Number(process.env.KNOWLEDGE_PARSER_THREADS) || undefined, // parser sandbox (S-K2c): threads, 1-4, default 2
        timeoutMs: Number(process.env.KNOWLEDGE_PARSER_TIMEOUT_MS) || undefined, // per file, default 10 000
        maxOldGenerationSizeMb: Number(process.env.KNOWLEDGE_PARSER_HEAP_MB) || undefined, // per thread, default 384
      },
    })
  : null;
log(
  knowledge ? 'knowledge_ingest_enabled' : 'knowledge_ingest_disabled',
  knowledge
    ? { adapter: knowledgeStore?.status.adapter }
    : {
        reason: knowledgeStore
          ? knowledgeStore.status.problems
          : 'KNOWLEDGE_INGEST_ENABLED is not true',
      },
);

void runLoop(
  () =>
    withSpan('worker.tick', async () => {
      await auditJob?.();
      await partitions();
      await knowledge?.drain(3);
      const r = await relay.runOnce(async (row) => {
        const handler = subscribers.get(row.topic);
        // Unknown topic: acknowledge after logging so the outbox does not grow unbounded before
        // subscribers exist. Once a topic has a subscriber, failures retry (at-least-once).
        if (handler) await handler(row.payload, { eventId: eventId(row), orgId: row.org_id });
        else log('no_subscriber', { topic: row.topic, id: row.id });
      });
      if (r.delivered || r.failed) log('outbox_batch', r);
    }),
  { intervalMs: 1000, signal: ac.signal, onError: (e) => console.error('worker tick failed', e) },
).then(async () => {
  await db.close();
  log('stopped');
});
log('started');
