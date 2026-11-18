import type { AppMeta, AuditEntry, ListQuery, Row, Scope, Store, UserRow } from './types.ts';

function inScope(r: Row, s: Scope): boolean {
  if (s.ownerId === null && s.teamId === null) return true;
  return (s.ownerId !== null && r['ownerId'] === s.ownerId) || (s.teamId !== null && r['teamId'] === s.teamId);
}
function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/** In-memory persistence: tests and local development. Same contract as the PostgreSQL store. */
export class MemoryStore implements Store {
  private meta: AppMeta;
  private tables = new Map<string, Map<string, Row>>();
  private files = new Map<string, Uint8Array>();
  private audit: AuditEntry[] = [];
  private users = new Map<string, UserRow>();
  constructor(meta: AppMeta) {
    this.meta = meta;
  }
  private t(entity: string): Map<string, Row> {
    let m = this.tables.get(entity);
    if (!m) {
      m = new Map();
      this.tables.set(entity, m);
    }
    return m;
  }
  async insert(entity: string, row: Row): Promise<Row> {
    const em = this.meta.entities[entity];
    if (!em) throw new Error('unknown entity ' + entity);
    for (const f of em.fields) {
      if (f.unique && row[f.name] !== null && row[f.name] !== undefined) {
        for (const o of this.t(entity).values())
          if (o[f.name] === row[f.name]) throw Object.assign(new Error('unique'), { code: 'unique', field: f.name });
      }
      if (f.type === 'reference' && row[f.name] && !this.t(f.references as string).has(row[f.name] as string))
        throw Object.assign(new Error('reference'), { code: 'reference', field: f.name });
    }
    const copy = this.stripFiles(entity, row.id, { ...row }) as Row;
    this.t(entity).set(row.id, copy);
    return { ...copy };
  }
  /** File bytes live beside the row, never inside it (same as the bytea columns of the PostgreSQL store). */
  private stripFiles(entity: string, id: string, data: Record<string, unknown>): Record<string, unknown> {
    for (const f of this.meta.entities[entity]?.fields ?? []) {
      const v = data[f.name] as { name: string; mime: string; size: number; data?: Uint8Array } | null | undefined;
      if (f.type !== 'file' || !(f.name in data)) continue;
      if (v && v.data) this.files.set(entity + ':' + id + ':' + f.name, v.data);
      if (!v) this.files.delete(entity + ':' + id + ':' + f.name);
      data[f.name] = v ? { name: v.name, mime: v.mime, size: v.size } : null;
    }
    return data;
  }
  async get(entity: string, id: string): Promise<Row | null> {
    const r = this.t(entity).get(id);
    return r ? { ...r } : null;
  }
  async update(entity: string, id: string, patch: Record<string, unknown>, expectedVersion: number | null): Promise<Row | 'conflict' | null> {
    const cur = this.t(entity).get(id);
    if (!cur) return null;
    if (expectedVersion !== null && cur['version'] !== expectedVersion) return 'conflict';
    const em = this.meta.entities[entity];
    for (const f of em?.fields ?? []) {
      if (!(f.name in patch)) continue;
      if (f.unique && patch[f.name] !== null)
        for (const o of this.t(entity).values())
          if (o.id !== id && o[f.name] === patch[f.name]) throw Object.assign(new Error('unique'), { code: 'unique', field: f.name });
      if (f.type === 'reference' && patch[f.name] && !this.t(f.references as string).has(patch[f.name] as string))
        throw Object.assign(new Error('reference'), { code: 'reference', field: f.name });
    }
    Object.assign(cur, this.stripFiles(entity, id, { ...patch }), { version: (cur['version'] as number) + 1, updatedAt: new Date().toISOString() });
    return { ...cur };
  }
  async remove(entity: string, id: string): Promise<boolean> {
    // referential integrity: a row that is referenced cannot be deleted
    for (const em of Object.values(this.meta.entities))
      for (const f of em.fields)
        if (f.type === 'reference' && f.references === entity)
          for (const o of this.t(em.name).values())
            if (o[f.name] === id) {
              if (f.required) throw Object.assign(new Error('in_use'), { code: 'in_use' });
              o[f.name] = null;
            }
    for (const k of [...this.files.keys()]) if (k.startsWith(entity + ':' + id + ':')) this.files.delete(k);
    return this.t(entity).delete(id);
  }
  async list(entity: string, q: ListQuery): Promise<{ rows: Row[]; total: number }> {
    let rows = [...this.t(entity).values()].filter((r) => inScope(r, q.scope));
    for (const f of q.filters) {
      rows = rows.filter((r) => {
        const v = r[f.field];
        if (f.op === 'eq') return String(v) === f.value;
        if (f.op === 'contains') return String(v ?? '').toLowerCase().includes(f.value.toLowerCase());
        const n = Number(f.value);
        const cmpTo = Number.isFinite(n) && typeof v === 'number' ? n : f.value;
        return f.op === 'gte' ? cmp(v, cmpTo) >= 0 : cmp(v, cmpTo) <= 0;
      });
    }
    if (q.search) {
      const s = q.search.toLowerCase();
      rows = rows.filter((r) => q.searchFields.some((k) => String(r[k] ?? '').toLowerCase().includes(s)));
    }
    const total = rows.length;
    const sort = q.sort ?? { field: 'createdAt', dir: 'desc' as const };
    rows.sort((a, b) => (sort.dir === 'asc' ? 1 : -1) * cmp(a[sort.field], b[sort.field]) || cmp(a.id, b.id));
    return { rows: rows.slice(q.offset, q.offset + q.limit).map((r) => ({ ...r })), total };
  }
  async groupCount(entity: string, field: string, scope: Scope): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const r of this.t(entity).values()) if (inScope(r, scope)) out[String(r[field])] = (out[String(r[field])] ?? 0) + 1;
    return out;
  }
  async sum(entity: string, field: string, scope: Scope): Promise<number> {
    let n = 0;
    for (const r of this.t(entity).values()) if (inScope(r, scope) && typeof r[field] === 'number') n += r[field] as number;
    return n;
  }
  async fileData(entity: string, id: string, field: string): Promise<Uint8Array | null> {
    return this.files.get(entity + ':' + id + ':' + field) ?? null;
  }
  async appendAudit(e: AuditEntry): Promise<void> {
    this.audit.push(e);
  }
  async listAudit(entity: string, recordId: string): Promise<AuditEntry[]> {
    return this.audit.filter((a) => a.entity === entity && a.recordId === recordId).sort((a, b) => a.at.localeCompare(b.at));
  }
  async findUserByEmail(email: string): Promise<UserRow | null> {
    for (const u of this.users.values()) if (u.email === email.toLowerCase()) return { ...u };
    return null;
  }
  async getUser(id: string): Promise<UserRow | null> {
    const u = this.users.get(id);
    return u ? { ...u } : null;
  }
  async insertUser(u: UserRow): Promise<UserRow> {
    if (await this.findUserByEmail(u.email)) throw Object.assign(new Error('unique'), { code: 'unique', field: 'email' });
    this.users.set(u.id, { ...u });
    return { ...u };
  }
  async listUsers(): Promise<UserRow[]> {
    return [...this.users.values()].map((u) => ({ ...u }));
  }
}
