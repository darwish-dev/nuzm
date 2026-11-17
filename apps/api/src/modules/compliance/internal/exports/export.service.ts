import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import type { FieldCipher } from '../../../../common/field-crypto';
import { decodeCursor, pageOf, type Page } from '../../../../common/pagination';
import type { DsrHandler, HandlerResult } from '../dsr/handlers';
import { parseSubject, type DsrConfig, type Subject } from '../dsr/types';
import { selfRef } from '../consent.service';
import type { ExportSink } from './export-sink';

export const EXPORT_KIND = 'compliance.data_export';
const KEY_COLUMN = 'platform.operations.result.dataKey';
const LINK_COLUMN = 'compliance.data_export.link';
type Row = Record<string, unknown>;
const SUBJECT = /^[A-Za-z0-9:_.-]{1,128}$/;

export interface ExportDto {
  id: string;
  scope: 'org' | 'user';
  subjectRef: string | null;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'expired';
  requestedAt: string;
  expiresAt: string | null;
  bytes: number | null;
  sha256: string | null;
  downloadUrl: string | null;
  dsrRequestId: string | null;
}
export interface ArchiveInput {
  orgId: string;
  subject: Subject;
  results: { handler: string; result: HandlerResult }[];
  now: Date;
}

/** One handler's data, or the reason it has none, as written into the archive. */
const section = (r: HandlerResult) =>
  r.outcome === 'done'
    ? (r.data ?? r.summary)
    : { notIncluded: r.outcome === 'refused' ? r.reason : 'not_applicable' };

/**
 * Data exports (M04 §4 task 11, docs/10 §4). An export is a `platform.operations` record plus an encrypted archive in the ExportSink (no table of its
 * own: docs/05 §4). The archive is gzip(JSON) sealed with AES-256-GCM under a random per-export key; that key is itself sealed with the vault-backed
 * field cipher, so the stored bytes open only with the vault key. The download link is a sealed, expiring token bound to the organization:
 * another organization's link does not open. A finished archive expires too.
 */
export class ExportService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly sink: ExportSink,
    private readonly cipher: FieldCipher,
    private readonly cfg: DsrConfig,
    private readonly handlers: () => DsrHandler[],
    private readonly clock: () => Date = () => new Date(),
  ) {}

  sinkAvailable() {
    return this.sink.available();
  }

  /** Request an export (202): needs a sink (422 `no_export_sink`), at most `max_concurrent` in progress per organization (422 `quota_exceeded`). */
  async request(
    orgId: string,
    actorUserId: string,
    idempotencyKey: string,
    body: Record<string, unknown>,
  ): Promise<{ export: ExportDto; created: boolean }> {
    const scope = body.scope;
    if (scope !== 'org' && scope !== 'user')
      throw new ProblemException('validation_failed', "scope must be 'org' or 'user'");
    let subjectRef: string | null = null;
    if (scope === 'user') {
      subjectRef =
        body.subjectRef === undefined || body.subjectRef === null
          ? selfRef(actorUserId)
          : (body.subjectRef as string);
      if (typeof subjectRef !== 'string' || !SUBJECT.test(subjectRef))
        throw new ProblemException('validation_failed', 'subjectRef must be an opaque id');
    } else if (body.subjectRef !== undefined && body.subjectRef !== null)
      throw new ProblemException('validation_failed', 'subjectRef is only for scope user');
    if (!this.sink.available())
      throw new ProblemException(
        'no_export_sink',
        'no export sink is configured in this deployment',
      );
    const now = this.clock();
    return this.db.withOrg(orgId, async (c) => {
      const replay = (
        await c.query(
          `SELECT * FROM platform.operations WHERE kind = $1 AND org_id = $2 AND idempotency_key = $3`,
          [EXPORT_KIND, orgId, `${actorUserId}:${idempotencyKey}`],
        )
      ).rows[0];
      if (replay) return { export: this.dto(replay, now), created: false };
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `export-quota:${orgId}`,
      ]);
      const active = Number(
        (
          await c.query(
            `SELECT count(*) n FROM platform.operations WHERE kind = $1 AND state IN ('pending','running','needs_reconcile','waiting_provider')`,
            [EXPORT_KIND],
          )
        ).rows[0].n,
      );
      if (active >= this.cfg.maxConcurrentExports)
        throw new ProblemException(
          'quota_exceeded',
          `at most ${this.cfg.maxConcurrentExports} exports can be in progress at once`,
        );
      const row = (
        await c.query(
          `INSERT INTO platform.operations (id, org_id, kind, input, resource_kind, created_by, idempotency_key)
           VALUES ($1,$2,$3,$4::jsonb,'data_export',$5,$6) RETURNING *`,
          [
            uuidv7(),
            orgId,
            EXPORT_KIND,
            JSON.stringify({ scope, subjectRef }),
            actorUserId,
            `${actorUserId}:${idempotencyKey}`,
          ],
        )
      ).rows[0]!;
      await this.audit.record({
        action: 'compliance.export.requested',
        actorUserId,
        orgId,
        resource: { type: 'data_export', id: row.id as string },
        outcome: 'success',
        after: { scope, subjectRef },
      });
      return { export: this.dto(row, now), created: true };
    });
  }

  /** Build, seal and store the archive for a claimed export operation. Returns the operation result. */
  async build(op: {
    orgId: string;
    id: string;
    input: { scope: 'org' | 'user'; subjectRef: string | null; dsrRequestId?: string };
  }): Promise<Record<string, unknown>> {
    const subject: Subject =
      op.input.scope === 'org' ? { kind: 'org' } : parseSubject(op.input.subjectRef!);
    const results: ArchiveInput['results'] = [];
    for (const h of this.handlers())
      results.push({
        handler: h.name,
        result: await h.export({ orgId: op.orgId, subject, now: this.clock(), db: this.db }),
      });
    return this.store({ orgId: op.orgId, subject, results, now: this.clock() }, op.id);
  }

  /** Seal and store an archive from handler results (also used by the DSR processor for access and portability requests). */
  async store(a: ArchiveInput, opId: string): Promise<Record<string, unknown>> {
    const doc = {
      generatedAt: a.now.toISOString(),
      organization: a.orgId,
      subject:
        a.subject.kind === 'member'
          ? `member:${a.subject.userId}`
          : a.subject.kind === 'org'
            ? 'org'
            : a.subject.ref,
      sections: Object.fromEntries(a.results.map((r) => [r.handler, section(r.result)])),
    };
    const plain = gzipSync(Buffer.from(JSON.stringify(doc), 'utf8'));
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(Buffer.from(`${a.orgId}|${opId}`, 'utf8'));
    const sealed = Buffer.concat([iv, c.update(plain), c.final(), c.getAuthTag()]);
    const ref = await this.sink.put(`${a.orgId}_${opId}.enc`, sealed);
    return {
      sinkRef: ref,
      bytes: sealed.length,
      sha256: createHash('sha256').update(sealed).digest('hex'),
      keyEnc: await this.cipher.encrypt(key.toString('base64'), { column: KEY_COLUMN, row: opId }),
      expiresAt: new Date(a.now.getTime() + this.cfg.archiveTtlHours * 3_600_000).toISOString(),
      sections: Object.fromEntries(a.results.map((r) => [r.handler, r.result.outcome])),
    };
  }

  /** Register a finished archive as a succeeded operation (for DSR access/portability requests). */
  async register(
    orgId: string,
    actorUserId: string,
    input: Record<string, unknown>,
    a: ArchiveInput,
  ): Promise<string> {
    const id = uuidv7();
    const result = await this.store(a, id);
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `INSERT INTO platform.operations (id, org_id, kind, state, input, result, resource_kind, created_by, attempts)
         VALUES ($1,$2,$3,'succeeded',$4::jsonb,$5::jsonb,'data_export',$6,1)`,
        [id, orgId, EXPORT_KIND, JSON.stringify(input), JSON.stringify(result), actorUserId],
      ),
    );
    return id;
  }

  private dto(r: Row, now: Date): ExportDto {
    const input = (r.input ?? {}) as {
      scope?: 'org' | 'user';
      subjectRef?: string | null;
      dsrRequestId?: string;
    };
    const res = (r.result ?? null) as {
      bytes?: number;
      sha256?: string;
      expiresAt?: string;
    } | null;
    const state = r.state as string;
    const expired =
      state === 'succeeded' && res?.expiresAt ? Date.parse(res.expiresAt) <= now.getTime() : false;
    return {
      id: r.id as string,
      scope: input.scope ?? 'user',
      subjectRef: input.subjectRef ?? null,
      status: expired
        ? 'expired'
        : state === 'succeeded'
          ? 'succeeded'
          : state === 'failed' || state === 'cancelled'
            ? 'failed'
            : state === 'pending'
              ? 'pending'
              : 'running',
      requestedAt: (r.created_at as Date).toISOString(),
      expiresAt: res?.expiresAt ?? null,
      bytes: res?.bytes ?? null,
      sha256: res?.sha256 ?? null,
      downloadUrl: null,
      dsrRequestId: input.dsrRequestId ?? null,
    };
  }

  /** The organization's exports, newest first; a finished, unexpired one carries a signed, expiring link (valid `link_ttl_seconds`). */
  async list(orgId: string, q: { limit: number; cursor?: unknown }): Promise<Page<ExportDto>> {
    const now = this.clock();
    const cursor = decodeCursor(q.cursor);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM platform.operations WHERE kind = $1 AND ($2::uuid IS NULL OR id < $2) ORDER BY id DESC LIMIT ${q.limit + 1}`,
            [EXPORT_KIND, cursor],
          )
        ).rows,
    );
    const items = await Promise.all(
      rows.map(async (r) => {
        const d = this.dto(r, now);
        if (d.status === 'succeeded')
          d.downloadUrl = `/v1/compliance/data-exports?download=${encodeURIComponent(await this.link(orgId, d.id, now))}`;
        return d;
      }),
    );
    return pageOf(items, q.limit);
  }

  /** A fresh signed link for a finished, unexpired archive; null otherwise (used by the data-subject request that produced it). */
  async linkIfLive(orgId: string, opId: string): Promise<string | null> {
    const now = this.clock();
    const op = (
      await this.db.withOrg(orgId, (c) =>
        c.query(`SELECT state, result FROM platform.operations WHERE id = $1 AND kind = $2`, [
          opId,
          EXPORT_KIND,
        ]),
      )
    ).rows[0];
    const res = (op?.result ?? null) as { expiresAt?: string } | null;
    if (
      !op ||
      op.state !== 'succeeded' ||
      !res?.expiresAt ||
      Date.parse(res.expiresAt) <= now.getTime()
    )
      return null;
    return this.link(orgId, opId, now);
  }

  private link(orgId: string, opId: string, now: Date) {
    return this.cipher.encryptJson(
      { op: opId, exp: now.getTime() + this.cfg.linkTtlSeconds * 1000 },
      { column: LINK_COLUMN, row: orgId },
    );
  }

  /** Open a link for THIS organization (another organization's token does not open: 404), refuse an expired link or archive (410), return the archive bytes. */
  async download(
    orgId: string,
    actorUserId: string,
    token: string,
    only: { dsrRequestId?: string } = {},
  ): Promise<{ bytes: Buffer; filename: string }> {
    const now = this.clock();
    let payload: { op: string; exp: number };
    try {
      payload = await this.cipher.decryptJson(token, { column: LINK_COLUMN, row: orgId });
    } catch {
      throw new ProblemException('not_found', 'export link not found');
    }
    if (typeof payload.op !== 'string' || typeof payload.exp !== 'number')
      throw new ProblemException('not_found', 'export link not found');
    if (payload.exp <= now.getTime())
      throw new ProblemException(
        'gone',
        'this download link has expired: request a new one from the export list',
      );
    const op = (
      await this.db.withOrg(orgId, (c) =>
        c.query(`SELECT * FROM platform.operations WHERE id = $1 AND kind = $2`, [
          payload.op,
          EXPORT_KIND,
        ]),
      )
    ).rows[0];
    if (!op || op.state !== 'succeeded')
      throw new ProblemException('not_found', 'export not found');
    // a link made for one data-subject request opens only that request's archive
    if (
      only.dsrRequestId !== undefined &&
      (op.input as { dsrRequestId?: string } | null)?.dsrRequestId !== only.dsrRequestId
    )
      throw new ProblemException('not_found', 'export not found');
    const res = op.result as { sinkRef: string; keyEnc: string; expiresAt: string };
    if (Date.parse(res.expiresAt) <= now.getTime())
      throw new ProblemException('gone', 'this export has expired');
    const sealed = await this.sink.get(res.sinkRef);
    const key = Buffer.from(
      await this.cipher.decrypt(res.keyEnc, { column: KEY_COLUMN, row: op.id as string }),
      'base64',
    );
    const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
    d.setAAD(Buffer.from(`${orgId}|${op.id as string}`, 'utf8'));
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    const gz = Buffer.concat([d.update(sealed.subarray(12, sealed.length - 16)), d.final()]);
    await this.audit.record({
      action: 'compliance.export.downloaded',
      actorUserId,
      orgId,
      resource: { type: 'data_export', id: op.id as string },
      outcome: 'success',
    });
    return { bytes: gz, filename: `export-${(op.id as string).slice(0, 8)}.json.gz` };
  }

  /** For tests and tools: the plain document of an archive. */
  static unzip(gz: Buffer): {
    generatedAt: string;
    organization: string;
    subject: string;
    sections: Record<string, unknown>;
  } {
    return JSON.parse(gunzipSync(gz).toString('utf8'));
  }
}
