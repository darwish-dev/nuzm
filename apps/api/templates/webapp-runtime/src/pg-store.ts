import pg from 'pg';
import type {
  AppMeta,
  AuditEntry,
  EntityMeta,
  FieldMeta,
  ListQuery,
  Row,
  Scope,
  Store,
  UserRow,
} from './types.ts';

const q = (id: string): string => '"' + id.replace(/"/g, '""') + '"';
const camel = (s: string): string => s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/** pg parsers: bigint and numeric as numbers, date as the plain string, so rows have the same shape as in the memory store. */
const types = {
  getTypeParser(oid: number, format?: string) {
    if (oid === 20) return (v: string) => Number(v);
    if (oid === 1700) return (v: string) => Number(v);
    if (oid === 1082) return (v: string) => v;
    return pg.types.getTypeParser(oid, format as 'text');
  },
};

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10, types });
}

function scopeSql(scope: Scope, params: unknown[]): string {
  if (scope.ownerId === null && scope.teamId === null) return 'TRUE';
  const parts: string[] = [];
  if (scope.ownerId !== null) {
    params.push(scope.ownerId);
    parts.push('"owner_id" = $' + params.length);
  }
  if (scope.teamId !== null) {
    params.push(scope.teamId);
    parts.push('"team_id" = $' + params.length);
  }
  return '(' + parts.join(' OR ') + ')';
}

export class PgStore implements Store {
  private pool: pg.Pool;
  private meta: AppMeta;
  constructor(pool: pg.Pool, meta: AppMeta) {
    this.pool = pool;
    this.meta = meta;
  }
  private em(entity: string): EntityMeta {
    const e = this.meta.entities[entity];
    if (!e) throw new Error('unknown entity ' + entity);
    return e;
  }
  /** Columns a field occupies: a file field spans name/mime/size/data. */
  private columns(f: FieldMeta): string[] {
    return f.type === 'file'
      ? [f.column + '_name', f.column + '_mime', f.column + '_size', f.column + '_data']
      : [f.column];
  }
  private fromDb(em: EntityMeta, r: Record<string, unknown>): Row {
    const out: Record<string, unknown> = {
      id: r['id'],
      ownerId: r['owner_id'] ?? null,
      teamId: r['team_id'] ?? null,
      createdAt: r['created_at'] instanceof Date ? r['created_at'].toISOString() : r['created_at'],
      updatedAt: r['updated_at'] instanceof Date ? r['updated_at'].toISOString() : r['updated_at'],
      createdBy: r['created_by'] ?? null,
      updatedBy: r['updated_by'] ?? null,
      version: r['version'],
    };
    for (const f of em.fields) {
      if (f.type === 'file') {
        const name = r[f.column + '_name'];
        out[f.name] = name
          ? { name, mime: r[f.column + '_mime'], size: r[f.column + '_size'] }
          : null;
      } else {
        const v = r[f.column];
        out[f.name] = v instanceof Date ? v.toISOString() : (v ?? null);
      }
    }
    return out as Row;
  }
  private selectList(em: EntityMeta): string {
    const cols = [
      'id',
      'owner_id',
      'team_id',
      'created_at',
      'updated_at',
      'created_by',
      'updated_by',
      'version',
    ];
    for (const f of em.fields)
      for (const c of this.columns(f)) if (!c.endsWith('_data')) cols.push(c);
    return cols.map(q).join(', ');
  }
  private toDb(em: EntityMeta, row: Record<string, unknown>): { cols: string[]; vals: unknown[] } {
    const cols: string[] = [];
    const vals: unknown[] = [];
    const meta: [string, string][] = [
      ['ownerId', 'owner_id'],
      ['teamId', 'team_id'],
      ['createdBy', 'created_by'],
      ['updatedBy', 'updated_by'],
    ];
    for (const [k, c] of meta)
      if (k in row) {
        cols.push(c);
        vals.push(row[k]);
      }
    for (const f of em.fields) {
      if (!(f.name in row)) continue;
      const v = row[f.name];
      if (f.type === 'file') {
        const x = v as { name: string; mime: string; size: number; data?: Uint8Array } | null;
        cols.push(f.column + '_name', f.column + '_mime', f.column + '_size', f.column + '_data');
        vals.push(
          x?.name ?? null,
          x?.mime ?? null,
          x?.size ?? null,
          x?.data ? Buffer.from(x.data) : null,
        );
      } else {
        cols.push(f.column);
        vals.push(v);
      }
    }
    return { cols, vals };
  }
  private mapError(e: unknown, em: EntityMeta): never {
    const err = e as { code?: string; constraint?: string; detail?: string };
    const col = (suffix: string): string | undefined => {
      const c = err.constraint ?? '';
      const middle =
        c.startsWith(em.table + '_') && c.endsWith(suffix)
          ? c.slice(em.table.length + 1, -suffix.length)
          : '';
      return em.fields.find((f) => f.column === middle)?.name;
    };
    if (err.code === '23505')
      throw Object.assign(new Error('unique'), { code: 'unique', field: col('_key') ?? 'email' });
    if (err.code === '23503')
      throw Object.assign(new Error('reference'), {
        code: err.detail?.includes('is still referenced') ? 'in_use' : 'reference',
        field: col('_fkey'),
      });
    throw e;
  }
  async insert(entity: string, row: Row): Promise<Row> {
    const em = this.em(entity);
    const { cols, vals } = this.toDb(em, row);
    cols.unshift('id');
    vals.unshift(row.id);
    try {
      const r = await this.pool.query(
        'INSERT INTO ' +
          q(em.table) +
          ' (' +
          cols.map(q).join(', ') +
          ') VALUES (' +
          cols.map((_c, i) => '$' + (i + 1)).join(', ') +
          ') RETURNING ' +
          this.selectList(em),
        vals,
      );
      return this.fromDb(em, r.rows[0] as Record<string, unknown>);
    } catch (e) {
      return this.mapError(e, em);
    }
  }
  async get(entity: string, id: string): Promise<Row | null> {
    const em = this.em(entity);
    const r = await this.pool.query(
      'SELECT ' + this.selectList(em) + ' FROM ' + q(em.table) + ' WHERE "id" = $1',
      [id],
    );
    return r.rows[0] ? this.fromDb(em, r.rows[0] as Record<string, unknown>) : null;
  }
  async update(
    entity: string,
    id: string,
    patch: Record<string, unknown>,
    expectedVersion: number | null,
  ): Promise<Row | 'conflict' | null> {
    const em = this.em(entity);
    const { cols, vals } = this.toDb(em, patch);
    const sets = cols.map((c, i) => q(c) + ' = $' + (i + 1));
    sets.push('"version" = "version" + 1', '"updated_at" = now()');
    vals.push(id);
    let sql = 'UPDATE ' + q(em.table) + ' SET ' + sets.join(', ') + ' WHERE "id" = $' + vals.length;
    if (expectedVersion !== null) {
      vals.push(expectedVersion);
      sql += ' AND "version" = $' + vals.length;
    }
    try {
      const r = await this.pool.query(sql + ' RETURNING ' + this.selectList(em), vals);
      if (r.rows[0]) return this.fromDb(em, r.rows[0] as Record<string, unknown>);
    } catch (e) {
      return this.mapError(e, em);
    }
    return (await this.get(entity, id)) ? 'conflict' : null;
  }
  async remove(entity: string, id: string): Promise<boolean> {
    const em = this.em(entity);
    try {
      const r = await this.pool.query('DELETE FROM ' + q(em.table) + ' WHERE "id" = $1', [id]);
      return (r.rowCount ?? 0) > 0;
    } catch (e) {
      return this.mapError(e, em);
    }
  }
  async list(entity: string, qy: ListQuery): Promise<{ rows: Row[]; total: number }> {
    const em = this.em(entity);
    const params: unknown[] = [];
    const where: string[] = [scopeSql(qy.scope, params)];
    const col = (name: string): FieldMeta => {
      const f = em.fields.find((x) => x.name === name);
      if (!f) throw new Error('unknown field ' + name);
      return f;
    };
    for (const f of qy.filters) {
      const fm = col(f.field);
      params.push(f.op === 'contains' ? '%' + f.value.replace(/[%_\\]/g, '\\$&') + '%' : f.value);
      const ph = '$' + params.length;
      if (f.op === 'eq') where.push(q(fm.column) + '::text = ' + ph);
      else if (f.op === 'contains') where.push(q(fm.column) + '::text ILIKE ' + ph);
      else
        where.push(
          q(fm.column) +
            (f.op === 'gte' ? ' >= ' : ' <= ') +
            ph +
            '::' +
            (fm.type === 'date' ? 'date' : fm.type === 'datetime' ? 'timestamptz' : 'numeric'),
        );
    }
    if (qy.search && qy.searchFields.length) {
      params.push('%' + qy.search.replace(/[%_\\]/g, '\\$&') + '%');
      where.push(
        '(' +
          qy.searchFields
            .map((n) => q(col(n).column) + '::text ILIKE $' + params.length)
            .join(' OR ') +
          ')',
      );
    }
    const sortCol = qy.sort
      ? ['createdAt', 'updatedAt'].includes(qy.sort.field)
        ? qy.sort.field === 'createdAt'
          ? 'created_at'
          : 'updated_at'
        : col(qy.sort.field).column
      : 'created_at';
    const dir = qy.sort ? (qy.sort.dir === 'asc' ? 'ASC' : 'DESC') : 'DESC';
    const total = await this.pool.query(
      'SELECT count(*)::int AS n FROM ' + q(em.table) + ' WHERE ' + where.join(' AND '),
      params,
    );
    params.push(qy.limit, qy.offset);
    const r = await this.pool.query(
      'SELECT ' +
        this.selectList(em) +
        ' FROM ' +
        q(em.table) +
        ' WHERE ' +
        where.join(' AND ') +
        ' ORDER BY ' +
        q(sortCol) +
        ' ' +
        dir +
        ' NULLS LAST, "id" LIMIT $' +
        (params.length - 1) +
        ' OFFSET $' +
        params.length,
      params,
    );
    return {
      rows: r.rows.map((x) => this.fromDb(em, x as Record<string, unknown>)),
      total: (total.rows[0] as { n: number }).n,
    };
  }
  async groupCount(entity: string, field: string, scope: Scope): Promise<Record<string, number>> {
    const em = this.em(entity);
    const f = em.fields.find((x) => x.name === field);
    if (!f) throw new Error('unknown field ' + field);
    const params: unknown[] = [];
    const r = await this.pool.query(
      'SELECT ' +
        q(f.column) +
        '::text AS k, count(*)::int AS n FROM ' +
        q(em.table) +
        ' WHERE ' +
        scopeSql(scope, params) +
        ' GROUP BY 1',
      params,
    );
    const out: Record<string, number> = {};
    for (const x of r.rows as { k: string | null; n: number }[]) out[String(x.k)] = x.n;
    return out;
  }
  async sum(entity: string, field: string, scope: Scope): Promise<number> {
    const em = this.em(entity);
    const f = em.fields.find((x) => x.name === field);
    if (!f) throw new Error('unknown field ' + field);
    const params: unknown[] = [];
    const r = await this.pool.query(
      'SELECT coalesce(sum(' +
        q(f.column) +
        '), 0)::float8 AS s FROM ' +
        q(em.table) +
        ' WHERE ' +
        scopeSql(scope, params),
      params,
    );
    return Number((r.rows[0] as { s: number }).s);
  }
  async fileData(entity: string, id: string, field: string): Promise<Uint8Array | null> {
    const em = this.em(entity);
    const f = em.fields.find((x) => x.name === field && x.type === 'file');
    if (!f) return null;
    const r = await this.pool.query(
      'SELECT ' + q(f.column + '_data') + ' AS d FROM ' + q(em.table) + ' WHERE "id" = $1',
      [id],
    );
    const d = (r.rows[0] as { d: Buffer | null } | undefined)?.d;
    return d ? new Uint8Array(d) : null;
  }
  async appendAudit(e: AuditEntry): Promise<void> {
    await this.pool.query(
      'INSERT INTO "audit_log" ("id","entity","record_id","action","actor_id","diff","at") VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [e.id, e.entity, e.recordId, e.action, e.actorId, JSON.stringify(e.diff), e.at],
    );
  }
  async listAudit(entity: string, recordId: string): Promise<AuditEntry[]> {
    const r = await this.pool.query(
      'SELECT "id","entity","record_id","action","actor_id","diff","at" FROM "audit_log" WHERE "entity" = $1 AND "record_id" = $2 ORDER BY "at"',
      [entity, recordId],
    );
    return r.rows.map((x) => {
      const o = x as {
        id: string;
        entity: string;
        record_id: string;
        action: AuditEntry['action'];
        actor_id: string | null;
        diff: Record<string, unknown>;
        at: Date;
      };
      return {
        id: o.id,
        entity: o.entity,
        recordId: o.record_id,
        action: o.action,
        actorId: o.actor_id,
        diff: o.diff,
        at: o.at.toISOString(),
      };
    });
  }
  private userFromDb(r: Record<string, unknown>): UserRow {
    return {
      id: r['id'] as string,
      email: r['email'] as string,
      name: r['name'] as string,
      role: r['role'] as string,
      teamId: (r['team_id'] as string | null) ?? null,
      locale: r['locale'] as 'ar' | 'en',
      passwordHash: r['password_hash'] as string,
      active: r['active'] as boolean,
      createdAt: (r['created_at'] as Date).toISOString(),
    };
  }
  async findUserByEmail(email: string): Promise<UserRow | null> {
    const r = await this.pool.query('SELECT * FROM "app_users" WHERE "email" = $1', [
      email.toLowerCase(),
    ]);
    return r.rows[0] ? this.userFromDb(r.rows[0] as Record<string, unknown>) : null;
  }
  async getUser(id: string): Promise<UserRow | null> {
    const r = await this.pool.query('SELECT * FROM "app_users" WHERE "id" = $1', [id]);
    return r.rows[0] ? this.userFromDb(r.rows[0] as Record<string, unknown>) : null;
  }
  async insertUser(u: UserRow): Promise<UserRow> {
    try {
      const r = await this.pool.query(
        'INSERT INTO "app_users" ("id","email","name","role","team_id","locale","password_hash","active") VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [u.id, u.email.toLowerCase(), u.name, u.role, u.teamId, u.locale, u.passwordHash, u.active],
      );
      return this.userFromDb(r.rows[0] as Record<string, unknown>);
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw Object.assign(new Error('unique'), { code: 'unique', field: 'email' });
      throw e;
    }
  }
  async listUsers(): Promise<UserRow[]> {
    const r = await this.pool.query('SELECT * FROM "app_users" ORDER BY "created_at"');
    return r.rows.map((x) => this.userFromDb(x as Record<string, unknown>));
  }
}
