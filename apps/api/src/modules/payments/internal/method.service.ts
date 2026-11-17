import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { containsCardData } from './pan';
import type { PspRegistry } from './psp/registry';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^tok_[a-z0-9_]{3,80}$/;

export interface PaymentMethodDto {
  id: string;
  provider: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  status: 'active' | 'removed';
  isDefault: boolean;
  /** Expires within 60 days (or already did): drives the "expiring" badge. */
  expiring: boolean;
  createdAt: string;
}
const dto = (r: Row, provider: string, now: Date): PaymentMethodDto => {
  const end = Date.UTC(r.exp_year as number, r.exp_month as number, 1); // first instant after the expiry month
  return {
    id: r.id as string,
    provider,
    brand: r.brand as string,
    last4: (r.last4 as string).trim(),
    expMonth: r.exp_month as number,
    expYear: r.exp_year as number,
    status: r.status as 'active' | 'removed',
    isDefault: r.is_default as boolean,
    expiring: end - now.getTime() < 60 * 86_400_000,
    createdAt: (r.created_at as Date).toISOString(),
  };
};

/**
 * Tokenized payment methods (docs/11 §7). Methods come from a PSP-produced setup token (hosted fields / redirect); a request that carries
 * card data in any form is refused before anything else happens (`pan_not_allowed`). Only token, brand, last4, expiry and a
 * fingerprint are stored.
 */
export class PaymentMethodService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly psp: PspRegistry,
  ) {}

  async create(
    orgId: string,
    actorUserId: string,
    input: Record<string, unknown>,
    now = new Date(),
  ): Promise<PaymentMethodDto> {
    if (containsCardData(input))
      throw new ProblemException(
        'pan_not_allowed',
        'send the setup token produced by the PSP hosted fields; card numbers are never accepted',
      );
    const provider = input.provider;
    if (typeof provider !== 'string')
      throw new ProblemException('validation_failed', 'provider is required');
    const adapter = this.psp.find(provider);
    if (!adapter) throw new ProblemException('validation_failed', `unknown provider '${provider}'`);
    if (typeof input.setupToken !== 'string' || !TOKEN.test(input.setupToken))
      throw new ProblemException(
        'validation_failed',
        'setupToken (the token produced by the PSP hosted fields) is required; redirect set-ups are not supported by this provider',
      );
    const account = await this.db.withoutScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, code FROM payments.psp_accounts WHERE provider = $1 AND status = 'active' ORDER BY created_at LIMIT 1`,
            [provider],
          )
        ).rows[0],
    );
    if (!account)
      throw new ProblemException(
        'service_unavailable',
        'no PSP account is configured for this provider',
      );
    const customerRef = await this.customer(orgId, account.id as string, adapter);
    let details;
    try {
      details = await adapter.attachMethod(customerRef, input.setupToken);
    } catch {
      throw new ProblemException(
        'validation_failed',
        'the PSP did not accept this setup token (it may be expired or already used)',
      );
    }
    const id = uuidv7();
    try {
      return await this.db.withOrg(orgId, async (c) => {
        const first = !(
          await c.query(
            `SELECT 1 FROM payments.payment_methods WHERE org_id = $1 AND status = 'active'`,
            [orgId],
          )
        ).rowCount;
        const row = (
          await c.query(
            `INSERT INTO payments.payment_methods (id, org_id, psp_account_id, token_ref, brand, last4, exp_month, exp_year, fingerprint, is_default, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
            [
              id,
              orgId,
              account.id,
              details.token,
              details.brand,
              details.last4,
              details.expMonth,
              details.expYear,
              details.fingerprint,
              first,
              actorUserId,
            ],
          )
        ).rows[0]!;
        await this.audit.record({
          action: 'payments.payment_method.added',
          actorUserId,
          orgId,
          resource: { type: 'payment_method', id },
          outcome: 'success',
          after: { provider, brand: details.brand, last4: details.last4, default: first },
        });
        return dto(row, provider, now);
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        await adapter.detachMethod(details.token).catch(() => undefined);
        throw new ProblemException('conflict', 'this payment method is already saved');
      }
      throw e;
    }
  }

  private async customer(
    orgId: string,
    accountId: string,
    adapter: { createCustomer(o: string): Promise<{ customerRef: string }> },
  ): Promise<string> {
    const existing = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query<{ psp_customer_ref: string }>(
            `SELECT psp_customer_ref FROM payments.customers_psp WHERE org_id = $1 AND psp_account_id = $2`,
            [orgId, accountId],
          )
        ).rows[0],
    );
    if (existing) return existing.psp_customer_ref;
    const { customerRef } = await adapter.createCustomer(orgId);
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `INSERT INTO payments.customers_psp (org_id, psp_account_id, psp_customer_ref) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [orgId, accountId, customerRef],
      ),
    );
    return customerRef;
  }

  async list(orgId: string, now = new Date()): Promise<{ items: PaymentMethodDto[] }> {
    return this.db.withOrg(orgId, async (c) => {
      const rows = (
        await c.query(
          `SELECT m.*, a.provider FROM payments.payment_methods m JOIN payments.psp_accounts a ON a.id = m.psp_account_id WHERE m.org_id = $1 AND m.status = 'active' ORDER BY m.is_default DESC, m.created_at DESC, m.id`,
          [orgId],
        )
      ).rows;
      return { items: rows.map((r) => dto(r, r.provider as string, now)) };
    });
  }

  async setDefault(
    orgId: string,
    id: string,
    actorUserId: string,
    now = new Date(),
  ): Promise<PaymentMethodDto> {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    return this.db.withOrg(orgId, async (c) => {
      const m = (
        await c.query(
          `SELECT m.*, a.provider FROM payments.payment_methods m JOIN payments.psp_accounts a ON a.id = m.psp_account_id WHERE m.id = $1 AND m.org_id = $2 FOR UPDATE OF m`,
          [id, orgId],
        )
      ).rows[0];
      if (!m || m.status !== 'active') throw new ProblemException('not_found');
      await c.query(
        `UPDATE payments.payment_methods SET is_default = false WHERE org_id = $1 AND is_default AND id <> $2`,
        [orgId, id],
      );
      await c.query(`UPDATE payments.payment_methods SET is_default = true WHERE id = $1`, [id]);
      await this.audit.record({
        action: 'payments.payment_method.default_changed',
        actorUserId,
        orgId,
        resource: { type: 'payment_method', id },
        outcome: 'success',
      });
      return dto({ ...m, is_default: true }, m.provider as string, now);
    });
  }

  /**
   * Tell the billing managers that a saved card expires within `days` (or already expired): once per method, recorded on the method. The notice
   * says which card (last four digits and expiry month/year), never more. Returns how many methods were announced.
   */
  async notifyExpiring(
    notify: (orgId: string, kind: string, params: Record<string, unknown>) => Promise<void>,
    now = new Date(),
    days = 30,
    limit = 200,
  ): Promise<number> {
    const today = now.toISOString().slice(0, 10);
    const due = await this.db.withoutScope(
      async (c) =>
        (
          await c.query<{
            org_id: string;
            method_id: string;
            last4: string;
            exp_month: number;
            exp_year: number;
          }>(
            `SELECT org_id, method_id, last4, exp_month, exp_year FROM payments.methods_expiring($1::date, $2, $3)`,
            [today, days, limit],
          )
        ).rows,
    );
    let n = 0;
    for (const m of due) {
      // claim first (once), then tell: a crash in between loses one notice, never repeats it
      const claimed = await this.db.withOrg(
        m.org_id,
        async (c) =>
          (
            await c.query(
              `UPDATE payments.payment_methods SET expiry_notified_at = $2::date WHERE id = $1 AND expiry_notified_at IS NULL AND status = 'active'`,
              [m.method_id, today],
            )
          ).rowCount,
      );
      if (!claimed) continue;
      await notify(m.org_id, 'billing.card_expiring', {
        methodId: m.method_id,
        last4: m.last4,
        month: m.exp_month,
        year: m.exp_year,
      }).catch(() => undefined);
      n++;
    }
    return n;
  }

  private readonly usageGuards: ((orgId: string, methodId: string) => Promise<boolean>)[] = [];
  /** Other modules (subscriptions) register a check that says whether a method is still needed; such a method cannot be removed (409). */
  registerUsageGuard(fn: (orgId: string, methodId: string) => Promise<boolean>): void {
    this.usageGuards.push(fn);
  }

  /** The method exists, belongs to the organization and is active (404 otherwise). */
  async assertUsable(orgId: string, id: string): Promise<void> {
    const ok = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT 1 FROM payments.payment_methods WHERE id = $1 AND org_id = $2 AND status = 'active'`,
            [id, orgId],
          )
        ).rowCount,
    );
    if (!ok) throw new ProblemException('not_found', 'payment method not found');
  }

  /** Remove (detach at the PSP, mark removed). A method with an open payment cannot be removed. The default passes to the newest other one. */
  async remove(orgId: string, id: string, actorUserId: string): Promise<void> {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    const m = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT m.*, a.provider FROM payments.payment_methods m JOIN payments.psp_accounts a ON a.id = m.psp_account_id WHERE m.id = $1 AND m.org_id = $2`,
            [id, orgId],
          )
        ).rows[0],
    );
    if (!m || m.status !== 'active') throw new ProblemException('not_found');
    for (const guard of this.usageGuards)
      if (await guard(orgId, id))
        throw new ProblemException(
          'conflict',
          'this payment method is used by an active subscription; change the subscription first',
        );
    await this.db.withOrg(orgId, async (c) => {
      if (
        (
          await c.query(
            `SELECT 1 FROM payments.payment_intents WHERE org_id = $1 AND payment_method_id = $2 AND status IN ('requires_action','processing')`,
            [orgId, id],
          )
        ).rowCount
      )
        throw new ProblemException('conflict', 'this payment method has a payment in progress');
      await c.query(
        `UPDATE payments.payment_methods SET status = 'removed', is_default = false, removed_at = now() WHERE id = $1`,
        [id],
      );
      if (m.is_default) {
        const next = (
          await c.query<{ id: string }>(
            `SELECT id FROM payments.payment_methods WHERE org_id = $1 AND status = 'active' ORDER BY created_at DESC, id LIMIT 1`,
            [orgId],
          )
        ).rows[0];
        if (next)
          await c.query(`UPDATE payments.payment_methods SET is_default = true WHERE id = $1`, [
            next.id,
          ]);
      }
      await this.audit.record({
        action: 'payments.payment_method.removed',
        actorUserId,
        orgId,
        resource: { type: 'payment_method', id },
        outcome: 'success',
        after: { brand: m.brand, last4: (m.last4 as string).trim() },
      });
    });
    // after our records are final, ask the PSP to forget the token (best effort: a leftover token at the PSP cannot be charged without us)
    await this.psp
      .find(m.provider as string)
      ?.detachMethod(m.token_ref as string)
      .catch(() => undefined);
  }
}
