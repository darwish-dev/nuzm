import { validate, type Schema } from '../schema';

/**
 * The versioned structured application spec (`builder.app_specs.spec`, M10 §4 S42.5): entities, roles, pages, API, non-functional requirements.
 * It is the single input of every scaffolder (database, backend, frontend, QA, DevOps): model output is a STRUCTURED spec validated here, and trusted
 * deterministic scaffolders render code from it. Free-form model-authored code only enters through the checked changes pipeline (S46).
 */
export const FIELD_TYPES = [
  'string',
  'text',
  'integer',
  'decimal',
  'boolean',
  'date',
  'datetime',
  'enum',
  'reference',
  'email',
  'phone',
  'url',
  'file',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const CRUD = ['create', 'read', 'update', 'delete', 'import', 'export'] as const;
export type CrudAction = (typeof CRUD)[number];
export type DataScope = 'own' | 'team' | 'all';
export type OwnershipRule = 'owner' | 'team' | 'org';

export interface Bilingual {
  ar: string;
  en: string;
}
export interface FieldSpec {
  name: string;
  type: FieldType;
  labels: Bilingual;
  required?: boolean;
  unique?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  enumValues?: string[];
  /** Entity name for `reference` fields. */
  references?: string;
  /** Marks personal data: classified and masked in logs; generated-app test data stays synthetic. */
  pii?: boolean;
}
export interface EntitySpec {
  name: string;
  plural: string;
  labels: Bilingual;
  fields: FieldSpec[];
  /** Row-level ownership: `owner` = a user owns a row (reps see their own), `team` = rows of the owner's team, `org` = everyone with the role. */
  ownership: OwnershipRule;
  audit: boolean;
  searchable: string[];
  sortable: string[];
  /** For a pipeline board: the enum field whose values are the stages. */
  stageField?: string;
}
export interface RoleSpec {
  name: string;
  labels: Bilingual;
  /** Per entity name -> allowed actions. */
  permissions: Record<string, CrudAction[]>;
  scope: DataScope;
  admin?: boolean;
}
export interface PageSpec {
  path: string;
  kind: 'list' | 'detail' | 'form' | 'board' | 'dashboard' | 'custom';
  title: Bilingual;
  entity?: string;
  roles?: string[];
  widgets?: {
    id: string;
    kind: 'count' | 'sum' | 'by_stage' | 'recent';
    entity: string;
    field?: string;
    title: Bilingual;
  }[];
}
export interface AppSpec {
  name: string;
  slug: string;
  description: string;
  locales: ('ar' | 'en')[];
  defaultLocale: 'ar' | 'en';
  entities: EntitySpec[];
  roles: RoleSpec[];
  pages: PageSpec[];
  api: { basePath: string; defaultLimit: number; maxLimit: number };
  nonFunctional: {
    rtl: boolean;
    accessibility: 'WCAG2.1-AA';
    dataRegion: string;
    csvImportExport: boolean;
    attachmentMaxBytes: number;
    notifications: { event: string; channel: 'email'; template: string }[];
  };
}

const bilingual: Schema = {
  type: 'object',
  required: ['ar', 'en'],
  additionalProperties: false,
  properties: {
    ar: { type: 'string', minLength: 1, maxLength: 120 },
    en: { type: 'string', minLength: 1, maxLength: 120 },
  },
};
const IDENT = '^[A-Za-z][A-Za-z0-9]{0,39}$';
const FIELD_IDENT = '^[a-z][a-zA-Z0-9]{0,39}$';

export const APP_SPEC_SCHEMA: Schema = {
  type: 'object',
  required: [
    'name',
    'slug',
    'description',
    'locales',
    'defaultLocale',
    'entities',
    'roles',
    'pages',
    'api',
    'nonFunctional',
  ],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    slug: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,40}$' },
    description: { type: 'string', maxLength: 2000 },
    locales: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
      items: { enum: ['ar', 'en'] },
    },
    defaultLocale: { enum: ['ar', 'en'] },
    entities: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: {
        type: 'object',
        required: [
          'name',
          'plural',
          'labels',
          'fields',
          'ownership',
          'audit',
          'searchable',
          'sortable',
        ],
        additionalProperties: false,
        properties: {
          name: { type: 'string', pattern: IDENT },
          plural: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,39}$' },
          labels: bilingual,
          ownership: { enum: ['owner', 'team', 'org'] },
          audit: { type: 'boolean' },
          searchable: { type: 'array', maxItems: 20, items: { type: 'string' } },
          sortable: { type: 'array', maxItems: 20, items: { type: 'string' } },
          stageField: { type: 'string' },
          fields: {
            type: 'array',
            minItems: 1,
            maxItems: 60,
            items: {
              type: 'object',
              required: ['name', 'type', 'labels'],
              additionalProperties: false,
              properties: {
                name: { type: 'string', pattern: FIELD_IDENT },
                type: { enum: FIELD_TYPES },
                labels: bilingual,
                required: { type: 'boolean' },
                unique: { type: 'boolean' },
                maxLength: { type: 'integer', minimum: 1, maximum: 100000 },
                min: { type: 'number' },
                max: { type: 'number' },
                enumValues: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 40,
                  uniqueItems: true,
                  items: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_ -]{0,39}$' },
                },
                references: { type: 'string', pattern: IDENT },
                pii: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
    roles: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        required: ['name', 'labels', 'permissions', 'scope'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,30}$' },
          labels: bilingual,
          scope: { enum: ['own', 'team', 'all'] },
          admin: { type: 'boolean' },
          permissions: {
            type: 'object',
            additionalProperties: { type: 'array', items: { enum: CRUD } },
          },
        },
      },
    },
    pages: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        required: ['path', 'kind', 'title'],
        additionalProperties: false,
        properties: {
          path: { type: 'string', pattern: '^/[a-z0-9/_-]{0,80}$' },
          kind: { enum: ['list', 'detail', 'form', 'board', 'dashboard', 'custom'] },
          title: bilingual,
          entity: { type: 'string' },
          roles: { type: 'array', items: { type: 'string' } },
          widgets: {
            type: 'array',
            maxItems: 12,
            items: {
              type: 'object',
              required: ['id', 'kind', 'entity', 'title'],
              additionalProperties: false,
              properties: {
                id: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,30}$' },
                kind: { enum: ['count', 'sum', 'by_stage', 'recent'] },
                entity: { type: 'string' },
                field: { type: 'string' },
                title: bilingual,
              },
            },
          },
        },
      },
    },
    api: {
      type: 'object',
      required: ['basePath', 'defaultLimit', 'maxLimit'],
      additionalProperties: false,
      properties: {
        basePath: { type: 'string', pattern: '^/[a-z0-9/_-]{0,40}$' },
        defaultLimit: { type: 'integer', minimum: 1, maximum: 500 },
        maxLimit: { type: 'integer', minimum: 1, maximum: 1000 },
      },
    },
    nonFunctional: {
      type: 'object',
      required: [
        'rtl',
        'accessibility',
        'dataRegion',
        'csvImportExport',
        'attachmentMaxBytes',
        'notifications',
      ],
      additionalProperties: false,
      properties: {
        rtl: { type: 'boolean' },
        accessibility: { enum: ['WCAG2.1-AA'] },
        dataRegion: { type: 'string', pattern: '^[A-Za-z0-9._-]{2,40}$' },
        csvImportExport: { type: 'boolean' },
        attachmentMaxBytes: { type: 'integer', minimum: 0, maximum: 104857600 },
        notifications: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            required: ['event', 'channel', 'template'],
            additionalProperties: false,
            properties: {
              event: { type: 'string', maxLength: 60 },
              channel: { enum: ['email'] },
              template: { type: 'string', maxLength: 60 },
            },
          },
        },
      },
    },
  },
};

/** SQL reserved words (and generator-internal names) that may not be used as an entity/plural/column identifier. */
const RESERVED = new Set([
  'select',
  'insert',
  'update',
  'delete',
  'drop',
  'table',
  'user',
  'users',
  'order',
  'group',
  'where',
  'from',
  'index',
  'primary',
  'foreign',
  'key',
  'check',
  'constraint',
  'default',
  'grant',
  'revoke',
  'union',
  'all',
  'and',
  'or',
  'not',
  'null',
  'true',
  'false',
  'create',
  'alter',
  'column',
  'to',
  'as',
  'on',
  'in',
  'is',
  'like',
  'limit',
  'offset',
  'join',
  'left',
  'right',
  'inner',
  'outer',
  'having',
  'distinct',
  'case',
  'when',
  'then',
  'else',
  'end',
  'schema',
  'view',
  'trigger',
  'sequence',
  'transaction',
  'commit',
  'rollback',
  'audit_log',
  'schema_migrations',
]);
/** Columns the scaffolder owns: a spec field cannot reuse them. */
export const SYSTEM_COLUMNS = [
  'id',
  'org_id',
  'owner_id',
  'team_id',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'version',
] as const;

export interface SpecIssue {
  path: string;
  message: string;
}
export interface SpecCheck {
  ok: boolean;
  issues: SpecIssue[];
}

/** Structural validation (schema) plus every cross-reference rule. A spec that passes is safe to feed to all scaffolders. */
export function validateAppSpec(spec: unknown): SpecCheck {
  const issues: SpecIssue[] = validate(APP_SPEC_SCHEMA, spec).map((m) => {
    const i = m.indexOf(':');
    return { path: m.slice(0, i), message: m.slice(i + 2) };
  });
  if (issues.length) return { ok: false, issues };
  const s = spec as AppSpec;
  const add = (path: string, message: string) => issues.push({ path, message });
  if (!s.locales.includes(s.defaultLocale)) add('$.defaultLocale', 'must be one of locales');
  if (s.api.defaultLimit > s.api.maxLimit) add('$.api.defaultLimit', 'must not exceed maxLimit');
  const entityNames = new Set<string>();
  const plurals = new Set<string>();
  for (const [ei, e] of s.entities.entries()) {
    const p = `$.entities[${ei}]`;
    if (entityNames.has(e.name)) add(`${p}.name`, `duplicate entity ${e.name}`);
    entityNames.add(e.name);
    if (plurals.has(e.plural)) add(`${p}.plural`, `duplicate plural ${e.plural}`);
    plurals.add(e.plural);
    if (RESERVED.has(e.name.toLowerCase()) || RESERVED.has(e.plural))
      add(`${p}.name`, `${e.name}/${e.plural} is a reserved identifier`);
    const fieldNames = new Set<string>();
    for (const [fi, f] of e.fields.entries()) {
      const fp = `${p}.fields[${fi}]`;
      if (fieldNames.has(f.name)) add(`${fp}.name`, `duplicate field ${f.name}`);
      fieldNames.add(f.name);
      const snake = f.name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      if ((SYSTEM_COLUMNS as readonly string[]).includes(snake) || RESERVED.has(snake))
        add(`${fp}.name`, `${f.name} is a reserved column name`);
      if (f.type === 'enum' && !f.enumValues?.length)
        add(`${fp}.enumValues`, 'an enum field needs values');
      if (f.type !== 'enum' && f.enumValues)
        add(`${fp}.enumValues`, 'only an enum field has values');
      if (f.type === 'reference' && !f.references)
        add(`${fp}.references`, 'a reference field needs a target entity');
      if (f.type !== 'reference' && f.references)
        add(`${fp}.references`, 'only a reference field has a target');
      if (f.min !== undefined && f.max !== undefined && f.min > f.max)
        add(`${fp}.min`, 'min must not exceed max');
    }
    for (const [fi, f] of e.fields.entries())
      if (
        f.type === 'reference' &&
        f.references &&
        !s.entities.some((x) => x.name === f.references)
      )
        add(`${p}.fields[${fi}].references`, `unknown entity ${f.references}`);
    for (const k of ['searchable', 'sortable'] as const)
      for (const n of e[k])
        if (!fieldNames.has(n) && !(k === 'sortable' && (n === 'createdAt' || n === 'updatedAt')))
          add(`${p}.${k}`, `unknown field ${n}`);
    if (e.stageField) {
      const sf = e.fields.find((f) => f.name === e.stageField);
      if (!sf || sf.type !== 'enum')
        add(`${p}.stageField`, 'the stage field must be an enum field of the entity');
    }
  }
  const roleNames = new Set<string>();
  for (const [ri, r] of s.roles.entries()) {
    const p = `$.roles[${ri}]`;
    if (roleNames.has(r.name)) add(`${p}.name`, `duplicate role ${r.name}`);
    roleNames.add(r.name);
    for (const en of Object.keys(r.permissions))
      if (!entityNames.has(en)) add(`${p}.permissions.${en}`, `unknown entity ${en}`);
  }
  if (!s.roles.some((r) => r.admin))
    add('$.roles', 'at least one role must be an administrator role');
  const paths = new Set<string>();
  for (const [pi, pg] of s.pages.entries()) {
    const p = `$.pages[${pi}]`;
    if (paths.has(pg.path)) add(`${p}.path`, `duplicate page ${pg.path}`);
    paths.add(pg.path);
    if (['list', 'detail', 'form', 'board'].includes(pg.kind) && !pg.entity)
      add(`${p}.entity`, `a ${pg.kind} page needs an entity`);
    if (pg.entity && !entityNames.has(pg.entity)) add(`${p}.entity`, `unknown entity ${pg.entity}`);
    if (pg.kind === 'board') {
      const e = s.entities.find((x) => x.name === pg.entity);
      if (e && !e.stageField) add(`${p}.entity`, `${e.name} has no stage field for a board`);
    }
    for (const r of pg.roles ?? []) if (!roleNames.has(r)) add(`${p}.roles`, `unknown role ${r}`);
    for (const [wi, w] of (pg.widgets ?? []).entries())
      if (!entityNames.has(w.entity))
        add(`${p}.widgets[${wi}].entity`, `unknown entity ${w.entity}`);
  }
  return { ok: issues.length === 0, issues };
}

export const toSnake = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/^_/, '');
