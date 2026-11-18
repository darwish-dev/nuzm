// Runtime types of the generated application (static file of the Nuzm app-builder scaffold).
export type FieldType =
  | 'string'
  | 'text'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'enum'
  | 'reference'
  | 'email'
  | 'phone'
  | 'url'
  | 'file';

export interface FieldMeta {
  name: string;
  column: string;
  type: FieldType;
  required: boolean;
  unique: boolean;
  maxLength: number | null;
  min: number | null;
  max: number | null;
  enumValues: string[] | null;
  references: string | null;
  pii: boolean;
  labels: { ar: string; en: string };
}
export interface EntityMeta {
  name: string;
  plural: string;
  table: string;
  labels: { ar: string; en: string };
  ownership: 'owner' | 'team' | 'org';
  audit: boolean;
  searchable: string[];
  sortable: string[];
  stageField: string | null;
  fields: FieldMeta[];
}
export interface RoleMeta {
  name: string;
  labels: { ar: string; en: string };
  scope: 'own' | 'team' | 'all';
  admin: boolean;
  permissions: Record<string, string[]>;
}
export interface WidgetMeta {
  id: string;
  kind: 'count' | 'sum' | 'by_stage' | 'recent';
  entity: string;
  field: string | null;
  title: { ar: string; en: string };
}
export interface PageMeta {
  path: string;
  kind: string;
  title: { ar: string; en: string };
  entity: string | null;
  roles: string[] | null;
  widgets: WidgetMeta[];
}
export interface AppMeta {
  slug: string;
  name: string;
  locales: string[];
  defaultLocale: string;
  basePath: string;
  defaultLimit: number;
  maxLimit: number;
  attachmentMaxBytes: number;
  csvImportExport: boolean;
  notifications: { event: string; channel: string; template: string }[];
  entities: Record<string, EntityMeta>;
  roles: Record<string, RoleMeta>;
  pages: PageMeta[];
}

export type Row = Record<string, unknown> & { id: string };
export interface Scope {
  ownerId: string | null;
  teamId: string | null;
}
export interface Filter {
  field: string;
  op: 'eq' | 'contains' | 'gte' | 'lte';
  value: string;
}
export interface ListQuery {
  filters: Filter[];
  search: string | null;
  searchFields: string[];
  sort: { field: string; dir: 'asc' | 'desc' } | null;
  limit: number;
  offset: number;
  scope: Scope;
}
export interface AuditEntry {
  id: string;
  entity: string;
  recordId: string;
  action: 'create' | 'update' | 'delete' | 'import';
  actorId: string | null;
  diff: Record<string, unknown>;
  at: string;
}
export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  teamId: string | null;
  locale: 'ar' | 'en';
  passwordHash: string;
  active: boolean;
  createdAt: string;
}
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
  teamId: string | null;
  locale: 'ar' | 'en';
}

/** Persistence port: an in-memory implementation (tests, development) and a PostgreSQL implementation. */
export interface Store {
  insert(entity: string, row: Row): Promise<Row>;
  get(entity: string, id: string): Promise<Row | null>;
  update(
    entity: string,
    id: string,
    patch: Record<string, unknown>,
    expectedVersion: number | null,
  ): Promise<Row | 'conflict' | null>;
  remove(entity: string, id: string): Promise<boolean>;
  list(entity: string, q: ListQuery): Promise<{ rows: Row[]; total: number }>;
  groupCount(entity: string, field: string, scope: Scope): Promise<Record<string, number>>;
  sum(entity: string, field: string, scope: Scope): Promise<number>;
  fileData(entity: string, id: string, field: string): Promise<Uint8Array | null>;
  appendAudit(e: AuditEntry): Promise<void>;
  listAudit(entity: string, recordId: string): Promise<AuditEntry[]>;
  findUserByEmail(email: string): Promise<UserRow | null>;
  getUser(id: string): Promise<UserRow | null>;
  insertUser(u: UserRow): Promise<UserRow>;
  listUsers(): Promise<UserRow[]>;
}

export interface Notifier {
  send(msg: { to: string; template: string; data: Record<string, unknown> }): Promise<void>;
}
