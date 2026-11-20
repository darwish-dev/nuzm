/**
 * Pure helpers of the web-app Data panel: the generated database as the SQL migrations describe it (tables, columns, keys), joined with the agreed app spec (labels,
 * personal-data flags, relations), the generated REST endpoints and the role matrix. No I/O: unit-tested in `webapp-data.spec.ts`.
 *
 * Everything read here is UNTRUSTED text (a migration is model-made): it is only ever parsed with bounded loops and rendered as React text.
 */
import { safeText } from './appbuilder';
import type { Bi, EndpointView, EntityView, RoleView, SpecView } from './appworkspace';

export interface SqlColumn {
  name: string;
  type: string;
  notNull: boolean;
  primary: boolean;
  unique: boolean;
  default: string | null;
  check: string | null;
  /** `table.column` this column points at (a foreign key) */
  references: { table: string; column: string; onDelete: string | null } | null;
}
export interface SqlTable {
  name: string;
  columns: SqlColumn[];
  indexes: string[];
}

const MAX_SQL = 200_000;
/** An identifier as written in the SQL: "quoted" (with "" for a quote) or bare. */
const IDENT = String.raw`(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_]*))`;
const unq = (a: string | undefined, b: string | undefined): string =>
  (a !== undefined ? a.replace(/""/g, '"') : (b ?? '')).slice(0, 80);

/** Remove `-- line` and block comments; string literals are kept as they are. */
function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'") {
      const start = i++;
      while (i < sql.length && !(sql[i] === "'" && sql[i + 1] !== "'")) i += sql[i] === "'" ? 2 : 1;
      i++;
      out += sql.slice(start, i);
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The text up to the parenthesis that closes the one opened just before `from`, and the index after it. */
function balanced(sql: string, from: number): { body: string; end: number } | null {
  let depth = 1;
  let i = from;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < sql.length && !(sql[i] === q && sql[i + 1] !== q)) i += sql[i] === q ? 2 : 1;
    } else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return { body: sql.slice(from, i), end: i + 1 };
    }
    i++;
  }
  return null;
}

/** Split at the commas that are not inside parentheses or quotes. */
function topLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < body.length && !(body[i] === q && body[i + 1] !== q)) i += body[i] === q ? 2 : 1;
    } else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

const KEYWORDS =
  /\s(?:NOT\s+NULL|NULL|DEFAULT|PRIMARY\s+KEY|UNIQUE|CHECK|REFERENCES|CONSTRAINT|GENERATED)\b/i;

function columnOf(def: string): SqlColumn | null {
  const m = new RegExp(`^${IDENT}\\s+([\\s\\S]+)$`).exec(def);
  if (!m) return null;
  const rest = m[3]!;
  const cut = KEYWORDS.exec(` ${rest}`);
  const type = (cut ? rest.slice(0, Math.max(0, cut.index - 1)) : rest).trim().replace(/\s+/g, ' ');
  const primary = /\bPRIMARY\s+KEY\b/i.test(rest);
  const def_ =
    /\bDEFAULT\s+(.+?)(?=\s+(?:NOT\s+NULL|NULL|CHECK|UNIQUE|PRIMARY|REFERENCES|CONSTRAINT)\b|$)/i.exec(
      rest,
    );
  const check = /\bCHECK\s*\(/i.exec(rest);
  const checkBody = check ? balanced(rest, check.index + check[0].length) : null;
  const ref = new RegExp(
    `\\bREFERENCES\\s+${IDENT}\\s*\\(\\s*${IDENT}\\s*\\)(?:\\s+ON\\s+DELETE\\s+([A-Z ]+?))?\\s*$`,
    'i',
  ).exec(rest);
  return {
    name: unq(m[1], m[2]),
    type: type.slice(0, 60) || '—',
    notNull: primary || /\bNOT\s+NULL\b/i.test(rest),
    primary,
    unique: /\bUNIQUE\b/i.test(rest),
    default: def_ ? def_[1]!.trim().slice(0, 60) : null,
    check: checkBody ? checkBody.body.trim().replace(/\s+/g, ' ').slice(0, 160) : null,
    references: ref
      ? {
          table: unq(ref[1], ref[2]),
          column: unq(ref[3], ref[4]),
          onDelete: ref[5]?.trim() ?? null,
        }
      : null,
  };
}

/**
 * The tables the migrations (applied in order) leave behind: `CREATE TABLE`, `ALTER TABLE ... ADD COLUMN / DROP COLUMN / ADD CONSTRAINT ... FOREIGN KEY / UNIQUE`,
 * `DROP TABLE` and `CREATE INDEX`. It is a reader for the SQL the generator writes, not a SQL engine: a statement it does not know is skipped.
 */
export function parseTables(migrationsUp: readonly string[]): SqlTable[] {
  const tables = new Map<string, SqlTable>();
  for (const raw of migrationsUp) {
    const sql = stripComments(raw.slice(0, MAX_SQL));
    // CREATE TABLE
    const create = new RegExp(
      `\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}\\s*\\(`,
      'gi',
    );
    for (let m = create.exec(sql); m; m = create.exec(sql)) {
      const b = balanced(sql, m.index + m[0].length);
      if (!b) continue;
      create.lastIndex = b.end;
      const table: SqlTable = { name: unq(m[1], m[2]), columns: [], indexes: [] };
      for (const part of topLevel(b.body).slice(0, 200)) {
        if (/^(?:CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK)\b/i.test(part)) {
          const u = new RegExp(`UNIQUE\\s*\\(\\s*${IDENT}\\s*\\)`, 'i').exec(part);
          const col = u && table.columns.find((c) => c.name === unq(u[1], u[2]));
          if (col) col.unique = true;
          continue;
        }
        const col = columnOf(part);
        if (col) table.columns.push(col);
      }
      tables.set(table.name, table);
    }
    // ALTER TABLE ... (one action per statement, as the generator writes them)
    const alter = new RegExp(`\\bALTER\\s+TABLE\\s+(?:ONLY\\s+)?${IDENT}\\s+([^;]+);`, 'gi');
    for (let m = alter.exec(sql); m; m = alter.exec(sql)) {
      const table = tables.get(unq(m[1], m[2]));
      const action = m[3]!.trim();
      if (!table) continue;
      const add = /^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([\s\S]+)$/i.exec(action);
      if (add) {
        const col = columnOf(add[1]!.trim());
        if (col && !table.columns.some((c) => c.name === col.name)) table.columns.push(col);
        continue;
      }
      const drop = new RegExp(`^DROP\\s+COLUMN\\s+(?:IF\\s+EXISTS\\s+)?${IDENT}`, 'i').exec(action);
      if (drop) {
        const n = unq(drop[1], drop[2]);
        table.columns = table.columns.filter((c) => c.name !== n);
        continue;
      }
      const fk = new RegExp(
        `FOREIGN\\s+KEY\\s*\\(\\s*${IDENT}\\s*\\)\\s*REFERENCES\\s+${IDENT}\\s*\\(\\s*${IDENT}\\s*\\)(?:\\s+ON\\s+DELETE\\s+([A-Z ]+?))?\\s*$`,
        'i',
      ).exec(action);
      if (fk) {
        const col = table.columns.find((c) => c.name === unq(fk[1], fk[2]));
        if (col)
          col.references = {
            table: unq(fk[3], fk[4]),
            column: unq(fk[5], fk[6]),
            onDelete: fk[7]?.trim() ?? null,
          };
        continue;
      }
      const uq = new RegExp(`UNIQUE\\s*\\(\\s*${IDENT}\\s*\\)`, 'i').exec(action);
      if (uq) {
        const col = table.columns.find((c) => c.name === unq(uq[1], uq[2]));
        if (col) col.unique = true;
      }
    }
    const drops = new RegExp(`\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${IDENT}`, 'gi');
    for (let m = drops.exec(sql); m; m = drops.exec(sql)) tables.delete(unq(m[1], m[2]));
    const idx = new RegExp(
      `\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}\\s+ON\\s+${IDENT}`,
      'gi',
    );
    for (let m = idx.exec(sql); m; m = idx.exec(sql))
      tables.get(unq(m[3], m[4]))?.indexes.push(unq(m[1], m[2]));
  }
  return [...tables.values()];
}

/* ------------------------------------------------------------------ migration files */

export interface MigrationFile {
  version: number;
  name: string;
  /** `db/migrations/0001_init.sql` */
  upPath: string | null;
  /** `db/migrations/0001_init.down.sql` */
  downPath: string | null;
}
const MIGRATION = /^db\/migrations\/(\d{1,6})_([A-Za-z0-9_-]{1,80})(\.down)?\.sql$/;
/** The generated migrations in the file list of a version, paired as apply (`.sql`) and reverse (`.down.sql`), oldest first. */
export function migrationFiles(paths: readonly string[]): MigrationFile[] {
  const by = new Map<string, MigrationFile>();
  for (const p of paths) {
    const m = MIGRATION.exec(p);
    if (!m) continue;
    const key = `${Number(m[1])}_${m[2]}`;
    const cur = by.get(key) ?? { version: Number(m[1]), name: m[2]!, upPath: null, downPath: null };
    if (m[3]) cur.downPath = p;
    else cur.upPath = p;
    by.set(key, cur);
  }
  return [...by.values()].sort((a, b) => a.version - b.version);
}

/* ------------------------------------------------------------------ the data model of the app */

export interface ColumnModel extends SqlColumn {
  /** the column is one of the app's own fields (not an id, owner, timestamp or version column the platform adds) */
  field: boolean;
  label: Bi | null;
  pii: boolean;
  enumValues: string[];
}
export interface AccessRow {
  role: string;
  scope: string;
  actions: string[];
}
export interface TableModel {
  name: string;
  entity: EntityView | null;
  columns: ColumnModel[];
  indexes: string[];
  /** this table's foreign keys */
  outgoing: { column: string; table: string; onDelete: string | null }[];
  /** foreign keys of other tables that point here */
  incoming: { table: string; column: string }[];
  endpoints: EndpointView[];
  access: AccessRow[];
}
const snake = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/^_/, '');

/** The endpoints under `{basePath}/{plural}` (the list, the one record, import and export). */
export function endpointsOf(
  api: readonly EndpointView[],
  basePath: string,
  plural: string,
): EndpointView[] {
  const root = `${basePath.replace(/\/$/, '')}/${plural}`;
  return api.filter((e) => e.path === root || e.path.startsWith(`${root}/`));
}

/**
 * The tables of the generated database, each with its columns (from the SQL, labelled from the spec), keys, the endpoints that serve it and who may do what on it.
 * Without migrations the tables come from the spec's entities alone (the columns are then the spec's fields, typed as the spec types them).
 */
export function tableModels(
  sql: readonly SqlTable[],
  spec: SpecView | null,
  endpoints: readonly EndpointView[],
  roles: readonly RoleView[],
): TableModel[] {
  const byPlural = new Map((spec?.entities ?? []).map((e) => [e.plural, e]));
  const names = sql.length > 0 ? sql.map((s) => s.name) : [...byPlural.keys()];
  const out: TableModel[] = names.map((name) => {
    const entity = byPlural.get(name) ?? null;
    const s = sql.find((x) => x.name === name);
    const fields = new Map((entity?.fields ?? []).map((f) => [snake(f.name), f]));
    const columns: ColumnModel[] = s
      ? s.columns.map((c) => {
          const f = fields.get(c.name) ?? fields.get(c.name.replace(/_(name|mime|size|data)$/, ''));
          return {
            ...c,
            field: f !== undefined,
            label: f?.label ?? null,
            pii: f?.pii === true,
            enumValues: f?.enumValues ?? [],
          };
        })
      : (entity?.fields ?? []).map((f) => ({
          name: snake(f.name),
          type: f.type,
          notNull: f.required,
          primary: false,
          unique: f.unique,
          default: null,
          check: null,
          references: f.references ? { table: f.references, column: 'id', onDelete: null } : null,
          field: true,
          label: f.label,
          pii: f.pii,
          enumValues: f.enumValues,
        }));
    return {
      name,
      entity,
      columns,
      indexes: s?.indexes ?? [],
      outgoing: columns
        .filter((c) => c.references)
        .map((c) => ({
          column: c.name,
          table: c.references!.table,
          onDelete: c.references!.onDelete,
        })),
      incoming: [],
      endpoints: spec ? endpointsOf(endpoints, spec.api.basePath, name) : [],
      access: entity
        ? roles
            .map((r) => ({
              role: r.name,
              scope: r.scope,
              actions: r.permissions[entity.name] ?? [],
            }))
            .filter((r) => r.actions.length > 0)
        : [],
    };
  });
  for (const tb of out)
    for (const o of tb.outgoing)
      out.find((x) => x.name === o.table)?.incoming.push({ table: tb.name, column: o.column });
  return out;
}

/** Statements that destroy data in a migration (the generator flags them and a deploy needs a human approval); a plain scan for the file view when no artifact says. */
export const looksDestructive = (sql: string): boolean =>
  /\b(DROP\s+(TABLE|COLUMN|SCHEMA|DATABASE)|TRUNCATE|DELETE\s+FROM)\b/i.test(stripComments(sql));

/** One short, safe line of a SQL column's constraints for the table: `NOT NULL · UNIQUE · default now()`. */
export function constraintText(c: SqlColumn): string[] {
  const out: string[] = [];
  if (c.primary) out.push('PRIMARY KEY');
  else if (c.notNull) out.push('NOT NULL');
  if (c.unique) out.push('UNIQUE');
  if (c.default) out.push(`DEFAULT ${safeText(c.default, 60)}`);
  return out;
}
