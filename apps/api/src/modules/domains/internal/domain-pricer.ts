import type { Db } from '@nuzm/platform';
import type { ResidencyEvaluator } from '@nuzm/domain';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { PriceContext, PricedItem, PricerResult, QuotePricer } from '../../commerce';
import { badRequest, normalizeDomainName, splitDomain, type Row } from './common';
import type { EligibilityDecision, EligibilityService } from './eligibility.service';
import { customerUnitPrice } from './pricing';
import type { DomainsConfig } from './ports';
import type { RegistrarAccessService, RegistrarAccount } from './registrar-access.service';
import type { SearchService } from './search.service';
import type { DomainAction } from './tld-policy';
import type { TldSupport } from '@nuzm/registrar-contracts';

export const RESIDENCY_PURPOSE = 'domain_registration';
export interface DomainQuoteItem {
  name: string;
  tld: string;
  years: number;
  action: DomainAction;
  registrarAccountId: string;
  providerCost: { amountMinor: string; currency: string; perYear: true };
  domainId: string | null;
}

const ACTIONS: DomainAction[] = ['register', 'renew', 'transfer_in'];
const METER: Record<DomainAction, { id: string; verb: string }> = {
  register: { id: 'domain.registration_years', verb: 'Domain registration' },
  renew: { id: 'domain.renewal_years', verb: 'Domain renewal' },
  transfer_in: { id: 'domain.transfers', verb: 'Domain transfer-in' },
};

/**
 * `POST /v1/quotes kind=domain` (M07 S28 task 5): per (name, years, action) item. Every refusal happens HERE, before any order, authorization or payment exists:
 * blocked/unsupported TLD or capability -> 422, taken name -> 409, residency not allowed -> 403. The quote is immutable once issued; the eligibility evidence of
 * every item is stored append-only and echoed in the quote. Prices are the registrar cost converted exactly (no float) plus the configured markup, rounded up.
 */
export class DomainPricer implements QuotePricer {
  readonly kind = 'domain' as const;
  constructor(
    private readonly db: Db,
    private readonly access: RegistrarAccessService,
    private readonly eligibility: EligibilityService,
    private readonly search: SearchService,
    private readonly residency: ResidencyEvaluator,
    private readonly audit: AuditSink,
    private readonly cfg: DomainsConfig,
  ) {}

  async price(ctx: PriceContext, rawItems: unknown[]): Promise<PricerResult> {
    const accounts = await this.access.sellableAccounts();
    const known = new Set<string>(accounts.flatMap((a) => a.tldSupport.map((t) => t.tld)));
    const items: PricedItem[] = [];
    const evaluations: unknown[] = [];
    const stored: DomainQuoteItem[] = [];
    const residencyByAccount = new Map<string, unknown>();
    const seen = new Set<string>();

    for (const [i, raw] of rawItems.entries()) {
      const it = (raw ?? {}) as { name?: unknown; years?: unknown; action?: unknown };
      const at = (m: string) => badRequest(`items[${i}]: ${m}`);
      const name = normalizeDomainName(it.name);
      if (!name) throw at('name is not a valid domain name');
      const years = it.years === undefined ? 1 : it.years;
      if (typeof years !== 'number' || !Number.isInteger(years) || years < 1 || years > 10)
        throw at('years must be an integer 1..10');
      const action = (it.action === undefined ? 'register' : it.action) as DomainAction;
      if (!ACTIONS.includes(action)) throw at(`action must be one of ${ACTIONS.join(', ')}`);
      if (seen.has(`${name}|${action}`)) throw at('duplicate item');
      seen.add(`${name}|${action}`);
      const split = splitDomain(name, known);
      if (!split) {
        const d = this.eligibility.decide(name.slice(name.indexOf('.') + 1), action, undefined);
        await this.block(ctx, name, d, true);
        throw new ProblemException('unsupported_capability', d.reason);
      }
      const { tld } = split;

      // the account: a renewal stays with the account the domain lives at; a new order picks the best verified account for the TLD
      let account: RegistrarAccount | undefined;
      let support: TldSupport | undefined;
      let domainId: string | null = null;
      if (action === 'renew') {
        const d = await this.db.withOrg(
          ctx.orgId,
          async (c) =>
            (
              await c.query(
                `SELECT id, registrar_account_id, state FROM domains.domains WHERE org_id = $1 AND name = $2 AND state IN ('active','renewal_at_risk','expired')`,
                [ctx.orgId, name],
              )
            ).rows[0] as Row | undefined,
        );
        if (!d)
          throw new ProblemException('not_found', 'you do not own an active domain with this name');
        domainId = d.id as string;
        account = (await this.access.getAccount(d.registrar_account_id as string)) ?? undefined;
        support = account?.tldSupport.find((t) => t.tld === tld);
        if (account && !(account.registrarEnabled && account.enabled)) account = undefined;
      } else {
        const need =
          action === 'register'
            ? (['registrar.search', 'registrar.register'] as const)
            : (['registrar.transfer-in'] as const);
        const pick = await this.access.pick(tld, [...need]);
        account = pick?.account;
        support = pick?.support;
      }
      const decision = this.eligibility.decide(tld, action, account ? support : undefined);
      await this.eligibility.record(ctx.orgId, decision, {
        quoteId: ctx.quoteId ?? null,
        domainId,
        name,
      });
      evaluations.push({ name, ...pick3(decision) });
      if (decision.result !== 'allowed' || !account || !support) {
        await this.block(ctx, name, decision, false);
        throw new ProblemException(
          decision.errorCode ?? 'unsupported_capability',
          decision.reason,
          undefined,
          { name, tld, rule: decision.rule },
        );
      }

      // residency BEFORE any registrant data could leave: the quote refuses a registrar the organization's policy does not allow
      if (!residencyByAccount.has(account.id)) {
        const r = await this.residency.evaluate({
          orgId: ctx.orgId,
          dataClass: 'personal',
          targetRegion: account.dataRegion,
          purpose: RESIDENCY_PURPOSE,
          processorId: account.providerCode,
          operation: 'write',
        });
        residencyByAccount.set(account.id, {
          decision: r.decision,
          policyVersion: r.policyVersion,
          floorVersion: r.floorVersion,
          assessmentId: r.assessmentId,
          evidenceRef: r.evidenceRef,
          region: account.dataRegion,
        });
        if (r.decision !== 'allow') {
          await this.audit.record({
            action: 'domain.quote.residency_blocked',
            orgId: ctx.orgId,
            actorUserId: ctx.actorUserId,
            outcome: 'failure',
            resource: { type: 'domain', id: name },
            detail: { decision: r.decision, region: account.dataRegion },
          });
          throw new ProblemException(
            'residency_denied',
            'the registrar for this domain is not allowed by your data residency policy',
            r.reasons.map((x) => ({ code: x.code, message: x.message })),
          );
        }
      }

      // availability (fresh) and price
      let cost: { amountMinor: string; currency: string } | null;
      if (action === 'register') {
        const [a] = await this.search.availability(
          account,
          [split.label],
          [tld],
          ctx.quoteId ?? 'quote',
          { fresh: true },
        );
        if (!a || a.available === false)
          throw new ProblemException('domain_unavailable', 'this domain name is not available');
        if (a.available === 'unknown')
          throw new ProblemException(
            'service_unavailable',
            'the registry did not answer; try again shortly',
          );
        if (a.premium)
          throw new ProblemException(
            'unsupported_capability',
            'premium domain names are not sold yet',
          );
        cost = a.registerPrice ?? support.prices?.register ?? null;
      } else
        cost =
          action === 'renew' ? (support.prices?.renew ?? null) : (support.prices?.transfer ?? null);
      const unit = cost ? customerUnitPrice(cost, this.cfg) : null;
      if (!cost || !unit)
        throw new ProblemException(
          'unsupported_capability',
          'no price is available for this domain (no registrar price or no exchange rate)',
        );
      const amount = unit.unitMinor * BigInt(years);
      const m = METER[action];
      items.push({
        description: `${m.verb} ${name} × ${years}y`,
        meterId: m.id,
        meterGroup: action === 'register' ? 'domains' : null,
        quantity: String(years),
        unit: 'year',
        unitPriceMinor: unit.unitMinor.toString(),
        amountMinor: amount,
        details: { name, tld, action, years, registrarAccountId: account.id },
      });
      stored.push({
        name,
        tld,
        years,
        action,
        registrarAccountId: account.id,
        providerCost: { ...cost, perYear: true },
        domainId,
      });
    }
    const residency = [...residencyByAccount.values()];
    return {
      items,
      priceBookVersionId: null,
      residency: { status: 'evaluated', purpose: RESIDENCY_PURPOSE, decisions: residency },
      preferences: { eligibility: evaluations, domainItems: stored },
    };
  }

  private async block(
    ctx: PriceContext,
    name: string,
    d: EligibilityDecision,
    record: boolean,
  ): Promise<void> {
    if (record) await this.eligibility.record(ctx.orgId, d, { quoteId: ctx.quoteId ?? null, name });
    await this.audit.record({
      action: 'domain.eligibility.blocked',
      orgId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      outcome: 'failure',
      resource: { type: 'domain', id: name },
      detail: { rule: d.rule, tld: d.tld, action: d.action },
    });
  }
}
const pick3 = (d: EligibilityDecision) => ({
  tld: d.tld,
  action: d.action,
  state: d.result,
  rule: d.rule,
  reason: d.reason,
  ruleSetVersion: d.ruleSetVersion,
});
