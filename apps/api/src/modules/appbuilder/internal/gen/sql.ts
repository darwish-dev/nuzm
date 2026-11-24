import type { AppSpec, EntitySpec, FieldSpec } from '../spec/app-spec';
import { toSnake } from '../spec/app-spec';

/** Schema generator for the GENERATED app's database (S43.1): versioned, reversible migrations, expand/contract aware; destructive statements are detected and gated by approval. */
export interface GeneratedMigration {
  version: number;
  name: string;
  /** `expand` = additive (safe while the old app still runs); `contract` = removes/tightens (run after the new app is live and any backfill is done). */
  phase: 'expand' | 'contract';
  up: string;
  down: string;
  /** Statements that destroy data or tighten a column; each one needs the `destructive_migration` approval. */
  destructive: string[];
}

const q = (id: string) => '"' + id.replace(/"/g, '""') + '"';
const lit = (s: string) => "'" + s.replace(/'/g, "''") + "'";
export const tableOf = (e: EntitySpec) => e.plural;
export const columnOf = (f: FieldSpec) => toSnake(f.name);

/** SQL column definition(s) of a field. A `file` field is stored in four columns. */
export function columnDefs(f: FieldSpec, forceNullable = false): string[] {
  const c = columnOf(f);
  const nn = f.required && !forceNullable ? ' NOT NULL' : '';
  switch (f.type) {
    case 'string':
      return [`${q(c)} varchar(${f.maxLength ?? 255})${nn}`];
    case 'text':
      return [
        `${q(c)} text${nn}${f.maxLength ? ` CHECK (char_length(${q(c)}) <= ${f.maxLength})` : ''}`,
      ];
    case 'integer':
      return [`${q(c)} bigint${nn}${bounds(c, f)}`];
    case 'decimal':
      return [`${q(c)} numeric(18,4)${nn}${bounds(c, f)}`];
    case 'boolean':
      return [`${q(c)} boolean${nn}`];
    case 'date':
      return [`${q(c)} date${nn}`];
    case 'datetime':
      return [`${q(c)} timestamptz${nn}`];
    case 'enum':
      return [`${q(c)} text${nn} CHECK (${q(c)} IN (${(f.enumValues ?? []).map(lit).join(', ')}))`];
    case 'email':
      return [`${q(c)} varchar(254)${nn} CHECK (${q(c)} ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')`];
    case 'phone':
      return [`${q(c)} varchar(32)${nn} CHECK (${q(c)} ~ '^\\+?[0-9 ()-]{5,30}$')`];
    case 'url':
      return [`${q(c)} varchar(2048)${nn} CHECK (${q(c)} ~ '^https?://')`];
    case 'reference':
      return [`${q(c)} uuid${nn}`]; // the FK constraint is a separate statement (cycles, ordering)
    case 'file':
      return [
        `${q(c + '_name')} varchar(255)`,
        `${q(c + '_mime')} varchar(127)`,
        `${q(c + '_size')} integer CHECK (${q(c + '_size')} >= 0)`,
        `${q(c + '_data')} bytea`,
      ];
  }
}
function bounds(c: string, f: FieldSpec): string {
  const parts: string[] = [];
  if (f.min !== undefined) parts.push(`${q(c)} >= ${Number(f.min)}`);
  if (f.max !== undefined) parts.push(`${q(c)} <= ${Number(f.max)}`);
  return parts.length ? ` CHECK (${parts.join(' AND ')})` : '';
}

/** Generation options that change the schema. `multi`: every table carries `tenant_id` and PostgreSQL row-level security isolates tenants (P3-S05). */
export interface SqlOptions {
  tenancy?: 'single' | 'multi';
}
/** The expression every tenant policy and default uses: the tenant the application set for the transaction; NULL (no row matches) when none was set: fail closed. */
export const TENANT_GUC = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;

export function createTableSql(
  spec: AppSpec,
  e: EntitySpec,
  o: SqlOptions = {},
): { table: string; fks: string[]; indexes: string[]; rls: string[] } {
  const multi = o.tenancy === 'multi';
  const t = tableOf(e);
  const lines = [
    `${q('id')} uuid PRIMARY KEY`,
    ...(multi
      ? [
          `${q('tenant_id')} uuid NOT NULL DEFAULT ${TENANT_GUC} REFERENCES ${q('app_tenants')}(${q('id')})`,
        ]
      : []),
    `${q('owner_id')} uuid`,
    `${q('team_id')} uuid`,
    ...e.fields.flatMap((f) => columnDefs(f)),
    `${q('created_at')} timestamptz NOT NULL DEFAULT now()`,
    `${q('updated_at')} timestamptz NOT NULL DEFAULT now()`,
    `${q('created_by')} uuid`,
    `${q('updated_by')} uuid`,
    `${q('version')} integer NOT NULL DEFAULT 1`,
  ];
  // multi-tenant: a value is unique WITHIN a tenant, and `(tenant_id, id)` is unique so that a foreign key can name the tenant too (a reference can never cross tenants)
  const uniques = [
    ...(multi
      ? [`CONSTRAINT ${q(`${t}_tenant_id_id_key`)} UNIQUE (${q('tenant_id')}, ${q('id')})`]
      : []),
    ...e.fields
      .filter((f) => f.unique && f.type !== 'file')
      .map(
        (f) =>
          `CONSTRAINT ${q(`${t}_${columnOf(f)}_key`)} UNIQUE (${multi ? q('tenant_id') + ', ' : ''}${q(columnOf(f))})`,
      ),
  ];
  const table = `CREATE TABLE ${q(t)} (\n  ${[...lines, ...uniques].join(',\n  ')}\n);`;
  const fks = e.fields
    .filter((f) => f.type === 'reference')
    .map((f) => {
      const target = spec.entities.find((x) => x.name === f.references)!;
      const onDelete = f.required
        ? 'RESTRICT'
        : multi
          ? `SET NULL (${q(columnOf(f))})` // column list: PostgreSQL 15+, never nulls the tenant
          : 'SET NULL';
      return multi
        ? `ALTER TABLE ${q(t)} ADD CONSTRAINT ${q(`${t}_${columnOf(f)}_fkey`)} FOREIGN KEY (${q('tenant_id')}, ${q(columnOf(f))}) REFERENCES ${q(tableOf(target))}(${q('tenant_id')}, ${q('id')}) ON DELETE ${onDelete};`
        : `ALTER TABLE ${q(t)} ADD CONSTRAINT ${q(`${t}_${columnOf(f)}_fkey`)} FOREIGN KEY (${q(columnOf(f))}) REFERENCES ${q(tableOf(target))}(${q('id')}) ON DELETE ${onDelete};`;
    });
  const rls = multi ? tenantPolicySql(t) : [];
  const idx = [
    ...(multi ? [`CREATE INDEX ${q(`${t}_tenant_idx`)} ON ${q(t)} (${q('tenant_id')});`] : []),
    `CREATE INDEX ${q(`${t}_owner_idx`)} ON ${q(t)} (${q('owner_id')});`,
    `CREATE INDEX ${q(`${t}_team_idx`)} ON ${q(t)} (${q('team_id')});`,
    ...e.fields
      .filter(
        (f) => f.type === 'reference' || e.sortable.includes(f.name) || e.stageField === f.name,
      )
      .map((f) => `CREATE INDEX ${q(`${t}_${columnOf(f)}_idx`)} ON ${q(t)} (${q(columnOf(f))});`),
  ];
  return { table, fks, indexes: [...new Set(idx)], rls };
}
/** Row-level security of a tenant table: enabled AND forced (the table owner is the application's role, which would otherwise bypass it). */
export function tenantPolicySql(table: string): string[] {
  return [
    `ALTER TABLE ${q(table)} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${q(table)} FORCE ROW LEVEL SECURITY;`,
    `CREATE POLICY ${q(`${table}_tenant_isolation`)} ON ${q(table)} USING (${q('tenant_id')} = ${TENANT_GUC}) WITH CHECK (${q('tenant_id')} = ${TENANT_GUC});`,
  ];
}

/** Tables every generated app has regardless of the spec: users, audit trail, revoked sessions, (multi-tenant) tenants, migration ledger. */
export function platformTablesSql(o: SqlOptions = {}): string {
  const multi = o.tenancy === 'multi';
  return `${
    multi
      ? `CREATE TABLE "app_tenants" (
  "id" uuid PRIMARY KEY,
  "name" varchar(120) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
`
      : ''
  }CREATE TABLE "app_users" (
  "id" uuid PRIMARY KEY,
  "email" varchar(254) NOT NULL UNIQUE,
  "name" varchar(120) NOT NULL,
  "role" varchar(40) NOT NULL,
  "team_id" uuid,
${
  multi
    ? `  "tenant_id" uuid NOT NULL REFERENCES "app_tenants"("id"),
`
    : ''
}  "locale" varchar(2) NOT NULL DEFAULT 'ar' CHECK ("locale" IN ('ar','en')),
  "password_hash" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now()
);${
    multi
      ? `
CREATE INDEX "app_users_tenant_idx" ON "app_users" ("tenant_id");`
      : ''
  }
CREATE TABLE "app_revoked_sessions" (
  "jti" varchar(64) PRIMARY KEY,
  "expires_at" timestamptz NOT NULL
);
CREATE INDEX "app_revoked_sessions_expiry_idx" ON "app_revoked_sessions" ("expires_at");
CREATE TABLE "audit_log" (
  "id" uuid PRIMARY KEY,
${
  multi
    ? `  "tenant_id" uuid NOT NULL DEFAULT ${TENANT_GUC} REFERENCES "app_tenants"("id"),
`
    : ''
}  "entity" varchar(60) NOT NULL,
  "record_id" uuid NOT NULL,
  "action" varchar(20) NOT NULL CHECK ("action" IN ('create','update','delete','import')),
  "actor_id" uuid,
  "diff" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "audit_log_record_idx" ON "audit_log" ("entity", "record_id", "at");
CREATE FUNCTION "audit_log_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER "audit_log_no_change" BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION "audit_log_immutable"();${
    multi
      ? `
${tenantPolicySql('audit_log').join('\n')}`
      : ''
  }`;
}
export function platformTablesDown(o: SqlOptions = {}): string {
  return `DROP TABLE IF EXISTS "audit_log";
DROP FUNCTION IF EXISTS "audit_log_immutable"();
DROP TABLE IF EXISTS "app_revoked_sessions";
DROP TABLE IF EXISTS "app_users";${o.tenancy === 'multi' ? '\nDROP TABLE IF EXISTS "app_tenants";' : ''}`;
}
export const PLATFORM_TABLES_SQL = platformTablesSql();
export const PLATFORM_TABLES_DOWN = platformTablesDown();

/** Version 1: the whole schema. Created in dependency order is unnecessary because foreign keys are added after every table exists. */
export function initialMigration(spec: AppSpec, o: SqlOptions = {}): GeneratedMigration {
  const parts = spec.entities.map((e) => createTableSql(spec, e, o));
  const up = [
    '-- generated by the Nuzm app builder from the approved application spec; do not edit by hand',
    platformTablesSql(o),
    ...parts.map((p) => p.table),
    ...parts.flatMap((p) => p.fks),
    ...parts.flatMap((p) => p.indexes),
    ...parts.flatMap((p) => p.rls),
  ].join('\n');
  const down = [
    '-- reverses migration 1 (drops every table: development and staging only; production is fixed forward)',
    ...[...spec.entities].reverse().map((e) => `DROP TABLE IF EXISTS ${q(tableOf(e))} CASCADE;`),
    platformTablesDown(o),
  ].join('\n');
  return { version: 1, name: 'init', phase: 'expand', up, down, destructive: [] };
}

const DESTRUCTIVE = [
  {
    re: /\bDROP\s+(TABLE|COLUMN|SCHEMA|DATABASE|INDEX\s+CONCURRENTLY\s+\w+\s+CASCADE)\b/i,
    why: 'drops an object',
  },
  { re: /\bDROP\s+CONSTRAINT\b[^;]*\bCASCADE\b/i, why: 'drops a constraint with cascade' },
  { re: /\bTRUNCATE\b/i, why: 'truncates a table' },
  { re: /\bDELETE\s+FROM\b/i, why: 'deletes rows' },
  { re: /\bALTER\s+TABLE\b[^;]*\bDROP\s+COLUMN\b/i, why: 'removes a column' },
  { re: /\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i, why: 'changes a column type' },
  { re: /\bALTER\s+COLUMN\b[^;]*\bSET\s+NOT\s+NULL\b/i, why: 'tightens a column to NOT NULL' },
  { re: /\bUPDATE\b[^;]*\bSET\b(?![^;]*\bWHERE\b)/i, why: 'updates every row' },
];
/** Statement-level scan (also applied to migrations a model proposes): returns the destructive statements with the reason. */
export function detectDestructive(sql: string): string[] {
  const out: string[] = [];
  for (const stmt of sql.split(/;\s*(?:\n|$)/)) {
    const s = stmt.replace(/--[^\n]*/g, '').trim();
    if (!s) continue;
    for (const d of DESTRUCTIVE)
      if (d.re.test(s)) {
        out.push(`${s.replace(/\s+/g, ' ').slice(0, 160)} -- ${d.why}`);
        break;
      }
  }
  return out;
}

const fieldMap = (e: EntitySpec) => new Map(e.fields.map((f) => [f.name, f]));
const sameDef = (a: FieldSpec, b: FieldSpec) => columnDefs(a).join() === columnDefs(b).join();

/**
 * Next migrations between two approved specs. Additive changes are `expand`; removals, type changes, narrowed enums and new NOT NULL columns are produced as
 * `contract` migrations (a new required column is first added nullable, then tightened by the contract migration after the backfill). A rename is
 * indistinguishable from drop + add and is therefore treated as destructive (never guessed).
 */
export function diffSpecs(
  prev: AppSpec,
  next: AppSpec,
  startVersion: number,
  opt: SqlOptions = {},
): GeneratedMigration[] {
  const expandUp: string[] = [];
  const expandDown: string[] = [];
  const contractUp: string[] = [];
  const contractDown: string[] = [];
  const prevE = new Map(prev.entities.map((e) => [e.name, e]));
  const nextE = new Map(next.entities.map((e) => [e.name, e]));
  const newEntities = next.entities.filter((e) => !prevE.has(e.name));
  const created = newEntities.map((e) => createTableSql(next, e, opt));
  expandUp.push(
    ...created.map((c) => c.table),
    ...created.flatMap((c) => c.fks),
    ...created.flatMap((c) => c.indexes),
    ...created.flatMap((c) => c.rls),
  );
  expandDown.push(
    ...[...newEntities].reverse().map((e) => `DROP TABLE IF EXISTS ${q(tableOf(e))} CASCADE;`),
  );
  for (const e of next.entities) {
    const old = prevE.get(e.name);
    if (!old) continue;
    const t = q(tableOf(e));
    const oldF = fieldMap(old);
    const newF = fieldMap(e);
    for (const f of e.fields) {
      const o = oldF.get(f.name);
      if (!o) {
        expandUp.push(...columnDefs(f, true).map((d) => `ALTER TABLE ${t} ADD COLUMN ${d};`));
        expandDown.push(
          ...columnDefs(f, true).map(
            (d) => `ALTER TABLE ${t} DROP COLUMN IF EXISTS ${d.split(' ')[0]};`,
          ),
        );
        if (f.type === 'reference') {
          const target = next.entities.find((x) => x.name === f.references)!;
          expandUp.push(
            opt.tenancy === 'multi'
              ? `ALTER TABLE ${t} ADD CONSTRAINT ${q(`${tableOf(e)}_${columnOf(f)}_fkey`)} FOREIGN KEY (${q('tenant_id')}, ${q(columnOf(f))}) REFERENCES ${q(tableOf(target))}(${q('tenant_id')}, ${q('id')}) ON DELETE SET NULL (${q(columnOf(f))});`
              : `ALTER TABLE ${t} ADD CONSTRAINT ${q(`${tableOf(e)}_${columnOf(f)}_fkey`)} FOREIGN KEY (${q(columnOf(f))}) REFERENCES ${q(tableOf(target))}(${q('id')}) ON DELETE SET NULL;`,
          );
        }
        if (f.required && f.type !== 'file') {
          contractUp.push(`ALTER TABLE ${t} ALTER COLUMN ${q(columnOf(f))} SET NOT NULL;`);
          contractDown.push(`ALTER TABLE ${t} ALTER COLUMN ${q(columnOf(f))} DROP NOT NULL;`);
        }
      } else if (!sameDef(o, f)) {
        const c = q(columnOf(f));
        if (o.type !== f.type) {
          contractUp.push(
            `ALTER TABLE ${t} ALTER COLUMN ${c} TYPE ${sqlType(f)} USING ${c}::${sqlType(f)};`,
          );
          contractDown.push(
            `ALTER TABLE ${t} ALTER COLUMN ${c} TYPE ${sqlType(o)} USING ${c}::${sqlType(o)};`,
          );
        } else if (f.type === 'enum') {
          const removed = (o.enumValues ?? []).filter((v) => !(f.enumValues ?? []).includes(v));
          const name = q(`${tableOf(e)}_${columnOf(f)}_check`);
          const mk = (vals: string[]) =>
            `ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${name}; ALTER TABLE ${t} ADD CONSTRAINT ${name} CHECK (${c} IN (${vals.map(lit).join(', ')}));`;
          (removed.length ? contractUp : expandUp).push(mk(f.enumValues ?? []));
          (removed.length ? contractDown : expandDown).push(mk(o.enumValues ?? []));
          if (removed.length)
            contractUp.push(`DELETE FROM ${t} WHERE ${c} IN (${removed.map(lit).join(', ')});`);
        } else if (!o.required && f.required) {
          contractUp.push(`ALTER TABLE ${t} ALTER COLUMN ${c} SET NOT NULL;`);
          contractDown.push(`ALTER TABLE ${t} ALTER COLUMN ${c} DROP NOT NULL;`);
        } else if (o.required && !f.required) {
          expandUp.push(`ALTER TABLE ${t} ALTER COLUMN ${c} DROP NOT NULL;`);
          expandDown.push(`ALTER TABLE ${t} ALTER COLUMN ${c} SET NOT NULL;`);
        } else if (o.maxLength !== f.maxLength && f.type === 'string') {
          const widening = (f.maxLength ?? 255) >= (o.maxLength ?? 255);
          (widening ? expandUp : contractUp).push(
            `ALTER TABLE ${t} ALTER COLUMN ${c} TYPE varchar(${f.maxLength ?? 255});`,
          );
          (widening ? expandDown : contractDown).push(
            `ALTER TABLE ${t} ALTER COLUMN ${c} TYPE varchar(${o.maxLength ?? 255});`,
          );
        }
      }
    }
    for (const o of old.fields)
      if (!newF.has(o.name)) {
        contractUp.push(
          ...columnDefs(o, true).map((d) => `ALTER TABLE ${t} DROP COLUMN ${d.split(' ')[0]};`),
        );
        contractDown.push(...columnDefs(o, true).map((d) => `ALTER TABLE ${t} ADD COLUMN ${d};`));
      }
  }
  for (const old of prev.entities)
    if (!nextE.has(old.name)) {
      contractUp.push(`DROP TABLE ${q(tableOf(old))} CASCADE;`);
      contractDown.push(createTableSql(prev, old, opt).table);
    }
  const out: GeneratedMigration[] = [];
  let v = startVersion;
  const header = '-- generated by the Nuzm app builder; do not edit by hand\n';
  if (expandUp.length)
    out.push({
      version: v++,
      name: 'expand',
      phase: 'expand',
      up: header + expandUp.join('\n'),
      down: header + expandDown.reverse().join('\n'),
      destructive: detectDestructive(expandUp.join(';\n')),
    });
  if (contractUp.length) {
    const up = contractUp.join('\n');
    out.push({
      version: v,
      name: 'contract',
      phase: 'contract',
      up: `${header}-- CONTRACT phase: run after the new application version is live and any backfill is complete\n${up}`,
      down: `${header}-- reverses the contract phase structurally; DATA REMOVED BY THE UP SCRIPT IS NOT RESTORED\n${contractDown.reverse().join('\n')}`,
      destructive: detectDestructive(up),
    });
  }
  return out;
}
function sqlType(f: FieldSpec): string {
  const d = columnDefs(f, true)[0]!;
  return d
    .split(' ')
    .slice(1)
    .join(' ')
    .replace(/ CHECK.*$/, '');
}
export { q as quoteIdent };
