import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';

export interface EffectiveEntitlements {
  plan: { key: string; versionId: string; source: 'assignment' | 'default' };
  features: Record<string, { enabled: boolean; source: 'plan' | 'override' }>;
  limits: {
    meterGroup: string;
    limit: string | null;
    allowance: string | null;
    mode: 'soft' | 'hard';
    source: 'plan' | 'override';
  }[];
  /** Marketplace entitlements (`marketplace.v_entitlements`) are merged here from M11; empty until then. */
  marketplace: unknown[];
}

/** Plan applied to an organization with no assignment row (docs/05: assignment is an entitlements row). */
export const DEFAULT_PLAN_KEY = 'free';

type Row = Record<string, unknown>;
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));

/**
 * Effective entitlements = the assigned plan version's rows, then the organization's overrides on top (newest per
 * key wins). The assignment itself is an `entitlements` row (kind=plan_assignment, source=plan): no extra table.
 */
export class EntitlementService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  async resolve(orgId: string): Promise<EffectiveEntitlements> {
    return this.db.withOrg(orgId, async (c) => {
      const assigned = (
        await c.query(
          `SELECT e.plan_version_id, p.key FROM billing.entitlements e
             JOIN billing.plan_versions v ON v.id = e.plan_version_id JOIN billing.plans p ON p.id = v.plan_id
            WHERE e.kind = 'plan_assignment' AND e.org_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT 1`,
          [orgId],
        )
      ).rows[0];
      let versionId = assigned?.plan_version_id as string | undefined;
      let key = assigned?.key as string | undefined;
      const source: 'assignment' | 'default' = assigned ? 'assignment' : 'default';
      if (!versionId) {
        const def = (
          await c.query(
            `SELECT v.id, p.key FROM billing.plans p JOIN billing.plan_versions v ON v.plan_id = p.id
              WHERE p.key = $1 AND v.status = 'published' ORDER BY v.version DESC LIMIT 1`,
            [DEFAULT_PLAN_KEY],
          )
        ).rows[0];
        if (!def)
          throw new ProblemException('service_unavailable', 'the default plan is not configured');
        versionId = def.id;
        key = def.key;
      }
      const planRows = (
        await c.query(
          `SELECT * FROM billing.entitlements WHERE scope='plan' AND plan_version_id = $1 ORDER BY created_at, id`,
          [versionId],
        )
      ).rows;
      const overrides = (
        await c.query(
          `SELECT * FROM billing.entitlements WHERE scope='org_override' AND org_id=$1 AND kind IN ('feature','meter_limit') ORDER BY created_at, id`,
          [orgId],
        )
      ).rows;
      const features: EffectiveEntitlements['features'] = {};
      const limits = new Map<string, EffectiveEntitlements['limits'][number]>();
      const apply = (r: Row, src: 'plan' | 'override') => {
        if (r.kind === 'feature')
          features[r.feature_key as string] = { enabled: r.enabled as boolean, source: src };
        else
          limits.set(r.meter_group as string, {
            meterGroup: r.meter_group as string,
            limit: s(r.limit_value),
            allowance: s(r.allowance),
            mode: r.mode as 'soft' | 'hard',
            source: src,
          });
      };
      for (const r of planRows) apply(r, 'plan');
      for (const r of overrides) apply(r, 'override'); // later (newer) rows overwrite earlier ones
      return {
        plan: { key: key!, versionId: versionId!, source },
        features,
        limits: [...limits.values()].sort((a, b) => a.meterGroup.localeCompare(b.meterGroup)),
        marketplace: [],
      };
    });
  }

  /**
   * Record the organization's plan (M02 tooling; subscriptions in M03 supersede it). Admin scope: customers can
   * never write entitlements. Only a PUBLISHED plan version can be assigned.
   */
  async assignPlan(orgId: string, planVersionId: string, actorUserId?: string): Promise<void> {
    await this.db.withPlatformScope(async (c) => {
      const v = (
        await c.query(`SELECT status FROM billing.plan_versions WHERE id = $1`, [planVersionId])
      ).rows[0];
      if (!v) throw new ProblemException('not_found');
      if (v.status !== 'published')
        throw new ProblemException('conflict', 'only a published plan version can be assigned');
      await c.query(
        `INSERT INTO billing.entitlements (id, scope, source, kind, plan_version_id, org_id, mode, created_by)
         VALUES ($1,'org_override','plan','plan_assignment',$2,$3,'soft',$4)`,
        [uuidv7(), planVersionId, orgId, actorUserId ?? null],
      );
    });
    await this.audit.record({
      action: 'billing.plan.assigned',
      orgId,
      actorUserId,
      resource: { type: 'plan_version', id: planVersionId },
      outcome: 'success',
    });
  }

  /** Put the organization back on the default (free) plan: what a cancelled subscription ends with. A no-op when it already is. */
  async assignDefaultPlan(orgId: string, actorUserId?: string): Promise<void> {
    const cur = await this.resolve(orgId);
    if (cur.plan.source === 'default') return;
    const def = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query<{ id: string }>(
            `SELECT v.id FROM billing.plans p JOIN billing.plan_versions v ON v.plan_id = p.id
              WHERE p.key = $1 AND v.status = 'published' ORDER BY v.version DESC LIMIT 1`,
            [DEFAULT_PLAN_KEY],
          )
        ).rows[0],
    );
    if (!def)
      throw new ProblemException('service_unavailable', 'the default plan is not configured');
    await this.assignPlan(orgId, def.id, actorUserId);
  }

  /** Per-organization override (admin DB tooling per M02 §4.5: docs/04 defines no endpoint for it). */
  async setOverride(
    orgId: string,
    o: {
      kind: 'feature' | 'meter_limit';
      key: string;
      enabled?: boolean;
      limit?: string | null;
      allowance?: string | null;
      mode?: 'soft' | 'hard';
      note?: string;
    },
    actorUserId?: string,
  ): Promise<void> {
    await this.db.withPlatformScope((c) =>
      c.query(
        `INSERT INTO billing.entitlements (id, scope, source, kind, org_id, meter_group, feature_key, limit_value, allowance, mode, enabled, note, created_by)
         VALUES ($1,'org_override','override',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          uuidv7(),
          o.kind,
          orgId,
          o.kind === 'meter_limit' ? o.key : null,
          o.kind === 'feature' ? o.key : null,
          o.limit ?? null,
          o.allowance ?? null,
          o.mode ?? 'soft',
          o.enabled ?? true,
          o.note ?? null,
          actorUserId ?? null,
        ],
      ),
    );
    await this.audit.record({
      action: 'billing.entitlement.overridden',
      orgId,
      actorUserId,
      resource: { type: 'entitlement', id: `${o.kind}:${o.key}` },
      outcome: 'success',
    });
  }
}
