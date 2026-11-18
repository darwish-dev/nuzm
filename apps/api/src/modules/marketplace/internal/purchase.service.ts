import { v5 as uuidv5, v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { recipes, type LedgerPostingService } from '../../billing';
import type { OrderService, QuoteService } from '../../commerce';
import type { InvoiceService } from '../../invoicing';
import { MARKETPLACE_FLAG, badRequest, isUuid, iso, pgCode, shareOf, type MarketplaceConfig, type Row } from './model';

const NS = '8c1b7f0e-5d2a-5b69-9f43-3a6d0e5c2b11';
export interface PurchaseDto {
  purchaseId: string;
  listingId: string;
  listingVersionId: string;
  invoiceId: string | null;
  entitlementId: string;
  status: 'pending_payment' | 'paid' | 'failed' | 'refunded';
  entitlementStatus: 'pending' | 'active' | 'revoked';
  amount: { amount: string; currency: string };
  paidAt: string | null;
  createdAt: string;
}

/**
 * Marketplace purchases (M11 S53.3-S53.6). quote (kind `marketplace`) → order (spend and quota rules apply) → invoice through M03 (`InvoiceService.issueOrderCharge`, revenue 4400) → payment through
 * M03 (`/v1/billing/payments`, or at once with the default method) → entitlement ACTIVE and the publisher share ACCRUED (ledger 2600) once the invoice is PAID. Every step is idempotent on
 * the purchase id (a deterministic function of buyer and quote), so a duplicate request or callback, a crash between steps, or two concurrent purchases give exactly one order, one invoice,
 * one entitlement and one accrual. A refund (a credit note covering the invoice) revokes the entitlement (installs already made stay; no further install) and reverses the accrual.
 * There is NO payout: this service writes liabilities, never payments to publishers (D-26 / HG-11-01 open).
 */
export class PurchaseService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly quotes: Pick<QuoteService, 'internal'>,
    private readonly orders: Pick<OrderService, 'createFromQuote' | 'findByQuote'>,
    private readonly invoices: Pick<InvoiceService, 'issueOrderCharge' | 'get' | 'creditedMinor'>,
    private readonly ledger: Pick<LedgerPostingService, 'post'>,
    private readonly flags: { enabled(orgId: string | null, key: string): Promise<boolean> },
    private readonly cfg: MarketplaceConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  static purchaseId(orgId: string, quoteId: string) {
    return uuidv5(`${orgId}|${quoteId}`, NS);
  }
  private dto(p: Row, e: Row): PurchaseDto {
    return {
      purchaseId: p.id, listingId: p.listing_id, listingVersionId: p.listing_version_id, invoiceId: p.invoice_id ?? null, entitlementId: e.id, status: p.status, entitlementStatus: e.status,
      amount: { amount: String(p.amount_minor), currency: (p.currency as string).trim() }, paidAt: iso(p.paid_at), createdAt: iso(p.created_at)!,
    };
  }
  private async load(orgId: string, purchaseId: string): Promise<{ p: Row; e: Row } | null> {
    return this.db.withOrg(orgId, async (c) => {
      const p = (await c.query(`SELECT * FROM marketplace.purchases WHERE id = $1 AND org_id = $2`, [purchaseId, orgId])).rows[0] as Row | undefined;
      if (!p) return null;
      return { p, e: (await c.query(`SELECT * FROM marketplace.entitlements_mkt WHERE purchase_id = $1`, [purchaseId])).rows[0] as Row };
    });
  }

  /** POST /v1/marketplace/purchases */
  async create(orgId: string, actor: string, body: Record<string, unknown>): Promise<{ purchase: PurchaseDto; http: 200 | 202 }> {
    for (const k of Object.keys(body)) if (!['listingId', 'versionId', 'quoteId'].includes(k)) throw badRequest(`unknown field ${k}`);
    if (!(await this.flags.enabled(orgId, MARKETPLACE_FLAG))) throw new ProblemException('feature_disabled', 'the marketplace is not enabled for this organization');
    if (!isUuid(body.listingId) || !isUuid(body.quoteId) || (body.versionId !== undefined && !isUuid(body.versionId))) throw badRequest('listingId and quoteId are required uuids (versionId optional)');
    const quoteId = (body.quoteId as string).toLowerCase();
    const purchaseId = PurchaseService.purchaseId(orgId, quoteId);

    // a repeat of the same purchase (same quote): the original, after bringing it up to date
    const again = await this.load(orgId, purchaseId);
    if (again) return this.finish(orgId, purchaseId, actor);

    const q = await this.quotes.internal(orgId, quoteId); // 404 for another organization's quote
    const item = q.items[0];
    const d = item?.details as { listingId?: string; versionId?: string } | undefined;
    if (q.kind !== 'marketplace' || !d || q.items.length !== 1) throw new ProblemException('quote_conflict', 'the quote is not a marketplace quote');
    if (d.listingId !== (body.listingId as string).toLowerCase() || (body.versionId !== undefined && d.versionId !== (body.versionId as string).toLowerCase())) throw new ProblemException('quote_conflict', 'the quote was issued for another listing or version');
    if (q.expiresAt.getTime() <= this.now().getTime()) throw new ProblemException('quote_expired', 'this quote has expired; request a new one');

    const cur = await this.db.withOrg(orgId, async (c) => {
      const l = (await c.query(`SELECT * FROM marketplace.listings WHERE id = $1 AND status = 'published'`, [d.listingId])).rows[0] as Row | undefined;
      const v = l ? ((await c.query(`SELECT * FROM marketplace.listing_versions WHERE id = $1 AND listing_id = $2 AND moderation_status = 'approved'`, [d.versionId, d.listingId])).rows[0] as Row | undefined) : undefined;
      const ent = (await c.query(`SELECT 1 FROM marketplace.entitlements_mkt WHERE org_id = $1 AND listing_id = $2 AND status IN ('pending','active')`, [orgId, d.listingId])).rowCount;
      return { l, v, ent };
    });
    if (!cur.l || !cur.v || cur.l.org_id === orgId) throw new ProblemException('not_purchasable', 'this listing or version cannot be purchased');
    const lst: Row = cur.l;
    const ver: Row = cur.v;
    if (cur.ent) throw new ProblemException('already_entitled', 'this organization already holds an entitlement for this listing');
    const net = BigInt(item!.amountMinor);
    if (net !== BigInt(lst.price_minor) || q.currency !== (lst.currency as string).trim()) throw new ProblemException('price_changed', 'the price changed since the quote was issued; request a new quote');
    const share = shareOf(net, this.cfg.publisherShareBps);

    // 1. order (spend limits, quotas, dunning); an order from a crashed earlier attempt is adopted
    let orderId: string | null = null;
    let invoiceId: string | null = null;
    if (net > 0n) {
      const existingOrder = await this.orders.findByQuote(orgId, quoteId);
      orderId = existingOrder?.id ?? (await this.orders.createFromQuote(orgId, quoteId, actor, this.now())).id;
      // 2. invoice (idempotent on the purchase id)
      const inv = await this.invoices.issueOrderCharge(orgId, { sourceKey: `marketplace:${purchaseId}`, currency: q.currency, lines: [{ description: item!.details.version ? `Marketplace: ${lst.title_en} v${String(item!.details.version)}` : `Marketplace: ${lst.title_en}`, quantity: '1', unit: 'licence', netMinor: net.toString(), sourceId: purchaseId, revenueAccount: '4400' }] }, actor, this.now());
      invoiceId = inv.invoice.id;
    }
    // 3. purchase + entitlement (pending until the invoice is paid; a free listing is active at once)
    try {
      await this.db.withOrg(orgId, async (c) => {
        await c.query(
          `INSERT INTO marketplace.purchases (id, org_id, listing_id, listing_version_id, publisher_id, publisher_org_id, quote_id, order_id, invoice_id, status, amount_minor, currency, publisher_share_minor, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending_payment',$10,$11,$12,$13) ON CONFLICT (org_id, quote_id) DO NOTHING`,
          [purchaseId, orgId, lst.id, ver.id, lst.publisher_id, lst.org_id, quoteId, orderId, invoiceId, net.toString(), q.currency, share.toString(), actor],
        );
        await c.query(`INSERT INTO marketplace.entitlements_mkt (id, org_id, listing_id, purchase_id, version_range, licence, seats, status) VALUES ($1,$2,$3,$4,'*',$5,$6,'pending') ON CONFLICT (purchase_id) DO NOTHING`, [uuidv7(), orgId, lst.id, purchaseId, lst.licence, lst.seats]);
      });
    } catch (e) {
      if (pgCode(e) === '23505') throw new ProblemException('already_entitled', 'this organization already holds an entitlement for this listing');
      throw e;
    }
    await this.audit.record({ action: 'purchase.purchase.created', actorUserId: actor, orgId, resource: { type: 'purchase', id: purchaseId }, outcome: 'success', after: { listingId: lst.id, versionId: ver.id, invoiceId, amountMinor: net.toString(), currency: q.currency } });
    if (net === 0n) await this.settle(orgId, purchaseId, actor);

    // 4. the buyer pays the INVOICE through M03 (POST /v1/billing/payments with the invoiceId and a return URL): payment needs the buyer's own payment method and, for redirect methods,
    //    the buyer's return URL, so it is a separate, idempotent M03 call, not hidden inside this endpoint. The purchase follows the invoice (see `sync`).
    return this.finish(orgId, purchaseId, actor);
  }

  private async finish(orgId: string, purchaseId: string, actor: string | null): Promise<{ purchase: PurchaseDto; http: 200 | 202 }> {
    const synced = await this.sync(orgId, purchaseId, actor);
    return { purchase: synced, http: synced.status === 'paid' ? 200 : 202 };
  }

  /** GET /v1/marketplace/purchases/{id}: brings the purchase up to date with its invoice first (webhook-safe: the payment webhook only updates the invoice). */
  async get(orgId: string, purchaseId: string): Promise<PurchaseDto> {
    if (!isUuid(purchaseId)) throw new ProblemException('not_found');
    if (!(await this.load(orgId, purchaseId.toLowerCase()))) throw new ProblemException('not_found');
    return this.sync(orgId, purchaseId.toLowerCase(), null);
  }

  /**
   * Reconcile ONE purchase with its invoice. Idempotent and safe to call from anywhere, any number of times: pending → paid (entitlement active, accrual posted once);
   * pending → failed (invoice void/uncollectible); paid → refunded (credit note covers the invoice: entitlement revoked, accrual reversed once).
   */
  async sync(orgId: string, purchaseId: string, actor: string | null): Promise<PurchaseDto> {
    const x = await this.load(orgId, purchaseId);
    if (!x) throw new ProblemException('not_found');
    const { p } = x;
    if (p.status === 'pending_payment' && p.invoice_id) {
      const inv = await this.invoices.get(orgId, p.invoice_id);
      if (inv.status === 'paid') await this.settle(orgId, purchaseId, actor);
      else if (inv.status === 'void' || inv.status === 'uncollectible') await this.fail(orgId, purchaseId, inv.status);
    } else if (p.status === 'paid' && p.invoice_id) {
      const inv = await this.invoices.get(orgId, p.invoice_id);
      const credited = await this.invoices.creditedMinor(orgId, p.invoice_id);
      if (credited >= BigInt(inv.totalMinor)) await this.refund(orgId, purchaseId, actor);
    }
    const y = await this.load(orgId, purchaseId);
    return this.dto(y!.p, y!.e);
  }

  private async settle(orgId: string, purchaseId: string, actor: string | null): Promise<void> {
    const became = await this.db.withOrg(orgId, async (c) => {
      const r = await c.query(`UPDATE marketplace.purchases SET status = 'paid', paid_at = now() WHERE id = $1 AND status = 'pending_payment' RETURNING id`, [purchaseId]);
      if (!r.rowCount) return false;
      await c.query(`UPDATE marketplace.entitlements_mkt SET status = 'active' WHERE purchase_id = $1 AND status = 'pending'`, [purchaseId]);
      return true;
    });
    if (became) {
      await this.audit.record({ action: 'purchase.purchase.completed', ...(actor ? { actorUserId: actor } : { actorType: 'system' as const }), orgId, resource: { type: 'purchase', id: purchaseId }, outcome: 'success' });
      await this.audit.record({ action: 'entitlement.entitlement.granted', ...(actor ? { actorUserId: actor } : { actorType: 'system' as const }), orgId, resource: { type: 'purchase', id: purchaseId }, outcome: 'success' });
    }
    await this.accrue(orgId, purchaseId, false); // idempotent even when `became` is false: a crash between settle and accrue is repaired by the next sync
  }

  private async fail(orgId: string, purchaseId: string, why: string): Promise<void> {
    await this.db.withOrg(orgId, async (c) => {
      await c.query(`UPDATE marketplace.purchases SET status = 'failed' WHERE id = $1 AND status = 'pending_payment'`, [purchaseId]);
      await c.query(`UPDATE marketplace.entitlements_mkt SET status = 'revoked', revoked_at = now(), revoke_reason = $2 WHERE purchase_id = $1 AND status = 'pending'`, [purchaseId, `invoice ${why}`]);
    });
  }

  private async refund(orgId: string, purchaseId: string, actor: string | null): Promise<void> {
    const became = await this.db.withOrg(orgId, async (c) => {
      const r = await c.query(`UPDATE marketplace.purchases SET status = 'refunded', refunded_at = now() WHERE id = $1 AND status = 'paid' RETURNING id`, [purchaseId]);
      if (!r.rowCount) return false;
      await c.query(`UPDATE marketplace.entitlements_mkt SET status = 'revoked', revoked_at = now(), revoke_reason = 'refund' WHERE purchase_id = $1 AND status IN ('pending','active')`, [purchaseId]);
      return true;
    });
    if (became) await this.audit.record({ action: 'entitlement.entitlement.revoked', ...(actor ? { actorUserId: actor } : { actorType: 'system' as const }), orgId, resource: { type: 'purchase', id: purchaseId }, outcome: 'success', detail: { reason: 'refund' } });
    await this.accrue(orgId, purchaseId, true);
  }

  /** Revoke an entitlement for another reason (chargeback, abuse): service-level, audited. Further installs are blocked; installs already made stay. */
  async revokeEntitlement(orgId: string, entitlementId: string, reason: string, actor: string | null): Promise<void> {
    const n = await this.db.withOrg(orgId, async (c) => (await c.query(`UPDATE marketplace.entitlements_mkt SET status = 'revoked', revoked_at = now(), revoke_reason = $3 WHERE id = $1 AND org_id = $2 AND status IN ('pending','active')`, [entitlementId, orgId, reason.slice(0, 200)])).rowCount);
    if (!n) throw new ProblemException('not_found');
    await this.audit.record({ action: 'entitlement.entitlement.revoked', ...(actor ? { actorUserId: actor } : { actorType: 'system' as const }), orgId, resource: { type: 'entitlement', id: entitlementId }, outcome: 'success', detail: { reason } });
  }

  /** The publisher's ACCRUAL (ledger 2600) and its log row. Both idempotent on the purchase id. */
  private async accrue(orgId: string, purchaseId: string, reverse: boolean): Promise<void> {
    const p = (await this.load(orgId, purchaseId))!.p;
    if (p.status !== 'paid' && !(reverse && p.status === 'refunded')) return;
    const share = BigInt(p.publisher_share_minor);
    if (share === 0n || !p.invoice_id) return;
    const built = recipes.publisherAccrual({ orgId, publisherId: p.publisher_id, purchaseId, invoiceId: p.invoice_id, shareMinor: share, currency: (p.currency as string).trim(), reverse });
    const posted = await this.ledger.post(built, built.sourceEventId!);
    await this.db.withOrg(p.publisher_org_id, (c) =>
      c.query(
        `INSERT INTO marketplace.publisher_accruals (id, org_id, publisher_id, listing_id, purchase_id, invoice_id, kind, gross_minor, share_minor, currency, ledger_transaction_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (purchase_id, kind) DO NOTHING`,
        [uuidv7(), p.publisher_org_id, p.publisher_id, p.listing_id, purchaseId, p.invoice_id, reverse ? 'reversal' : 'accrual', p.amount_minor, share.toString(), (p.currency as string).trim(), posted.transactionId],
      ),
    );
    if (!reverse) await this.audit.record({ action: 'purchase.accrual.posted', actorType: 'system', orgId, resource: { type: 'purchase', id: purchaseId }, outcome: 'success', detail: { shareMinor: share.toString() } });
  }

  /** Background reconciliation: bring every open purchase up to date (payment webhooks, refunds). Returns how many changed state. */
  async syncOpen(limit = 100): Promise<number> {
    const open = await this.db.withPlatformScope(async (c) => (await c.query(`SELECT id, org_id, status FROM marketplace.purchases WHERE status IN ('pending_payment','paid') ORDER BY updated_at LIMIT $1`, [limit])).rows as Row[]);
    let n = 0;
    for (const o of open) {
      const before = o.status;
      const after = await this.sync(o.org_id, o.id, null).catch(() => null);
      if (after && after.status !== before) n++;
    }
    return n;
  }
}
