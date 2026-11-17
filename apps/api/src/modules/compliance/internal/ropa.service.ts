import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';

export interface Processor {
  name: string;
  role: 'processor' | 'sub-processor';
  region: string;
  dataClasses: string[];
  contractRef: string | null;
}
export interface RopaDto {
  id: string;
  entryKey: string;
  version: number;
  kind: 'activity' | 'adapter';
  adapterKind: string | null;
  activity: string;
  purpose: string;
  dataClasses: string[];
  processors: Processor[];
  regions: string[];
  retentionRef: string | null;
  status: 'placeholder' | 'draft' | 'reviewed';
  reviewedBy: string | null;
  changeNote: string | null;
  createdBy: string | null;
  createdAt: string;
}
type Row = Record<string, unknown>;
const dto = (r: Row): RopaDto => ({
  id: r.id as string,
  entryKey: r.entry_key as string,
  version: r.version as number,
  kind: r.kind as RopaDto['kind'],
  adapterKind: (r.adapter_kind as string | null) ?? null,
  activity: r.activity as string,
  purpose: r.purpose as string,
  dataClasses: r.data_classes as string[],
  processors: r.processors as Processor[],
  regions: r.regions as string[],
  retentionRef: (r.retention_ref as string | null) ?? null,
  status: r.status as RopaDto['status'],
  reviewedBy: (r.reviewed_by as string | null) ?? null,
  changeNote: (r.change_note as string | null) ?? null,
  createdBy: (r.created_by as string | null) ?? null,
  createdAt: (r.created_at as Date).toISOString(),
});

const KEY = /^[a-z][a-z0-9-]*(:[a-z0-9][a-z0-9-]*)?$/;
const REGION = /^([A-Z]{2}|in_kingdom|gcc|eu|other)$/;
const ADAPTER = /^[a-z][a-z-]{1,40}$/;
const GROUPS = ['in_kingdom', 'gcc', 'eu', 'other'];

export interface RopaInput {
  entryKey: string;
  kind?: 'activity' | 'adapter';
  adapterKind?: string;
  activity: string;
  purpose: string;
  dataClasses: string[];
  processors: Processor[];
  regions: string[];
  retentionRef: string | null;
  status: 'draft' | 'reviewed';
  changeNote: string | null;
  baseVersion: number | null;
}

/** Validate a ROPA request body; one entry per bad field (422). Data-class NAMES are checked against the catalogue by the service. */
export function parseRopaInput(raw: Record<string, unknown>): RopaInput {
  const errors: { field: string; message: string }[] = [];
  const bad = (field: string, message: string) => errors.push({ field, message });
  const str = (k: string, min: number, max: number, optional = false): string | null => {
    const v = raw[k];
    if (v === undefined || v === null) {
      if (!optional) bad(k, `is required (${min}..${max} characters)`);
      return null;
    }
    if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max) {
      bad(k, `must be ${min}..${max} characters`);
      return null;
    }
    return v.trim();
  };
  const classes = (v: unknown, field: string): string[] => {
    if (!Array.isArray(v) || v.length < 1 || v.length > 6 || v.some((x) => typeof x !== 'string')) {
      bad(field, 'must be 1..6 data class keys');
      return [];
    }
    if (new Set(v).size !== v.length) bad(field, 'must not repeat a class');
    return v as string[];
  };
  const entryKey = str('entryKey', 3, 80);
  if (entryKey && !KEY.test(entryKey))
    bad('entryKey', 'must look like "activity:billing" (lowercase letters, digits, - and one :)');
  const kind = raw.kind;
  if (kind !== undefined && kind !== 'activity' && kind !== 'adapter')
    bad('kind', "must be 'activity' or 'adapter'");
  const adapterKind = str('adapterKind', 2, 41, true);
  if (adapterKind && !ADAPTER.test(adapterKind))
    bad('adapterKind', 'must be a lowercase adapter kind such as "psp"');
  if (kind === 'adapter' && !adapterKind) bad('adapterKind', 'is required for an adapter entry');
  if (kind !== 'adapter' && adapterKind) bad('adapterKind', "is only for kind 'adapter'");
  const activity = str('activity', 1, 200);
  const purpose = str('purpose', 1, 500);
  const dataClasses = classes(raw.dataClasses, 'dataClasses');
  const processors: Processor[] = [];
  if (!Array.isArray(raw.processors) || raw.processors.length > 50)
    bad('processors', 'must be a list of at most 50 processors');
  else
    (raw.processors as Record<string, unknown>[]).forEach((p, i) => {
      const f = (s: string) => `processors[${i}].${s}`;
      const name = typeof p?.name === 'string' ? p.name.trim() : '';
      if (name.length < 1 || name.length > 120) bad(f('name'), 'is required (1..120 characters)');
      if (p?.role !== 'processor' && p?.role !== 'sub-processor')
        bad(f('role'), "must be 'processor' or 'sub-processor'");
      if (typeof p?.region !== 'string' || !REGION.test(p.region))
        bad(f('region'), 'must be an ISO country code (SA) or one of in_kingdom, gcc, eu, other');
      const cref = p?.contractRef;
      if (
        cref !== undefined &&
        cref !== null &&
        (typeof cref !== 'string' || cref.length < 1 || cref.length > 200)
      )
        bad(f('contractRef'), 'must be 1..200 characters');
      processors.push({
        name,
        role: p?.role as Processor['role'],
        region: p?.region as string,
        dataClasses: classes(p?.dataClasses, f('dataClasses')),
        contractRef: typeof cref === 'string' ? cref : null,
      });
    });
  const regions = Array.isArray(raw.regions)
    ? (raw.regions as unknown[])
    : (bad('regions', 'must be a list'), []);
  for (const r of regions)
    if (typeof r !== 'string' || !REGION.test(r))
      bad('regions', `"${String(r).slice(0, 20)}" is not an ISO country code or region group`);
  const retentionRef = str('retentionRef', 1, 100, true);
  const changeNote = str('changeNote', 1, 500, true);
  const status = raw.status === undefined ? 'draft' : raw.status;
  if (status !== 'draft' && status !== 'reviewed') bad('status', "must be 'draft' or 'reviewed'");
  const base = raw.baseVersion;
  if (base !== undefined && base !== null && (!Number.isInteger(base) || (base as number) < 1))
    bad('baseVersion', 'must be a positive integer');
  if (errors.length) throw new ProblemException('validation_failed', 'invalid ROPA entry', errors);
  return {
    entryKey: entryKey!,
    ...(kind ? { kind: kind as 'activity' | 'adapter' } : {}),
    ...(adapterKind ? { adapterKind } : {}),
    activity: activity!,
    purpose: purpose!,
    dataClasses,
    processors,
    regions: regions as string[],
    retentionRef,
    status: status as 'draft' | 'reviewed',
    changeNote,
    baseVersion: typeof base === 'number' ? base : null,
  };
}

/** The part of an entry that a review approves: identical content, only the status and reviewer change. */
const content = (x: {
  activity: string;
  purpose: string;
  dataClasses: string[];
  processors: Processor[];
  regions: string[];
  retentionRef: string | null;
}) =>
  JSON.stringify([x.activity, x.purpose, x.dataClasses, x.processors, x.regions, x.retentionRef]);

export { GROUPS as REGION_GROUPS };

/**
 * Record of processing activities (M04 §4 task 4). Versioned and immutable: a change is a NEW version, the current one is the highest. A
 * `reviewed` version approves the previous content unchanged and needs a DIFFERENT person than the one who wrote it. Seeded placeholders name no
 * processor until a provider is chosen. Admin realm only (platform scope).
 */
export class RopaService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  async list(q: {
    entryKey?: string;
    kind?: string;
    status?: string;
    adapterKind?: string;
    history?: boolean;
    limit: number;
    cursor?: unknown;
  }): Promise<Page<RopaDto>> {
    if (q.kind !== undefined && q.kind !== 'activity' && q.kind !== 'adapter')
      throw new ProblemException('validation_failed', "kind must be 'activity' or 'adapter'");
    if (q.status !== undefined && !['placeholder', 'draft', 'reviewed'].includes(q.status))
      throw new ProblemException(
        'validation_failed',
        'status must be placeholder, draft or reviewed',
      );
    if (q.history && !q.entryKey)
      throw new ProblemException('validation_failed', 'history needs an entryKey');
    const cursor = decodeCursor(q.cursor);
    return this.db.withPlatformScope(async (c) => {
      const args: unknown[] = [];
      const where: string[] = ['org_id IS NULL'];
      if (q.entryKey) where.push(`entry_key = $${args.push(q.entryKey)}`);
      if (q.kind) where.push(`kind = $${args.push(q.kind)}`);
      if (q.adapterKind) where.push(`adapter_kind = $${args.push(q.adapterKind)}`);
      const inner = q.history
        ? `SELECT * FROM compliance.ropa_entries WHERE ${where.join(' AND ')}`
        : `SELECT DISTINCT ON (entry_key) * FROM compliance.ropa_entries WHERE ${where.join(' AND ')} ORDER BY entry_key, version DESC`;
      const outer: string[] = [];
      if (q.status && !q.history) outer.push(`status = $${args.push(q.status)}`);
      if (cursor) outer.push(`id < $${args.push(cursor)}`);
      const rows = (
        await c.query(
          `SELECT * FROM (${inner}) t ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${q.limit + 1}`,
          args,
        )
      ).rows;
      return pageOf(rows.map(dto), q.limit);
    });
  }

  /**
   * Create an entry (no baseVersion) or add a new version (baseVersion must be the current one: 409 otherwise). The same Idempotency-Key with
   * the same content returns the same version without writing; the same key with other content is 422.
   */
  async save(
    actorUserId: string,
    idempotencyKey: string,
    body: Record<string, unknown>,
  ): Promise<{ entry: RopaDto; created: boolean }> {
    const input = parseRopaInput(body);
    return this.db.withPlatformScope(async (c) => {
      const classes = new Set(
        (await c.query(`SELECT key FROM compliance.data_classes`)).rows.map((r) => r.key as string),
      );
      const unknown = [
        ...input.dataClasses,
        ...input.processors.flatMap((p) => p.dataClasses),
      ].find((k) => !classes.has(k));
      if (unknown)
        throw new ProblemException(
          'validation_failed',
          `unknown data class "${unknown.slice(0, 40)}"`,
          [{ field: 'dataClasses', message: 'is not in the catalogue' }],
        );
      const prior = (
        await c.query(
          `SELECT * FROM compliance.ropa_entries WHERE entry_key = $1 AND org_id IS NULL ORDER BY version DESC LIMIT 1`,
          [input.entryKey],
        )
      ).rows[0];
      const replay = (
        await c.query(
          `SELECT * FROM compliance.ropa_entries WHERE entry_key = $1 AND idempotency_key = $2`,
          [input.entryKey, idempotencyKey],
        )
      ).rows[0];
      if (replay) {
        const r = dto(replay);
        if (content(r) !== content(input) || r.status !== input.status)
          throw new ProblemException(
            'idempotency_key_reuse',
            'this Idempotency-Key was used with different content',
          );
        return { entry: r, created: false };
      }
      if (prior && input.baseVersion !== prior.version)
        throw new ProblemException(
          'conflict',
          `entry ${input.entryKey} is at version ${prior.version}; send baseVersion ${prior.version}`,
        );
      if (!prior && input.baseVersion !== null)
        throw new ProblemException('conflict', 'baseVersion is only for an entry that exists');
      if (!prior && !input.kind)
        throw new ProblemException('validation_failed', 'kind is required for a new entry', [
          { field: 'kind', message: 'is required for a new entry' },
        ]);
      const kind = (prior?.kind ?? input.kind) as 'activity' | 'adapter';
      const adapterKind = (
        prior ? ((prior.adapter_kind as string | null) ?? null) : (input.adapterKind ?? null)
      ) as string | null;
      if (
        prior &&
        ((input.kind && input.kind !== prior.kind) ||
          (input.adapterKind && input.adapterKind !== prior.adapter_kind))
      )
        throw new ProblemException('validation_failed', 'the kind of an entry cannot change', [
          { field: 'kind', message: 'is fixed once the entry exists' },
        ]);
      if (input.status === 'reviewed') {
        if (!prior)
          throw new ProblemException('validation_failed', 'a new entry cannot start as reviewed');
        if (content(dto(prior)) !== content(input))
          throw new ProblemException(
            'validation_failed',
            'a review approves the current content unchanged: send it as it is, or save a draft first',
          );
        if (prior.created_by === actorUserId)
          throw new ProblemException(
            'forbidden',
            'a different person than the author of this version must review it',
          );
      }
      const id = uuidv7();
      const version = prior ? Number(prior.version) + 1 : 1;
      let row: Row;
      try {
        row = (
          await c.query(
            `INSERT INTO compliance.ropa_entries (id, entry_key, version, org_id, kind, adapter_kind, activity, purpose, data_classes, processors, regions,
                    retention_ref, status, reviewed_by, change_note, idempotency_key, created_by)
             VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
            [
              id,
              input.entryKey,
              version,
              kind,
              adapterKind,
              input.activity,
              input.purpose,
              input.dataClasses,
              JSON.stringify(input.processors),
              input.regions,
              input.retentionRef,
              input.status,
              input.status === 'reviewed' ? actorUserId : null,
              input.changeNote,
              idempotencyKey,
              actorUserId,
            ],
          )
        ).rows[0]!;
      } catch (e) {
        if ((e as { code?: string }).code === '23505')
          throw new ProblemException(
            'conflict',
            'the entry was changed at the same time; reload and try again',
          );
        throw e;
      }
      await this.audit.record({
        action:
          input.status === 'reviewed'
            ? 'compliance.ropa.reviewed'
            : prior
              ? 'compliance.ropa.versioned'
              : 'compliance.ropa.created',
        actorUserId,
        resource: { type: 'ropa_entry', id },
        outcome: 'success',
        after: {
          entryKey: input.entryKey,
          version,
          kind,
          status: input.status,
          dataClasses: input.dataClasses,
          processors: input.processors.length,
        },
      });
      return { entry: dto(row), created: true };
    });
  }
}
