import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import {
  idempotencyToken,
  orgTag,
  type TransactionalEmailAdapter,
  type VerifiedEmailEvent,
} from '@nuzm/adapter-data';
import { WebhookSignatureError } from '@nuzm/adapter-data';
import { emitUsage, usageEventId, type Db, type Operation } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { FieldCipher } from '../../../common/field-crypto';
import {
  decodeCursor,
  encodeTimeCursor,
  decodeTimeCursor,
  pageOf,
  type Page,
} from '../../../common/pagination';
import type { ResidencyService } from '../../compliance';
import {
  DataAdapterRegistry,
  DataAlerts,
  DataFlags,
  DataOperations,
  DataProviderService,
  DatabaseFlow,
  FlowFailure,
  FlowUncertain,
  OP,
  isUuid,
  outcomeOf,
  retryTransient,
  type DataConfig,
  type DataRow as Row,
} from '../../data';
import type { SenderTemplateService } from './sender-template.service';
import { addressHash, type SuppressionService } from './suppression.service';
import {
  hasControl,
  parseAddress,
  prepareTemplate,
  renderTemplate,
  type TemplateDef,
} from './template';

/** Proposals (D-34, D-31 and the M08 prompt): configuration with conservative defaults; none is a legal period or a provider recommendation. */
export interface EmailConfig {
  maxRecipients: number;
  ratePerMinute: number;
  warmupBasePerDay: number;
  maxPerDay: number;
  throttleBounceRate: number;
  throttleComplaintRate: number;
  throttleMinSample: number;
  softBounceThreshold: number;
  softBounceWindowHours: number;
  bodyRetentionDays: number;
  queueBufferHours: number;
  usageTolerancePct: number;
}
export const loadEmailConfig = (env: NodeJS.ProcessEnv = process.env): EmailConfig => {
  const n = (k: string, d: number) => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    maxRecipients: n('EMAIL_MAX_RECIPIENTS', 10),
    ratePerMinute: n('EMAIL_RATE_PER_MINUTE', 120),
    warmupBasePerDay: n('EMAIL_WARMUP_BASE_PER_DAY', 200),
    maxPerDay: n('EMAIL_MAX_PER_DAY', 50_000),
    throttleBounceRate: n('EMAIL_THROTTLE_BOUNCE_RATE', 0.05),
    throttleComplaintRate: n('EMAIL_THROTTLE_COMPLAINT_RATE', 0.001),
    throttleMinSample: n('EMAIL_THROTTLE_MIN_SAMPLE', 20),
    softBounceThreshold: n('EMAIL_SOFT_BOUNCE_THRESHOLD', 3),
    softBounceWindowHours: n('EMAIL_SOFT_BOUNCE_WINDOW_HOURS', 72),
    bodyRetentionDays: n('EMAIL_BODY_RETENTION_DAYS', 7),
    queueBufferHours: n('EMAIL_QUEUE_BUFFER_HOURS', 24),
    usageTolerancePct: n('EMAIL_USAGE_TOLERANCE_PCT', 1),
  };
};
export const EMAIL_CONFIG = Symbol('EMAIL_CONFIG');

export interface MessageDto {
  id: string;
  senderId: string;
  templateId: string | null;
  category: 'transactional';
  status: string;
  recipientCount: number;
  errorCode: string | null;
  dataRegion: string;
  operationId: string | null;
  acceptedAt: string | null;
  createdAt: string;
  events?: EventDto[];
}
export interface EventDto {
  id: string;
  messageId: string | null;
  type: string;
  occurredAt: string;
}
const iso = (v: unknown) => (v ? (v as Date).toISOString() : null);
const ORG_FLAG_RETAIN = 'email.retain_bodies';
const ORG_FLAG_OVERRIDE = 'email.throttle_override';
const rank: Record<string, number> = {
  queued: 0,
  sending: 1,
  unknown: 1,
  sent: 2,
  delivered: 3,
  bounced: 4,
  complained: 4,
  failed: 4,
};

/**
 * Transactional email (M08 S36). `POST /v1/email/messages` is accepted only for `category=transactional` from a VERIFIED sender identity, with the recipients checked against the
 * suppression list BEFORE anything is sent, header injection and HTML sanitized, residency evaluated, and the per-organization guardrails (rate, warm-up, auto-throttle) applied.
 * The send runs as a durable operation: the provider call carries a deterministic idempotency token (a replay is one provider call), an uncertain answer is looked up by token
 * before any retry, and the usage meter is emitted ONLY when the provider accepted the message. Bodies are stored as hashes; sealed copies exist only for the queue buffer and,
 * when the organization enabled retention, for N days. Recipients are `personal`: sealed + hashed.
 */
export class MessageService {
  private kicker: (orgId: string, operationId: string) => void = () => undefined;
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ops: DataOperations,
    private readonly providers: DataProviderService,
    private readonly registry: DataAdapterRegistry,
    private readonly residency: Pick<ResidencyService, 'evaluate'>,
    private readonly cipher: FieldCipher,
    private readonly senders: SenderTemplateService,
    private readonly suppressions: SuppressionService,
    private readonly flow: DatabaseFlow,
    private readonly alerts: DataAlerts,
    private readonly flags: DataFlags,
    private readonly dataCfg: DataConfig,
    private readonly cfg: EmailConfig,
  ) {
    flow.register(OP.MESSAGE_SEND, (o, op, w) => this.runSend(o, op, w));
  }
  setKicker(k: (orgId: string, operationId: string) => void) {
    this.kicker = k;
  }

  dto(r: Row): MessageDto {
    return {
      id: r.id as string,
      senderId: r.sender_id as string,
      templateId: (r.template_id as string | null) ?? null,
      category: 'transactional',
      status: r.state as string,
      recipientCount: (r.to_hashes as string[]).length,
      errorCode: (r.error_code as string | null) ?? null,
      dataRegion: r.data_region as string,
      operationId: (r.operation_id as string | null) ?? null,
      acceptedAt: iso(r.accepted_at),
      createdAt: iso(r.created_at)!,
    };
  }

  private async orgFlag(
    orgId: string,
    key: string,
  ): Promise<{ enabled: boolean; until?: string } | null> {
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT value FROM platform.feature_flags WHERE key = $1 AND org_id = $2`, [
            key,
            orgId,
          ])
        ).rows as Row[],
    );
    const v = rows[0]?.value as { enabled?: boolean; until?: string } | boolean | undefined;
    if (v === undefined) return null;
    if (typeof v === 'boolean') return { enabled: v };
    return { enabled: v.enabled === true, until: v.until };
  }
  /** Retention of message bodies is OFF unless the organization enabled it (an org-level flag recorded by an administrator after the lawful-basis check). */
  async retentionEnabled(orgId: string): Promise<boolean> {
    return (await this.orgFlag(orgId, ORG_FLAG_RETAIN))?.enabled === true;
  }
  /** A platform administrator's time-boxed override of the warm-up cap and the auto-throttle (service API; the console endpoint is a proposed addition, PA-19). */
  async setThrottleOverride(orgId: string, actor: string, untilIso: string | null): Promise<void> {
    const value = untilIso ? { enabled: true, until: untilIso } : { enabled: false };
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `INSERT INTO platform.feature_flags (id, key, org_id, value, updated_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (key, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [uuidv7(), ORG_FLAG_OVERRIDE, orgId, JSON.stringify(value), actor],
      ),
    );
    await this.audit.record({
      action: 'email.throttle.override',
      actorUserId: actor,
      orgId,
      resource: { type: 'organization', id: orgId },
      outcome: 'success',
      after: { until: untilIso },
    });
  }
  private async overrideActive(orgId: string): Promise<boolean> {
    const f = await this.orgFlag(orgId, ORG_FLAG_OVERRIDE);
    return !!f?.enabled && (!f.until || Date.parse(f.until) > Date.now());
  }

  /** Rolling-24h rates for the deliverability screens and the auto-throttle. */
  async rates(orgId: string): Promise<{
    sent: number;
    bounced: number;
    complaints: number;
    bounceRate: number;
    complaintRate: number;
    throttled: boolean;
  }> {
    const r = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT (SELECT count(*) FROM email.messages WHERE org_id = $1 AND accepted_at > now() - interval '24 hours') AS sent,
                  (SELECT count(*) FROM email.email_events WHERE org_id = $1 AND occurred_at > now() - interval '24 hours' AND type IN ('bounce_hard','bounce_soft')) AS bounced,
                  (SELECT count(*) FROM email.email_events WHERE org_id = $1 AND occurred_at > now() - interval '24 hours' AND type = 'complaint') AS complaints`,
            [orgId],
          )
        ).rows[0],
    )) as Row;
    const sent = Number(r.sent);
    const bounced = Number(r.bounced);
    const complaints = Number(r.complaints);
    const bounceRate = sent ? bounced / sent : 0;
    const complaintRate = sent ? complaints / sent : 0;
    const throttled =
      sent >= this.cfg.throttleMinSample &&
      (bounceRate > this.cfg.throttleBounceRate || complaintRate > this.cfg.throttleComplaintRate);
    return { sent, bounced, complaints, bounceRate, complaintRate, throttled };
  }
  private async guardrails(orgId: string): Promise<void> {
    const perMin = Number(
      await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `SELECT count(*) n FROM email.messages WHERE org_id = $1 AND created_at > now() - interval '1 minute'`,
              [orgId],
            )
          ).rows[0]!.n,
      ),
    );
    if (perMin >= this.cfg.ratePerMinute)
      throw new ProblemException(
        'rate_limited',
        'too many messages per minute for this organization',
        undefined,
        { retryAfterSeconds: 60 },
      );
    if (await this.overrideActive(orgId)) return;
    // warm-up: the daily allowance starts small and doubles each day since the first verified sending domain, up to the maximum
    const first = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT min(verified_at) v FROM email.email_domains WHERE org_id = $1 AND verified_at IS NOT NULL AND 'transactional' = ANY(purposes)`,
            [orgId],
          )
        ).rows[0]!.v as Date | null,
    );
    const days = first ? Math.floor((Date.now() - first.getTime()) / 86_400_000) : 0;
    const allowance = Math.min(
      this.cfg.maxPerDay,
      this.cfg.warmupBasePerDay * 2 ** Math.min(days, 20),
    );
    const day = Number(
      await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `SELECT count(*) n FROM email.messages WHERE org_id = $1 AND created_at > now() - interval '24 hours' AND state <> 'failed'`,
              [orgId],
            )
          ).rows[0]!.n,
      ),
    );
    if (day >= allowance)
      throw new ProblemException(
        'rate_limited',
        `the daily sending allowance (${allowance}, warm-up) is used up`,
        undefined,
        { retryAfterSeconds: 3600 },
      );
    const r = await this.rates(orgId);
    if (r.throttled)
      throw new ProblemException(
        'rate_limited',
        'sending is paused: the bounce or complaint rate of the last 24 hours is too high',
        undefined,
        { throttled: true, retryAfterSeconds: 3600 },
      );
  }

  async send(
    orgId: string,
    actor: string,
    idempotencyKey: string,
    body: Record<string, unknown>,
  ): Promise<MessageDto> {
    if (
      Object.keys(body).some(
        (k) =>
          ![
            'senderId',
            'to',
            'templateId',
            'subject',
            'html',
            'text',
            'variables',
            'category',
          ].includes(k),
      )
    )
      throw new ProblemException('validation_failed', 'unknown field');
    if (typeof body.category !== 'string')
      throw new ProblemException('validation_failed', 'category is required (transactional)');
    if (body.category !== 'transactional')
      throw new ProblemException(
        'category_not_allowed',
        'only transactional email is allowed; marketing and bulk email are blocked by policy',
      );
    if (!isUuid(body.senderId))
      throw new ProblemException('validation_failed', 'senderId is required');
    if (!Array.isArray(body.to) || body.to.length < 1)
      throw new ProblemException('validation_failed', 'to must be a non-empty list of addresses');
    if (body.to.length > this.cfg.maxRecipients)
      throw new ProblemException(
        'category_not_allowed',
        `a transactional message goes to at most ${this.cfg.maxRecipients} recipients; bulk sending is blocked by policy`,
      );
    const to = [...new Set(body.to.map((a) => parseAddress(a)))];
    if (hasControl(idempotencyKey))
      throw new ProblemException(
        'validation_failed',
        'the Idempotency-Key must not contain control characters',
      );
    // a replay across processes returns the original message (the HTTP layer replays the response itself)
    const existing = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT * FROM email.messages WHERE org_id = $1 AND idempotency_key = $2`, [
            orgId,
            idempotencyKey,
          ])
        ).rows[0],
    )) as Row | undefined;
    if (existing) return this.dto(existing);
    const sender = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT s.*, d.verification_state, d.purposes, d.tx_provider_id, d.data_region, d.domain FROM email.sender_identities s JOIN email.email_domains d ON d.id = s.domain_id WHERE s.id = $1 AND s.org_id = $2`,
            [body.senderId, orgId],
          )
        ).rows[0],
    )) as Row | undefined;
    if (
      !sender ||
      sender.state !== 'verified' ||
      sender.verification_state !== 'verified' ||
      !(sender.purposes as string[]).includes('transactional')
    )
      throw new ProblemException(
        'sender_not_verified',
        'the sender must be a verified identity of this organization (its domain must pass SPF/DKIM verification)',
      );
    // content
    let def: TemplateDef;
    let templateId: string | null = null;
    if (body.templateId !== undefined) {
      if (body.subject !== undefined || body.html !== undefined || body.text !== undefined)
        throw new ProblemException(
          'validation_failed',
          'send either templateId or subject+html, not both',
        );
      const t = await this.senders.getTemplate(orgId, body.templateId);
      templateId = t.id as string;
      def = {
        subject: t.subject as string,
        html: t.html as string,
        text: (t.body_text as string | null) ?? null,
        variables: t.variables as TemplateDef['variables'],
      };
    } else {
      if (body.variables !== undefined && Object.keys(body.variables as object).length)
        throw new ProblemException('validation_failed', 'variables are for templates');
      def = prepareTemplate({
        subject: body.subject,
        html: body.html,
        text: body.text,
        variables: {},
      });
    }
    const content = renderTemplate(def, body.variables);
    // suppression BEFORE anything else happens (and again at execution)
    const hit = await this.suppressions.isSuppressed(orgId, to);
    if (hit.length > 0)
      throw new ProblemException(
        'suppressed',
        `${hit.length} recipient(s) are on the suppression list; remove them to send`,
      );
    // the provider that serves this sender's domain
    const p = sender.tx_provider_id
      ? await this.providers.byId(orgId, sender.tx_provider_id as string, 'transactional-email')
      : null;
    if (!p || !p.row.enabled || p.row.probe?.capabilities?.['email.send'] !== 'supported')
      throw new ProblemException(
        'unsupported_capability',
        'transactional email is not available: no provider is enabled for this domain',
      );
    const processing =
      (p.row.config.processingRegion as string | undefined) ?? String(sender.data_region);
    const res = await this.residency.evaluate({
      orgId,
      dataClass: 'personal',
      targetRegion: processing,
      purpose: 'transactional_email',
      operation: 'write',
      ...(p.row.family.startsWith('provider-') ? { processorId: p.row.providerCode } : {}),
    });
    if (res.decision !== 'allow')
      throw new ProblemException(
        'residency_denied',
        res.reasons.map((r) => r.message.en).join('; ') ||
          'sending email through this provider is not allowed by the residency policy',
      );
    await this.guardrails(orgId);
    // store: hashes + sealed recipients; the sealed body is the queue buffer (kept only while queued, or N days when the organization enabled retention)
    const id = uuidv7();
    const retain = await this.retentionEnabled(orgId);
    const expires = new Date(
      Date.now() +
        (retain ? this.cfg.bodyRetentionDays * 24 : this.cfg.queueBufferHours) * 3_600_000,
    );
    const recipientsEnc = await this.cipher.encryptJson(to, {
      column: 'email.messages.recipients_enc',
      row: id,
    });
    const bodyEnc = await this.cipher.encryptJson(
      {
        from: sender.from_address,
        subject: content.subject,
        html: content.html,
        text: content.text,
      },
      { column: 'email.messages.body_enc', row: id },
    );
    const bodyHash = createHash('sha256')
      .update(JSON.stringify([sender.from_address, content.subject, content.html, content.text]))
      .digest('hex');
    const subjectHash = createHash('sha256').update(content.subject).digest('hex');
    let row: Row;
    try {
      row = (await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `INSERT INTO email.messages (id, org_id, sender_id, template_id, category, state, to_hashes, recipients_enc, body_hash, body_enc, subject_hash, expires_at, idempotency_key, send_token, provider_id, data_region, created_by)
             VALUES ($1,$2,$3,$4,'transactional','queued',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
              [
                id,
                orgId,
                sender.id,
                templateId,
                to.map(addressHash),
                recipientsEnc,
                bodyHash,
                bodyEnc,
                subjectHash,
                expires,
                idempotencyKey,
                idempotencyToken(orgId, idempotencyKey, 'email-send'),
                p.row.id,
                processing,
                actor,
              ],
            )
          ).rows[0],
      )) as Row;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        const again = (await this.db.withOrg(
          orgId,
          async (c) =>
            (
              await c.query(
                `SELECT * FROM email.messages WHERE org_id = $1 AND idempotency_key = $2`,
                [orgId, idempotencyKey],
              )
            ).rows[0],
        )) as Row;
        return this.dto(again);
      }
      throw e;
    }
    const op = await this.ops.create(orgId, {
      kind: OP.MESSAGE_SEND,
      resourceKind: 'email_message',
      resourceId: id,
      createdBy: actor,
      maxAttempts: 1,
      input: { messageId: id },
    });
    row = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`UPDATE email.messages SET operation_id = $2 WHERE id = $1 RETURNING *`, [
            id,
            op.id,
          ])
        ).rows[0],
    )) as Row;
    await this.audit.record({
      action: 'email.message.queued',
      actorUserId: actor,
      orgId,
      resource: { type: 'email_message', id },
      outcome: 'success',
      after: { senderId: sender.id, recipients: to.length, templateId, dataRegion: processing },
    });
    this.kicker(orgId, op.id);
    return this.dto(row);
  }

  // ---- send flow ---------------------------------------------------------------------------------------------------------------
  /** The provider accepted the message: state, meter and event, in ONE transaction (the meter id is deterministic, so a replay never double counts). */
  async markAccepted(
    orgId: string,
    messageId: string,
    providerRef: string | null,
    providerCode: string,
    retain: boolean,
    how: 'send' | 'webhook',
  ): Promise<boolean> {
    return this.db.withOrg(orgId, async (c) => {
      const m = (
        await c.query(`SELECT * FROM email.messages WHERE id = $1 AND org_id = $2 FOR UPDATE`, [
          messageId,
          orgId,
        ])
      ).rows[0] as Row | undefined;
      if (!m) return false;
      const first = !m.accepted_at;
      if (!first && m.provider_message_ref) return false;
      await c.query(
        `UPDATE email.messages SET provider_message_ref = coalesce(provider_message_ref, $2), accepted_at = coalesce(accepted_at, now()),
                state = CASE WHEN state IN ('queued','sending','unknown') THEN 'sent' ELSE state END,
                body_enc = CASE WHEN $3 THEN body_enc ELSE NULL END, expires_at = CASE WHEN $3 THEN expires_at ELSE NULL END
          WHERE id = $1`,
        [messageId, providerRef, retain],
      );
      const when = new Date();
      await emitUsage(c, {
        eventId: usageEventId({
          orgId,
          meterId: 'email.transactional_messages',
          resourceId: messageId,
          windowStart: new Date(
            Math.floor(new Date(m.created_at as Date).getTime() / 86_400_000) * 86_400_000,
          ).toISOString(),
          sourceSeq: messageId,
        }),
        orgId,
        meterId: 'email.transactional_messages',
        quantity: '1',
        unit: 'message',
        resourceId: messageId,
        windowStart: (m.created_at as Date).toISOString(),
        windowEnd: when.toISOString(),
        occurredAt: when.toISOString(),
        dimensions: { provider: providerCode, stream: 'transactional' },
        dataRegion: String(m.data_region),
        source: 'email@M08',
        providerEventId: providerRef ?? undefined,
      });
      await c.query(
        `INSERT INTO email.email_events (id, org_id, message_id, provider_code, provider_event_id, type, payload, occurred_at) VALUES ($1,$2,$3,$4,$5,'sent',$6,$7) ON CONFLICT (provider_code, provider_event_id) DO NOTHING`,
        [
          uuidv7(),
          orgId,
          messageId,
          'nuzm',
          `nuzm:sent:${messageId}`,
          JSON.stringify({ via: how }),
          when,
        ],
      );
      return true;
    });
  }
  private async runSend(orgId: string, op: Operation, worker: string): Promise<void> {
    const input = op.input as { messageId: string };
    const m = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT * FROM email.messages WHERE id = $1 AND org_id = $2`, [
            input.messageId,
            orgId,
          ])
        ).rows[0],
    )) as Row | undefined;
    if (!m) throw new FlowFailure('not_found', 'the message no longer exists');
    if (
      m.accepted_at ||
      ['failed', 'bounced', 'complained', 'delivered'].includes(m.state as string)
    )
      return void (await this.flow.ops.succeed(orgId, op.id, worker, {
        messageId: m.id,
        state: m.state,
      }));
    const fail = async (code: string, msg: string): Promise<never> => {
      await this.db.withOrg(orgId, async (c) => {
        await c.query(
          `UPDATE email.messages SET state = 'failed', error_code = $2, body_enc = NULL, expires_at = NULL WHERE id = $1`,
          [m.id, code.replace(/[^a-z0-9_]/g, '_').slice(0, 60)],
        );
        await c.query(
          `INSERT INTO email.email_events (id, org_id, message_id, provider_code, provider_event_id, type, payload, occurred_at) VALUES ($1,$2,$3,'nuzm',$4,'failed',$5,now()) ON CONFLICT (provider_code, provider_event_id) DO NOTHING`,
          [uuidv7(), orgId, m.id, `nuzm:failed:${String(m.id)}`, JSON.stringify({ code })],
        );
      });
      throw new FlowFailure(code, msg);
    };
    const p = m.provider_id
      ? await this.providers.byId(orgId, m.provider_id as string, 'transactional-email')
      : null;
    if (!p || !p.row.enabled) return fail('provider_unavailable', 'the provider is not available');
    const adapter = p.adapter as unknown as TransactionalEmailAdapter;
    const ctx = this.registry.ctx({ id: p.row.id, config: p.row.config }, 'email-send');
    const res = await this.residency.evaluate({
      orgId,
      dataClass: 'personal',
      targetRegion: String(m.data_region),
      purpose: 'transactional_email',
      operation: 'write',
      ...(p.row.family.startsWith('provider-') ? { processorId: p.row.providerCode } : {}),
    });
    if (res.decision !== 'allow')
      return fail('residency_denied', 'sending is no longer allowed by the residency policy');
    const to = await this.cipher.decryptJson<string[]>(m.recipients_enc as string, {
      column: 'email.messages.recipients_enc',
      row: m.id as string,
    });
    if ((await this.suppressions.isSuppressed(orgId, to)).length > 0)
      return fail('suppressed', 'a recipient was suppressed while the message was queued');
    if (!m.body_enc) return fail('body_missing', 'the queued content is no longer available');
    const body = await this.cipher.decryptJson<{
      from: string;
      subject: string;
      html: string;
      text: string | null;
    }>(m.body_enc as string, { column: 'email.messages.body_enc', row: m.id as string });
    await this.db.withOrg(orgId, (c) =>
      c.query(`UPDATE email.messages SET state = 'sending' WHERE id = $1 AND state = 'queued'`, [
        m.id,
      ]),
    );
    const message = {
      from: body.from,
      to,
      subject: body.subject,
      html: body.html,
      ...(body.text ? { text: body.text } : {}),
      tags: { 'nuzm-org': orgTag(orgId), 'nuzm-msg': String(m.id).slice(-12) },
    };
    const token = m.send_token as string;
    const call = () => adapter.send(ctx, message, token);
    let o = outcomeOf(await retryTransient(this.dataCfg, call));
    if (o.kind === 'uncertain' || (op.attempts > 1 && o.kind !== 'ok')) {
      // reconcile before retry: the provider may have accepted it
      const f = outcomeOf(await adapter.findByToken(ctx, token));
      if (f.kind === 'ok' && f.data)
        o = {
          kind: 'ok',
          ref: (f.data as { providerMessageRef: string }).providerMessageRef,
          data: f.data as never,
        };
      else if (f.kind === 'ok') {
        const again = outcomeOf(await call());
        if (again.kind === 'ok') o = again;
        else throw new FlowUncertain('the send call timed out twice');
      } else throw new FlowUncertain('the send call timed out and the lookup failed');
    }
    if (o.kind === 'failed')
      return fail(o.unsupported ? 'unsupported_capability' : 'provider_refused', o.message);
    if (o.kind !== 'ok') throw new FlowUncertain('no provider reference after send');
    const ref =
      o.ref ?? (o.data as { providerMessageRef?: string } | undefined)?.providerMessageRef ?? null;
    await this.markAccepted(
      orgId,
      m.id as string,
      ref,
      p.row.providerCode,
      await this.retentionEnabled(orgId),
      'send',
    );
    await this.audit.record({
      action: 'email.message.sent',
      actorType: 'system',
      orgId,
      resource: { type: 'email_message', id: String(m.id) },
      outcome: 'success',
      after: { recipients: to.length, providerCode: p.row.providerCode },
    });
    await this.flow.ops.succeed(orgId, op.id, worker, { messageId: m.id, state: 'sent' });
  }

  // ---- reads --------------------------------------------------------------------------------------------------------------------
  async get(orgId: string, id: string): Promise<MessageDto> {
    if (!isUuid(id)) throw new ProblemException('not_found');
    const m = (await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM email.messages WHERE id = $1 AND org_id = $2`, [id, orgId]))
          .rows[0],
    )) as Row | undefined;
    if (!m) throw new ProblemException('not_found');
    const ev = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM email.email_events WHERE message_id = $1 ORDER BY occurred_at, id`,
            [id],
          )
        ).rows,
    )) as Row[];
    return {
      ...this.dto(m),
      events: ev.map((e) => ({
        id: e.id as string,
        messageId: id,
        type: e.type as string,
        occurredAt: iso(e.occurred_at)!,
      })),
    };
  }
  async list(
    orgId: string,
    q: { limit: number; cursor?: string; status?: string; senderId?: string },
  ): Promise<Page<MessageDto>> {
    const before = decodeCursor(q.cursor);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM email.messages WHERE org_id = $1 AND ($2::uuid IS NULL OR id < $2) AND ($3::text IS NULL OR state = $3) AND ($4::uuid IS NULL OR sender_id = $4) ORDER BY id DESC LIMIT $5`,
            [
              orgId,
              before,
              q.status ?? null,
              q.senderId && isUuid(q.senderId) ? q.senderId : null,
              q.limit + 1,
            ],
          )
        ).rows as Row[],
    );
    const p = pageOf(rows as (Row & { id: string })[], q.limit);
    return { items: p.items.map((r) => this.dto(r)), nextCursor: p.nextCursor };
  }
  async listEvents(
    orgId: string,
    q: { limit: number; cursor?: string; type?: string; messageId?: string },
  ): Promise<Page<EventDto>> {
    const cur = decodeTimeCursor(q.cursor);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM email.email_events WHERE org_id = $1 AND ($2::text IS NULL OR type = $2) AND ($3::uuid IS NULL OR message_id = $3)
              AND ($4::timestamptz IS NULL OR (occurred_at, id) < ($4, $5::uuid)) ORDER BY occurred_at DESC, id DESC LIMIT $6`,
            [
              orgId,
              q.type ?? null,
              q.messageId && isUuid(q.messageId) ? q.messageId : null,
              cur?.t ?? null,
              cur?.id ?? null,
              q.limit + 1,
            ],
          )
        ).rows as Row[],
    );
    const items = rows.slice(0, q.limit).map((e) => ({
      id: e.id as string,
      messageId: (e.message_id as string | null) ?? null,
      type: e.type as string,
      occurredAt: iso(e.occurred_at)!,
    }));
    const last = rows[q.limit - 1];
    return {
      items,
      nextCursor:
        rows.length > q.limit && last
          ? encodeTimeCursor(last.occurred_at as Date, last.id as string)
          : null,
    };
  }

  // ---- webhooks -------------------------------------------------------------------------------------------------------------------
  /**
   * `POST /v1/webhooks/email/{provider}`: the signature over the RAW body and the replay window authenticate the call. Every event is stored durably (unique per provider event id)
   * BEFORE the 200; a duplicate is a no-op (no second event, suppression or meter). A hard bounce or a complaint suppresses the address in the same transaction as the event,
   * so the suppression exists when the 200 goes out (well inside the 60 s target).
   */
  async handleWebhook(
    providerCode: string,
    rawBody: string | undefined,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ received: number; applied: number; duplicates: number; unmatched: number }> {
    const adapter = this.registry.get('transactional-email', providerCode);
    if (!adapter || rawBody === undefined)
      throw new ProblemException('not_found', 'unknown provider');
    const h: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    let events: VerifiedEmailEvent[];
    try {
      events = adapter.parseWebhook(h, rawBody, new Date());
    } catch (e) {
      if (e instanceof WebhookSignatureError) {
        if (e.reason === 'replay_window')
          throw new ProblemException('conflict', 'the webhook is outside the replay window');
        if (e.reason === 'malformed')
          throw new ProblemException('validation_failed', 'the webhook payload is malformed');
        throw new ProblemException('invalid_signature', 'invalid webhook signature');
      }
      throw e;
    }
    if (events.length > 500)
      throw new ProblemException('validation_failed', 'too many events in one delivery');
    const out = { received: events.length, applied: 0, duplicates: 0, unmatched: 0 };
    for (const ev of events) {
      if (!ev.providerMessageRef) {
        out.unmatched++;
        continue;
      }
      const m = (await this.db.withPlatformScope(
        async (c) =>
          (
            await c.query(
              `SELECT id, org_id FROM email.messages WHERE provider_message_ref = $1 LIMIT 1`,
              [ev.providerMessageRef],
            )
          ).rows[0],
      )) as Row | undefined;
      if (!m) {
        out.unmatched++;
        continue;
      }
      const orgId = m.org_id as string;
      const r = await this.applyEvent(orgId, m.id as string, providerCode, ev);
      if (r === 'duplicate') out.duplicates++;
      else out.applied++;
    }
    return out;
  }
  private async applyEvent(
    orgId: string,
    messageId: string,
    providerCode: string,
    ev: VerifiedEmailEvent,
  ): Promise<'applied' | 'duplicate'> {
    const retain = await this.retentionEnabled(orgId);
    const result = await this.db.withOrg(orgId, async (c) => {
      const eventId = uuidv7();
      const ins = await c.query(
        `INSERT INTO email.email_events (id, org_id, message_id, provider_code, provider_event_id, type, payload, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (provider_code, provider_event_id) DO NOTHING RETURNING id`,
        [
          eventId,
          orgId,
          messageId,
          providerCode,
          ev.providerEventId,
          ev.type === 'rejected' ? 'rejected' : ev.type,
          JSON.stringify(redact(ev.payload)),
          new Date(ev.occurredAt),
        ],
      );
      if (ins.rowCount === 0) return 'duplicate' as const;
      const m = (
        await c.query(`SELECT * FROM email.messages WHERE id = $1 FOR UPDATE`, [messageId])
      ).rows[0] as Row;
      const to = await this.cipher.decryptJson<string[]>(m.recipients_enc as string, {
        column: 'email.messages.recipients_enc',
        row: messageId,
      });
      const target =
        ev.recipient && to.includes(ev.recipient.toLowerCase()) ? ev.recipient.toLowerCase() : null;
      const next =
        ev.type === 'delivered'
          ? 'delivered'
          : ev.type === 'bounce_hard'
            ? 'bounced'
            : ev.type === 'complaint'
              ? 'complained'
              : null;
      if (next && (rank[m.state as string] ?? 0) < rank[next]!)
        await c.query(`UPDATE email.messages SET state = $2 WHERE id = $1`, [messageId, next]);
      if (ev.type === 'bounce_hard' && target)
        await this.suppressions.addIn(c, orgId, target, 'bounce_hard', 'webhook', eventId, null);
      if (ev.type === 'complaint' && target)
        await this.suppressions.addIn(c, orgId, target, 'complaint', 'webhook', eventId, null);
      if (ev.type === 'bounce_soft' && target) {
        const n = Number(
          (
            await c.query(
              `SELECT count(*) n FROM email.email_events e JOIN email.messages mm ON mm.id = e.message_id WHERE e.org_id = $1 AND e.type = 'bounce_soft' AND e.occurred_at > now() - make_interval(hours => $2) AND $3 = ANY(mm.to_hashes)`,
              [orgId, this.cfg.softBounceWindowHours, addressHash(target)],
            )
          ).rows[0]!.n,
        );
        if (n >= this.cfg.softBounceThreshold)
          await this.suppressions.addIn(c, orgId, target, 'bounce_soft', 'webhook', eventId, null);
      }
      return 'applied' as const;
    });
    if (result === 'applied') {
      // an event for a message we were not sure about is proof the provider has it: accept it (idempotent meter)
      await this.markAccepted(
        orgId,
        messageId,
        ev.providerMessageRef,
        providerCode,
        retain,
        'webhook',
      ).catch(() => false);
    }
    return result;
  }

  /** Remove sealed bodies whose retention ended (D-34: parameterized). Recipients stay sealed; the hash stays. */
  async purgeBodies(now: Date): Promise<number> {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, org_id FROM email.messages WHERE body_enc IS NOT NULL AND expires_at < $1 LIMIT 500`,
            [now],
          )
        ).rows as Row[],
    );
    for (const r of rows)
      await this.db.withOrg(r.org_id as string, (c) =>
        c.query(`UPDATE email.messages SET body_enc = NULL, expires_at = NULL WHERE id = $1`, [
          r.id,
        ]),
      );
    return rows.length;
  }

  /**
   * Usage vs provider-reported reconciliation (S36 task 5): our provider-accepted count for a day against the provider's own number, within the tolerance (D-31 proposal 1%).
   * Outside it raises an alert; nothing is "fixed" silently.
   */
  async reconcileUsage(
    providerId: string,
    day: Date,
  ): Promise<{
    ours: number;
    provider: number | null;
    variancePct: number | null;
    withinTolerance: boolean | null;
  }> {
    const start = new Date(Math.floor(day.getTime() / 86_400_000) * 86_400_000);
    const end = new Date(start.getTime() + 86_400_000);
    const row = (await this.db.withPlatformScope(
      async (c) =>
        (await c.query(`SELECT * FROM data.data_providers WHERE id = $1`, [providerId])).rows[0],
    )) as Row | undefined;
    const ours = Number(
      await this.db.withPlatformScope(
        async (c) =>
          (
            await c.query(
              `SELECT count(*) n FROM email.messages WHERE provider_id = $1 AND accepted_at >= $2 AND accepted_at < $3`,
              [providerId, start, end],
            )
          ).rows[0]!.n,
      ),
    );
    const adapter = row
      ? this.registry.get('transactional-email', row.provider_code as string)
      : null;
    if (!row || !adapter) return { ours, provider: null, variancePct: null, withinTolerance: null };
    const r = outcomeOf(
      await adapter.usage(
        this.registry.ctx(
          { id: row.id as string, config: (row.config as Record<string, unknown>) ?? {} },
          'email-usage',
        ),
        { from: start.toISOString(), to: end.toISOString() },
      ),
    );
    const provider =
      r.kind === 'ok' && r.data ? ((r.data as { accepted: number | null }).accepted ?? null) : null;
    if (provider === null)
      return { ours, provider: null, variancePct: null, withinTolerance: null };
    const variancePct =
      provider === 0 ? (ours === 0 ? 0 : 100) : (Math.abs(ours - provider) / provider) * 100;
    const within = variancePct <= this.cfg.usageTolerancePct;
    if (!within)
      await this.alerts
        .raise('00000000-0000-0000-0000-000000000001', {
          kind: 'email.usage_variance',
          severity: 'warning',
          resource: { type: 'data_provider', id: providerId },
          detail: { ours, provider, variancePct: Math.round(variancePct * 100) / 100 },
        })
        .catch(() => undefined);
    return { ours, provider, variancePct, withinTolerance: within };
  }
}
const redact = (p: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p ?? {}))
    if (
      !/(address|email|recipient|to|from|subject|body|content|html|text)/i.test(k) &&
      ['string', 'number', 'boolean'].includes(typeof v)
    )
      out[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  return out;
};
export { DataFlags };
