import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { ResellerPriceRuleService } from '../../billing';
import type { OrgService } from '../../tenancy';
import { RESELLER_FLAG, badRequest, isUuid, iso, pgCode, type Row } from './model';
import { validateRules, type StoredRule } from './pricing';

export interface ResellerDto {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  currency: string;
  role: 'reseller' | 'sub_organization';
  etag: number;
  createdAt: string;
}
export interface SubOrgDto {
  id: string;
  resellerId: string;
  subOrgId: string;
  subOrgName: string | null;
  priceBookRef: string | null;
  status: 'pending' | 'active' | 'removed' | 'declined';
  acceptedAt: string | null;
  createdAt: string;
}
export interface RuleSetDto {
  version: number;
  etag: string;
  rules: { scope: string; scopeKey: string; markup: unknown; effectiveFrom: string }[];
  history: { version: number; createdAt: string; rules: number }[];
}
type Perms = ReadonlySet<string>;

/** Reseller program (M11 S54): the profile, sub-organization LINKS (the sub-organization accepts), and VERSIONED price rules. Resellers see aggregates and metadata only, never sub-org content. */
export class ResellerService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly orgs: Pick<OrgService, 'get'>,
    private readonly flags: { enabled(orgId: string | null, key: string): Promise<boolean> },
    private readonly priceRules: Pick<ResellerPriceRuleService, 'all' | 'replace'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async enabled(orgId: string) {
    if (!(await this.flags.enabled(orgId, RESELLER_FLAG)))
      throw new ProblemException(
        'feature_disabled',
        'reseller programs are not enabled for this organization',
      );
  }
  private need(perms: Perms, p: string) {
    if (!perms.has(p) && !perms.has('*')) throw new ProblemException('forbidden', `requires ${p}`);
  }
  private rdto(r: Row, role: ResellerDto['role']): ResellerDto {
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      currency: (r.currency as string).trim(),
      role,
      etag: r.version_lock,
      createdAt: iso(r.created_at)!,
    };
  }

  async create(orgId: string, actor: string, body: Record<string, unknown>): Promise<ResellerDto> {
    await this.enabled(orgId);
    for (const k of Object.keys(body)) if (k !== 'name') throw badRequest(`unknown field ${k}`);
    const org = await this.orgs.get(orgId);
    if (!org || org.type !== 'reseller')
      throw new ProblemException(
        'forbidden',
        'only an organization of type reseller can create a reseller profile',
      );
    const name = typeof body.name === 'string' ? body.name.trim() : org.name;
    if (name.length < 1 || name.length > 200) throw badRequest('name must be 1..200 characters');
    try {
      const r = (await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `INSERT INTO programs.resellers (id, org_id, name, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
              [uuidv7(), orgId, name, actor],
            )
          ).rows[0],
      )) as Row;
      await this.audit.record({
        action: 'reseller.reseller.created',
        actorUserId: actor,
        orgId,
        resource: { type: 'reseller', id: r.id },
        outcome: 'success',
      });
      return this.rdto(r, 'reseller');
    } catch (e) {
      if (pgCode(e) === '23505')
        throw new ProblemException('conflict', 'this organization already has a reseller profile');
      throw e;
    }
  }
  async list(orgId: string): Promise<{ items: ResellerDto[]; nextCursor: null }> {
    await this.enabled(orgId);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM programs.resellers ORDER BY created_at DESC LIMIT 100`))
          .rows as Row[],
    );
    return {
      items: rows.map((r) => this.rdto(r, r.org_id === orgId ? 'reseller' : 'sub_organization')),
      nextCursor: null,
    };
  }
  /** The reseller as seen by the caller: its own profile, or (for a linked sub-organization) read-only. */
  async side(
    orgId: string,
    resellerId: string,
  ): Promise<{ side: 'reseller' | 'sub'; reseller: Row }> {
    if (!isUuid(resellerId)) throw new ProblemException('not_found');
    const r = (await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM programs.resellers WHERE id = $1`, [resellerId])).rows[0],
    )) as Row | undefined;
    if (!r) throw new ProblemException('not_found');
    return { side: r.org_id === orgId ? 'reseller' : 'sub', reseller: r };
  }
  /** Reseller-only: 404 for anyone else (a sub-organization must not learn more than it is told). */
  async ownOnly(orgId: string, resellerId: string): Promise<Row> {
    const x = await this.side(orgId, resellerId.toLowerCase());
    if (x.side !== 'reseller') throw new ProblemException('not_found');
    return x.reseller;
  }

  // ---- sub-organizations --------------------------------------------------------------------------------------------------
  /**
   * POST /v1/resellers/{id}/sub-organizations: the reseller LINKS an existing organization `{subOrgId, priceBookRef?}` (→ pending); the sub-organization's administrator answers
   * `{linkId, decision}`. CREATING a brand-new sub-organization is NOT implemented: who owns it afterwards is a product/legal decision (a reseller owner would see its content, contradicting the isolation rule) and is recorded as an open question.
   */
  async postSubOrg(
    orgId: string,
    actor: string,
    perms: Perms,
    resellerId: string,
    body: Record<string, unknown>,
  ): Promise<SubOrgDto> {
    await this.enabled(orgId);
    const { side, reseller } = await this.side(orgId, resellerId.toLowerCase());
    if (side === 'reseller') {
      this.need(perms, 'reseller:manage');
      for (const k of Object.keys(body))
        if (!['subOrgId', 'priceBookRef', 'create'].includes(k))
          throw badRequest(`unknown field ${k}`);
      if (body.create !== undefined)
        throw new ProblemException(
          'unsupported_capability',
          'creating a sub-organization is not available: link an existing organization (it accepts the link)',
        );
      if (!isUuid(body.subOrgId)) throw badRequest('subOrgId is required');
      const sub = (body.subOrgId as string).toLowerCase();
      if (sub === orgId) throw badRequest('a reseller cannot be its own sub-organization');
      if (
        body.priceBookRef !== undefined &&
        (typeof body.priceBookRef !== 'string' || body.priceBookRef.length > 200)
      )
        throw badRequest('priceBookRef must be at most 200 characters');
      if (reseller.status !== 'active')
        throw new ProblemException('invalid_state', 'the reseller is suspended');
      try {
        const r = (await this.db.withOrg(
          orgId,
          async (c) =>
            (
              await c.query(
                `INSERT INTO programs.reseller_sub_orgs (id, org_id, reseller_id, sub_org_id, price_book_ref, invited_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
                [
                  uuidv7(),
                  orgId,
                  reseller.id,
                  sub,
                  (body.priceBookRef as string | undefined) ?? null,
                  actor,
                ],
              )
            ).rows[0],
        )) as Row;
        await this.audit.record({
          action: 'reseller.sub_org.invited',
          actorUserId: actor,
          orgId,
          resource: { type: 'reseller_sub_org', id: r.id },
          outcome: 'success',
          detail: { subOrgId: sub },
        });
        return this.sdto(r, null);
      } catch (e) {
        if (pgCode(e) === '23505')
          throw new ProblemException(
            'conflict',
            'this organization already has a pending or active reseller link',
          );
        throw e;
      }
    }
    this.need(perms, 'partners:manage');
    for (const k of Object.keys(body))
      if (!['linkId', 'decision'].includes(k)) throw badRequest(`unknown field ${k}`);
    if (!isUuid(body.linkId) || !['accept', 'decline'].includes(body.decision as string))
      throw badRequest('linkId and decision (accept|decline) are required');
    const accept = body.decision === 'accept';
    const linkId = (body.linkId as string).toLowerCase();
    const r = (await this.db.withOrg(
      orgId,
      async (c) =>
        (accept
          ? await c.query(
              `UPDATE programs.reseller_sub_orgs SET status = 'active', accepted_by = $2, accepted_at = now() WHERE id = $1 AND sub_org_id = $3 AND status = 'pending' RETURNING *`,
              [linkId, actor, orgId],
            )
          : await c.query(
              `UPDATE programs.reseller_sub_orgs SET status = 'declined' WHERE id = $1 AND sub_org_id = $2 AND status = 'pending' RETURNING *`,
              [linkId, orgId],
            )
        ).rows[0],
    )) as Row | undefined;
    if (!r) throw new ProblemException('conflict', 'no pending link with this id');
    await this.audit.record({
      action: accept ? 'reseller.sub_org.created' : 'reseller.sub_org.declined',
      actorUserId: actor,
      orgId,
      actingOrgId: reseller.org_id,
      resource: { type: 'reseller_sub_org', id: r.id },
      outcome: 'success',
    });
    return this.sdto(r, null);
  }
  private sdto(r: Row, name: string | null): SubOrgDto {
    return {
      id: r.id,
      resellerId: r.reseller_id,
      subOrgId: r.sub_org_id,
      subOrgName: name,
      priceBookRef: r.price_book_ref ?? null,
      status: r.status,
      acceptedAt: iso(r.accepted_at),
      createdAt: iso(r.created_at)!,
    };
  }
  async listSubOrgs(
    orgId: string,
    resellerId: string,
  ): Promise<{ items: SubOrgDto[]; nextCursor: null }> {
    await this.enabled(orgId);
    const { reseller } = await this.side(orgId, resellerId.toLowerCase());
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM programs.reseller_sub_orgs WHERE reseller_id = $1 ORDER BY created_at DESC LIMIT 200`,
            [reseller.id],
          )
        ).rows as Row[],
    );
    const items: SubOrgDto[] = [];
    for (const r of rows) {
      // METADATA only (the organization's name), and only for an ACTIVE link
      const name =
        r.status === 'active' && r.org_id === orgId
          ? ((await this.orgs.get(r.sub_org_id))?.name ?? null)
          : null;
      items.push(this.sdto(r, name));
    }
    return { items, nextCursor: null };
  }
  /** The ACTIVE sub-organizations of a reseller (used by statements). */
  async activeSubOrgs(orgId: string, resellerId: string): Promise<Row[]> {
    return this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM programs.reseller_sub_orgs WHERE reseller_id = $1 AND status = 'active' ORDER BY id`,
            [resellerId],
          )
        ).rows as Row[],
    );
  }

  // ---- price rules --------------------------------------------------------------------------------------------------------
  async rules(orgId: string, resellerId: string): Promise<RuleSetDto> {
    await this.enabled(orgId);
    const reseller = await this.ownOnly(orgId, resellerId);
    return this.ruleSet(orgId, reseller.id);
  }
  private async ruleSet(orgId: string, resellerId: string): Promise<RuleSetDto> {
    const rows = await this.priceRules.all(orgId, resellerId);
    const v = rows[0]?.ruleSetVersion ?? 0;
    const hist = new Map<number, { createdAt: string; n: number }>();
    for (const r of rows)
      hist.set(r.ruleSetVersion, {
        createdAt: r.createdAt.toISOString(),
        n: (hist.get(r.ruleSetVersion)?.n ?? 0) + 1,
      });
    return {
      version: v,
      etag: `"${v}"`,
      rules: rows
        .filter((r) => r.ruleSetVersion === v)
        .map((r) => ({
          scope: r.scope,
          scopeKey: r.scopeKey,
          markup: r.markup,
          effectiveFrom: r.effectiveFrom.toISOString(),
        })),
      history: [...hist.entries()].map(([version, h]) => ({
        version,
        createdAt: h.createdAt,
        rules: h.n,
      })),
    };
  }
  /** PUT /v1/resellers/{id}/price-rules: replaces the rule set with a NEW version (append-only, through the billing module). `If-Match` = the current version (0 when none). Negative markups are `below_cost`. */
  async putRules(
    orgId: string,
    actor: string,
    perms: Perms,
    resellerId: string,
    ifMatch: number,
    body: Record<string, unknown>,
  ): Promise<RuleSetDto> {
    await this.enabled(orgId);
    this.need(perms, 'reseller:pricing');
    for (const k of Object.keys(body)) if (k !== 'rules') throw badRequest(`unknown field ${k}`);
    const reseller = await this.ownOnly(orgId, resellerId);
    const rules = validateRules(body.rules, this.now(), (reseller.currency as string).trim());
    // serialize concurrent PUTs of one reseller on its own profile row
    await this.priceRules.replace(orgId, actor, reseller.id, ifMatch, rules, {
      text: `SELECT 1 FROM programs.resellers WHERE id = $1 FOR UPDATE`,
      values: [reseller.id],
    });
    return this.ruleSet(orgId, reseller.id);
  }
  async storedRules(orgId: string, resellerId: string): Promise<StoredRule[]> {
    return (await this.priceRules.all(orgId, resellerId)).map((r) => ({
      scope: r.scope,
      scopeKey: r.scopeKey,
      markup: r.markup as StoredRule['markup'],
      effectiveFrom: r.effectiveFrom,
      ruleSetVersion: r.ruleSetVersion,
    }));
  }
}
