import { Client } from 'pg';
import type { Manifest } from './migrations';

export interface ClassViolation {
  kind:
    | 'unclassified_column'
    | 'stale_column'
    | 'unknown_class'
    | 'weak_class'
    | 'bad_exception'
    | 'no_classes'
    | 'credential_unprotected'
    | 'unknown_protection'
    | 'stale_protection'
    | 'protection_mismatch'
    | 'bad_ciphertext';
  object: string;
  detail: string;
}
export interface ColumnRef {
  table: string; // schema.table
  column: string;
}

/**
 * Name patterns that say "this column holds personal, financial or credential data". A column matching one of them may not be classed
 * `public` or `internal` unless the manifest lists a justified exception: the heuristic catches a new `email` column classed carelessly.
 */
const SENSITIVE: { pattern: RegExp; why: string }[] = [
  {
    pattern:
      /(^|_)(email|phone|mobile|ip|user_agent|display_name|first_name|last_name|full_name|legal_name|address|birth|national_id|passport)(_|$)/,
    why: 'looks personal',
  },
  {
    pattern: /(secret|password|passwd|token|api_key|private_key|credential|otp|totp|recovery|csrf)/,
    why: 'looks credential-bearing',
  },
  { pattern: /(_minor$|amount|balance|iban|card_number|(^|_)pan$)/, why: 'looks financial' },
];
const WEAK = new Set(['public', 'internal']);
const PROTECTIONS: Record<string, RegExp> = {
  hash: /_hash$/,
  vault_ref: /_ref$/,
  encrypted: /_enc$/,
  lookup: /^prefix$/,
};

/**
 * Pure evaluation (no I/O): `catalog` is every column of every table in the database. Rules: every column is classified with a known
 * class; no manifest entry is stale (a table or column that no longer exists); a sensitive-looking name is not weakly classed
 * unless an exception with a reason (10+ characters) is listed.
 */
export function evaluateClassification(catalog: ColumnRef[], manifest: Manifest): ClassViolation[] {
  const { classes, columns, exceptions } = manifest.classification;
  const out: ClassViolation[] = [];
  if (classes.length === 0)
    return [{ kind: 'no_classes', object: 'classification', detail: 'no classes are defined' }];
  const known = new Set(classes);
  const seen = new Map<string, Set<string>>();
  for (const c of catalog) {
    if (!seen.has(c.table)) seen.set(c.table, new Set());
    seen.get(c.table)!.add(c.column);
    const cls = columns[c.table]?.[c.column];
    const fq = `${c.table}.${c.column}`;
    if (cls === undefined) {
      out.push({ kind: 'unclassified_column', object: fq, detail: 'column has no data class' });
      continue;
    }
    if (!known.has(cls))
      out.push({ kind: 'unknown_class', object: fq, detail: `"${cls}" is not a defined class` });
    if (WEAK.has(cls) && !exceptions[fq]) {
      const hit = SENSITIVE.find((s) => s.pattern.test(c.column));
      if (hit)
        out.push({
          kind: 'weak_class',
          object: fq,
          detail: `${hit.why} but is classed ${cls}; classify it or add a justified exception`,
        });
    }
  }
  for (const [table, cols] of Object.entries(columns))
    for (const column of Object.keys(cols))
      if (!seen.get(table)?.has(column))
        out.push({
          kind: 'stale_column',
          object: `${table}.${column}`,
          detail: 'listed in the manifest but not in the database',
        });
  for (const [fq, why] of Object.entries(exceptions)) {
    const [table, column] = [fq.slice(0, fq.lastIndexOf('.')), fq.slice(fq.lastIndexOf('.') + 1)];
    if (!seen.get(table)?.has(column))
      out.push({
        kind: 'bad_exception',
        object: fq,
        detail: 'exception for a column that does not exist',
      });
    else if (typeof why !== 'string' || why.trim().length < 10)
      out.push({
        kind: 'bad_exception',
        object: fq,
        detail: 'an exception needs a reason of 10+ characters',
      });
  }
  // credential-class columns hold only hashes, vault references, ciphertext or a non-secret lookup prefix (never a recoverable secret)
  const protection = manifest.classification.protection;
  for (const [table, cols] of Object.entries(columns))
    for (const [column, cls] of Object.entries(cols))
      if (
        cls === 'credentials' &&
        seen.get(table)?.has(column) &&
        !protection[`${table}.${column}`]
      )
        out.push({
          kind: 'credential_unprotected',
          object: `${table}.${column}`,
          detail:
            'a credentials column must declare its protection: hash, vault_ref, lookup or encrypted',
        });
  for (const [fq, how] of Object.entries(protection)) {
    const [table, column] = [fq.slice(0, fq.lastIndexOf('.')), fq.slice(fq.lastIndexOf('.') + 1)];
    const rule = PROTECTIONS[how];
    if (!rule)
      out.push({
        kind: 'unknown_protection',
        object: fq,
        detail: `"${how}" is not hash, vault_ref, lookup or encrypted`,
      });
    else if (!seen.get(table)?.has(column))
      out.push({
        kind: 'stale_protection',
        object: fq,
        detail: 'protection for a column that does not exist',
      });
    else if (!rule.test(column))
      out.push({
        kind: 'protection_mismatch',
        object: fq,
        detail: `a ${how} column is named accordingly (${rule.source})`,
      });
  }
  return out;
}

/** Every column of every ordinary/partitioned table (partitions are governed by their parent), outside the system schemas. */
export async function checkClassification(
  url: string,
  manifest: Manifest,
): Promise<ClassViolation[]> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query<{ schema: string; table: string; column: string }>(`
      SELECT n.nspname AS schema, c.relname AS table, a.attname AS column
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p') AND NOT c.relispartition
        AND c.relname !~ '^archived_.*_[0-9]{6}$' -- a detached archive keeps its parent's classification
        AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname NOT IN ('information_schema','public')
      ORDER BY 1, 2, a.attnum`);
    const out = evaluateClassification(
      r.rows.map((x) => ({ table: `${x.schema}.${x.table}`, column: x.column })),
      manifest,
    );
    // an `encrypted` column holds only sealed values (enc:v1:<key id>:<ciphertext>) or NULL (a legacy row not yet sealed)
    for (const [fq, how] of Object.entries(manifest.classification.protection)) {
      if (how !== 'encrypted') continue;
      const i = fq.lastIndexOf('.');
      const table = fq
        .slice(0, i)
        .split('.')
        .map((x) => `"${x.replace(/"/g, '""')}"`)
        .join('.');
      const col = `"${fq.slice(i + 1).replace(/"/g, '""')}"`;
      const bad = await c
        .query(
          `SELECT count(*)::int n FROM ${table} WHERE ${col} IS NOT NULL AND ${col} !~ '^enc:v1:[A-Za-z0-9_-]{1,40}:[A-Za-z0-9_-]{38,}$'`,
        )
        .catch(() => null);
      if (bad && bad.rows[0].n > 0)
        out.push({
          kind: 'bad_ciphertext',
          object: fq,
          detail: `${bad.rows[0].n} row(s) hold a value that is not a sealed field value`,
        });
    }
    return out;
  } finally {
    await c.end();
  }
}
