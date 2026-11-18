import { v7 as uuidv7 } from 'uuid';
import {
  route,
  type RouteCandidate,
  type RoutingDecision,
  type RoutingRequest,
  type RoutingRule,
} from '@nuzm/domain';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { UUID, body, iso, oneOf, reqText, type Row } from './common';
import type { OfferCandidate } from './offer.service';

export interface RoutingRuleDto {
  id: string;
  ruleKey: string;
  version: number;
  priority: number;
  match: RoutingRule['match'];
  action: RoutingRule['action'];
  enabled: boolean;
  note: string | null;
  createdAt: string;
}
const toDto = (r: Row): RoutingRuleDto => ({
  id: r.id as string,
  ruleKey: r.rule_key as string,
  version: r.version as number,
  priority: r.priority as number,
  match: r.match as RoutingRule['match'],
  action: r.action as RoutingRule['action'],
  enabled: r.enabled as boolean,
  note: (r.note as string | null) ?? null,
  createdAt: iso(r.created_at)!,
});

function parseMatch(v: unknown): RoutingRule['match'] {
  if (v === undefined) return {};
  const m = body(v);
  const out: RoutingRule['match'] = {};
  for (const k of Object.keys(m))
    if (!['country', 'geoGroup', 'mode'].includes(k))
      throw new ProblemException('validation_failed', `match.${k} is not supported`);
  if (m.country !== undefined) {
    if (
      !Array.isArray(m.country) ||
      m.country.length > 50 ||
      m.country.some((c) => typeof c !== 'string' || !/^[A-Za-z]{2}$/.test(c))
    )
      throw new ProblemException(
        'validation_failed',
        'match.country must be a list of ISO country codes',
      );
    out.country = (m.country as string[]).map((c) => c.toUpperCase());
  }
  if (m.geoGroup !== undefined) {
    if (
      !Array.isArray(m.geoGroup) ||
      m.geoGroup.length > 20 ||
      m.geoGroup.some((g) => typeof g !== 'string' || !/^[a-z_]{2,30}$/.test(g))
    )
      throw new ProblemException(
        'validation_failed',
        'match.geoGroup must be a list of region groups',
      );
    out.geoGroup = m.geoGroup as string[];
  }
  if (m.mode !== undefined)
    out.mode = oneOf(m.mode, 'match.mode', ['explicit', 'automatic'] as const);
  return out;
}
function parseAction(v: unknown): RoutingRule['action'] {
  const a = body(v);
  for (const k of Object.keys(a))
    if (!['type', 'providerKey', 'accountId', 'providerRegionId'].includes(k))
      throw new ProblemException('validation_failed', `action.${k} is not supported`);
  const type = oneOf(a.type, 'action.type', ['prefer', 'exclude', 'pin'] as const);
  const out: RoutingRule['action'] = { type };
  if (a.providerKey !== undefined)
    out.providerKey = reqText(a.providerKey, 'action.providerKey', 1, 31);
  if (a.accountId !== undefined) {
    if (typeof a.accountId !== 'string' || !UUID.test(a.accountId))
      throw new ProblemException('validation_failed', 'action.accountId must be a UUID');
    out.accountId = a.accountId.toLowerCase();
  }
  if (a.providerRegionId !== undefined)
    out.providerRegionId = reqText(a.providerRegionId, 'action.providerRegionId', 1, 100);
  if (!out.providerKey && !out.accountId && !out.providerRegionId)
    throw new ProblemException(
      'validation_failed',
      'an action needs providerKey, accountId or providerRegionId',
    );
  return out;
}

/** Routing rules (`cloud.routing_rules`): versioned (every change is a new immutable row), audited, and the decision recorded in the quote. */
export class RoutingService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  async list(history = false): Promise<RoutingRuleDto[]> {
    return this.db.withPlatformScope(async (c) =>
      (
        await c.query(
          history
            ? `SELECT * FROM cloud.routing_rules ORDER BY rule_key, version DESC`
            : `SELECT DISTINCT ON (rule_key) * FROM cloud.routing_rules ORDER BY rule_key, version DESC`,
        )
      ).rows.map(toDto),
    );
  }

  /** The CURRENT version of every rule (the router ignores disabled rules). */
  async current(): Promise<RoutingRule[]> {
    return (await this.list()).map((r) => ({
      ruleKey: r.ruleKey,
      version: r.version,
      priority: r.priority,
      enabled: r.enabled,
      match: r.match,
      action: r.action,
    }));
  }

  /** Creates the rule (version 1) or its next version. */
  async put(actorUserId: string, input: unknown): Promise<RoutingRuleDto> {
    const b = body(input);
    const ruleKey = reqText(b.ruleKey, 'ruleKey', 2, 61);
    if (!/^[a-z][a-z0-9_-]{1,60}$/.test(ruleKey))
      throw new ProblemException(
        'validation_failed',
        'ruleKey must be lower-case letters, digits, dashes and underscores',
      );
    const priority = b.priority;
    if (
      typeof priority !== 'number' ||
      !Number.isInteger(priority) ||
      priority < 0 ||
      priority > 100000
    )
      throw new ProblemException('validation_failed', 'priority must be an integer 0..100000');
    const match = parseMatch(b.match);
    const action = parseAction(b.action);
    const enabled = b.enabled === undefined ? true : b.enabled === true;
    if (b.enabled !== undefined && typeof b.enabled !== 'boolean')
      throw new ProblemException('validation_failed', 'enabled must be a boolean');
    const note = b.note === undefined || b.note === null ? null : reqText(b.note, 'note', 1, 500);
    const row = await this.db.withPlatformScope(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`routing-rule:${ruleKey}`]);
      const prev = (
        await c.query(
          `SELECT * FROM cloud.routing_rules WHERE rule_key = $1 ORDER BY version DESC LIMIT 1`,
          [ruleKey],
        )
      ).rows[0] as Row | undefined;
      const version = ((prev?.version as number | undefined) ?? 0) + 1;
      const r = (
        await c.query(
          `INSERT INTO cloud.routing_rules (id, rule_key, version, priority, match, action, enabled, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [
            uuidv7(),
            ruleKey,
            version,
            priority,
            JSON.stringify(match),
            JSON.stringify(action),
            enabled,
            note,
            actorUserId,
          ],
        )
      ).rows[0] as Row;
      await this.audit.record({
        action: 'routing.rule.changed',
        actorUserId,
        resource: { type: 'routing_rule', id: r.id as string },
        outcome: 'success',
        before: prev
          ? {
              version: prev.version,
              priority: prev.priority,
              enabled: prev.enabled,
              match: prev.match,
              action: prev.action,
            }
          : {},
        after: { ruleKey, version, priority, enabled, match, action },
      });
      return r;
    });
    return toDto(row);
  }

  /** Choose among ELIGIBLE offers. Pure ordering lives in the domain `route`; here only the inputs and the recorded decision are assembled. */
  async decide(
    eligible: OfferCandidate[],
    req: RoutingRequest,
  ): Promise<{ chosen: OfferCandidate | null; decision: RoutingDecision }> {
    const byId = new Map(eligible.map((c) => [c.offerId, c]));
    const cands: RouteCandidate[] = eligible.map((c) => ({
      offerId: c.offerId,
      providerKey: c.providerKey,
      accountId: c.accountId,
      providerRegionId: c.providerRegionId,
      country: c.country,
      geoGroup: c.geoGroup,
      planRef: c.planRef,
      priceMinor: c.price!.monthlyMinor,
    }));
    const { chosen, decision } = route(cands, req, await this.current());
    return { chosen: chosen ? (byId.get(chosen.offerId) ?? null) : null, decision };
  }
}
