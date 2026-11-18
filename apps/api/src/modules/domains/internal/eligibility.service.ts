import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import {
  isSupported,
  type ContactPayload,
  type RegistrarAdapter,
  type TldSupport,
} from '@nuzm/registrar-contracts';
import type { AccountContext } from '@nuzm/registrar-contracts';
import type { Row } from './common';
import type { RegistrarAccount } from './registrar-access.service';
import { evaluateTld, type DomainAction, type TldPolicy } from './tld-policy';

export interface EligibilityDecision {
  tld: string;
  action: DomainAction;
  result: 'allowed' | 'blocked' | 'needs_info';
  rule: string;
  reason: string;
  /** Present when blocked: the HTTP-facing error. */
  errorCode: 'unsupported_capability' | 'eligibility_blocked' | null;
  ruleSetVersion: string;
  evidence: Record<string, unknown>;
}

/**
 * Eligibility engine (M07 S30 task 5): the platform's TLD policy, then — only when the registrar declares the capability — the registry's own rules for a
 * given registrant. Every evaluation tied to an organization is stored APPEND-ONLY in `domains.eligibility_checks` (the evidence of why a quote was refused).
 */
export class EligibilityService {
  constructor(
    private readonly db: Db,
    private readonly policy: TldPolicy,
  ) {}

  get ruleSetVersion(): string {
    return this.policy.ruleSetVersion;
  }

  /** Pure: platform policy against a probed registrar support. No I/O. */
  decide(tld: string, action: DomainAction, support: TldSupport | undefined): EligibilityDecision {
    const o = evaluateTld(this.policy, tld, action, support);
    return {
      tld,
      action,
      result: o.result,
      rule: o.rule,
      reason: o.reason,
      errorCode: o.result === 'blocked' ? o.errorCode : null,
      ruleSetVersion: this.policy.ruleSetVersion,
      evidence: o.evidence,
    };
  }

  /** Registry-level rules for a registrant, when the registrar's probe says it can answer them. */
  async decideForRegistrant(
    base: EligibilityDecision,
    adapter: RegistrarAdapter,
    account: RegistrarAccount,
    ctx: AccountContext,
    registrant: ContactPayload | null,
  ): Promise<EligibilityDecision> {
    if (
      base.result !== 'allowed' ||
      !adapter.eligibility ||
      !isSupported(account.capabilities, 'registrar.eligibility')
    )
      return base;
    if (!registrant)
      return {
        ...base,
        result: 'needs_info',
        rule: 'registry.needs_registrant',
        reason: 'the registry rules need the registrant details',
        errorCode: null,
      };
    const r = await adapter.eligibility(ctx, base.tld, registrant);
    if (r.state === 'allowed')
      return { ...base, evidence: { ...base.evidence, registry: r.evidence } };
    return {
      ...base,
      result: r.state,
      rule: r.rule,
      reason: r.reason,
      errorCode: r.state === 'blocked' ? 'eligibility_blocked' : null,
      evidence: { ...base.evidence, registry: r.evidence },
    };
  }

  /** Append one evaluation (organization context). Failures to persist never silently allow: callers persist BEFORE they act on an allow. */
  async record(
    orgId: string,
    d: EligibilityDecision,
    ref: { quoteId?: string | null; domainId?: string | null; name?: string | null },
  ): Promise<string> {
    const id = uuidv7();
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `INSERT INTO domains.eligibility_checks (id, org_id, quote_id, domain_id, name, tld, action, rule_set_version, result, rule, reason, error_code, evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          id,
          orgId,
          ref.quoteId ?? null,
          ref.domainId ?? null,
          ref.name ?? null,
          d.tld,
          d.action,
          d.ruleSetVersion,
          d.result,
          d.rule,
          d.reason,
          d.errorCode,
          JSON.stringify(d.evidence),
        ],
      ),
    );
    return id;
  }

  /** Latest stored evaluation for a domain (GET /v1/domains/{id}/eligibility). */
  async latestForDomain(orgId: string, domainId: string) {
    return this.db.withOrg(orgId, async (c) => {
      const r = (
        await c.query(
          `SELECT * FROM domains.eligibility_checks WHERE domain_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
          [domainId],
        )
      ).rows[0] as Row | undefined;
      return r
        ? {
            rule: r.rule as string,
            state: r.result as string,
            reason: r.reason as string,
            action: r.action as string,
            ruleSetVersion: r.rule_set_version as string,
            evaluatedAt: (r.created_at as Date).toISOString(),
            evidence: r.evidence as unknown,
          }
        : null;
    });
  }
}
