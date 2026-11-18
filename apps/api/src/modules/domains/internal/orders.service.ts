import type { PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { assertTransition, type ResidencyEvaluator } from '@nuzm/domain';
import {
  emitUsage,
  enqueue,
  usageEventId,
  type Db,
  type Operation,
  type OperationsService,
} from '@nuzm/platform';
import {
  idempotencyToken,
  isSupported,
  type ContactSet,
  type DomainRef,
  type OperationResult,
} from '@nuzm/registrar-contracts';
import type { AuditSink } from '../../../common/audit';
import { ProblemException, type ErrorCode } from '../../../common/errors';
import type { FieldCipher } from '../../../common/field-crypto';
import type { LedgerPostingService } from '../../billing';
import type { OrderService as CommerceOrders } from '../../commerce';
import type { ConsentService } from '../../compliance';
import { selfRef } from '../../compliance';
import type { ProviderCostService } from '../../metering';
import { UUID, badRequest, pgCode, type Row } from './common';
import { openContact, parseContacts, sealContact } from './contacts';
import type { DomainQuoteItem } from './domain-pricer';
import { RESIDENCY_PURPOSE } from './domain-pricer';
import type { EligibilityService } from './eligibility.service';
import * as ledger from './ledger-recipes';
import type { DomainsConfig } from './ports';
import type { AccountAccess, RegistrarAccessService } from './registrar-access.service';
import type { DomainAction } from './tld-policy';

export const OP_REGISTER = 'domains.order.register';
export const OP_RENEWAL = 'domains.order.renewal';
export const OP_TRANSFER = 'domains.order.transfer_in';
export const OP_UPDATE = 'domains.domain.update';
export const DOMAIN_OP_KINDS = [OP_REGISTER, OP_RENEWAL, OP_TRANSFER, OP_UPDATE] as const;
const MAX_REGISTER_CALLS = 2; // the first call and ONE retry after absence was proven

export interface OrderDeps {
  db: Db;
  audit: AuditSink;
  ops: OperationsService;
  access: RegistrarAccessService;
  eligibility: EligibilityService;
  commerce: CommerceOrders;
  ledger: LedgerPostingService;
  providerCost: ProviderCostService;
  consents: ConsentService;
  cipher: FieldCipher;
  residency: ResidencyEvaluator;
  vault: { put(code: string, label: string): Promise<string> };
  cfg: DomainsConfig;
  notify?: (orgId: string, kind: string, params: Record<string, unknown>) => Promise<void>;
}

interface Veto {
  code: ErrorCode | string;
  message: string;
}
const token = (orgId: string, orderId: string, step: string) =>
  idempotencyToken(orgId, orderId, step);

/**
 * Domain order orchestration (M07 S29): quote → spend authorization → funds reservation (ledger) → registrar call with a deterministic token → persist →
 * ledger record → meter → notify, as `platform.operations`. After `uncertain` the order is `needs_reconcile`: the reconciler looks (findByToken / inspect)
 * and only when absence is PROVEN does it retry, once. A definitive failure releases the reservation. Provider identity and PII never appear in operation
 * inputs, results or errors (customers can read operations).
 */
export class DomainOrderService {
  autoKick = true;
  constructor(private readonly d: OrderDeps) {}

  // ---- shared -----------------------------------------------------------------------------------------------------------------
  private async loadQuote(orgId: string, quoteId: unknown, action: DomainAction) {
    if (typeof quoteId !== 'string' || !UUID.test(quoteId)) throw badRequest('quoteId is required');
    const q = await this.d.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT * FROM commerce.quotes WHERE id = $1 AND org_id = $2`, [
            quoteId,
            orgId,
          ])
        ).rows[0] as Row | undefined,
    );
    if (!q) throw new ProblemException('not_found', 'quote not found');
    if (q.kind !== 'domain') throw badRequest('the quote is not a domain quote');
    if ((q.expires_at as Date).getTime() <= Date.now())
      throw new ProblemException('quote_expired', 'this quote has expired; request a new one');
    const items = ((q.preferences as { domainItems?: DomainQuoteItem[] }).domainItems ??
      []) as DomainQuoteItem[];
    if (items.length !== 1 || items[0]!.action !== action)
      throw badRequest(
        `this endpoint takes a quote with exactly one ${action.replace('_', ' ')} item`,
      );
    return { q, item: items[0]! };
  }

  private async funds(orgId: string, currency: string, amount: bigint): Promise<void> {
    // read the wallet from the ledger itself (the projection is refreshed asynchronously by the outbox relay and may lag)
    const bal = await this.d.db.withOrg(orgId, async (c) => {
      await c.query(`SELECT billing.refresh_wallet($1)`, [orgId]);
      return (
        await c.query(
          `SELECT balance_minor FROM billing.wallet_balances WHERE org_id = $1 AND currency = $2`,
          [orgId, currency],
        )
      ).rows[0];
    });
    if (BigInt(String(bal?.balance_minor ?? 0)) < amount)
      throw new ProblemException(
        'payment_required',
        'the wallet balance does not cover this order; top up and try again',
      );
  }

  private async residencyFor(orgId: string, providerCode: string, region: string) {
    const r = await this.d.residency.evaluate({
      orgId,
      dataClass: 'personal',
      targetRegion: region,
      purpose: RESIDENCY_PURPOSE,
      processorId: providerCode,
      operation: 'write',
    });
    if (r.decision !== 'allow')
      throw new ProblemException(
        'residency_denied',
        'the registrar is not allowed by your data residency policy',
        r.reasons.map((x) => ({ code: x.code, message: x.message })),
      );
    return {
      decision: r.decision,
      policyVersion: r.policyVersion,
      assessmentId: r.assessmentId,
      evidenceRef: r.evidenceRef,
      region,
    };
  }

  private async requireDisclosureConsent(
    orgId: string,
    userId: string,
    privacy: boolean,
  ): Promise<string[]> {
    if (privacy) return [];
    const ok =
      (await this.d.consents.isAllowed(orgId, selfRef(userId), 'domain_registrant_disclosure')) ||
      (await this.d.consents.isAllowed(orgId, 'org', 'domain_registrant_disclosure'));
    if (!ok)
      throw new ProblemException(
        'consent_required',
        'privacy protection is not used for this domain, so the registrant details are public: record the consent domain_registrant_disclosure first',
      );
    return ['domain_registrant_disclosure'];
  }

  /** Spend/approval and quota checks through the commerce order; maps its errors to the M07 contract. */
  private async commerceOrder(
    orgId: string,
    quoteId: string,
    actor: string,
  ): Promise<{ id: string }> {
    try {
      return await this.d.commerce.createFromQuote(orgId, quoteId, actor);
    } catch (e) {
      if (e instanceof ProblemException) {
        if (e.code === 'gone')
          throw new ProblemException('quote_expired', 'this quote has expired; request a new one');
        if (e.code === 'spend_approval_required')
          throw new ProblemException(
            'approval_required',
            'this order exceeds the spending limit; request an approval for the quote',
          );
        if (e.code === 'conflict') {
          const existing = await this.d.commerce.findByQuote(orgId, quoteId);
          if (existing && existing.status === 'created') return { id: existing.id };
          throw new ProblemException('quote_conflict', 'this quote has already been used');
        }
      }
      throw e;
    }
  }

  private async authorizeFunds(
    orgId: string,
    orderId: string,
    total: bigint,
    currency: string,
    name: string,
    actor: string,
  ) {
    try {
      return await this.d.ledger.post(
        ledger.authorize(orgId, orderId, total, currency, `Domain order ${name}`),
        `domain-order:${orderId}:authorize`,
        actor,
      );
    } catch (e) {
      if (e instanceof ProblemException && e.code === 'insufficient_funds')
        throw new ProblemException(
          'payment_required',
          'the wallet balance does not cover this order',
        );
      throw e;
    }
  }

  private async newOperation(
    orgId: string,
    kind: string,
    orderId: string,
    domainId: string,
    actor: string,
    traceId: string,
    extra: Record<string, unknown> = {},
  ): Promise<Operation> {
    return this.d.ops.create(orgId, {
      kind,
      input: { orderId, domainId, ...extra },
      resourceKind: 'domain',
      resourceId: domainId,
      createdBy: actor,
      traceId,
      maxAttempts: 5,
    });
  }

  /** Persist the order's progress markers. */
  private async mark(orgId: string, orderId: string, set: Record<string, unknown>) {
    const cols = Object.keys(set);
    await this.d.db.withOrg(orgId, (c) =>
      c.query(
        `UPDATE domains.domain_orders SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, version = version + 1, updated_at = now() WHERE id = $1`,
        [orderId, ...cols.map((k) => set[k])],
      ),
    );
  }

  /** Undo a half-created order before any provider call: frees the name, never leaves a dangling authorization. */
  private async abortCreation(
    orgId: string,
    orderId: string,
    domainId: string,
    code: string,
    authorized: boolean,
    total: bigint,
    currency: string,
    name: string,
    commerceOrderId?: string,
  ) {
    if (authorized)
      await this.d.ledger
        .post(
          ledger.release(orgId, orderId, total, currency, `Domain order ${name} cancelled`),
          `domain-order:${orderId}:release`,
        )
        .catch(() => undefined);
    await this.d.db.withOrg(orgId, async (c) => {
      await c.query(
        `UPDATE domains.domain_orders SET state='failed', failure_code=$2, completed_at=now(), authorization_state=$3, version=version+1, updated_at=now() WHERE id=$1 AND state NOT IN ('succeeded','failed','cancelled')`,
        [orderId, code, authorized ? 'released' : 'none'],
      );
      await c.query(
        `UPDATE domains.domains SET state='failed', updated_at=now(), version=version+1 WHERE id=$1 AND state IN ('pending','transferring')`,
        [domainId],
      );
    });
    if (commerceOrderId)
      await this.d.commerce.setStatus(orgId, commerceOrderId, 'failed').catch(() => undefined);
  }

  kick(orgId: string, operationId: string): void {
    if (!this.autoKick) return;
    setImmediate(
      () =>
        void this.run(orgId, operationId).catch((e) =>
          console.error(JSON.stringify({ domains_operation_error: (e as Error).message })),
        ),
    );
  }

  // ---- create: register -----------------------------------------------------------------------------------------------------------
  async createRegistration(
    orgId: string,
    actor: string,
    body: Record<string, unknown>,
    traceId: string,
  ) {
    const { q, item } = await this.loadQuote(orgId, body.quoteId, 'register');
    const account = await this.d.access.getAccount(item.registrarAccountId);
    if (!account || !account.enabled || !account.registrarEnabled)
      throw new ProblemException(
        'unsupported_capability',
        'the registrar for this quote is no longer available',
      );
    const support = account.tldSupport.find((t) => t.tld === item.tld);
    const decision = this.d.eligibility.decide(item.tld, 'register', support);
    if (decision.result !== 'allowed')
      throw new ProblemException(decision.errorCode ?? 'unsupported_capability', decision.reason);
    const contacts = parseContacts(body.contacts, support?.requiredContactFields ?? []);
    const privacy = body.privacy === true;
    if (privacy && support?.privacy !== 'supported')
      throw new ProblemException(
        'unsupported_capability',
        'privacy protection is not available for this TLD at this registrar',
      );
    const nameservers = this.parseNameservers(body.nameservers);
    const autoRenew = body.autoRenew === true;
    const consentRefs = await this.requireDisclosureConsent(orgId, actor, privacy);
    const residency = await this.residencyFor(orgId, account.providerCode, account.dataRegion);
    const total = BigInt(String(q.total_minor));
    const currency = (q.currency as string).trim();
    await this.funds(orgId, currency, total);

    const domainId = uuidv7();
    const orderId = uuidv7();
    try {
      await this.d.db.withOrg(orgId, async (c) => {
        await c.query(
          `INSERT INTO domains.domains (id, org_id, name, tld, state, registrar_account_id, auto_renew, privacy_state, nameservers, data_region, provider_region_id, created_by)
           VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,'sa-pending',$9,$10)`,
          [
            domainId,
            orgId,
            item.name,
            item.tld,
            account.id,
            autoRenew,
            privacy ? 'on' : 'off',
            JSON.stringify(nameservers),
            account.dataRegion,
            actor,
          ],
        );
        await c.query(
          `INSERT INTO domains.domain_orders (id, org_id, type, domain_id, name, registrar_account_id, quote_id, idempotency_token, state, years, price_minor, tax_minor, currency, provider_cost_minor, provider_cost_currency, residency, consent_refs, created_by)
           VALUES ($1,$2,'register',$3,$4,$5,$6,$7,'created',$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            orderId,
            orgId,
            domainId,
            item.name,
            account.id,
            q.id,
            token(orgId, orderId, 'register'),
            item.years,
            total.toString(),
            String(q.tax_minor),
            currency,
            (BigInt(item.providerCost.amountMinor) * BigInt(item.years)).toString(),
            item.providerCost.currency,
            JSON.stringify(residency),
            JSON.stringify(consentRefs),
            actor,
          ],
        );
        await this.insertContacts(c, orgId, domainId, contacts);
      });
    } catch (e) {
      if (pgCode(e) === '23505') {
        const m = /domain_orders_quote_uniq|domain_orders_org_id_idempotency/.exec(
          (e as Error).message,
        );
        if (m) return this.existingForQuote(orgId, q.id as string);
        throw new ProblemException('domain_unavailable', 'this domain name is not available');
      }
      throw e;
    }
    let commerceOrderId: string | undefined;
    try {
      commerceOrderId = (await this.commerceOrder(orgId, q.id as string, actor)).id;
      await this.authorizeFunds(orgId, orderId, total, currency, item.name, actor);
    } catch (e) {
      await this.abortCreation(
        orgId,
        orderId,
        domainId,
        e instanceof ProblemException ? e.code : 'internal_error',
        commerceOrderId !== undefined &&
          e instanceof ProblemException &&
          e.code === 'payment_required'
          ? false
          : false,
        total,
        currency,
        item.name,
        commerceOrderId,
      );
      throw e;
    }
    const op = await this.newOperation(orgId, OP_REGISTER, orderId, domainId, actor, traceId);
    await this.mark(orgId, orderId, {
      commerce_order_id: commerceOrderId,
      operation_id: op.id,
      state: 'authorized',
      authorization_state: 'held',
    });
    await this.d.audit.record({
      action: 'domain.order.created',
      orgId,
      actorUserId: actor,
      resource: { type: 'domain_order', id: orderId },
      outcome: 'success',
      after: {
        type: 'register',
        tld: item.tld,
        years: item.years,
        totalMinor: total.toString(),
        currency,
        residency: residency.decision,
      },
    });
    this.kick(orgId, op.id);
    return {
      operationId: op.id,
      orderId,
      domain: { id: domainId, name: item.name, status: 'pending' },
    };
  }

  private async existingForQuote(orgId: string, quoteId: string) {
    const r = await this.d.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT o.id, o.operation_id, o.domain_id, o.name, d.state FROM domains.domain_orders o JOIN domains.domains d ON d.id = o.domain_id WHERE o.org_id = $1 AND o.quote_id = $2`,
            [orgId, quoteId],
          )
        ).rows[0] as Row | undefined,
    );
    if (!r) throw new ProblemException('quote_conflict', 'this quote has already been used');
    return {
      operationId: r.operation_id as string | null,
      orderId: r.id as string,
      domain: { id: r.domain_id as string, name: r.name as string, status: r.state as string },
      replay: true,
    };
  }

  private parseNameservers(v: unknown): string[] {
    if (v === undefined || v === null) return [];
    if (
      !Array.isArray(v) ||
      v.length > 13 ||
      v.some(
        (n) =>
          typeof n !== 'string' ||
          !/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(n),
      )
    )
      throw badRequest('nameservers must be at most 13 host names');
    return (v as string[]).map((n) => n.toLowerCase());
  }

  private async insertContacts(
    c: PoolClient,
    orgId: string,
    domainId: string,
    contacts: ContactSet,
  ) {
    for (const role of ['registrant', 'admin', 'tech', 'billing'] as const) {
      const id = uuidv7();
      await c.query(
        `INSERT INTO domains.domain_contacts (id, org_id, domain_id, role, payload_enc) VALUES ($1,$2,$3,$4,$5)`,
        [id, orgId, domainId, role, await sealContact(this.d.cipher, id, contacts[role])],
      );
    }
  }
  async loadContacts(orgId: string, domainId: string): Promise<ContactSet> {
    const rows = await this.d.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT id, role, payload_enc FROM domains.domain_contacts WHERE domain_id = $1`,
            [domainId],
          )
        ).rows as Row[],
    );
    const out: Partial<ContactSet> = {};
    for (const r of rows)
      out[r.role as keyof ContactSet] = await openContact(
        this.d.cipher,
        r.id as string,
        r.payload_enc as string,
      );
    if (!out.registrant) throw new Error('contacts missing');
    for (const k of ['admin', 'tech', 'billing'] as const) out[k] ??= out.registrant;
    return out as ContactSet;
  }

  // ---- create: renewal ------------------------------------------------------------------------------------------------------------
  async createRenewal(
    orgId: string,
    actor: string,
    domainId: string,
    body: Record<string, unknown>,
    traceId: string,
  ) {
    if (!UUID.test(domainId)) throw new ProblemException('not_found');
    const dom = await this.d.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM domains.domains WHERE id = $1`, [domainId])).rows[0] as
          Row | undefined,
    );
    if (!dom) throw new ProblemException('not_found');
    const { q, item } = await this.loadQuote(orgId, body.quoteId, 'renew');
    if (dom.name !== item.name || item.domainId !== domainId)
      throw badRequest('the quote is for a different domain');
    if (!['active', 'renewal_at_risk', 'expired'].includes(dom.state as string))
      throw new ProblemException('conflict', `a ${String(dom.state)} domain cannot be renewed`);
    const account = await this.d.access.getAccount(dom.registrar_account_id as string);
    if (!account || !account.enabled || !account.registrarEnabled)
      throw new ProblemException(
        'unsupported_capability',
        'the registrar for this domain is not available',
      );
    const decision = this.d.eligibility.decide(
      item.tld,
      'renew',
      account.tldSupport.find((t) => t.tld === item.tld),
    );
    if (decision.result !== 'allowed')
      throw new ProblemException(decision.errorCode ?? 'unsupported_capability', decision.reason);
    if (body.years !== undefined && body.years !== item.years)
      throw badRequest('years must match the quote');
    const total = BigInt(String(q.total_minor));
    const currency = (q.currency as string).trim();
    await this.funds(orgId, currency, total);
    const orderId = uuidv7();
    try {
      await this.d.db.withOrg(orgId, (c) =>
        c.query(
          `INSERT INTO domains.domain_orders (id, org_id, type, domain_id, name, registrar_account_id, quote_id, idempotency_token, state, years, price_minor, tax_minor, currency, provider_cost_minor, provider_cost_currency, created_by)
           VALUES ($1,$2,'renewal',$3,$4,$5,$6,$7,'created',$8,$9,$10,$11,$12,$13,$14)`,
          [
            orderId,
            orgId,
            domainId,
            item.name,
            account.id,
            q.id,
            token(orgId, orderId, 'renew'),
            item.years,
            total.toString(),
            String(q.tax_minor),
            currency,
            (BigInt(item.providerCost.amountMinor) * BigInt(item.years)).toString(),
            item.providerCost.currency,
            actor,
          ],
        ),
      );
    } catch (e) {
      if (pgCode(e) === '23505') return this.existingForQuote(orgId, q.id as string);
      throw e;
    }
    let commerceOrderId: string | undefined;
    try {
      commerceOrderId = (await this.commerceOrder(orgId, q.id as string, actor)).id;
      await this.authorizeFunds(orgId, orderId, total, currency, item.name, actor);
    } catch (e) {
      await this.d.db.withOrg(orgId, (c) =>
        c.query(
          `UPDATE domains.domain_orders SET state='failed', failure_code=$2, completed_at=now(), version=version+1 WHERE id=$1`,
          [orderId, e instanceof ProblemException ? e.code : 'internal_error'],
        ),
      );
      if (commerceOrderId)
        await this.d.commerce.setStatus(orgId, commerceOrderId, 'failed').catch(() => undefined);
      throw e;
    }
    const op = await this.newOperation(orgId, OP_RENEWAL, orderId, domainId, actor, traceId, {
      baselineExpiresAt: dom.expires_at ? (dom.expires_at as Date).toISOString() : null,
    });
    await this.mark(orgId, orderId, {
      commerce_order_id: commerceOrderId,
      operation_id: op.id,
      state: 'authorized',
      authorization_state: 'held',
    });
    await this.d.audit.record({
      action: 'domain.renewal.created',
      orgId,
      actorUserId: actor,
      resource: { type: 'domain_order', id: orderId },
      outcome: 'success',
      after: { years: item.years, totalMinor: total.toString(), currency },
    });
    this.kick(orgId, op.id);
    return {
      operationId: op.id,
      orderId,
      domain: { id: domainId, name: item.name, status: dom.state as string },
    };
  }

  // ---- create: transfer-in --------------------------------------------------------------------------------------------------------
  async createTransfer(
    orgId: string,
    actor: string,
    body: Record<string, unknown>,
    traceId: string,
  ) {
    const { q, item } = await this.loadQuote(orgId, body.quoteId, 'transfer_in');
    if (typeof body.name === 'string' && body.name.toLowerCase() !== item.name)
      throw badRequest('name must match the quote');
    const account = await this.d.access.getAccount(item.registrarAccountId);
    if (
      !account ||
      !account.enabled ||
      !account.registrarEnabled ||
      !isSupported(account.capabilities, 'registrar.transfer-in')
    )
      throw new ProblemException(
        'unsupported_capability',
        'transfers are not available at the registrar for this quote',
      );
    const support = account.tldSupport.find((t) => t.tld === item.tld);
    const decision = this.d.eligibility.decide(item.tld, 'transfer_in', support);
    if (decision.result !== 'allowed')
      throw new ProblemException(decision.errorCode ?? 'unsupported_capability', decision.reason);
    // the auth code is write-only: it goes to the vault and only its REFERENCE is kept; it is never echoed, logged or audited
    let authCodeRef: string;
    if (typeof body.authCodeRef === 'string') {
      if (!/^vault:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{1,200}$/.test(body.authCodeRef))
        throw new ProblemException(
          'credential_value_rejected',
          'authCodeRef must be a vault:// reference',
        );
      authCodeRef = body.authCodeRef;
    } else if (
      typeof body.authCode === 'string' &&
      body.authCode.length >= 4 &&
      body.authCode.length <= 128
    ) {
      try {
        authCodeRef = await this.d.vault.put(body.authCode, `transfer-${item.name}`);
      } catch {
        throw new ProblemException(
          'service_unavailable',
          'the secret store is not available; try again later',
        );
      }
    } else throw badRequest('authCode or authCodeRef is required');
    const contacts = parseContacts(body.contacts, support?.requiredContactFields ?? []);
    const privacy = body.privacy === true;
    if (privacy && support?.privacy !== 'supported')
      throw new ProblemException(
        'unsupported_capability',
        'privacy protection is not available for this TLD at this registrar',
      );
    const nameservers = this.parseNameservers(body.nameservers);
    const consentRefs = await this.requireDisclosureConsent(orgId, actor, privacy);
    const residency = await this.residencyFor(orgId, account.providerCode, account.dataRegion);
    const total = BigInt(String(q.total_minor));
    const currency = (q.currency as string).trim();
    await this.funds(orgId, currency, total);
    const domainId = uuidv7();
    const orderId = uuidv7();
    const transferId = uuidv7();
    try {
      await this.d.db.withOrg(orgId, async (c) => {
        await c.query(
          `INSERT INTO domains.domains (id, org_id, name, tld, state, registrar_account_id, privacy_state, nameservers, data_region, provider_region_id, created_by) VALUES ($1,$2,$3,$4,'transferring',$5,$6,$7,'sa-pending',$8,$9)`,
          [
            domainId,
            orgId,
            item.name,
            item.tld,
            account.id,
            privacy ? 'on' : 'off',
            JSON.stringify(nameservers),
            account.dataRegion,
            actor,
          ],
        );
        await c.query(
          `INSERT INTO domains.domain_orders (id, org_id, type, domain_id, name, registrar_account_id, quote_id, idempotency_token, state, years, price_minor, tax_minor, currency, provider_cost_minor, provider_cost_currency, residency, consent_refs, created_by)
           VALUES ($1,$2,'transfer_in',$3,$4,$5,$6,$7,'created',$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            orderId,
            orgId,
            domainId,
            item.name,
            account.id,
            q.id,
            token(orgId, orderId, 'transfer'),
            item.years,
            total.toString(),
            String(q.tax_minor),
            currency,
            (BigInt(item.providerCost.amountMinor) * BigInt(item.years)).toString(),
            item.providerCost.currency,
            JSON.stringify(residency),
            JSON.stringify(consentRefs),
            actor,
          ],
        );
        await c.query(
          `INSERT INTO domains.domain_transfers (id, org_id, domain_id, order_id, name, registrar_account_id, auth_code_ref, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [transferId, orgId, domainId, orderId, item.name, account.id, authCodeRef, actor],
        );
        await this.insertContacts(c, orgId, domainId, contacts);
      });
    } catch (e) {
      if (pgCode(e) === '23505') {
        if (/domain_orders_quote_uniq/.test((e as Error).message))
          return this.existingForQuote(orgId, q.id as string);
        throw new ProblemException('domain_unavailable', 'this domain name is not available');
      }
      throw e;
    }
    let commerceOrderId: string | undefined;
    try {
      commerceOrderId = (await this.commerceOrder(orgId, q.id as string, actor)).id;
      await this.authorizeFunds(orgId, orderId, total, currency, item.name, actor);
    } catch (e) {
      await this.abortCreation(
        orgId,
        orderId,
        domainId,
        e instanceof ProblemException ? e.code : 'internal_error',
        false,
        total,
        currency,
        item.name,
        commerceOrderId,
      );
      await this.d.db.withOrg(orgId, (c) =>
        c.query(
          `UPDATE domains.domain_transfers SET state='failed', completed_at=now(), failure_code='order_not_created', updated_at=now() WHERE id=$1`,
          [transferId],
        ),
      );
      throw e;
    }
    const op = await this.newOperation(orgId, OP_TRANSFER, orderId, domainId, actor, traceId, {
      transferId,
    });
    await this.mark(orgId, orderId, {
      commerce_order_id: commerceOrderId,
      operation_id: op.id,
      state: 'authorized',
      authorization_state: 'held',
    });
    await this.d.audit.record({
      action: 'domain.transfer.created',
      orgId,
      actorUserId: actor,
      resource: { type: 'domain_transfer', id: transferId },
      outcome: 'success',
      after: { tld: item.tld, totalMinor: total.toString(), currency },
    });
    this.kick(orgId, op.id);
    return {
      operationId: op.id,
      orderId,
      transferId,
      domain: { id: domainId, name: item.name, status: 'transferring' },
    };
  }

  // ---- execution ------------------------------------------------------------------------------------------------------------------
  async run(orgId: string, operationId: string, worker = `api-${process.pid}`): Promise<void> {
    const claimed = await this.d.ops.claimById(orgId, operationId, worker);
    if (!claimed) return;
    const op = await this.d.ops.get(orgId, operationId);
    if (op) await this.execute(orgId, op, worker);
  }

  private async execute(orgId: string, op: Operation, worker: string): Promise<void> {
    try {
      const input = op.input as { orderId: string };
      const order = await this.loadOrder(orgId, input.orderId);
      if (!order)
        return void (await this.d.ops
          .fail(orgId, op.id, worker, { code: 'not_found' })
          .catch(() => undefined));
      if (['succeeded', 'failed', 'cancelled'].includes(order.state as string))
        return void (await this.settleOp(
          orgId,
          op.id,
          worker,
          order.state as string,
          order.failure_code as string | null,
        ));
      await this.step(orgId, op.id, 'revalidate', 'running');
      const access = await this.d.access.access(
        order.registrar_account_id as string,
        op.trace_id ?? op.id,
      );
      if (!access)
        return this.compensate(orgId, op, worker, order, {
          code: 'unsupported_capability',
          message: 'no adapter is available for this registrar',
        });
      const veto = await this.revalidate(orgId, order, access);
      await this.step(
        orgId,
        op.id,
        'revalidate',
        veto ? 'failed' : 'succeeded',
        veto ? { code: veto.code } : {},
      );
      if (veto) return this.compensate(orgId, op, worker, order, veto);
      const fresh = await this.d.ops.get(orgId, op.id);
      if (fresh?.cancel_requested)
        return this.compensate(orgId, op, worker, order, {
          code: 'conflict',
          message: 'the operation was cancelled',
        });
      await this.callProvider(orgId, op, worker, order, access);
    } catch (e) {
      // an unexpected error after a provider call may have happened: never retry blindly
      await this.d.ops
        .markNeedsReconcile(
          orgId,
          op.id,
          worker,
          `unexpected: ${(e as Error).message}`.slice(0, 200),
        )
        .catch(() => undefined);
      await this.mark(orgId, (op.input as { orderId: string }).orderId, {
        state: 'needs_reconcile',
      }).catch(() => undefined);
    }
  }

  private async loadOrder(orgId: string, orderId: string): Promise<Row | undefined> {
    return this.d.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT o.*, d.expires_at AS domain_expires_at, d.state AS domain_state, d.tld FROM domains.domain_orders o JOIN domains.domains d ON d.id = o.domain_id WHERE o.id = $1`,
            [orderId],
          )
        ).rows[0] as Row | undefined,
    );
  }

  private async step(
    orgId: string,
    opId: string,
    name: string,
    state: 'running' | 'succeeded' | 'failed',
    detail: Record<string, unknown> = {},
  ) {
    await this.d.db.withOrg(orgId, async (c) => {
      const ex = (
        await c.query(`SELECT id FROM platform.operation_steps WHERE operation_id=$1 AND name=$2`, [
          opId,
          name,
        ])
      ).rows[0];
      if (ex)
        await c.query(
          `UPDATE platform.operation_steps SET state=$2, detail=$3, finished_at = CASE WHEN $2 IN ('succeeded','failed') THEN now() ELSE finished_at END WHERE id=$1`,
          [ex.id, state, JSON.stringify(detail)],
        );
      else {
        const seq = Number(
          (
            await c.query(
              `SELECT coalesce(max(seq),0)+1 n FROM platform.operation_steps WHERE operation_id=$1`,
              [opId],
            )
          ).rows[0]!.n,
        );
        await c.query(
          `INSERT INTO platform.operation_steps (id, org_id, operation_id, seq, name, state, detail, started_at, finished_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now(), CASE WHEN $6 IN ('succeeded','failed') THEN now() ELSE NULL END)`,
          [uuidv7(), orgId, opId, seq, name, state, JSON.stringify(detail)],
        );
      }
    });
  }

  /** TOCTOU re-check at execution: the registrar account, the TLD policy and capability, residency and consent must STILL hold before PII leaves. */
  private async revalidate(orgId: string, order: Row, access: AccountAccess): Promise<Veto | null> {
    const a = await this.d.access.getAccount(access.account.id);
    if (!a || !a.enabled || !a.registrarEnabled)
      return {
        code: 'unsupported_capability',
        message: 'the registrar account is no longer enabled',
      };
    const action =
      order.type === 'register' ? 'register' : order.type === 'renewal' ? 'renew' : 'transfer_in';
    const dec = this.d.eligibility.decide(
      order.tld as string,
      action,
      a.tldSupport.find((t) => t.tld === order.tld),
    );
    if (dec.result !== 'allowed')
      return { code: dec.errorCode ?? 'unsupported_capability', message: dec.reason };
    if (order.type !== 'renewal') {
      try {
        await this.residencyFor(orgId, a.providerCode, a.dataRegion);
      } catch (e) {
        if (e instanceof ProblemException)
          return {
            code: 'residency_denied',
            message: 'the residency policy no longer allows this registrar',
          };
        throw e;
      }
    }
    return null;
  }

  private async callProvider(
    orgId: string,
    op: Operation,
    worker: string,
    order: Row,
    access: AccountAccess,
  ) {
    const orderId = order.id as string;
    const name = order.name as string;
    const tokenStep =
      order.type === 'register' ? 'register' : order.type === 'renewal' ? 'renew' : 'transfer';
    const tok = order.idempotency_token as string;
    void tokenStep;
    await this.mark(orgId, orderId, { attempts: (order.attempts as number) + 1 });
    await this.step(orgId, op.id, 'provider_call', 'running');
    let r: OperationResult<DomainRef>;
    if (order.type === 'register') {
      const contacts = await this.loadContacts(orgId, order.domain_id as string);
      const dom = await this.d.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(`SELECT nameservers, privacy_state FROM domains.domains WHERE id=$1`, [
              order.domain_id,
            ])
          ).rows[0] as Row,
      );
      r = await access.adapter.register(access.ctx, {
        name,
        years: order.years as number,
        contacts,
        nameservers: (dom.nameservers as string[]).length
          ? (dom.nameservers as string[])
          : undefined,
        privacy: dom.privacy_state === 'on',
        autoRenew: false,
        idempotencyToken: tok,
      });
    } else if (order.type === 'renewal') {
      const dom = await this.d.db.withOrg(
        orgId,
        async (c) =>
          (await c.query(`SELECT provider_ref FROM domains.domains WHERE id=$1`, [order.domain_id]))
            .rows[0] as Row,
      );
      const baseline =
        (op.input as { baselineExpiresAt?: string | null }).baselineExpiresAt ?? null;
      r = await access.adapter.renew(access.ctx, {
        name,
        providerRef: dom.provider_ref as string,
        years: order.years as number,
        currentExpiresAt: baseline,
        idempotencyToken: tok,
      });
    } else {
      const transfer = await this.d.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(`SELECT auth_code_ref FROM domains.domain_transfers WHERE order_id=$1`, [
              orderId,
            ])
          ).rows[0] as Row,
      );
      const contacts = await this.loadContacts(orgId, order.domain_id as string);
      const dom = await this.d.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(`SELECT nameservers, privacy_state FROM domains.domains WHERE id=$1`, [
              order.domain_id,
            ])
          ).rows[0] as Row,
      );
      r = await access.adapter.transferIn(access.ctx, {
        name,
        authCodeRef: transfer.auth_code_ref as string,
        contacts,
        nameservers: (dom.nameservers as string[]).length
          ? (dom.nameservers as string[])
          : undefined,
        privacy: dom.privacy_state === 'on',
        idempotencyToken: tok,
      });
    }
    if (r.status === 'uncertain')
      return this.park(
        orgId,
        op,
        worker,
        orderId,
        r.error?.message ?? 'the registrar did not answer in time',
      );
    if (r.status === 'failed') {
      await this.step(orgId, op.id, 'provider_call', 'failed', {
        category: r.error?.category ?? 'unknown',
      });
      if (r.error?.retryable) {
        const o = await this.d.ops.fail(orgId, op.id, worker, {
          code: r.error.category,
          message: 'the registrar could not take the request yet',
        });
        if (o.state !== 'failed') return; // pending with backoff: the same token is used on the next run
      }
      return this.compensate(orgId, op, worker, order, this.vetoFrom(r));
    }
    await this.step(orgId, op.id, 'provider_call', 'succeeded');
    if (r.status === 'accepted' && (!r.data || r.data.state !== 'active')) {
      await this.mark(orgId, orderId, {
        state: 'provider_pending',
        provider_order_ref: r.providerRef ?? r.data?.providerRef ?? null,
      });
      if (r.data?.providerRef)
        await this.d.db.withOrg(orgId, (c) =>
          c.query(
            `UPDATE domains.domains SET provider_ref = coalesce(provider_ref, $2), updated_at = now() WHERE id = $1`,
            [order.domain_id, r.data!.providerRef],
          ),
        );
      await this.d.ops.markNeedsReconcile(orgId, op.id, worker, 'pending_at_registry');
      return;
    }
    await this.finalize(orgId, orderId, r.data!);
    await this.settleOp(orgId, op.id, worker, 'succeeded', null);
  }

  private vetoFrom(r: OperationResult<unknown>): Veto {
    const c = r.error?.category;
    const code: ErrorCode =
      c === 'conflict'
        ? 'domain_unavailable'
        : c === 'unsupported'
          ? 'unsupported_capability'
          : c === 'validation'
            ? /lock/i.test(r.error?.message ?? '')
              ? 'transfer_locked'
              : 'validation_failed'
            : c === 'quota'
              ? 'payment_required'
              : 'service_unavailable';
    return { code, message: r.error?.message ?? 'the registrar refused the request' };
  }

  private async park(
    orgId: string,
    op: Operation,
    worker: string,
    orderId: string,
    reason: string,
  ) {
    await this.step(orgId, op.id, 'provider_call', 'failed', { uncertain: true });
    await this.mark(orgId, orderId, { state: 'needs_reconcile' });
    await this.d.ops.markNeedsReconcile(orgId, op.id, worker, reason.slice(0, 200));
    await this.d.audit.record({
      action: 'domain.order.needs_reconcile',
      orgId,
      resource: { type: 'domain_order', id: orderId },
      outcome: 'failure',
      detail: { reason: 'provider_uncertain' },
    });
  }

  private async settleOp(
    orgId: string,
    opId: string,
    worker: string,
    orderState: string,
    failure: string | null,
  ) {
    const cur = await this.d.ops.get(orgId, opId);
    if (!cur || cur.state === 'succeeded' || cur.state === 'failed' || cur.state === 'cancelled')
      return;
    if (cur.lease_owner !== worker) return;
    if (orderState === 'succeeded')
      await this.d.ops.succeed(orgId, opId, worker, {
        orderId: (cur.input as { orderId: string }).orderId,
        state: 'succeeded',
      });
    else await this.failTerminal(orgId, opId, worker, { code: failure ?? 'failed' });
  }
  private async failTerminal(orgId: string, opId: string, worker: string, error: unknown) {
    await this.d.db.withOrg(orgId, (c) =>
      c.query(`UPDATE platform.operations SET max_attempts = attempts WHERE id = $1`, [opId]),
    );
    await this.d.ops.fail(orgId, opId, worker, error);
  }

  // ---- finalize / compensate ------------------------------------------------------------------------------------------------------
  /** Idempotent: the ledger posting is keyed by the order, the transaction is guarded by the order state, so 100 duplicate callbacks change nothing after the first. */
  async finalize(orgId: string, orderId: string, ref: DomainRef): Promise<{ changed: boolean }> {
    const order = await this.loadOrder(orgId, orderId);
    if (!order) throw new ProblemException('not_found');
    if (order.state === 'succeeded') return { changed: false };
    if (order.state === 'failed' || order.state === 'cancelled') return { changed: false };
    const total = BigInt(String(order.price_minor));
    const tax = BigInt(String(order.tax_minor));
    const currency = (order.currency as string).trim();
    const rec = await this.d.ledger.post(
      ledger.record(
        orgId,
        orderId,
        total - tax,
        tax,
        currency,
        `Domain ${String(order.type)} ${String(order.name)}`,
      ),
      `domain-order:${orderId}:record`,
    );
    const meter =
      order.type === 'register'
        ? 'domain.registration_years'
        : order.type === 'renewal'
          ? 'domain.renewal_years'
          : 'domain.transfers';
    const years = order.type === 'transfer_in' ? 1 : (order.years as number);
    const changed = await this.d.db.withOrg(orgId, async (c) => {
      const o = (
        await c.query(`SELECT state FROM domains.domain_orders WHERE id=$1 FOR UPDATE`, [orderId])
      ).rows[0] as Row;
      if (o.state === 'succeeded' || o.state === 'failed' || o.state === 'cancelled') return false;
      const now = new Date();
      if (order.type === 'renewal')
        await c.query(
          `UPDATE domains.domains SET state='active', expires_at = coalesce($2, expires_at), last_provider_state=$3, last_synced_at=now(), version=version+1, updated_at=now() WHERE id=$1`,
          [order.domain_id, ref.expiresAt, ref.state],
        );
      else
        await c.query(
          `UPDATE domains.domains SET state='active', provider_ref=$2, registered_at = coalesce(registered_at, now()), expires_at=$3, locked=coalesce($4, locked), nameservers = CASE WHEN $5::jsonb = '[]'::jsonb THEN nameservers ELSE $5::jsonb END,
             privacy_state = CASE WHEN $6::text IS NULL THEN privacy_state ELSE $6 END, last_provider_state=$7, last_synced_at=now(), version=version+1, updated_at=now() WHERE id=$1`,
          [
            order.domain_id,
            ref.providerRef,
            ref.expiresAt,
            ref.locked,
            JSON.stringify(ref.nameservers),
            ref.privacy === 'unsupported' ? 'unsupported' : ref.privacy,
            ref.state,
          ],
        );
      await c.query(
        `UPDATE domains.domain_orders SET state='succeeded', authorization_state='captured', provider_order_ref = coalesce($2, provider_order_ref), ledger_record_tx=$3, completed_at=now(), version=version+1, updated_at=now() WHERE id=$1`,
        [orderId, ref.providerRef, rec.transactionId],
      );
      if (order.type === 'transfer_in')
        await c.query(
          `UPDATE domains.domain_transfers SET state='completed', provider_ref=$2, completed_at=now(), updated_at=now() WHERE order_id=$1`,
          [orderId, ref.providerRef],
        );
      const windowStart = now.toISOString();
      await emitUsage(c, {
        eventId: usageEventId({
          orgId,
          meterId: meter,
          resourceId: order.domain_id as string,
          windowStart: new Date(Date.UTC(2000, 0, 1)).toISOString(),
          sourceSeq: `${orderId}:meter`,
        }),
        orgId,
        meterId: meter,
        quantity: String(years),
        unit: order.type === 'transfer_in' ? 'transfer' : 'year',
        resourceId: order.domain_id as string,
        windowStart,
        windowEnd: windowStart,
        occurredAt: windowStart,
        dimensions:
          order.type === 'register'
            ? { tld: order.tld as string, registrar: 'hidden' }
            : { tld: order.tld as string },
        dataRegion: 'sa-pending',
        source: 'domains@M07',
      });
      await enqueue(
        c,
        orgId,
        order.type === 'register' || order.type === 'transfer_in'
          ? 'domain.registered'
          : 'domain.renewed',
        { domainId: order.domain_id, name: order.name, orderId, type: order.type },
      );
      await enqueue(c, orgId, 'resource.state_changed', {
        resourceKind: 'domain',
        resourceId: order.domain_id,
        state: 'active',
      });
      return true;
    });
    if (changed) {
      await this.d.commerce
        .setStatus(orgId, order.commerce_order_id as string, 'fulfilled')
        .catch(() => undefined);
      await this.d.audit.record({
        action: 'domain.order.succeeded',
        orgId,
        resource: { type: 'domain_order', id: orderId },
        outcome: 'success',
        detail: { type: order.type as string },
      });
      await this.recordCost(order);
      await this.d
        .notify?.(orgId, 'domain.order_succeeded', { name: order.name, type: order.type })
        .catch(() => undefined);
    }
    return { changed };
  }

  private async recordCost(order: Row) {
    if (order.provider_cost_minor === null || BigInt(String(order.provider_cost_minor)) <= 0n)
      return;
    const day = new Date().toISOString().slice(0, 10);
    await this.d.providerCost
      .record([
        {
          providerAccountId: order.registrar_account_id as string,
          providerLineRef: `domain-order:${String(order.id)}`,
          periodStart: day,
          periodEnd: day,
          meterOrSku: `domain.${String(order.type)}`,
          quantity: String(order.years),
          costMinor: String(order.provider_cost_minor),
          currency: (order.provider_cost_currency as string).trim(),
          source: 'api',
          orgId: order.org_id as string,
        },
      ])
      .catch(() => undefined); // the reconciler (S31) completes a missing cost record
  }

  private async compensate(orgId: string, op: Operation, worker: string, order: Row, veto: Veto) {
    const orderId = order.id as string;
    const total = BigInt(String(order.price_minor));
    const currency = (order.currency as string).trim();
    if (order.authorization_state === 'held')
      await this.d.ledger.post(
        ledger.release(
          orgId,
          orderId,
          total,
          currency,
          `Domain order ${String(order.name)} failed`,
        ),
        `domain-order:${orderId}:release`,
      );
    await this.d.db.withOrg(orgId, async (c) => {
      await c.query(
        `UPDATE domains.domain_orders SET state='failed', failure_code=$2, authorization_state = CASE WHEN authorization_state='held' THEN 'released' ELSE authorization_state END, completed_at=now(), version=version+1, updated_at=now() WHERE id=$1 AND state NOT IN ('succeeded','failed','cancelled')`,
        [orderId, String(veto.code)],
      );
      if (order.type === 'register' || order.type === 'transfer_in')
        await c.query(
          `UPDATE domains.domains SET state='failed', version=version+1, updated_at=now() WHERE id=$1 AND state IN ('pending','transferring')`,
          [order.domain_id],
        );
      if (order.type === 'transfer_in')
        await c.query(
          `UPDATE domains.domain_transfers SET state='failed', failure_code=$2, completed_at=now(), updated_at=now() WHERE order_id=$1 AND state IN ('pending','in_progress')`,
          [orderId, String(veto.code)],
        );
    });
    if (order.commerce_order_id)
      await this.d.commerce
        .setStatus(orgId, order.commerce_order_id as string, 'failed')
        .catch(() => undefined);
    await this.d.audit.record({
      action: 'domain.order.failed',
      orgId,
      resource: { type: 'domain_order', id: orderId },
      outcome: 'failure',
      detail: { code: String(veto.code) },
    });
    await this.failTerminal(orgId, op.id, worker, {
      code: String(veto.code),
      message: veto.message,
    });
    await this.d
      .notify?.(orgId, 'domain.order_failed', { name: order.name, type: order.type })
      .catch(() => undefined);
  }

  // ---- reconciliation ------------------------------------------------------------------------------------------------------------
  /** Takes an operation parked in needs_reconcile (or pending) under a lease so it can be driven to a terminal state. */
  private async lease(orgId: string, opId: string, worker: string): Promise<boolean> {
    return this.d.db.withOrg(orgId, async (c) => {
      const op = (
        await c.query(`SELECT state FROM platform.operations WHERE id=$1 FOR UPDATE`, [opId])
      ).rows[0] as Row | undefined;
      if (!op || !['needs_reconcile', 'pending'].includes(op.state as string)) return false;
      assertTransition(op.state as 'needs_reconcile', 'running');
      await c.query(
        `UPDATE platform.operations SET state='running', lease_owner=$2, lease_expires_at=now()+interval '60 seconds', attempts=attempts+1, version=version+1, updated_at=now() WHERE id=$1`,
        [opId, worker],
      );
      await enqueue(c, orgId, 'operation.state_changed', {
        operationId: opId,
        from: op.state,
        to: 'running',
      });
      return true;
    });
  }

  /**
   * Reconcile ONE order: look at the registrar first. Present and active ⇒ finalize (exactly one ledger transaction and one meter event); present but pending ⇒ keep
   * waiting; PROVABLY ABSENT ⇒ retry the provider call ONCE (same token); unclear ⇒ leave it parked. Returns what happened.
   */
  async reconcileOrder(
    orgId: string,
    orderId: string,
    worker = `reconciler-${process.pid}`,
  ): Promise<'finalized' | 'pending' | 'retried' | 'absent_exhausted' | 'unclear' | 'final'> {
    const order = await this.loadOrder(orgId, orderId);
    if (!order || ['succeeded', 'failed', 'cancelled'].includes(order.state as string))
      return 'final';
    const opId = order.operation_id as string | null;
    const access = await this.d.access.access(
      order.registrar_account_id as string,
      `reconcile-${orderId}`,
    );
    if (!access || !opId) return 'unclear';
    const f = await access.adapter.findByToken(access.ctx, order.idempotency_token as string, {
      name: order.name as string,
    });
    if (f.status !== 'succeeded') return 'unclear';
    if (!(await this.lease(orgId, opId, worker))) return 'unclear';
    const op = (await this.d.ops.get(orgId, opId))!;
    if (f.data) {
      if (
        f.data.state === 'active' ||
        (order.type === 'renewal' &&
          f.data.expiresAt &&
          order.domain_expires_at &&
          Date.parse(f.data.expiresAt) > (order.domain_expires_at as Date).getTime())
      ) {
        await this.finalize(orgId, orderId, f.data);
        await this.settleOp(orgId, opId, worker, 'succeeded', null);
        await this.d.audit.record({
          action: 'domain.order.reconciled',
          orgId,
          resource: { type: 'domain_order', id: orderId },
          outcome: 'success',
          detail: { result: 'found' },
        });
        return 'finalized';
      }
      await this.mark(orgId, orderId, {
        state: 'provider_pending',
        provider_order_ref: f.data.providerRef,
      });
      await this.d.ops.markNeedsReconcile(orgId, opId, worker, 'pending_at_registry');
      return 'pending';
    }
    // provably absent
    if ((order.attempts as number) >= MAX_REGISTER_CALLS) {
      await this.d.ops.markNeedsReconcile(orgId, opId, worker, 'absent_after_retry');
      await this.mark(orgId, orderId, { state: 'needs_reconcile' });
      return 'absent_exhausted';
    }
    await this.callProvider(orgId, op, worker, order, access);
    await this.d.audit.record({
      action: 'domain.order.reconciled',
      orgId,
      resource: { type: 'domain_order', id: orderId },
      outcome: 'success',
      detail: { result: 'absent_retried' },
    });
    return 'retried';
  }

  /** A provider-reported terminal failure (e.g. transfer failed): release the reservation and end the operation. */
  async failFromProvider(orgId: string, orderId: string, code: string): Promise<void> {
    const order = await this.loadOrder(orgId, orderId);
    if (
      !order ||
      ['succeeded', 'failed', 'cancelled'].includes(order.state as string) ||
      !order.operation_id
    )
      return;
    const worker = 'provider-event';
    if (!(await this.lease(orgId, order.operation_id as string, worker))) return;
    const op = (await this.d.ops.get(orgId, order.operation_id as string))!;
    await this.compensate(orgId, op, worker, order, {
      code,
      message: 'the registrar reported that the request failed',
    });
  }

  /** Operations that failed retryably are back in `pending` with a backoff: run those that are due (the retry reuses the same token). */
  async drain(limit = 50, olderThanSeconds = 20): Promise<number> {
    const rows = await this.d.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT org_id, operation_id FROM domains.domain_orders WHERE state IN ('created','authorized') AND operation_id IS NOT NULL AND updated_at < now() - make_interval(secs => $2) ORDER BY updated_at LIMIT $1`,
            [limit, olderThanSeconds],
          )
        ).rows as Row[],
    );
    let n = 0;
    for (const r of rows) {
      await this.run(r.org_id as string, r.operation_id as string).catch(() => undefined);
      n++;
    }
    return n;
  }

  /** Cross-organization sweep of orders that are waiting on the registrar (nightly and on demand). */
  async sweep(limit = 50): Promise<{ order: string; result: string }[]> {
    const rows = await this.d.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, org_id FROM domains.domain_orders WHERE state IN ('needs_reconcile','provider_pending') ORDER BY updated_at LIMIT $1`,
            [limit],
          )
        ).rows as Row[],
    );
    const out: { order: string; result: string }[] = [];
    for (const r of rows) {
      try {
        out.push({
          order: r.id as string,
          result: await this.reconcileOrder(r.org_id as string, r.id as string),
        });
      } catch (e) {
        out.push({ order: r.id as string, result: `error:${(e as Error).message.slice(0, 80)}` });
      }
    }
    return out;
  }
}
