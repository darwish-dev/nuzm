import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { isUuid, type Row } from './model';

const TYPES = ['text', 'number', 'boolean', 'date', 'localized_text'];
interface Field {
  name: string;
  type: string;
  required?: boolean;
}
function validateItem(fields: Field[], data: unknown, i: number): Record<string, unknown> {
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    throw new ProblemException('validation_failed', `items[${i}].data must be an object`);
  const d = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(d))
    if (!fields.some((f) => f.name === k))
      throw new ProblemException('validation_failed', `items[${i}].data.${k} is not a field`);
  for (const f of fields) {
    const v = d[f.name];
    if (v === undefined || v === null) {
      if (f.required)
        throw new ProblemException('validation_failed', `items[${i}].data.${f.name} is required`);
      continue;
    }
    const ok =
      (f.type === 'text' && typeof v === 'string' && v.length <= 4000) ||
      (f.type === 'number' && typeof v === 'number' && Number.isFinite(v)) ||
      (f.type === 'boolean' && typeof v === 'boolean') ||
      (f.type === 'date' && typeof v === 'string' && !Number.isNaN(Date.parse(v))) ||
      (f.type === 'localized_text' &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        Object.entries(v as object).every(
          ([l, s]) => (l === 'ar' || l === 'en') && typeof s === 'string' && s.length <= 4000,
        ));
    if (!ok)
      throw new ProblemException(
        'validation_failed',
        `items[${i}].data.${f.name} must be of type ${f.type}`,
      );
    out[f.name] = v;
  }
  return out;
}

/** CMS basics (M09 S41.3): typed collections of items with a publish state; only PUBLISHED items are consumed by the build (`bindCollections`). */
export class CmsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}
  async list(orgId: string, projectId: string) {
    if (!isUuid(projectId)) throw new ProblemException('not_found');
    return this.db.withOrg(orgId, async (c) => {
      if (
        !(
          await c.query(`SELECT 1 FROM builder.projects WHERE id=$1 AND deleted_at IS NULL`, [
            projectId,
          ])
        ).rows[0]
      )
        throw new ProblemException('not_found');
      const cols = (
        await c.query(
          `SELECT * FROM builder.cms_collections WHERE project_id=$1 ORDER BY collection_key`,
          [projectId],
        )
      ).rows as Row[];
      const items: { items: Row[] } = { items: [] };
      for (const col of cols) {
        const rows = (
          await c.query(
            `SELECT * FROM builder.cms_items WHERE collection_id=$1 ORDER BY created_at, id`,
            [col.id],
          )
        ).rows as Row[];
        items.items.push({
          id: col.id,
          collectionKey: col.collection_key,
          name: col.name,
          fields: col.fields,
          items: rows.map((r) => ({
            id: r.id,
            data: r.data,
            state: r.state,
            version: r.version,
            updatedAt: new Date(r.updated_at as string).toISOString(),
          })),
        });
      }
      return items;
    });
  }
  /** Create a collection (name + fields) and/or add items to it. Body {collectionKey, name?, fields?, items?: [{data, state?: draft|published}]}. */
  async upsert(orgId: string, userId: string, projectId: string, b: Record<string, unknown>) {
    if (!isUuid(projectId)) throw new ProblemException('not_found');
    const key = b.collectionKey;
    if (typeof key !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(key))
      throw new ProblemException('validation_failed', 'collectionKey must be a lower-case slug');
    const itemsIn = b.items === undefined ? [] : b.items;
    if (!Array.isArray(itemsIn) || itemsIn.length > 200)
      throw new ProblemException('validation_failed', 'items must be a list of at most 200');
    const out = await this.db.withOrg(orgId, async (c) => {
      if (
        !(
          await c.query(`SELECT 1 FROM builder.projects WHERE id=$1 AND deleted_at IS NULL`, [
            projectId,
          ])
        ).rows[0]
      )
        throw new ProblemException('not_found');
      let col = (
        await c.query(
          `SELECT * FROM builder.cms_collections WHERE project_id=$1 AND collection_key=$2 FOR UPDATE`,
          [projectId, key],
        )
      ).rows[0] as Row | undefined;
      if (!col) {
        const fields = b.fields;
        const name =
          typeof b.name === 'string' && b.name.length >= 1 && b.name.length <= 80 ? b.name : null;
        if (
          !name ||
          !Array.isArray(fields) ||
          fields.length < 1 ||
          fields.length > 20 ||
          fields.some(
            (f: Field) =>
              typeof f?.name !== 'string' ||
              !/^[a-z][a-z0-9_]{0,29}$/.test(f.name) ||
              !TYPES.includes(f.type),
          )
        )
          throw new ProblemException(
            'validation_failed',
            `a new collection needs name and fields (1..20 of {name, type: ${TYPES.join('|')}})`,
          );
        col = (
          await c.query(
            `INSERT INTO builder.cms_collections (id, org_id, project_id, collection_key, name, fields, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [uuidv7(), orgId, projectId, key, name, JSON.stringify(fields), userId],
          )
        ).rows[0] as Row;
      } else if (b.fields !== undefined)
        throw new ProblemException(
          'validation_failed',
          'the schema of an existing collection cannot be changed here',
        );
      const fields = col.fields as Field[];
      const created: string[] = [];
      for (const [i, it] of (itemsIn as { data: unknown; state?: string }[]).entries()) {
        const state =
          it.state === 'published'
            ? 'published'
            : it.state === undefined || it.state === 'draft'
              ? 'draft'
              : null;
        if (!state)
          throw new ProblemException(
            'validation_failed',
            `items[${i}].state must be draft or published`,
          );
        const data = validateItem(fields, it.data, i);
        const id = uuidv7();
        await c.query(
          `INSERT INTO builder.cms_items (id, org_id, collection_id, data, state, published_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            orgId,
            col!.id,
            JSON.stringify(data),
            state,
            state === 'published' ? new Date() : null,
            userId,
          ],
        );
        created.push(id);
      }
      return { collectionId: col.id as string, created };
    });
    await this.audit.record({
      action: 'builder.cms.changed',
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'builder_cms_collection', id: out.collectionId },
      outcome: 'success',
      detail: { added: out.created.length },
    });
    return this.list(orgId, projectId);
  }
  /** Published items per collection key: what the build consumes. */
  async published(
    orgId: string,
    projectId: string,
  ): Promise<{ key: string; items: { data: Record<string, unknown> }[] }[]> {
    return this.db.withOrg(orgId, async (c) => {
      const cols = (
        await c.query(
          `SELECT id, collection_key FROM builder.cms_collections WHERE project_id=$1`,
          [projectId],
        )
      ).rows as Row[];
      const out: { key: string; items: { data: Record<string, unknown> }[] }[] = [];
      for (const col of cols)
        out.push({
          key: col.collection_key as string,
          items: (
            (
              await c.query(
                `SELECT data FROM builder.cms_items WHERE collection_id=$1 AND state='published' ORDER BY created_at, id`,
                [col.id],
              )
            ).rows as Row[]
          ).map((r) => ({ data: r.data as Record<string, unknown> })),
        });
      return out;
    });
  }
}
