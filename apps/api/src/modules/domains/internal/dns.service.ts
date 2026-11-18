import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import {
  DEFAULT_DNS_OPTIONS,
  recordKey,
  validateChangeSet,
  valueKey,
  type DnsChangeInput,
  type DnsNormalizedChange,
  type DnsRecord,
  type ManagedBy,
} from '@nuzm/domain';
import { enqueue, type Db, type OperationsService } from '@nuzm/platform';
import { isSupported, type DnsChange, type DnsRecordData } from '@nuzm/registrar-contracts';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, parseLimit } from '../../../common/pagination';
import { SlidingWindowLimiter } from '../../../common/rate-limit';
import { UUID, badRequest, type Row } from './common';
import type { DomainsConfig } from './ports';
import type { AccountAccess, RegistrarAccessService } from './registrar-access.service';

export const OP_DNS_RECONCILE = 'domains.dns.reconcile';
const hashValue = (r: Pick<DnsRecord, 'value'>) =>
  createHash('sha256').update(valueKey(r)).digest('hex');
const neutral = (r: DnsRecord): DnsRecordData => ({
  name: r.name,
  type: r.type,
  ttl: r.ttl,
  value: r.value,
});
/** What identifies a record for comparison with the registrar's copy: name, type and value (a vendor may round the TTL). */
const sig = (r: Pick<DnsRecordData, 'name' | 'type' | 'value'>) =>
  `${r.name}|${r.type}|${JSON.stringify(sortKeys(r.value))}`;
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  return v;
}
const sameSet = (a: DnsRecordData[], b: DnsRecordData[]) => {
  const x = a.map(sig).sort();
  const y = b.map(sig).sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

export interface ZoneDto {
  id: string;
  domainId: string;
  name: string;
  state: string;
  version: number;
  degraded: boolean;
  dnssec: { available: boolean };
  recordCount?: number;
}
export interface ChangeSetResult {
  outcome: 'applied';
  results: { index: number; op: string; status: 'applied' }[];
  version: number;
}

/**
 * DNS engine (M07 S30). A change-set is validated as a whole (packages/domain dns-validate), checked against the zone version (If-Match), applied through the
 * registrar's DNS adapter, and VERIFIED by re-reading the registrar's zone before our copy changes. When the adapter is not atomic the platform snapshots first
 * and rolls back to the snapshot on any mismatch; if the rollback cannot be verified the zone is marked `degraded` and a reconcile operation is opened.
 */
export class DnsService {
  private readonly limiter = new SlidingWindowLimiter();
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly access: RegistrarAccessService,
    private readonly ops: OperationsService,
    private readonly cfg: DomainsConfig,
  ) {}

  private dto(z: Row, dnssecAvailable: boolean, count?: number): ZoneDto {
    return {
      id: z.id as string,
      domainId: z.domain_id as string,
      name: z.name as string,
      state: z.state as string,
      version: z.version as number,
      degraded: z.degraded as boolean,
      dnssec: { available: dnssecAvailable },
      ...(count === undefined ? {} : { recordCount: count }),
    };
  }
  // ---- zones --------------------------------------------------------------------------------------------------------------------
  async createZone(
    orgId: string,
    actor: string,
    body: Record<string, unknown>,
    traceId: string,
  ): Promise<ZoneDto> {
    const domainId = body.domainId;
    if (typeof domainId !== 'string' || !UUID.test(domainId))
      throw badRequest('domainId is required');
    const dom = await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM domains.domains WHERE id = $1`, [domainId])).rows[0] as
          Row | undefined,
    );
    if (!dom) throw new ProblemException('not_found', 'domain not found');
    if (dom.state !== 'active' && dom.state !== 'renewal_at_risk')
      throw new ProblemException('conflict', `a ${String(dom.state)} domain cannot get a DNS zone`);
    const account = await this.access.getAccount(dom.registrar_account_id as string);
    if (!account || !account.enabled || !isSupported(account.capabilities, 'registrar.dns'))
      throw new ProblemException(
        'unsupported_capability',
        'the registrar for this domain does not host DNS',
      );
    const acc = this.access.accessFor(account, traceId);
    if (!acc?.adapter.dns)
      throw new ProblemException(
        'unsupported_capability',
        'the registrar for this domain does not host DNS',
      );
    const existing = await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT id FROM domains.dns_zones WHERE domain_id = $1`, [domainId]))
          .rows[0],
    );
    if (existing) throw new ProblemException('conflict', 'this domain already has a DNS zone');
    const r = await acc.adapter.dns.createZone(acc.ctx, dom.name as string);
    if (r.status !== 'succeeded' || !r.data)
      throw new ProblemException(
        r.status === 'failed' && r.error?.category === 'unsupported'
          ? 'unsupported_capability'
          : 'service_unavailable',
        r.error?.message ?? 'the registrar did not create the zone',
      );
    const id = uuidv7();
    try {
      await this.db.withOrg(orgId, async (c) => {
        await c.query(
          `INSERT INTO domains.dns_zones (id, org_id, domain_id, name, provider_zone_ref, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, orgId, domainId, dom.name, r.data!.providerZoneRef, actor],
        );
        for (const rec of r.data!.records) {
          const v = validateChangeSet(
            dom.name as string,
            [],
            [
              {
                op: 'create',
                record: {
                  name: rec.name,
                  type: rec.type,
                  ttl: Math.min(86400, Math.max(60, rec.ttl)),
                  value: rec.value,
                  managedBy: 'user',
                },
              },
            ],
            { writer: 'linkage', maxRecords: 100000 },
          );
          if (v.ok) await this.insertRecord(c, orgId, id, v.resulting[0]!); // records already at the registrar are imported as they are
        }
        await enqueue(c, orgId, 'resource.state_changed', {
          resourceKind: 'dns_zone',
          resourceId: id,
          state: 'active',
        });
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException('conflict', 'this domain already has a DNS zone');
      throw e;
    }
    await this.audit.record({
      action: 'dns.zone.created',
      orgId,
      actorUserId: actor,
      resource: { type: 'dns_zone', id },
      outcome: 'success',
      detail: { domainId },
    });
    return this.getZone(orgId, id);
  }

  private async insertRecord(
    c: import('pg').PoolClient,
    orgId: string,
    zoneId: string,
    r: DnsRecord,
  ) {
    await c.query(
      `INSERT INTO domains.dns_records (id, org_id, zone_id, name, type, ttl, value, value_hash, managed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (zone_id, name, type, value_hash) DO UPDATE SET ttl = EXCLUDED.ttl, updated_at = now()`,
      [
        uuidv7(),
        orgId,
        zoneId,
        r.name,
        r.type,
        r.ttl,
        JSON.stringify(r.value),
        hashValue(r),
        r.managedBy,
      ],
    );
  }

  async getZone(orgId: string, id: string): Promise<ZoneDto> {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    const z = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT z.*, (SELECT count(*)::int FROM domains.dns_records r WHERE r.zone_id = z.id) AS n, d.registrar_account_id, d.tld FROM domains.dns_zones z JOIN domains.domains d ON d.id = z.domain_id WHERE z.id = $1`,
            [id],
          )
        ).rows[0] as Row | undefined,
    );
    if (!z) throw new ProblemException('not_found');
    return this.dto(
      z,
      await this.dnssecAvailable(z.registrar_account_id as string, z.tld as string),
      z.n as number,
    );
  }
  private async dnssecAvailable(accountId: string, tld: string): Promise<boolean> {
    const a = await this.access.getAccount(accountId);
    return (
      !!a &&
      isSupported(a.capabilities, 'registrar.dnssec') &&
      a.tldSupport.find((t) => t.tld === tld)?.dnssec === 'supported'
    );
  }

  async listZones(orgId: string, q: { limit?: unknown; cursor?: unknown }) {
    const limit = parseLimit(q.limit);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT z.*, d.registrar_account_id, d.tld FROM domains.dns_zones z JOIN domains.domains d ON d.id = z.domain_id WHERE ($1::uuid IS NULL OR z.id < $1) ORDER BY z.id DESC LIMIT $2`,
            [decodeCursor(q.cursor), limit + 1],
          )
        ).rows as Row[],
    );
    const page = pageOf(rows as (Row & { id: string })[], limit);
    const items: ZoneDto[] = [];
    for (const z of page.items)
      items.push(
        this.dto(z, await this.dnssecAvailable(z.registrar_account_id as string, z.tld as string)),
      );
    return { items, nextCursor: page.nextCursor };
  }

  async records(orgId: string, zoneId: string, f: { name?: unknown; type?: unknown }) {
    if (!UUID.test(zoneId)) throw new ProblemException('not_found');
    return this.db.withOrg(orgId, async (c) => {
      const z = (await c.query(`SELECT version FROM domains.dns_zones WHERE id = $1`, [zoneId]))
        .rows[0] as Row | undefined;
      if (!z) throw new ProblemException('not_found');
      const rows = (
        await c.query(
          `SELECT * FROM domains.dns_records WHERE zone_id = $1 AND ($2::text IS NULL OR name = $2) AND ($3::text IS NULL OR type = $3) ORDER BY name, type, value_hash`,
          [
            zoneId,
            typeof f.name === 'string' ? f.name.toLowerCase() : null,
            typeof f.type === 'string' ? f.type.toUpperCase() : null,
          ],
        )
      ).rows as Row[];
      return {
        version: z.version as number,
        items: rows.map((r) => ({
          id: r.id as string,
          name: r.name as string,
          type: r.type as string,
          ttl: r.ttl as number,
          value: r.value as unknown,
          managedBy: r.managed_by as string,
        })),
      };
    });
  }

  // ---- change-set ---------------------------------------------------------------------------------------------------------------
  /** `writer` is `user` for the public API; DnsLinkagePort passes `linkage` / `email-verification` (the only way to write reserved names and Nuzm hosting targets). */
  async applyChangeSet(
    orgId: string,
    actor: string | null,
    zoneId: string,
    ifMatch: number | null,
    body: Record<string, unknown>,
    opts: { writer?: ManagedBy; traceId?: string } = {},
  ): Promise<ChangeSetResult> {
    const writer = opts.writer ?? 'user';
    if (!UUID.test(zoneId)) throw new ProblemException('not_found');
    const zone = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT z.*, d.name AS domain_name, d.registrar_account_id FROM domains.dns_zones z JOIN domains.domains d ON d.id = z.domain_id WHERE z.id = $1`,
            [zoneId],
          )
        ).rows[0] as Row | undefined,
    );
    if (!zone) throw new ProblemException('not_found');
    if (ifMatch === null)
      throw new ProblemException(
        'precondition_required',
        'send If-Match with the zone version you read',
      );
    if (!this.limiter.allow(`dns:${orgId}`, 60, 60_000))
      throw new ProblemException('rate_limited', 'too many DNS change-sets; try again in a minute');
    const lists = ['create', 'update', 'delete'] as const;
    for (const k of Object.keys(body))
      if (!(lists as readonly string[]).includes(k)) throw badRequest(`unknown field ${k}`);
    const inputs: DnsChangeInput[] = [];
    for (const k of ['delete', 'update', 'create'] as const) {
      const v = body[k];
      if (v === undefined) continue;
      if (!Array.isArray(v)) throw badRequest(`${k} must be a list`);
      for (const e of v as Record<string, unknown>[]) {
        if (k === 'create') inputs.push({ op: 'create', record: e as never });
        else if (k === 'delete') inputs.push({ op: 'delete', match: (e ?? {}) as never });
        else
          inputs.push({
            op: 'update',
            match: ((e ?? {}) as { match?: never }).match as never,
            record: ((e ?? {}) as { record?: never }).record as never,
          });
      }
    }
    if (inputs.length === 0 || inputs.length > 200)
      throw badRequest('a change-set holds 1..200 changes');

    if (zone.version !== ifMatch)
      throw new ProblemException('etag_mismatch', `the zone is at version ${String(zone.version)}`);
    if (zone.state === 'degraded')
      throw new ProblemException(
        'conflict',
        'this zone is degraded: a reconciliation must finish before it can be changed',
      );
    const existing = await this.loadRecords(orgId, zoneId);
    const v = validateChangeSet(zone.name as string, existing, inputs, {
      ...DEFAULT_DNS_OPTIONS,
      writer,
      maxRecords: this.cfg.maxRecordsPerZone,
      protectedTargetSuffixes: this.cfg.protectedTargetSuffixes,
    });
    if (!v.ok)
      throw new ProblemException(
        'record_invalid',
        'the change-set is invalid; nothing was applied',
        v.errors.map((e) => ({ index: e.index, code: e.code, field: e.field, message: e.message })),
      );

    const acc = this.access.accessFor(
      (await this.access.getAccount(zone.registrar_account_id as string))!,
      opts.traceId ?? 'dns',
    );
    if (!acc?.adapter.dns)
      throw new ProblemException(
        'unsupported_capability',
        'the registrar does not host DNS for this zone',
      );
    const dns = acc.adapter.dns;
    const adapterChanges: DnsChange[] = v.changes.map((c) => this.toAdapterChange(c));
    const expected = v.resulting.map(neutral);

    // snapshot = the registrar's ACTUAL zone (not our copy), the state a rollback must restore
    const snap = await dns.listZone(acc.ctx, zone.name as string);
    if (snap.status !== 'succeeded' || !snap.data)
      throw new ProblemException(
        'service_unavailable',
        'the registrar zone could not be read; nothing was changed',
      );
    const snapshot = snap.data.records;

    const applied = await dns.applyChangeSet(acc.ctx, zone.name as string, adapterChanges);
    const after = await dns.listZone(acc.ctx, zone.name as string);
    const verified =
      after.status === 'succeeded' && !!after.data && sameSet(after.data.records, expected);
    if (applied.status === 'succeeded' && applied.data?.outcome === 'applied' && verified) {
      const version = await this.commit(
        orgId,
        actor,
        zoneId,
        ifMatch,
        v.resulting,
        existing,
        adapterChanges.length,
      );
      return {
        outcome: 'applied',
        results: v.changes.map((c, index) => ({ index, op: c.op, status: 'applied' as const })),
        version,
      };
    }
    // not applied as a whole, or applied but not what we asked for: restore the snapshot (atomic adapters reject, so this is a no-op re-read for them)
    const perChange =
      applied.data?.results ??
      adapterChanges.map((_, index) => ({ index, status: 'skipped' as const }));
    const stillSnapshot =
      after.status === 'succeeded' && !!after.data && sameSet(after.data.records, snapshot);
    let restored = stillSnapshot;
    if (!restored)
      restored = await this.rollback(
        acc,
        zone.name as string,
        snapshot,
        after.status === 'succeeded' && after.data ? after.data.records : null,
      );
    if (restored) {
      await this.audit.record({
        action: 'dns.changeset.rolled_back',
        orgId,
        actorUserId: actor ?? undefined,
        resource: { type: 'dns_zone', id: zoneId },
        outcome: 'failure',
        detail: {
          changes: adapterChanges.length,
          atomic: dns.atomicChangeSet,
          applied: perChange.filter((r) => r.status === 'applied').length,
        },
      });
      throw new ProblemException(
        'conflict',
        'the registrar did not apply the whole change-set; the zone was restored and nothing changed',
        undefined,
        { outcome: 'rolled_back', results: perChange, version: ifMatch },
      );
    }
    await this.markDegraded(orgId, actor, zoneId, zone.name as string);
    throw new ProblemException(
      'service_unavailable',
      'the registrar did not apply the change-set and the zone could not be restored; it is marked degraded and a reconciliation is open',
      undefined,
      { outcome: 'degraded', results: perChange },
    );
  }

  private toAdapterChange(c: DnsNormalizedChange): DnsChange {
    if (c.op === 'create') return { op: 'create', record: neutral(c.record) };
    if (c.op === 'update') return { op: 'update', match: c.match, record: neutral(c.record) };
    return { op: 'delete', match: c.match };
  }

  /** Brings the registrar's zone back to `snapshot` by the minimal inverse change-set, then VERIFIES by re-reading. */
  private async rollback(
    acc: AccountAccess,
    zone: string,
    snapshot: DnsRecordData[],
    current: DnsRecordData[] | null,
  ): Promise<boolean> {
    const dns = acc.adapter.dns!;
    let cur = current;
    if (!cur) {
      const r = await dns.listZone(acc.ctx, zone);
      if (r.status !== 'succeeded' || !r.data) return false;
      cur = r.data.records;
    }
    const want = new Map(snapshot.map((r) => [sig(r), r]));
    const have = new Map(cur.map((r) => [sig(r), r]));
    const undo: DnsChange[] = [];
    for (const [k, r] of have)
      if (!want.has(k)) undo.push({ op: 'delete', match: { name: r.name, type: r.type } });
    // a delete by (name,type) removes every value at that name/type: re-create the snapshot records of those pairs afterwards
    const touched = new Set(
      undo.map((u) => (u.op === 'delete' ? `${u.match.name}|${u.match.type}` : '')),
    );
    for (const [k, r] of want)
      if (!have.has(k) || touched.has(`${r.name}|${r.type}`))
        undo.push({ op: 'create', record: r });
    if (undo.length === 0) return true;
    const r = await dns.applyChangeSet(acc.ctx, zone, undo);
    void r;
    const check = await dns.listZone(acc.ctx, zone);
    return check.status === 'succeeded' && !!check.data && sameSet(check.data.records, snapshot);
  }

  private async markDegraded(orgId: string, actor: string | null, zoneId: string, name: string) {
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `UPDATE domains.dns_zones SET state='degraded', degraded=true, version=version+1, updated_at=now() WHERE id=$1`,
        [zoneId],
      ),
    );
    const op = await this.ops.create(orgId, {
      kind: OP_DNS_RECONCILE,
      input: { zoneId },
      resourceKind: 'dns_zone',
      resourceId: zoneId,
      traceId: 'dns-degraded',
    });
    const w = 'dns-degraded';
    if (await this.ops.claimById(orgId, op.id, w))
      await this.ops.markNeedsReconcile(orgId, op.id, w, 'rollback_unverified');
    await this.audit.record({
      action: 'dns.zone.degraded',
      orgId,
      actorUserId: actor ?? undefined,
      resource: { type: 'dns_zone', id: zoneId },
      outcome: 'failure',
      detail: { zone: name },
    });
  }

  /**
   * Reconciles a zone with the registrar: the registrar's live zone wins (it is what is served). Clears `degraded`, replaces our copy, finishes the open operation.
   * Returns what happened.
   */
  async reconcileZone(
    orgId: string,
    zoneId: string,
    traceId = 'dns-reconcile',
  ): Promise<'in_sync' | 'adopted' | 'unreachable'> {
    const zone = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT z.*, d.registrar_account_id FROM domains.dns_zones z JOIN domains.domains d ON d.id = z.domain_id WHERE z.id = $1`,
            [zoneId],
          )
        ).rows[0] as Row | undefined,
    );
    if (!zone) throw new ProblemException('not_found');
    const acc = this.access.accessFor(
      (await this.access.getAccount(zone.registrar_account_id as string))!,
      traceId,
    );
    if (!acc?.adapter.dns) return 'unreachable';
    const live = await acc.adapter.dns.listZone(acc.ctx, zone.name as string);
    if (live.status !== 'succeeded' || !live.data) return 'unreachable';
    const mine = await this.loadRecords(orgId, zoneId);
    const liveRecords: DnsRecord[] = [];
    for (const r of live.data.records) {
      const v = validateChangeSet(
        zone.name as string,
        [],
        [
          {
            op: 'create',
            record: {
              name: r.name,
              type: r.type,
              ttl: Math.min(86400, Math.max(60, r.ttl)),
              value: r.value,
              managedBy: 'user',
            },
          },
        ],
        { writer: 'linkage', maxRecords: 100000 },
      );
      if (v.ok) liveRecords.push(v.resulting[0]!);
    }
    const same = sameSet(mine.map(neutral), liveRecords.map(neutral));
    if (same && !zone.degraded) return 'in_sync';
    const managed = new Map(mine.map((m) => [sig(neutral(m)), m.managedBy]));
    await this.db.withOrg(orgId, async (c) => {
      await c.query(`DELETE FROM domains.dns_records WHERE zone_id = $1`, [zoneId]);
      for (const r of liveRecords)
        await this.insertRecord(c, orgId, zoneId, {
          ...r,
          managedBy: managed.get(sig(neutral(r))) ?? 'user',
        });
      await c.query(
        `UPDATE domains.dns_zones SET state='active', degraded=false, version=version+1, updated_at=now() WHERE id=$1`,
        [zoneId],
      );
      // finish the open reconcile operation of this zone
      const op = (
        await c.query(
          `SELECT id FROM platform.operations WHERE kind=$1 AND resource_id=$2 AND state='needs_reconcile' LIMIT 1`,
          [OP_DNS_RECONCILE, zoneId],
        )
      ).rows[0] as Row | undefined;
      if (op)
        await c.query(
          `UPDATE platform.operations SET state='succeeded', result=$2, lease_owner=NULL, lease_expires_at=NULL, version=version+1, updated_at=now() WHERE id=$1`,
          [op.id, JSON.stringify({ reconciled: true })],
        );
    });
    await this.audit.record({
      action: 'dns.zone.reconciled',
      orgId,
      resource: { type: 'dns_zone', id: zoneId },
      outcome: 'success',
      detail: { records: liveRecords.length },
    });
    return 'adopted';
  }

  private async loadRecords(orgId: string, zoneId: string): Promise<DnsRecord[]> {
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT name, type, ttl, value, managed_by FROM domains.dns_records WHERE zone_id = $1`,
            [zoneId],
          )
        ).rows as Row[],
    );
    return rows.map((r) => ({
      name: r.name as string,
      type: r.type as DnsRecord['type'],
      ttl: r.ttl as number,
      value: r.value as unknown,
      managedBy: r.managed_by as ManagedBy,
    }));
  }

  private async commit(
    orgId: string,
    actor: string | null,
    zoneId: string,
    ifMatch: number,
    resulting: DnsRecord[],
    before: DnsRecord[],
    n: number,
  ): Promise<number> {
    const keep = new Set(resulting.map((r) => `${recordKey(r)}|${hashValue(r)}`));
    const version = await this.db.withOrg(orgId, async (c) => {
      const z = (
        await c.query(`SELECT version FROM domains.dns_zones WHERE id=$1 FOR UPDATE`, [zoneId])
      ).rows[0] as Row;
      if (z.version !== ifMatch)
        throw new ProblemException(
          'etag_mismatch',
          'the zone changed while the change-set was running',
        );
      for (const b of before)
        if (!keep.has(`${recordKey(b)}|${hashValue(b)}`))
          await c.query(
            `DELETE FROM domains.dns_records WHERE zone_id=$1 AND name=$2 AND type=$3 AND value_hash=$4`,
            [zoneId, b.name, b.type, hashValue(b)],
          );
      for (const r of resulting) await this.insertRecord(c, orgId, zoneId, r);
      const up = (
        await c.query(
          `UPDATE domains.dns_zones SET version = version + 1, updated_at = now() WHERE id=$1 RETURNING version`,
          [zoneId],
        )
      ).rows[0] as Row;
      await enqueue(c, orgId, 'resource.state_changed', {
        resourceKind: 'dns_zone',
        resourceId: zoneId,
        state: 'active',
      });
      return up.version as number;
    });
    await this.audit.record({
      action: 'dns.changeset.applied',
      orgId,
      actorUserId: actor ?? undefined,
      resource: { type: 'dns_zone', id: zoneId },
      outcome: 'success',
      detail: { changes: n, version },
    });
    return version;
  }
}
