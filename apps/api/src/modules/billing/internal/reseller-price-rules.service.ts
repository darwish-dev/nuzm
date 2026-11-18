import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';

export interface ResellerRuleRow {
  scope: 'plan' | 'meter';
  scopeKey: string;
  markup: unknown;
  effectiveFrom: Date;
  ruleSetVersion: number;
  createdAt: Date;
}

/**
 * Owner of `billing.reseller_price_rules` (M11 S54, owner PR to the billing module). The programs module validates and calls these methods; nothing else writes the table. APPEND-VERSIONED:
 * `replace` inserts a whole new rule set under the next version number (the table forbids UPDATE and DELETE), serialized per reseller, guarded by the caller's expected current version.
 */
export class ResellerPriceRuleService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  async all(orgId: string, resellerId: string): Promise<ResellerRuleRow[]> {
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM billing.reseller_price_rules WHERE reseller_id = $1 AND org_id = $2 ORDER BY rule_set_version DESC, scope, scope_key`,
            [resellerId, orgId],
          )
        ).rows,
    );
    return rows.map((r) => ({
      scope: r.scope,
      scopeKey: r.scope_key,
      markup: r.markup,
      effectiveFrom: r.effective_from as Date,
      ruleSetVersion: r.rule_set_version as number,
      createdAt: r.created_at as Date,
    }));
  }

  /** Insert version `expectedVersion + 1`. `etag_mismatch` (412) when the stored version differs. `lockSql` serializes concurrent callers (the reseller's own profile row). */
  async replace(
    orgId: string,
    actor: string,
    resellerId: string,
    expectedVersion: number,
    rules: { scope: 'plan' | 'meter'; scopeKey: string; markup: unknown; effectiveFrom: string }[],
    lockSql: { text: string; values: unknown[] },
  ): Promise<number> {
    const next = await this.db.withOrg(orgId, async (c) => {
      await c.query(lockSql.text, lockSql.values);
      const cur = Number(
        (
          await c.query(
            `SELECT coalesce(max(rule_set_version), 0) v FROM billing.reseller_price_rules WHERE reseller_id = $1`,
            [resellerId],
          )
        ).rows[0]!.v,
      );
      if (cur !== expectedVersion)
        throw new ProblemException('etag_mismatch', `the rule set is at version ${cur}`);
      for (const r of rules)
        await c.query(
          `INSERT INTO billing.reseller_price_rules (id, org_id, reseller_id, scope, scope_key, markup, effective_from, rule_set_version, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            uuidv7(),
            orgId,
            resellerId,
            r.scope,
            r.scopeKey,
            JSON.stringify(r.markup),
            r.effectiveFrom,
            cur + 1,
            actor,
          ],
        );
      return cur + 1;
    });
    await this.audit.record({
      action: 'reseller.price_rule.changed',
      actorUserId: actor,
      orgId,
      resource: { type: 'reseller', id: resellerId },
      outcome: 'success',
      after: { ruleSetVersion: next, rules: rules.length },
    });
    return next;
  }
}
