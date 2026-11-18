import { v7 as uuidv7 } from 'uuid';
import { idempotencyToken, orgTag, type MailboxAdapter } from '@nuzm/adapter-data';
import { emitUsage, usageEventId, type Db, type Operation, type UsageEvent } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';
import type { SecretStore } from '../../../common/secrets';
import type { EntitlementService } from '../../billing';
import type { OrderService } from '../../commerce';
import type { ResidencyService } from '../../compliance';
import {
  DataAdapterRegistry,
  DataOperations,
  DataProviderService,
  DatabaseFlow,
  FlowFailure,
  FlowUncertain,
  OP,
  gibMonthFraction,
  isUuid,
  outcomeOf,
  retryTransient,
  type DataConfig,
  type DataRow as Row,
} from '../../data';

export interface MailboxDto {
  id: string;
  address: string;
  domainId: string;
  localPart: string;
  status: string;
  quotaMb: number;
  /** Which way the owner sets the password; the link or secret itself is in the vault and is never returned (reveal is a proposed addition, PA-19). */
  passwordSetup: { kind: 'reset_link' | 'one_time_secret'; state: 'pending' | 'revealed' } | null;
  usage: { at: string; storageBytes: number | null } | null;
  dataRegion: string;
  operationId: string | null;
  etag: number;
  createdAt: string;
}
export interface AliasDto {
  id: string;
  address: string;
  mailboxId: string;
  domainId: string;
  status: string;
  operationId: string | null;
  createdAt: string;
}
const LOCAL = /^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?$/;
const RESERVED = new Set([
  'postmaster',
  'abuse',
  'hostmaster',
  'webmaster',
  'root',
  'mailer-daemon',
  'noreply-nuzm',
  'security',
]);
const iso = (v: unknown) => (v ? (v as Date).toISOString() : null);
export const DEFAULT_MAILBOX_LIMITS = { count: 25, maxQuotaMb: 10_240 };

/**
 * Business mailboxes and aliases (M08 S35 task 2). A mailbox needs a VERIFIED domain with the mailbox purpose, an enabled mailbox provider, a `quoteId` of kind `email`
 * and passes residency (personal data) before the provider is called. The password is never persisted in the clear and never returned: the provider's reset link or
 * one-time secret goes straight into the vault; only its kind is visible. All provider calls run as durable operations with deterministic tokens.
 */
export class MailboxService {
  private kicker: (orgId: string, operationId: string) => void = () => undefined;
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ops: DataOperations,
    private readonly providers: DataProviderService,
    private readonly registry: DataAdapterRegistry,
    private readonly orders: Pick<OrderService, 'createFromQuote'>,
    private readonly entitlements: Pick<EntitlementService, 'resolve'>,
    private readonly residency: Pick<ResidencyService, 'evaluate'>,
    private readonly secrets: SecretStore,
    private readonly flow: DatabaseFlow,
    private readonly cfg: DataConfig,
  ) {
    flow.register(OP.MAILBOX_CREATE, (o, op, w) => this.runCreate(o, op, w));
    flow.register(OP.MAILBOX_UPDATE, (o, op, w) => this.runUpdate(o, op, w));
    flow.register(OP.MAILBOX_DELETE, (o, op, w) => this.runDelete(o, op, w));
    flow.register(OP.ALIAS_ADD, (o, op, w) => this.runAlias(o, op, w));
  }
  setKicker(k: (orgId: string, operationId: string) => void) {
    this.kicker = k;
  }

  dto(r: Row, domain: string): MailboxDto {
    const ps = r.password_setup as {
      kind?: 'reset_link' | 'one_time_secret';
      state?: 'pending' | 'revealed';
    } | null;
    return {
      id: r.id as string,
      address: `${r.local_part as string}@${domain}`,
      domainId: r.domain_id as string,
      localPart: r.local_part as string,
      status: r.state as string,
      quotaMb: Number(r.quota_mb),
      passwordSetup: ps?.kind ? { kind: ps.kind, state: ps.state ?? 'pending' } : null,
      usage: (r.usage as MailboxDto['usage']) ?? null,
      dataRegion: r.data_region as string,
      operationId: (r.operation_id as string | null) ?? null,
      etag: r.version_lock as number,
      createdAt: iso(r.created_at)!,
    };
  }
  private async domain(orgId: string, id: unknown): Promise<Row> {
    if (!isUuid(id)) throw new ProblemException('validation_failed', 'domainId is required');
    const d = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM email.email_domains WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
            [id, orgId],
          )
        ).rows[0],
    )) as Row | undefined;
    if (!d) throw new ProblemException('not_found', 'domain not found');
    return d;
  }
  async limits(orgId: string) {
    const e = await this.entitlements.resolve(orgId);
    const lim = (g: string) => {
      const v = e.limits.find((l) => l.meterGroup === g)?.limit;
      return v ? Number(v) : null;
    };
    return {
      count: lim('email_mailbox_count') ?? DEFAULT_MAILBOX_LIMITS.count,
      maxQuotaMb: lim('email_mailbox_quota_mb') ?? DEFAULT_MAILBOX_LIMITS.maxQuotaMb,
    };
  }

  async create(orgId: string, actor: string, body: Record<string, unknown>): Promise<MailboxDto> {
    if (Object.keys(body).some((k) => !['localPart', 'domainId', 'quotaMb', 'quoteId'].includes(k)))
      throw new ProblemException('validation_failed', 'unknown field');
    const local = typeof body.localPart === 'string' ? body.localPart.toLowerCase() : '';
    if (!LOCAL.test(local) || local.includes('..') || RESERVED.has(local))
      throw new ProblemException(
        'validation_failed',
        'localPart must be a plain mailbox name (letters, digits, . _ + -), not a reserved name',
      );
    if (!isUuid(body.quoteId))
      throw new ProblemException(
        'validation_failed',
        'quoteId (a quote of kind email) is required',
      );
    const lim = await this.limits(orgId);
    if (
      !Number.isInteger(body.quotaMb) ||
      (body.quotaMb as number) < 100 ||
      (body.quotaMb as number) > lim.maxQuotaMb
    )
      throw new ProblemException(
        'validation_failed',
        `quotaMb must be an integer of 100..${lim.maxQuotaMb}`,
      );
    const domain = await this.domain(orgId, body.domainId);
    if (
      domain.verification_state !== 'verified' ||
      !(domain.purposes as string[]).includes('mailbox')
    )
      throw new ProblemException(
        'unsupported_capability',
        'the domain must be verified for mailboxes before a mailbox can be created',
      );
    const used = await this.db.withOrg(orgId, async (c) =>
      Number(
        (
          await c.query(
            `SELECT count(*) n FROM email.mailboxes WHERE org_id = $1 AND state <> 'deleted'`,
            [orgId],
          )
        ).rows[0]!.n,
      ),
    );
    if (used >= lim.count)
      throw new ProblemException(
        'quota_exceeded',
        `the organization already has ${used} of ${lim.count} mailboxes`,
      );
    const q = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT kind FROM commerce.quotes WHERE id = $1 AND org_id = $2`, [
            body.quoteId,
            orgId,
          ])
        ).rows[0],
    )) as Row | undefined;
    if (!q) throw new ProblemException('not_found', 'quote not found');
    if (q.kind !== 'email')
      throw new ProblemException('validation_failed', 'the quote is not an email quote');
    const p = await this.providers.byId(orgId, domain.mailbox_provider_id as string, 'mailbox');
    if (!p || !p.row.enabled)
      throw new ProblemException('unsupported_capability', 'the mailbox provider is not available');
    if (p.row.probe?.capabilities?.['mailbox.provision'] !== 'supported')
      throw new ProblemException(
        'unsupported_capability',
        'the provider probe does not report mailbox provisioning as supported',
      );
    const res = await this.residency.evaluate({
      orgId,
      dataClass: 'personal',
      targetRegion: String(domain.data_region),
      purpose: 'mailbox_provisioning',
      operation: 'write',
      ...(p.row.family.startsWith('provider-') ? { processorId: p.row.providerCode } : {}),
    });
    if (res.decision !== 'allow')
      throw new ProblemException(
        'residency_denied',
        res.reasons.map((r) => r.message.en).join('; ') ||
          'mailbox placement is not allowed by the residency policy',
      );
    const order = await this.orders.createFromQuote(orgId, body.quoteId as string, actor);
    const id = uuidv7();
    try {
      await this.db.withOrg(orgId, (c) =>
        c.query(
          `INSERT INTO email.mailboxes (id, org_id, domain_id, local_part, state, provider_id, quota_mb, create_token, quote_id, order_id, data_region, created_by)
           VALUES ($1,$2,$3,$4,'provisioning',$5,$6,$7,$8,$9,$10,$11)`,
          [
            id,
            orgId,
            domain.id,
            local,
            p.row.id,
            body.quotaMb,
            idempotencyToken(orgId, id, 'create'),
            body.quoteId,
            order.id,
            domain.data_region,
            actor,
          ],
        ),
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException('conflict', 'this mailbox already exists');
      throw e;
    }
    const op = await this.ops.create(orgId, {
      kind: OP.MAILBOX_CREATE,
      resourceKind: 'mailbox',
      resourceId: id,
      createdBy: actor,
      maxAttempts: 1,
      input: { mailboxId: id },
    });
    const out = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`UPDATE email.mailboxes SET operation_id = $2 WHERE id = $1 RETURNING *`, [
            id,
            op.id,
          ])
        ).rows[0],
    )) as Row;
    await this.audit.record({
      action: 'email.mailbox.created',
      actorUserId: actor,
      orgId,
      resource: { type: 'mailbox', id },
      outcome: 'success',
      after: {
        domainId: domain.id,
        quotaMb: body.quotaMb,
        state: 'provisioning',
        operationId: op.id,
      },
    });
    this.kicker(orgId, op.id);
    return this.dto(out, domain.domain as string);
  }

  async list(
    orgId: string,
    q: { limit: number; cursor?: string; domainId?: string },
  ): Promise<Page<MailboxDto>> {
    const before = decodeCursor(q.cursor);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT m.*, d.domain FROM email.mailboxes m JOIN email.email_domains d ON d.id = m.domain_id WHERE m.org_id = $1 AND m.state <> 'deleted' AND ($2::uuid IS NULL OR m.id < $2) AND ($3::uuid IS NULL OR m.domain_id = $3) ORDER BY m.id DESC LIMIT $4`,
            [orgId, before, q.domainId ?? null, q.limit + 1],
          )
        ).rows as Row[],
    );
    const p = pageOf(rows as (Row & { id: string })[], q.limit);
    return { items: p.items.map((r) => this.dto(r, r.domain as string)), nextCursor: p.nextCursor };
  }
  async row(orgId: string, id: string): Promise<Row> {
    if (!isUuid(id)) throw new ProblemException('not_found');
    const r = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT m.*, d.domain FROM email.mailboxes m JOIN email.email_domains d ON d.id = m.domain_id WHERE m.id = $1 AND m.org_id = $2`,
            [id, orgId],
          )
        ).rows[0],
    )) as Row | undefined;
    if (!r || r.state === 'deleted') throw new ProblemException('not_found');
    return r;
  }

  async patch(
    orgId: string,
    actor: string,
    id: string,
    ifMatch: number,
    body: Record<string, unknown>,
  ): Promise<MailboxDto & { operationId: string }> {
    const cur = await this.row(orgId, id);
    if (cur.version_lock !== ifMatch)
      throw new ProblemException('precondition_failed', 'the mailbox changed; fetch it again');
    if (Object.keys(body).length === 0 || Object.keys(body).some((k) => k !== 'quotaMb'))
      throw new ProblemException('validation_failed', 'PATCH accepts quotaMb');
    const lim = await this.limits(orgId);
    if (
      !Number.isInteger(body.quotaMb) ||
      (body.quotaMb as number) < 100 ||
      (body.quotaMb as number) > lim.maxQuotaMb
    )
      throw new ProblemException(
        'validation_failed',
        `quotaMb must be an integer of 100..${lim.maxQuotaMb}`,
      );
    if (cur.state !== 'active') throw new ProblemException('conflict', 'the mailbox is not active');
    const p = await this.providers.byId(orgId, cur.provider_id as string, 'mailbox');
    if (!p || p.row.probe?.capabilities?.['mailbox.quota'] !== 'supported')
      throw new ProblemException(
        'unsupported_capability',
        'the provider does not support changing the quota',
      );
    const op = await this.ops.create(orgId, {
      kind: OP.MAILBOX_UPDATE,
      resourceKind: 'mailbox',
      resourceId: id,
      createdBy: actor,
      maxAttempts: 1,
      input: { mailboxId: id, quotaMb: body.quotaMb },
    });
    const out = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE email.mailboxes SET operation_id = $2 WHERE id = $1 AND version_lock = $3 RETURNING *`,
            [id, op.id, ifMatch],
          )
        ).rows[0],
    )) as Row | undefined;
    if (!out)
      throw new ProblemException('precondition_failed', 'the mailbox changed; fetch it again');
    await this.audit.record({
      action: 'email.mailbox.updated',
      actorUserId: actor,
      orgId,
      resource: { type: 'mailbox', id },
      outcome: 'success',
      after: { quotaMb: body.quotaMb, operationId: op.id },
    });
    this.kicker(orgId, op.id);
    return { ...this.dto(out, cur.domain as string), operationId: op.id };
  }
  async remove(
    orgId: string,
    actor: string,
    id: string,
  ): Promise<MailboxDto & { operationId: string }> {
    const cur = await this.row(orgId, id);
    if (!['active', 'suspended', 'failed', 'unknown', 'provisioning'].includes(cur.state as string))
      throw new ProblemException(
        'conflict',
        `a mailbox in state ${String(cur.state)} cannot be deleted`,
      );
    const op = await this.ops.create(orgId, {
      kind: OP.MAILBOX_DELETE,
      resourceKind: 'mailbox',
      resourceId: id,
      createdBy: actor,
      maxAttempts: 1,
      input: { mailboxId: id },
    });
    const out = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE email.mailboxes SET state = 'deleting', operation_id = $2 WHERE id = $1 RETURNING *`,
            [id, op.id],
          )
        ).rows[0],
    )) as Row;
    await this.audit.record({
      action: 'email.mailbox.deleted',
      actorUserId: actor,
      orgId,
      resource: { type: 'mailbox', id },
      outcome: 'success',
      after: { operationId: op.id },
    });
    this.kicker(orgId, op.id);
    return { ...this.dto(out, cur.domain as string), operationId: op.id };
  }

  // ---- aliases -----------------------------------------------------------------------------------------------------------------
  async createAlias(
    orgId: string,
    actor: string,
    body: Record<string, unknown>,
  ): Promise<AliasDto> {
    if (Object.keys(body).some((k) => !['mailboxId', 'localPart'].includes(k)))
      throw new ProblemException('validation_failed', 'unknown field');
    const local = typeof body.localPart === 'string' ? body.localPart.toLowerCase() : '';
    if (!LOCAL.test(local) || local.includes('..') || RESERVED.has(local))
      throw new ProblemException('validation_failed', 'localPart must be a plain alias name');
    const mbx = await this.row(orgId, String(body.mailboxId));
    if (mbx.state !== 'active') throw new ProblemException('conflict', 'the mailbox is not active');
    const p = await this.providers.byId(orgId, mbx.provider_id as string, 'mailbox');
    if (!p || p.row.probe?.capabilities?.['mailbox.alias'] !== 'supported')
      throw new ProblemException('unsupported_capability', 'the provider does not support aliases');
    const id = uuidv7();
    try {
      await this.db.withOrg(orgId, (c) =>
        c.query(
          `INSERT INTO email.aliases (id, org_id, domain_id, mailbox_id, local_part, create_token, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, orgId, mbx.domain_id, mbx.id, local, idempotencyToken(orgId, id, 'alias'), actor],
        ),
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException('conflict', 'this address is already used by an alias');
      throw e;
    }
    // an alias cannot shadow a mailbox
    const clash = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT 1 FROM email.mailboxes WHERE domain_id = $1 AND local_part = $2 AND state <> 'deleted'`,
            [mbx.domain_id, local],
          )
        ).rowCount,
    );
    if (clash) {
      await this.db.withOrg(orgId, (c) =>
        c.query(`UPDATE email.aliases SET state = 'failed' WHERE id = $1`, [id]),
      );
      throw new ProblemException('conflict', 'this address is already a mailbox');
    }
    const op = await this.ops.create(orgId, {
      kind: OP.ALIAS_ADD,
      resourceKind: 'mailbox',
      resourceId: String(mbx.id),
      createdBy: actor,
      maxAttempts: 1,
      input: { aliasId: id },
    });
    const out = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`UPDATE email.aliases SET operation_id = $2 WHERE id = $1 RETURNING *`, [
            id,
            op.id,
          ])
        ).rows[0],
    )) as Row;
    await this.audit.record({
      action: 'email.alias.created',
      actorUserId: actor,
      orgId,
      resource: { type: 'alias', id },
      outcome: 'success',
      after: { mailboxId: mbx.id },
    });
    this.kicker(orgId, op.id);
    return {
      id,
      address: `${local}@${mbx.domain as string}`,
      mailboxId: mbx.id as string,
      domainId: mbx.domain_id as string,
      status: 'provisioning',
      operationId: op.id,
      createdAt: iso(out.created_at)!,
    };
  }
  async listAliases(orgId: string, q: { limit: number; cursor?: string }): Promise<Page<AliasDto>> {
    const before = decodeCursor(q.cursor);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT a.*, d.domain FROM email.aliases a JOIN email.email_domains d ON d.id = a.domain_id WHERE a.org_id = $1 AND ($2::uuid IS NULL OR a.id < $2) ORDER BY a.id DESC LIMIT $3`,
            [orgId, before, q.limit + 1],
          )
        ).rows as Row[],
    );
    const p = pageOf(rows as (Row & { id: string })[], q.limit);
    return {
      items: p.items.map((r) => ({
        id: r.id as string,
        address: `${r.local_part as string}@${r.domain as string}`,
        mailboxId: r.mailbox_id as string,
        domainId: r.domain_id as string,
        status: r.state as string,
        operationId: (r.operation_id as string | null) ?? null,
        createdAt: iso(r.created_at)!,
      })),
      nextCursor: p.nextCursor,
    };
  }

  // ---- flows ---------------------------------------------------------------------------------------------------------------------
  private async access(orgId: string, mbx: Row) {
    const p = await this.providers.byId(orgId, mbx.provider_id as string, 'mailbox');
    if (!p || !p.row.enabled)
      throw new FlowFailure('provider_unavailable', 'the provider is not available');
    return {
      adapter: p.adapter as unknown as MailboxAdapter,
      ctx: this.registry.ctx({ id: p.row.id, config: p.row.config }, 'mailbox-flow'),
      providerCode: p.row.providerCode,
      family: p.row.family,
    };
  }
  private async setMbx(orgId: string, id: string, set: Record<string, unknown>) {
    const keys = Object.keys(set);
    const vals = keys.map((k) =>
      k === 'password_setup' || k === 'usage' ? JSON.stringify(set[k]) : set[k],
    );
    return (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE email.mailboxes SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} WHERE id = $1 AND org_id = $2 RETURNING *`,
            [id, orgId, ...vals],
          )
        ).rows[0],
    )) as Row;
  }
  private async runCreate(orgId: string, op: Operation, worker: string): Promise<void> {
    const input = op.input as { mailboxId: string };
    let m = await this.row(orgId, input.mailboxId).catch(() => null);
    if (!m) throw new FlowFailure('not_found', 'the mailbox no longer exists');
    if (m.state === 'active')
      return void (await this.flow.ops.succeed(orgId, op.id, worker, {
        mailboxId: m.id,
        state: 'active',
      }));
    try {
      const a = await this.access(orgId, m);
      const res = await this.residency.evaluate({
        orgId,
        dataClass: 'personal',
        targetRegion: String(m.data_region),
        purpose: 'mailbox_provisioning',
        operation: 'write',
        ...(a.family.startsWith('provider-') ? { processorId: a.providerCode } : {}),
      });
      if (res.decision !== 'allow')
        throw new FlowFailure(
          'residency_denied',
          'placement is no longer allowed by the residency policy',
          { evidenceRef: res.evidenceRef },
        );
      const token = m.create_token as string;
      const spec = {
        domain: m.domain as string,
        localPart: m.local_part as string,
        quotaMb: Number(m.quota_mb),
        tags: { 'nuzm-org': orgTag(orgId), 'nuzm-op': op.id },
      };
      const call = () => a.adapter.provisionMailbox(a.ctx, { ...spec, idempotencyToken: token });
      let setup:
        | { kind: 'reset_link'; url: string; expiresAt: string }
        | { kind: 'one_time_secret'; secret: string }
        | undefined;
      let ref: string | undefined = (m.provider_ref as string | null) ?? undefined;
      if (!ref) {
        let o = outcomeOf(await retryTransient(this.cfg, call));
        if (o.kind === 'uncertain' || (op.attempts > 1 && o.kind !== 'ok')) {
          const f = outcomeOf(await a.adapter.findByToken(a.ctx, token));
          if (f.kind === 'ok' && f.data)
            o = {
              kind: 'ok',
              ref: (f.data as { providerRef: string }).providerRef,
              data: undefined,
            };
          else if (f.kind === 'ok') {
            const again = outcomeOf(await call());
            if (again.kind === 'ok') o = again;
            else throw new FlowUncertain('the mailbox call timed out twice');
          } else throw new FlowUncertain('the mailbox call timed out and the lookup failed');
        }
        if (o.kind === 'failed')
          throw new FlowFailure(
            o.unsupported ? 'unsupported_capability' : 'provider_refused',
            o.message,
          );
        if (o.kind !== 'ok') throw new FlowUncertain('no provider reference after provisioning');
        ref = o.ref ?? (o.data as { providerRef: string } | undefined)?.providerRef;
        setup = (o.data as { passwordSetup?: typeof setup } | undefined)?.passwordSetup;
        if (!ref) throw new FlowUncertain('no provider reference after provisioning');
        m = {
          ...(await this.setMbx(orgId, m.id as string, { provider_ref: ref })),
          domain: m.domain,
        };
      }
      // the password setup goes to the vault immediately (no plaintext anywhere else); a replay that no longer has it just has none to store
      if (setup && !(m.password_setup as { ref?: string } | null)?.ref) {
        let vref: string;
        try {
          vref = await this.secrets.put(`mbx-${String(m.id)}-setup`, JSON.stringify(setup));
        } catch {
          throw new FlowUncertain('the vault is unavailable');
        }
        m = {
          ...(await this.setMbx(orgId, m.id as string, {
            password_setup: { kind: setup.kind, state: 'pending', ref: vref },
          })),
          domain: m.domain,
        };
      }
      m = { ...(await this.setMbx(orgId, m.id as string, { state: 'active' })), domain: m.domain };
      await this.audit.record({
        action: 'email.mailbox.provisioned',
        actorType: 'system',
        orgId,
        resource: { type: 'mailbox', id: String(m.id) },
        outcome: 'success',
        after: { dataRegion: m.data_region },
      });
      await this.flow.ops.succeed(orgId, op.id, worker, { mailboxId: m.id, state: 'active' });
    } catch (e) {
      if (e instanceof FlowFailure)
        await this.setMbx(orgId, m.id as string, { state: 'failed' }).catch(() => undefined);
      throw e;
    }
  }
  private async runUpdate(orgId: string, op: Operation, worker: string): Promise<void> {
    const input = op.input as { mailboxId: string; quotaMb: number };
    const m = await this.row(orgId, input.mailboxId);
    const a = await this.access(orgId, m);
    const r = outcomeOf(
      await retryTransient(this.cfg, () =>
        a.adapter.setQuota(
          a.ctx,
          m.provider_ref as string,
          input.quotaMb,
          idempotencyToken(orgId, op.id, 'quota'),
        ),
      ),
    );
    if (r.kind === 'uncertain') throw new FlowUncertain('the quota call timed out');
    if (r.kind === 'failed')
      throw new FlowFailure(
        r.unsupported ? 'unsupported_capability' : 'provider_refused',
        r.message,
      );
    await this.setMbx(orgId, m.id as string, { quota_mb: input.quotaMb });
    await this.flow.ops.succeed(orgId, op.id, worker, { mailboxId: m.id, quotaMb: input.quotaMb });
  }
  private async runDelete(orgId: string, op: Operation, worker: string): Promise<void> {
    const input = op.input as { mailboxId: string };
    const m = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT m.*, d.domain FROM email.mailboxes m JOIN email.email_domains d ON d.id = m.domain_id WHERE m.id = $1 AND m.org_id = $2`,
            [input.mailboxId, orgId],
          )
        ).rows[0],
    )) as Row | undefined;
    if (!m) throw new FlowFailure('not_found', 'the mailbox no longer exists');
    if (m.state === 'deleted')
      return void (await this.flow.ops.succeed(orgId, op.id, worker, { deleted: true }));
    if (m.provider_ref) {
      const a = await this.access(orgId, m);
      const r = outcomeOf(
        await retryTransient(this.cfg, () =>
          a.adapter.deleteMailbox(
            a.ctx,
            m.provider_ref as string,
            idempotencyToken(orgId, op.id, 'delete'),
          ),
        ),
      );
      if (r.kind === 'uncertain') {
        const i = outcomeOf(await a.adapter.inspectMailbox(a.ctx, m.provider_ref as string));
        if (!(
          i.kind === 'ok' &&
          i.data &&
          (i.data.state === 'deleted' || i.data.state === 'deleting')
        ))
          throw new FlowUncertain('the delete call timed out');
      } else if (r.kind === 'failed')
        throw new FlowFailure(
          r.unsupported ? 'unsupported_capability' : 'delete_failed',
          r.message,
        );
    }
    const ref = (m.password_setup as { ref?: string } | null)?.ref;
    if (ref) await this.secrets.delete(ref).catch(() => undefined);
    await this.setMbx(orgId, m.id as string, { state: 'deleted', deleted_at: new Date() });
    await this.audit.record({
      action: 'email.mailbox.destroyed',
      actorType: 'system',
      orgId,
      resource: { type: 'mailbox', id: String(m.id) },
      outcome: 'success',
    });
    await this.flow.ops.succeed(orgId, op.id, worker, { deleted: true });
  }
  private async runAlias(orgId: string, op: Operation, worker: string): Promise<void> {
    const input = op.input as { aliasId: string };
    const al = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT * FROM email.aliases WHERE id = $1 AND org_id = $2`, [
            input.aliasId,
            orgId,
          ])
        ).rows[0],
    )) as Row | undefined;
    if (!al) throw new FlowFailure('not_found', 'the alias no longer exists');
    const m = await this.row(orgId, al.mailbox_id as string);
    const a = await this.access(orgId, m);
    const r = outcomeOf(
      await retryTransient(this.cfg, () =>
        a.adapter.addAlias(
          a.ctx,
          m.provider_ref as string,
          al.local_part as string,
          al.create_token as string,
        ),
      ),
    );
    if (r.kind === 'uncertain') throw new FlowUncertain('the alias call timed out');
    if (r.kind === 'failed') {
      await this.db.withOrg(orgId, (c) =>
        c.query(`UPDATE email.aliases SET state = 'failed' WHERE id = $1`, [al.id]),
      );
      throw new FlowFailure(
        r.unsupported ? 'unsupported_capability' : 'provider_refused',
        r.message,
      );
    }
    await this.db.withOrg(orgId, (c) =>
      c.query(`UPDATE email.aliases SET state = 'active' WHERE id = $1`, [al.id]),
    );
    await this.flow.ops.succeed(orgId, op.id, worker, { aliasId: al.id });
  }

  /** One-time reveal of the password setup (reset link or one-time secret). PA-19 is NOT exposed over HTTP; this service is what the route will call. */
  async revealSetup(
    orgId: string,
    actor: string,
    id: string,
  ): Promise<
    | { kind: 'reset_link'; url: string; expiresAt: string }
    | { kind: 'one_time_secret'; secret: string }
  > {
    const m = await this.row(orgId, id);
    const ps = m.password_setup as { kind: string; state: string; ref: string } | null;
    if (!ps?.ref)
      throw new ProblemException('conflict', 'this mailbox has no password setup to reveal');
    const won = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE email.mailboxes SET password_setup = jsonb_set(password_setup, '{state}', '"revealed"') WHERE id = $1 AND password_setup->>'state' = 'pending' RETURNING id`,
            [id],
          )
        ).rows[0],
    );
    if (!won)
      throw new ProblemException('conflict', 'the password setup was already revealed once');
    const v = JSON.parse(await this.secrets.get(ps.ref)) as
      | { kind: 'reset_link'; url: string; expiresAt: string }
      | { kind: 'one_time_secret'; secret: string };
    await this.audit.record({
      action: 'email.mailbox.setup_revealed',
      actorUserId: actor,
      orgId,
      resource: { type: 'mailbox', id },
      outcome: 'success',
      after: { kind: ps.kind },
    });
    return v;
  }

  // ---- metering -------------------------------------------------------------------------------------------------------------------
  /**
   * Daily accrual (M08 §10): `email.mailbox_months` = 1/30 per active mailbox per day; `email.mailbox_storage_gb_months` from the provider's usage report. Storage the provider
   * cannot report is `unavailable` (no event, flagged on the mailbox, never estimated). Deterministic event ids make a re-run idempotent.
   */
  async collectDaily(day: Date): Promise<number> {
    const start = new Date(Math.floor(day.getTime() / 86_400_000) * 86_400_000);
    const end = new Date(start.getTime() + 86_400_000);
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT m.* FROM email.mailboxes m WHERE m.state = 'active' AND m.created_at < $1 ORDER BY m.id`,
            [end],
          )
        ).rows as Row[],
    );
    let n = 0;
    const usageByProvider = new Map<string, Map<string, number | null>>();
    for (const m of rows) {
      const orgId = m.org_id as string;
      const mk = (meterId: string, quantity: string, unit: string): UsageEvent => ({
        eventId: usageEventId({
          orgId,
          meterId,
          resourceId: String(m.id),
          windowStart: start.toISOString(),
        }),
        orgId,
        meterId,
        quantity,
        unit,
        resourceId: String(m.id),
        windowStart: start.toISOString(),
        windowEnd: end.toISOString(),
        occurredAt: end.toISOString(),
        dimensions: { plan: String(m.plan_ref ?? 'standard') },
        dataRegion: String(m.data_region),
        source: 'email@M08',
      });
      const events = [mk('email.mailbox_months', '0.03333333', 'mailbox_month')];
      try {
        const pid = String(m.provider_id);
        if (!usageByProvider.has(pid)) {
          const p = await this.providers.byId(orgId, pid, 'mailbox');
          const map = new Map<string, number | null>();
          if (p) {
            const r = outcomeOf(
              await (p.adapter as unknown as MailboxAdapter).usage(
                this.registry.ctx({ id: p.row.id, config: p.row.config }, 'mailbox-usage'),
                { from: start.toISOString(), to: end.toISOString() },
              ),
            );
            if (r.kind === 'ok' && r.data)
              for (const u of r.data) map.set(u.providerRef, u.storageBytes);
          }
          usageByProvider.set(pid, map);
        }
        const bytes = usageByProvider.get(pid)!.get(String(m.provider_ref)) ?? null;
        if (bytes !== null && bytes !== undefined)
          events.push(
            mk('email.mailbox_storage_gb_months', gibMonthFraction(BigInt(bytes)), 'gib_month'),
          );
        await this.db.withOrg(orgId, async (c) => {
          for (const e of events) await emitUsage(c, e);
          await c.query(`UPDATE email.mailboxes SET usage = $2 WHERE id = $1`, [
            m.id,
            JSON.stringify({ at: end.toISOString(), storageBytes: bytes ?? null }),
          ]);
        });
        n += events.length;
      } catch {
        /* one mailbox never stops the others; the next run covers the same day */
      }
    }
    return n;
  }
}
