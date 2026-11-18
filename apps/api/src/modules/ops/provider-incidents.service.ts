import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import { decodeCursor, pageOf, type Page } from '../../common/pagination';
import { fail, UUID_RE, assertNoPii, type Row } from './common';

export interface ProviderIncidentDto {
  id: string;
  providerKey: string;
  providerAccountId: string | null;
  externalRef: string;
  status: string;
  title: string;
  startedAt: string;
  resolvedAt: string | null;
  relatedIncidentId: string | null;
  source: string;
}
const dto = (r: Row): ProviderIncidentDto => ({
  id: r.id as string,
  providerKey: r.provider_key as string,
  providerAccountId: (r.provider_account_id as string | null) ?? null,
  externalRef: r.external_ref as string,
  status: r.status as string,
  title: r.title as string,
  startedAt: (r.started_at as Date).toISOString(),
  resolvedAt: r.resolved_at ? (r.resolved_at as Date).toISOString() : null,
  relatedIncidentId: (r.related_incident_id as string | null) ?? null,
  source: r.source as string,
});

/** Provider incident tracker: read through GET /v1/admin/provider-incidents; written by feed ingestion (a provider status page/adapter health) or an operator tool — no write endpoint exists in docs/04. */
export class ProviderIncidentService {
  constructor(private readonly db: Db) {}

  async list(q: {
    providerKey?: string;
    status?: string;
    limit: number;
    cursor?: unknown;
  }): Promise<Page<ProviderIncidentDto>> {
    const cur = decodeCursor(q.cursor);
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query<Row>(
            `SELECT * FROM ops.provider_incidents WHERE ($1::text IS NULL OR provider_key = $1) AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR id < $3) ORDER BY id DESC LIMIT $4`,
            [q.providerKey ?? null, q.status ?? null, cur, q.limit + 1],
          )
        ).rows,
    );
    return pageOf(rows.map(dto), q.limit);
  }

  /** Upsert by (provider, externalRef): the same event repeated is a no-op; a status change updates the row. */
  async ingest(e: {
    providerKey: string;
    externalRef: string;
    status: 'investigating' | 'identified' | 'monitoring' | 'resolved';
    title: string;
    startedAt: Date;
    resolvedAt?: Date;
    providerAccountId?: string;
    relatedIncidentId?: string;
    source?: 'manual' | 'feed';
  }): Promise<ProviderIncidentDto> {
    assertNoPii('title', e.title);
    if (e.providerAccountId && !UUID_RE.test(e.providerAccountId))
      fail('providerAccountId', 'invalid');
    const resolvedAt = e.status === 'resolved' ? (e.resolvedAt ?? new Date()) : null;
    const row = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query<Row>(
            `INSERT INTO ops.provider_incidents (id, provider_account_id, provider_key, external_ref, status, title, started_at, resolved_at, related_incident_id, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (provider_key, external_ref) DO UPDATE SET status = EXCLUDED.status, resolved_at = EXCLUDED.resolved_at, title = EXCLUDED.title, related_incident_id = coalesce(EXCLUDED.related_incident_id, ops.provider_incidents.related_incident_id), updated_at = now()
       RETURNING *`,
            [
              uuidv7(),
              e.providerAccountId ?? null,
              e.providerKey,
              e.externalRef,
              e.status,
              e.title.slice(0, 300),
              e.startedAt,
              resolvedAt,
              e.relatedIncidentId ?? null,
              e.source ?? 'manual',
            ],
          )
        ).rows[0]!,
    );
    return dto(row);
  }
}
