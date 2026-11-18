import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';
import { isUuid, type DataRow as Row } from '../../data';
import { parseAddress, prepareTemplate, type TemplateDef, type VariableSchema } from './template';

const iso = (v: unknown) => (v ? (v as Date).toISOString() : null);
export interface SenderDto {
  id: string;
  domainId: string;
  fromAddress: string;
  status: 'pending' | 'verified' | 'disabled';
  verifiedAt: string | null;
  createdAt: string;
}
export interface TemplateDto {
  id: string;
  key: string;
  version: number;
  name: string;
  locale: 'ar' | 'en';
  direction: 'rtl' | 'ltr';
  subject: string;
  html: string;
  text: string | null;
  variables: VariableSchema;
  createdAt: string;
}

/**
 * Sender identities (anti-spoofing: only an address of a domain the organization VERIFIED can be a `from`) and versioned templates (HTML sanitized at save,
 * variables declared, Arabic = RTL). A template version is immutable (database trigger): a change is a new version.
 */
export class SenderTemplateService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  senderDto(r: Row): SenderDto {
    return {
      id: r.id as string,
      domainId: r.domain_id as string,
      fromAddress: r.from_address as string,
      status: r.state as SenderDto['status'],
      verifiedAt: iso(r.verified_at),
      createdAt: iso(r.created_at)!,
    };
  }
  async createSender(
    orgId: string,
    actor: string,
    body: Record<string, unknown>,
  ): Promise<SenderDto> {
    if (Object.keys(body).some((k) => !['domainId', 'fromAddress'].includes(k)))
      throw new ProblemException('validation_failed', 'unknown field');
    if (!isUuid(body.domainId))
      throw new ProblemException('validation_failed', 'domainId is required');
    const from = parseAddress(body.fromAddress);
    const d = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM email.email_domains WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
            [body.domainId, orgId],
          )
        ).rows[0],
    )) as Row | undefined;
    if (!d) throw new ProblemException('not_found', 'domain not found');
    if (!(d.purposes as string[]).includes('transactional'))
      throw new ProblemException(
        'validation_failed',
        'the domain was not added for transactional email',
      );
    if (from.split('@')[1] !== d.domain)
      throw new ProblemException(
        'validation_failed',
        'the address must belong to the selected domain',
      );
    const verified = d.verification_state === 'verified';
    try {
      const row = (await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `INSERT INTO email.sender_identities (id, org_id, domain_id, from_address, state, verified_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
              [
                uuidv7(),
                orgId,
                d.id,
                from,
                verified ? 'verified' : 'pending',
                verified ? new Date() : null,
                actor,
              ],
            )
          ).rows[0],
      )) as Row;
      await this.audit.record({
        action: 'email.sender.created',
        actorUserId: actor,
        orgId,
        resource: { type: 'sender_identity', id: row.id as string },
        outcome: 'success',
        after: { domain: d.domain, state: row.state },
      });
      return this.senderDto(row);
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException('conflict', 'this sender identity already exists');
      throw e;
    }
  }
  async listSenders(
    orgId: string,
    q: { limit: number; cursor?: string },
  ): Promise<Page<SenderDto>> {
    const before = decodeCursor(q.cursor);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM email.sender_identities WHERE org_id = $1 AND ($2::uuid IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
            [orgId, before, q.limit + 1],
          )
        ).rows as Row[],
    );
    const p = pageOf(rows as (Row & { id: string })[], q.limit);
    return { items: p.items.map((r) => this.senderDto(r)), nextCursor: p.nextCursor };
  }

  templateDto(r: Row): TemplateDto {
    return {
      id: r.id as string,
      key: r.key as string,
      version: r.version as number,
      name: r.name as string,
      locale: r.locale as 'ar' | 'en',
      direction: r.direction as 'rtl' | 'ltr',
      subject: r.subject as string,
      html: r.html as string,
      text: (r.body_text as string | null) ?? null,
      variables: r.variables as VariableSchema,
      createdAt: iso(r.created_at)!,
    };
  }
  /** POST: a new template (version 1) or a NEW VERSION of an existing key. The html is sanitized; every placeholder must be declared. */
  async createTemplate(
    orgId: string,
    actor: string,
    body: Record<string, unknown>,
  ): Promise<TemplateDto> {
    if (
      Object.keys(body).some(
        (k) => !['key', 'name', 'locale', 'subject', 'html', 'text', 'variables'].includes(k),
      )
    )
      throw new ProblemException('validation_failed', 'unknown field');
    if (typeof body.key !== 'string' || !/^[a-z][a-z0-9_-]{1,62}$/.test(body.key))
      throw new ProblemException('validation_failed', 'key must be a lower-case slug');
    if (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 120)
      throw new ProblemException('validation_failed', 'name must be 1..120 characters');
    if (body.locale !== 'ar' && body.locale !== 'en')
      throw new ProblemException('validation_failed', 'locale must be ar or en');
    const def: TemplateDef = prepareTemplate({
      subject: body.subject,
      html: body.html,
      text: body.text,
      variables: body.variables,
    });
    const row = (await this.db.withOrg(orgId, async (c) => {
      const v =
        Number(
          (
            await c.query(
              `SELECT coalesce(max(version), 0) v FROM email.templates WHERE org_id = $1 AND key = $2`,
              [orgId, body.key],
            )
          ).rows[0]!.v,
        ) + 1;
      return (
        await c.query(
          `INSERT INTO email.templates (id, org_id, key, version, name, locale, direction, subject, html, body_text, variables, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [
            uuidv7(),
            orgId,
            body.key,
            v,
            body.name,
            body.locale,
            body.locale === 'ar' ? 'rtl' : 'ltr',
            def.subject,
            def.html,
            def.text,
            JSON.stringify(def.variables),
            actor,
          ],
        )
      ).rows[0];
    })) as Row;
    await this.audit.record({
      action: 'email.template.created',
      actorUserId: actor,
      orgId,
      resource: { type: 'template', id: row.id as string },
      outcome: 'success',
      after: { key: body.key, version: row.version, locale: body.locale },
    });
    return this.templateDto(row);
  }
  async listTemplates(
    orgId: string,
    q: { limit: number; cursor?: string; key?: string },
  ): Promise<Page<TemplateDto>> {
    const before = decodeCursor(q.cursor);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM email.templates WHERE org_id = $1 AND ($2::uuid IS NULL OR id < $2) AND ($3::text IS NULL OR key = $3) ORDER BY id DESC LIMIT $4`,
            [orgId, before, q.key ?? null, q.limit + 1],
          )
        ).rows as Row[],
    );
    const p = pageOf(rows as (Row & { id: string })[], q.limit);
    return { items: p.items.map((r) => this.templateDto(r)), nextCursor: p.nextCursor };
  }
  async getTemplate(orgId: string, id: unknown): Promise<Row> {
    if (!isUuid(id)) throw new ProblemException('validation_failed', 'templateId must be a uuid');
    const r = (await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM email.templates WHERE id = $1 AND org_id = $2`, [id, orgId]))
          .rows[0],
    )) as Row | undefined;
    if (!r) throw new ProblemException('not_found', 'template not found');
    return r;
  }
}
