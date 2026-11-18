import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { FieldCipher } from '../../../common/field-crypto';
import { decodeCursor, pageOf } from '../../../common/pagination';
import { SlidingWindowLimiter } from '../../../common/rate-limit';
import { isUuid, type BuilderConfig, type Row } from './model';

export abstract class FormNotifier {
  /** Called after a stored submission when the form has a notification address. M08 email is a SOFT dependency: the default sends nothing (NOT VERIFIED live). */
  abstract notify(
    orgId: string,
    formName: string,
    to: string,
    fields: Record<string, string>,
  ): Promise<boolean>;
}
export class NoopFormNotifier extends FormNotifier {
  async notify() {
    return false;
  }
}
const FIELD_TYPES = ['text', 'email', 'tel', 'textarea'];
const EMAIL = /^[^@\s<>"]{1,64}@[^@\s<>"]{1,200}$/;
const HONEYPOT = 'website_url';

export interface FormDto {
  id: string;
  projectId: string;
  formKey: string;
  name: string;
  fields: unknown;
  enabled: boolean;
  retentionDays: number;
  notifyEmailSet: boolean;
  submissions: number;
  spamBlocked: number;
  endpoint: string;
}

/**
 * Forms and submissions (M09 S41.2). The published site posts to the Nuzm-hosted ingest endpoint: honeypot (a filled `website_url` is accepted silently and counted as
 * spam), per-IP rate limit, body size and field limits, no third-party trackers. A submission is sealed with field encryption (`personal`), carries a salted IP hash (never
 * the address) and an expiry (retention). Viewers see masked values; `builder:submissions:read` sees them.
 */
export class FormsService {
  private readonly limiter = new SlidingWindowLimiter();
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly cipher: FieldCipher,
    private readonly notifier: FormNotifier,
    private readonly cfg: BuilderConfig,
  ) {}
  private dto(r: Row, n: number): FormDto {
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      formKey: r.form_key as string,
      name: r.name as string,
      fields: r.fields,
      enabled: r.enabled as boolean,
      retentionDays: r.retention_days as number,
      notifyEmailSet: r.notify_email_enc !== null,
      submissions: n,
      spamBlocked: Number(r.spam_count),
      endpoint: `${this.cfg.formsBaseUrl}/p/${r.project_id}/v1/public/forms/${r.form_key}`,
    };
  }
  async list(orgId: string, projectId: string) {
    if (!isUuid(projectId)) throw new ProblemException('not_found');
    return this.db.withOrg(orgId, async (c) => {
      if (
        !(
          await c.query(`SELECT 1 FROM builder.projects WHERE id=$1 AND deleted_at IS NULL`, [
            projectId,
          ])
        ).rows[0]
      )
        throw new ProblemException('not_found');
      const rows = (
        await c.query(
          `SELECT f.*, (SELECT count(*) FROM builder.form_submissions s WHERE s.form_id = f.id) AS n FROM builder.forms f WHERE f.project_id=$1 ORDER BY f.form_key`,
          [projectId],
        )
      ).rows as Row[];
      return { items: rows.map((r) => this.dto(r, Number(r.n))) };
    });
  }
  async create(
    orgId: string,
    userId: string,
    projectId: string,
    b: Record<string, unknown>,
  ): Promise<FormDto> {
    if (!isUuid(projectId)) throw new ProblemException('not_found');
    if (
      !(await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(`SELECT 1 FROM builder.projects WHERE id=$1 AND deleted_at IS NULL`, [
              projectId,
            ])
          ).rows[0],
      ))
    )
      throw new ProblemException('not_found');
    const key = b.formKey;
    if (typeof key !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(key))
      throw new ProblemException('validation_failed', 'formKey must be a lower-case slug');
    const name =
      typeof b.name === 'string' && b.name.length >= 1 && b.name.length <= 80 ? b.name : null;
    if (!name) throw new ProblemException('validation_failed', 'name must be 1..80 characters');
    const fields = b.fields;
    if (
      !Array.isArray(fields) ||
      fields.length < 1 ||
      fields.length > 12 ||
      fields.some(
        (f: { name?: unknown; type?: unknown }) =>
          typeof f?.name !== 'string' ||
          !/^[a-z][a-z0-9_]{0,29}$/.test(f.name) ||
          f.name === HONEYPOT ||
          !FIELD_TYPES.includes(String(f.type)),
      )
    )
      throw new ProblemException(
        'validation_failed',
        'fields must be 1..12 of {name, type: text|email|tel|textarea}',
      );
    const retention =
      b.retentionDays === undefined ? this.cfg.formRetentionDays : Number(b.retentionDays);
    if (!Number.isInteger(retention) || retention < 1 || retention > 3650)
      throw new ProblemException('validation_failed', 'retentionDays must be 1..3650');
    const notify = b.notifyEmail;
    if (
      notify !== undefined &&
      notify !== null &&
      (typeof notify !== 'string' || !EMAIL.test(notify))
    )
      throw new ProblemException('validation_failed', 'notifyEmail must be an email address');
    const id = uuidv7();
    const sealed =
      typeof notify === 'string'
        ? await this.cipher.encrypt(notify, { column: 'builder.forms.notify_email_enc', row: id })
        : null;
    try {
      const row = await this.db.withOrg(orgId, async (c) => {
        if (
          !(
            await c.query(`SELECT 1 FROM builder.projects WHERE id=$1 AND deleted_at IS NULL`, [
              projectId,
            ])
          ).rows[0]
        )
          throw new ProblemException('not_found');
        return (
          await c.query(
            `INSERT INTO builder.forms (id, org_id, project_id, form_key, name, fields, notify_email_enc, retention_days, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [id, orgId, projectId, key, name, JSON.stringify(fields), sealed, retention, userId],
          )
        ).rows[0] as Row;
      });
      await this.audit.record({
        action: 'builder.form.created',
        actorUserId: userId,
        actorType: 'user',
        orgId,
        resource: { type: 'builder_form', id },
        outcome: 'success',
      });
      return this.dto(row, 0);
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException('name_taken', 'a form with this key exists in the project');
      throw e;
    }
  }
  async submissions(
    orgId: string,
    projectId: string,
    o: { formId?: string; limit: number; cursor?: string },
    unmasked: boolean,
  ) {
    if (!isUuid(projectId)) throw new ProblemException('not_found');
    const cur = decodeCursor(o.cursor);
    const rows = await this.db.withOrg(orgId, async (c) => {
      if (!(await c.query(`SELECT 1 FROM builder.projects WHERE id=$1`, [projectId])).rows[0])
        throw new ProblemException('not_found');
      return (
        await c.query(
          `SELECT s.*, f.form_key FROM builder.form_submissions s JOIN builder.forms f ON f.id = s.form_id WHERE s.project_id=$1 AND ($2::uuid IS NULL OR s.form_id=$2) AND ($3::uuid IS NULL OR s.id < $3) ORDER BY s.id DESC LIMIT $4`,
          [projectId, o.formId ?? null, cur, o.limit + 1],
        )
      ).rows as Row[];
    });
    const page = pageOf(rows as (Row & { id: string })[], o.limit);
    const items = await Promise.all(
      page.items.map(async (r) => {
        const payload = await this.cipher.decryptJson<Record<string, string>>(
          r.payload_enc as string,
          { column: 'builder.form_submissions.payload_enc', row: r.id as string },
        );
        const fields = unmasked
          ? payload
          : Object.fromEntries(Object.keys(payload).map((k) => [k, '••••••']));
        return {
          id: r.id as string,
          formId: r.form_id as string,
          formKey: r.form_key as string,
          fields,
          masked: !unmasked,
          classification: 'personal',
          createdAt: new Date(r.created_at as string).toISOString(),
          expiresAt: new Date(r.expires_at as string).toISOString(),
        };
      }),
    );
    if (unmasked && items.length)
      await this.audit.record({
        action: 'builder.submission.read',
        actorType: 'user',
        orgId,
        resource: { type: 'builder_project', id: projectId },
        outcome: 'success',
        detail: { count: items.length },
      });
    return { items, nextCursor: page.nextCursor };
  }

  /** The public ingest. Returns the HTTP status to answer; never reveals whether a form exists beyond 404. */
  async ingest(
    projectId: string,
    formKey: string,
    body: unknown,
    ip: string,
    contentLength: number,
  ): Promise<{ status: 202 | 404 | 413 | 422 | 429; code?: string }> {
    if (!isUuid(projectId) || !/^[a-z][a-z0-9_-]{0,39}$/.test(formKey)) return { status: 404 };
    if (contentLength > this.cfg.formMaxBytes) return { status: 413, code: 'payload_too_large' };
    const form = await this.db.withAuthScope(
      'public_form',
      async (c) =>
        (
          await c.query(
            `SELECT f.* FROM builder.forms f JOIN builder.projects p ON p.id = f.project_id WHERE f.project_id=$1 AND f.form_key=$2 AND f.enabled AND p.deleted_at IS NULL`,
            [projectId, formKey],
          )
        ).rows[0] as Row | undefined,
    );
    if (!form) return { status: 404 };
    const orgId = form.org_id as string;
    const ipHash = createHash('sha256').update(`${this.cfg.ipHashSalt}|${ip}`).digest('hex');
    if (!this.limiter.allow(`${form.id}|${ipHash}`, this.cfg.formRatePerMinute, 60_000))
      return { status: 429, code: 'rate_limited' };
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      JSON.stringify(body).length > this.cfg.formMaxBytes
    )
      return { status: 422, code: 'validation_failed' };
    const data = body as Record<string, unknown>;
    if (typeof data[HONEYPOT] === 'string' && (data[HONEYPOT] as string).length > 0) {
      await this.db.withOrg(orgId, (c) =>
        c.query(`UPDATE builder.forms SET spam_count = spam_count + 1 WHERE id=$1`, [form.id]),
      );
      return { status: 202 }; // accepted silently: a bot learns nothing
    }
    const spec = form.fields as { name: string; type: string; required?: boolean }[];
    const clean: Record<string, string> = {};
    for (const f of spec) {
      const v = data[f.name];
      if (v === undefined || v === '') {
        if (f.required) return { status: 422, code: 'validation_failed' };
        continue;
      }
      if (
        typeof v !== 'string' ||
        v.length > 4000 ||
        (f.type === 'email' && !EMAIL.test(v)) ||
        (f.type === 'tel' && !/^\+?[0-9 ()-]{5,24}$/.test(v))
      )
        return { status: 422, code: 'validation_failed' };
      clean[f.name] = v;
    }
    if (Object.keys(data).some((k) => k !== HONEYPOT && !spec.some((f) => f.name === k)))
      return { status: 422, code: 'validation_failed' };
    const id = uuidv7();
    const sealed = await this.cipher.encryptJson(clean, {
      column: 'builder.form_submissions.payload_enc',
      row: id,
    });
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `INSERT INTO builder.form_submissions (id, org_id, project_id, form_id, payload_enc, ip_hash, data_region, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(days => $8))`,
        [id, orgId, projectId, form.id, sealed, ipHash, this.cfg.dataRegion, form.retention_days],
      ),
    );
    if (form.notify_email_enc) {
      try {
        const to = await this.cipher.decrypt(form.notify_email_enc as string, {
          column: 'builder.forms.notify_email_enc',
          row: form.id as string,
        });
        if (await this.notifier.notify(orgId, form.name as string, to, clean))
          await this.db.withOrg(orgId, (c) =>
            c.query(`UPDATE builder.form_submissions SET notified=true WHERE id=$1`, [id]),
          );
      } catch {
        /* a failed notification never loses the submission */
      }
    }
    return { status: 202 };
  }
  /** Retention: expired submissions are deleted. Returns how many. */
  async purgeExpired(): Promise<number> {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT DISTINCT org_id FROM builder.form_submissions WHERE expires_at < now()`,
          )
        ).rows as Row[],
    );
    let n = 0;
    for (const r of rows)
      n += await this.db.withOrg(
        r.org_id as string,
        async (c) =>
          (await c.query(`DELETE FROM builder.form_submissions WHERE expires_at < now()`))
            .rowCount ?? 0,
      );
    return n;
  }
}
