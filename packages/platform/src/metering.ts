import { v5 as uuidv5 } from 'uuid';
import type { PoolClient } from 'pg';
import { enqueue } from './outbox';

/** Fixed namespace for deterministic usage event ids (docs/12 §2). Never change: it would break dedupe. */
const USAGE_NS = '5b9d1f4e-8a5c-5f0e-9a58-6d2b7e8c1a30';

/**
 * Producer-side usage event (docs/12 §2). `quantity` is a decimal STRING in the meter's unit (no floats); corrections are
 * negative quantities with `adjustsEventId`. `orgId` comes from the producer's authenticated context, never from user input.
 */
export interface UsageEvent {
  eventId: string;
  orgId: string;
  meterId: string;
  quantity: string;
  unit: string;
  resourceId?: string;
  projectId?: string;
  environmentId?: string;
  windowStart: string;
  windowEnd: string;
  occurredAt: string;
  dimensions?: Record<string, string>;
  dataRegion: string;
  schemaVersion?: number;
  actingOrgId?: string;
  providerEventId?: string;
  tags?: Record<string, string>;
  adjustsEventId?: string;
  /** `module@Mnn`, e.g. `compute@M05`. */
  source: string;
}

/**
 * Deterministic event id from the business key: the same fact always yields the same id, so redelivery and reruns of a
 * sampler dedupe. `sourceSeq` distinguishes several events for one (resource, window), e.g. a message id.
 */
export function usageEventId(k: {
  orgId: string;
  meterId: string;
  resourceId?: string;
  windowStart: string;
  sourceSeq?: string;
}): string {
  return uuidv5(
    [
      k.orgId,
      k.meterId,
      k.resourceId ?? '',
      new Date(k.windowStart).toISOString(),
      k.sourceSeq ?? '',
    ].join('|'),
    USAGE_NS,
  );
}

/**
 * Emit a usage event IN THE CALLER'S TRANSACTION (transactional outbox): the business state change and the usage fact
 * commit together or not at all. The relay delivers it to the ingest consumer (at-least-once; ingest dedupes).
 * Direct inserts into `metering.usage_events` are impossible: runtime roles have no INSERT grant.
 */
export function emitUsage(c: PoolClient, event: UsageEvent): Promise<string> {
  return enqueue(c, event.orgId, 'usage.recorded', event);
}
