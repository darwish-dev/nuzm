import type { PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { enqueue, type Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, parseLimit, type Page } from './pagination';
import { slugify } from './slug';

export interface Org {
  id: string;
  name: string;
  slug: string;
  type: 'customer' | 'agency' | 'reseller';
  country: string;
  defaultLocale: 'ar' | 'en';
  status: 'active' | 'suspended';
  createdAt: string;
  updatedAt: string;
  version: number;
}

const COLS =
  'id, name, slug, type, country, default_locale, status, created_at, updated_at, version';
const toOrg = (r: Record<string, unknown>): Org => ({
  id: r.id as string,
  name: r.name as string,
  slug: r.slug as string,
  type: r.type as Org['type'],
  country: (r.country as string).trim(),
  defaultLocale: r.default_locale as Org['defaultLocale'],
  status: r.status as Org['status'],
  createdAt: (r.created_at as Date).toISOString(),
  updatedAt: (r.updated_at as Date).toISOString(),
  version: r.version as number,
});

export interface CreateOrg {
  name: string;
  type?: string;
  country?: string;
  defaultLocale?: string;
  slug?: string;
}

export class OrgService {
  constructor(private readonly db: Db) {}

  static validate(i: CreateOrg) {
    const name = typeof i.name === 'string' ? i.name.trim() : '';
    if (name.length < 1 || name.length > 200)
      throw new ProblemException('validation_failed', 'name must be 1..200 characters');
    const type = i.type ?? 'customer';
    if (!['customer', 'agency', 'reseller'].includes(type))
      throw new ProblemException('validation_failed', 'type must be customer, agency or reseller');
    const country = (i.country ?? 'SA').toUpperCase();
    if (!/^[A-Z]{2}$/.test(country))
      throw new ProblemException('validation_failed', 'country must be an ISO 3166-1 alpha-2 code');
    const defaultLocale = i.defaultLocale ?? 'ar';
    if (!['ar', 'en'].includes(defaultLocale))
      throw new ProblemException('validation_failed', 'defaultLocale must be ar or en');
    const slug = i.slug ?? slugify(name);
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug))
      throw new ProblemException(
        'validation_failed',
        'slug must be 2..63 chars of a-z, 0-9 and hyphen',
      );
    return { name, type, country, defaultLocale, slug };
  }

  /** Creates the org and its first owner atomically. The new id is established as the RLS context. */
  async create(userId: string, input: CreateOrg): Promise<Org> {
    const v = OrgService.validate(input);
    const id = uuidv7();
    try {
      return await this.db.withOrg(
        id,
        async (c) => {
          const { rows } = await c.query(
            `INSERT INTO tenancy.organizations (id, name, slug, type, country, default_locale, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${COLS}`,
            [id, v.name, v.slug, v.type, v.country, v.defaultLocale, userId],
          );
          await c.query(
            `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES ($1,$2,$3,'owner')`,
            [uuidv7(), id, userId],
          );
          await enqueue(c, id, 'org.created', { orgId: id, type: v.type });
          return toOrg(rows[0]);
        },
        { userId },
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException('conflict', 'organization slug is already taken');
      throw e;
    }
  }

  async listForUser(
    userId: string,
    q: { limit?: unknown; cursor?: unknown },
  ): Promise<Page<Org & { role: string }>> {
    const limit = parseLimit(q.limit);
    const cursor = decodeCursor(q.cursor);
    const rows = await this.db.withUser(
      userId,
      async (c) =>
        (
          await c.query(
            `SELECT o.${COLS.split(', ').join(', o.')}, m.role FROM tenancy.organizations o
           JOIN tenancy.memberships m ON m.org_id = o.id AND m.user_id = $1
          WHERE o.deleted_at IS NULL AND ($3::uuid IS NULL OR o.id < $3) ORDER BY o.id DESC LIMIT $2`,
            [userId, limit + 1, cursor],
          )
        ).rows,
    );
    return pageOf(
      rows.map((r) => ({ ...toOrg(r), role: r.role as string })),
      limit,
    );
  }

  async get(orgId: string): Promise<Org | null> {
    return this.db.withOrg(orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT ${COLS} FROM tenancy.organizations WHERE id = $1 AND deleted_at IS NULL`,
        [orgId],
      );
      return rows[0] ? toOrg(rows[0]) : null;
    });
  }

  /** Optimistic concurrency: `expectedVersion` comes from If-Match; stale → 412. */
  async update(
    orgId: string,
    expectedVersion: number,
    patch: { name?: string; defaultLocale?: string },
  ): Promise<Org> {
    if (
      patch.name !== undefined &&
      (typeof patch.name !== 'string' || patch.name.trim().length < 1 || patch.name.length > 200)
    )
      throw new ProblemException('validation_failed', 'name must be 1..200 characters');
    if (patch.defaultLocale !== undefined && !['ar', 'en'].includes(patch.defaultLocale))
      throw new ProblemException('validation_failed', 'defaultLocale must be ar or en');
    return this.db.withOrg(orgId, async (c) => {
      const { rows } = await c.query(
        `UPDATE tenancy.organizations SET name = COALESCE($3, name), default_locale = COALESCE($4, default_locale),
                updated_at = now(), version = version + 1
          WHERE id = $1 AND version = $2 AND deleted_at IS NULL RETURNING ${COLS}`,
        [orgId, expectedVersion, patch.name?.trim() ?? null, patch.defaultLocale ?? null],
      );
      if (!rows[0]) {
        const exists = (await c.query('SELECT 1 FROM tenancy.organizations WHERE id=$1', [orgId]))
          .rowCount;
        throw new ProblemException(exists ? 'precondition_failed' : 'not_found');
      }
      await enqueue(c, orgId, 'org.updated', { orgId });
      return toOrg(rows[0]);
    });
  }

  /** Used by the admin console later (S04): suspend/reinstate with a reason. */
  async setStatus(
    orgId: string,
    status: 'active' | 'suspended',
    reason: string | null,
    c?: PoolClient,
  ): Promise<void> {
    const run = async (cl: PoolClient) => {
      await cl.query(
        `UPDATE tenancy.organizations SET status=$2, suspended_reason=$3, updated_at=now(), version=version+1 WHERE id=$1`,
        [orgId, status, reason],
      );
      await enqueue(cl, orgId, status === 'suspended' ? 'org.suspended' : 'org.reinstated', {
        orgId,
      });
    };
    if (c) return run(c);
    return this.db.withOrg(orgId, run);
  }
}
