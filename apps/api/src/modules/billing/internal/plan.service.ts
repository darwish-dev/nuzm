import { v7 as uuidv7 } from 'uuid';
import type { PoolClient } from 'pg';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf } from '../../../common/pagination';

export interface PlanEntitlementDto {
  kind: 'meter_limit' | 'feature';
  meterGroup: string | null;
  featureKey: string | null;
  limit: string | null;
  allowance: string | null;
  mode: 'soft' | 'hard';
  enabled: boolean;
}
type Row = Record<string, unknown>;

const entDto = (r: Row): PlanEntitlementDto => ({
  kind: r.kind as PlanEntitlementDto['kind'],
  meterGroup: (r.meter_group as string | null) ?? null,
  featureKey: (r.feature_key as string | null) ?? null,
  limit: r.limit_value === null ? null : String(r.limit_value),
  allowance: r.allowance === null ? null : String(r.allowance),
  mode: r.mode as 'soft' | 'hard',
  enabled: r.enabled as boolean,
});

const INT = /^\d{1,15}$/;
/** Validates and normalizes the entitlement list of a plan write. */
export function parseEntitlements(raw: unknown): PlanEntitlementDto[] {
  if (!Array.isArray(raw) || raw.length > 100)
    throw new ProblemException(
      'validation_failed',
      'entitlements must be an array of at most 100 items',
    );
  const seen = new Set<string>();
  return raw.map((e, i) => {
    const bad = (m: string) =>
      new ProblemException('validation_failed', `entitlements[${i}]: ${m}`);
    if (!e || typeof e !== 'object') throw bad('must be an object');
    const x = e as Record<string, unknown>;
    if (x.kind !== 'meter_limit' && x.kind !== 'feature')
      throw bad('kind must be meter_limit or feature');
    const mode = x.mode ?? 'soft';
    if (mode !== 'soft' && mode !== 'hard') throw bad('mode must be soft or hard');
    const num = (k: string) => {
      const v = x[k];
      if (v === undefined || v === null) return null;
      if (
        typeof v === 'number'
          ? !Number.isSafeInteger(v) || v < 0
          : typeof v !== 'string' || !INT.test(v)
      )
        throw bad(`${k} must be a non-negative integer`);
      return String(v);
    };
    const meterGroup =
      typeof x.meterGroup === 'string' && /^[a-z][a-z0-9_.-]{0,60}$/.test(x.meterGroup)
        ? x.meterGroup
        : null;
    const featureKey =
      typeof x.featureKey === 'string' && /^[a-z][a-z0-9_.-]{0,60}$/.test(x.featureKey)
        ? x.featureKey
        : null;
    if (x.kind === 'meter_limit' && !meterGroup)
      throw bad('meterGroup is required for meter_limit');
    if (x.kind === 'feature' && !featureKey) throw bad('featureKey is required for feature');
    const key = `${x.kind}:${meterGroup ?? featureKey}`;
    if (seen.has(key)) throw bad(`duplicate ${key}`);
    seen.add(key);
    return {
      kind: x.kind,
      meterGroup: x.kind === 'meter_limit' ? meterGroup : null,
      featureKey: x.kind === 'feature' ? featureKey : null,
      limit: num('limit'),
      allowance: num('allowance'),
      mode,
      enabled: x.enabled === undefined ? true : x.enabled === true,
    };
  });
}

function parseName(raw: unknown) {
  const n = raw as { ar?: unknown; en?: unknown } | undefined;
  const ok = (v: unknown) =>
    typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 120;
  if (!n || !ok(n.ar) || !ok(n.en))
    throw new ProblemException(
      'validation_failed',
      'name.ar and name.en are required (1..120 characters)',
    );
  return { ar: (n.ar as string).trim(), en: (n.en as string).trim() };
}

export class PlanService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  private async hydrate(c: PoolClient, plans: Row[], onlyLatestPublished: boolean) {
    if (plans.length === 0) return [];
    const versions = (
      await c.query(
        `SELECT id, plan_id, version, status, currency, published_at FROM billing.plan_versions
          WHERE plan_id = ANY($1::uuid[]) ORDER BY plan_id, version`,
        [plans.map((p) => p.id)],
      )
    ).rows;
    const ents = (
      await c.query(
        `SELECT * FROM billing.entitlements WHERE scope = 'plan' AND plan_version_id = ANY($1::uuid[]) ORDER BY created_at, id`,
        [versions.map((v) => v.id)],
      )
    ).rows;
    return plans
      .map((p) => {
        const vs = versions
          .filter((v) => v.plan_id === p.id)
          .map((v) => ({
            id: v.id as string,
            version: v.version as number,
            status: v.status as 'draft' | 'published',
            currency: (v.currency as string).trim(),
            publishedAt: v.published_at ? (v.published_at as Date).toISOString() : null,
            entitlements: ents.filter((e) => e.plan_version_id === v.id).map(entDto),
          }));
        return { p, vs };
      })
      .map(({ p, vs }) => {
        const base = {
          id: p.id as string,
          key: p.key as string,
          name: { ar: p.name_ar as string, en: p.name_en as string },
          placeholder: p.placeholder as boolean,
        };
        if (!onlyLatestPublished) return { ...base, status: p.status as string, versions: vs };
        const latest = [...vs].reverse().find((v) => v.status === 'published');
        return latest
          ? {
              ...base,
              version: {
                id: latest.id,
                version: latest.version,
                currency: latest.currency,
                publishedAt: latest.publishedAt,
              },
              entitlements: latest.entitlements,
              price: null as null, // resolved from the price book once S06 lands
            }
          : null;
      })
      .filter((x) => x !== null);
  }

  /** Customer-facing catalogue: active plans with their latest published version. */
  async listPublic(orgId: string, o: { limit: number; cursor?: string | null }) {
    const cur = decodeCursor(o.cursor);
    return this.db.withOrg(orgId, async (c) => {
      const plans = (
        await c.query(
          `SELECT * FROM billing.plans p WHERE status = 'active' AND ($1::uuid IS NULL OR id > $1)
             AND EXISTS (SELECT 1 FROM billing.plan_versions v WHERE v.plan_id = p.id AND v.status = 'published')
           ORDER BY id LIMIT $2`,
          [cur, o.limit + 1],
        )
      ).rows;
      const shown = plans.slice(0, o.limit);
      const items = (await this.hydrate(c, shown, true)) as { id: string }[];
      return {
        items,
        nextCursor:
          plans.length > o.limit
            ? Buffer.from(shown[shown.length - 1]!.id as string).toString('base64url')
            : null,
      };
    });
  }

  async getPublic(orgId: string, planId: string) {
    return this.db.withOrg(orgId, async (c) => {
      const plans = (
        await c.query(`SELECT * FROM billing.plans WHERE id = $1 AND status = 'active'`, [planId])
      ).rows;
      const [plan] = await this.hydrate(c, plans, true);
      if (!plan) throw new ProblemException('not_found');
      return plan;
    });
  }

  // ---- admin ---------------------------------------------------------------------------------------------
  async adminList(o: { limit: number; cursor?: string | null }) {
    const cur = decodeCursor(o.cursor);
    return this.db.withPlatformScope(async (c) => {
      const plans = (
        await c.query(
          `SELECT * FROM billing.plans WHERE ($1::uuid IS NULL OR id < $1) ORDER BY id DESC LIMIT $2`,
          [cur, o.limit + 1],
        )
      ).rows;
      const items = (await this.hydrate(c, plans.slice(0, o.limit), false)) as { id: string }[];
      return pageOf(items, o.limit);
    });
  }

  private async adminGet(c: PoolClient, id: string) {
    const [plan] = await this.hydrate(
      c,
      (await c.query('SELECT * FROM billing.plans WHERE id = $1', [id])).rows,
      false,
    );
    if (!plan) throw new ProblemException('not_found');
    return plan;
  }

  async create(
    input: { key?: unknown; name?: unknown; currency?: unknown; entitlements?: unknown },
    actorUserId: string,
  ) {
    const key =
      typeof input.key === 'string' && /^[a-z][a-z0-9_-]{1,40}$/.test(input.key) ? input.key : null;
    if (!key)
      throw new ProblemException(
        'validation_failed',
        'key must be 2..41 chars of a-z, 0-9, _ and -',
      );
    const name = parseName(input.name);
    const currency = input.currency === undefined ? 'SAR' : input.currency;
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))
      throw new ProblemException('validation_failed', 'currency must be an ISO 4217 code');
    const ents = parseEntitlements(input.entitlements ?? []);
    const planId = uuidv7();
    const versionId = uuidv7();
    try {
      return await this.db.withPlatformScope(async (c) => {
        await c.query(
          `INSERT INTO billing.plans (id, key, name_ar, name_en) VALUES ($1,$2,$3,$4)`,
          [planId, key, name.ar, name.en],
        );
        await c.query(
          `INSERT INTO billing.plan_versions (id, plan_id, version, status, currency) VALUES ($1,$2,1,'draft',$3)`,
          [versionId, planId, currency],
        );
        await this.writeEntitlements(c, versionId, ents, actorUserId);
        await this.audit.record({
          action: 'billing.plan.created',
          actorUserId,
          resource: { type: 'plan', id: planId },
          outcome: 'success',
          after: { key, version: 1, status: 'draft' },
        });
        return await this.adminGet(c, planId);
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException('conflict', 'a plan with this key already exists');
      throw e;
    }
  }

  private async writeEntitlements(
    c: PoolClient,
    versionId: string,
    ents: PlanEntitlementDto[],
    actor: string,
  ) {
    for (const e of ents)
      await c.query(
        `INSERT INTO billing.entitlements (id, scope, source, kind, plan_version_id, meter_group, feature_key, limit_value, allowance, mode, enabled, created_by)
         VALUES ($1,'plan','plan',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          uuidv7(),
          e.kind,
          versionId,
          e.meterGroup,
          e.featureKey,
          e.limit,
          e.allowance,
          e.mode,
          e.enabled,
          actor,
        ],
      );
  }

  /**
   * Edit the draft, rename, publish or branch a new draft. Published versions are immutable (DB triggers back this up):
   * `new_draft` copies the latest published version's entitlements into version n+1.
   */
  async update(
    id: string,
    input: { name?: unknown; entitlements?: unknown; action?: unknown },
    actorUserId: string,
  ) {
    if (input.action !== undefined && input.action !== 'publish' && input.action !== 'new_draft')
      throw new ProblemException('validation_failed', 'action must be publish or new_draft');
    if (input.name === undefined && input.entitlements === undefined && input.action === undefined)
      throw new ProblemException('validation_failed', 'nothing to change');
    const name = input.name === undefined ? null : parseName(input.name);
    const ents = input.entitlements === undefined ? null : parseEntitlements(input.entitlements);
    return this.db.withPlatformScope(async (c) => {
      const plan = (await c.query('SELECT id FROM billing.plans WHERE id = $1 FOR UPDATE', [id]))
        .rows[0];
      if (!plan) throw new ProblemException('not_found');
      const versions = (
        await c.query(
          'SELECT id, version, status FROM billing.plan_versions WHERE plan_id = $1 ORDER BY version',
          [id],
        )
      ).rows;
      let draft = versions.find((v) => v.status === 'draft');
      const latestPub = [...versions].reverse().find((v) => v.status === 'published');

      if (name)
        await c.query(
          'UPDATE billing.plans SET name_ar=$2, name_en=$3, updated_at=now() WHERE id=$1',
          [id, name.ar, name.en],
        );

      if (input.action === 'new_draft') {
        if (draft) throw new ProblemException('conflict', 'a draft version already exists');
        if (!latestPub) throw new ProblemException('conflict', 'no published version to copy');
        const vid = uuidv7();
        await c.query(
          `INSERT INTO billing.plan_versions (id, plan_id, version, status, currency)
           SELECT $1, plan_id, version + 1, 'draft', currency FROM billing.plan_versions WHERE id = $2`,
          [vid, latestPub.id],
        );
        await c.query(
          `INSERT INTO billing.entitlements (id, scope, source, kind, plan_version_id, meter_group, feature_key, limit_value, allowance, mode, enabled, created_by)
           SELECT gen_random_uuid(), 'plan','plan', kind, $1, meter_group, feature_key, limit_value, allowance, mode, enabled, $3
             FROM billing.entitlements WHERE plan_version_id = $2 AND scope = 'plan'`,
          [vid, latestPub.id, actorUserId],
        );
        draft = { id: vid, version: latestPub.version + 1, status: 'draft' };
      }
      if (ents) {
        if (!draft)
          throw new ProblemException(
            'conflict',
            'there is no draft version to edit; use action new_draft',
          );
        await c.query(
          `DELETE FROM billing.entitlements WHERE plan_version_id = $1 AND scope = 'plan'`,
          [draft.id],
        );
        await this.writeEntitlements(c, draft.id as string, ents, actorUserId);
      }
      if (input.action === 'publish') {
        if (!draft) throw new ProblemException('conflict', 'there is no draft version to publish');
        await c.query(
          `UPDATE billing.plan_versions SET status='published', published_at=now(), published_by=$2 WHERE id=$1`,
          [draft.id, actorUserId],
        );
        await this.audit.record({
          action: 'billing.plan_version.published',
          actorUserId,
          resource: { type: 'plan', id },
          outcome: 'success',
          after: { version: draft.version },
        });
      } else {
        await this.audit.record({
          action: 'billing.plan.updated',
          actorUserId,
          resource: { type: 'plan', id },
          outcome: 'success',
          detail: {
            renamed: Boolean(name),
            entitlements: Boolean(ents),
            newDraft: input.action === 'new_draft',
          },
        });
      }
      return this.adminGet(c, id);
    });
  }
}
