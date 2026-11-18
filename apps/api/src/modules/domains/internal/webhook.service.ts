import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import {
  WebhookRejectedError,
  type VerifiedEvent,
  type VaultClient,
} from '@nuzm/registrar-contracts';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { Row } from './common';
import type { DomainOrderService } from './orders.service';
import type { DomainsConfig } from './ports';
import type { RegistrarAccessService } from './registrar-access.service';

export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored';

/**
 * Inbound registrar webhooks (M07 S29 task 5): signature over the RAW body, replay window, dedupe on the provider's event id in
 * `platform.webhook_events_inbound` (unique (provider, event_id)), durable record, then `200`. A duplicate changes nothing. The stored payload is a
 * whitelist, never the raw body. Unknown event kinds are stored and ignored. State changes go through the order service's idempotent paths.
 */
export class RegistrarWebhookService {
  constructor(
    private readonly db: Db,
    private readonly access: RegistrarAccessService,
    private readonly orders: DomainOrderService,
    private readonly vault: VaultClient,
    private readonly audit: AuditSink,
    private readonly cfg: DomainsConfig,
  ) {}

  async receive(
    provider: string,
    rawBody: string | undefined,
    headers: Record<string, string | string[] | undefined>,
    now = new Date(),
  ): Promise<{ outcome: WebhookOutcome }> {
    const accounts = (await this.access.listAccounts()).filter(
      (a) => a.providerCode === provider && a.webhookSecretRef && a.registrarEnabled,
    );
    if (accounts.length === 0) throw new ProblemException('not_found');
    if (typeof rawBody !== 'string')
      throw new ProblemException('invalid_signature', 'the raw body is required for verification');
    let ev: VerifiedEvent | null = null;
    let accountId: string | null = null;
    let last: WebhookRejectedError | null = null;
    for (const a of accounts) {
      const acc = this.access.accessFor(a, 'webhook');
      if (!acc?.adapter.parseWebhook) continue;
      let secret: string;
      try {
        secret = (await this.vault.resolve(a.webhookSecretRef!)).fields.secret ?? '';
      } catch {
        continue;
      }
      try {
        ev = acc.adapter.parseWebhook(headers, rawBody, {
          secret,
          now,
          toleranceMs: this.cfg.webhookToleranceMs,
        });
        accountId = a.id;
        break;
      } catch (e) {
        if (e instanceof WebhookRejectedError) last = e;
        else throw e;
      }
    }
    if (!ev) {
      if (!last) throw new ProblemException('not_found'); // no account of this provider can verify webhooks
      if (last.reason === 'replay')
        throw new ProblemException('conflict', 'the delivery is outside the replay window');
      throw new ProblemException(
        last.reason === 'malformed' ? 'validation_failed' : 'invalid_signature',
        last.message,
      );
    }
    const payload = {
      kind: ev.kind,
      rawType: ev.rawType.slice(0, 80),
      domainName: ev.domainName,
      providerRef: ev.providerRef,
      occurredAt: ev.occurredAt,
    };
    const fresh = await this.db.withoutScope(async (c) => {
      const r = await c.query(
        `INSERT INTO platform.webhook_events_inbound (id, provider, event_id, signature_ok, payload) VALUES ($1,$2,$3,true,$4) ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
        [uuidv7(), provider, ev!.eventId, JSON.stringify(payload)],
      );
      return r.rowCount === 1;
    });
    if (!fresh) return { outcome: 'duplicate' };
    const outcome = await this.process(ev, accountId!).catch(async (e) => {
      await this.audit.record({
        action: 'domain.webhook.failed',
        outcome: 'failure',
        detail: { provider, kind: ev!.kind, error: (e as Error).message.slice(0, 120) },
      });
      return 'ignored' as const;
    });
    await this.db.withoutScope((c) =>
      c.query(
        `UPDATE platform.webhook_events_inbound SET processed_at = now() WHERE provider=$1 AND event_id=$2`,
        [provider, ev!.eventId],
      ),
    );
    return { outcome };
  }

  private async process(ev: VerifiedEvent, accountId: string): Promise<WebhookOutcome> {
    if (ev.kind === 'unknown' || !ev.domainName) return 'ignored';
    const ref = await this.db.withoutScope(
      async (c) =>
        (await c.query(`SELECT * FROM domains.resolve_domain($1)`, [ev.domainName])).rows[0] as
          Row | undefined,
    );
    if (!ref || ref.registrar_account_id !== accountId) return 'ignored'; // a name we do not hold at this account: nothing to change, nothing to leak
    const orgId = ref.org_id as string;
    if (
      ev.kind === 'domain.registered' ||
      ev.kind === 'domain.renewed' ||
      ev.kind === 'domain.transfer_completed'
    ) {
      const order = await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `SELECT id FROM domains.domain_orders WHERE domain_id=$1 AND state IN ('provider_pending','needs_reconcile','authorized') ORDER BY created_at DESC LIMIT 1`,
              [ref.id],
            )
          ).rows[0] as Row | undefined,
      );
      if (!order) return 'ignored';
      const r = await this.orders.reconcileOrder(orgId, order.id as string, 'webhook');
      return r === 'finalized' || r === 'pending' || r === 'retried' ? 'processed' : 'ignored';
    }
    if (ev.kind === 'domain.transfer_failed') {
      const order = await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `SELECT id FROM domains.domain_orders WHERE domain_id=$1 AND type='transfer_in' AND state IN ('provider_pending','needs_reconcile','authorized') LIMIT 1`,
              [ref.id],
            )
          ).rows[0] as Row | undefined,
      );
      if (!order) return 'ignored';
      await this.orders.failFromProvider(orgId, order.id as string, 'transfer_failed');
      return 'processed';
    }
    if (ev.kind === 'domain.expired' || ev.kind === 'domain.deleted') {
      await this.db.withOrg(orgId, async (c) => {
        await c.query(
          `UPDATE domains.domains SET state='expired', version=version+1, updated_at=now() WHERE id=$1 AND state IN ('active','renewal_at_risk')`,
          [ref.id],
        );
      });
      await this.audit.record({
        action: 'domain.state.expired',
        orgId,
        resource: { type: 'domain', id: ref.id as string },
        outcome: 'success',
        detail: { via: 'webhook' },
      });
      return 'processed';
    }
    return 'ignored';
  }
}
