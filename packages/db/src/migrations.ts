import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export interface Manifest {
  schemas: Record<
    string,
    { owner_module: string; created_by: string; extended_by: string[]; tables: string[] }
  >;
  tenant_less: string[];
  /** Tables isolated by RLS on their own key instead of an org_id column (e.g. tenancy.organizations by id). */
  rls_keyed: string[];
  migration_ranges: Record<string, string>;
}

export interface MigrationFile {
  ordinal: number;
  schema: string;
  slug: string;
  up: string;
  down: string | null;
  sql: string;
  downSql: string | null;
  checksum: string;
}

const FILE = /^(\d{4})__([a-z_]+)__([a-z0-9_]+)(\.down)?\.sql$/;

export function loadManifest(path: string): Manifest {
  const raw = parse(readFileSync(path, 'utf8')) as Partial<Manifest>;
  return {
    schemas: raw.schemas ?? {},
    tenant_less: raw.tenant_less ?? [],
    rls_keyed: raw.rls_keyed ?? [],
    migration_ranges: raw.migration_ranges ?? {},
  };
}

export function parseRange(range: string): [number, number] {
  const m = /^(\d{4})-(\d{4})$/.exec(range);
  if (!m) throw new Error(`bad migration range "${range}"`);
  return [Number(m[1]), Number(m[2])];
}

export function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

/** Discover migrations on disk and validate naming, ownership, ranges, uniqueness and reversal files. */
export function discoverMigrations(dir: string, manifest: Manifest): MigrationFile[] {
  const errors: string[] = [];
  const ups = new Map<number, MigrationFile>();
  const downs = new Map<number, string>();

  for (const schemaDir of readdirSync(dir)) {
    const full = join(dir, schemaDir);
    if (!statSync(full).isDirectory()) continue;
    const owner = manifest.schemas[schemaDir];
    if (!owner) {
      errors.push(`directory "${schemaDir}" is not a schema in the ownership manifest`);
      continue;
    }
    const allowed = [owner.created_by, ...owner.extended_by].map((m) => {
      const r = manifest.migration_ranges[m];
      if (!r) throw new Error(`no migration range for ${m}`);
      return parseRange(r);
    });
    for (const file of readdirSync(full)) {
      const m = FILE.exec(file);
      if (!m) {
        errors.push(`${schemaDir}/${file}: name must match NNNN__<schema>__<slug>[.down].sql`);
        continue;
      }
      const ordinal = Number(m[1]);
      if (m[2] !== schemaDir)
        errors.push(`${schemaDir}/${file}: schema in file name differs from directory`);
      if (!allowed.some(([lo, hi]) => ordinal >= lo && ordinal <= hi)) {
        errors.push(
          `${schemaDir}/${file}: ordinal ${ordinal} outside ranges allowed for ${schemaDir}`,
        );
      }
      const sql = readFileSync(join(full, file), 'utf8');
      if (m[4]) {
        downs.set(ordinal, sql);
      } else {
        if (ups.has(ordinal)) errors.push(`ordinal ${ordinal} is used twice`);
        ups.set(ordinal, {
          ordinal,
          schema: schemaDir,
          slug: m[3]!,
          up: file,
          down: null,
          sql,
          downSql: null,
          checksum: checksum(sql),
        });
      }
    }
  }
  for (const [ordinal, mig] of ups) {
    const down = downs.get(ordinal);
    if (down === undefined)
      errors.push(`${mig.schema}/${mig.up}: missing .down.sql (documented reversal required)`);
    else mig.downSql = down;
  }
  for (const ordinal of downs.keys()) {
    if (!ups.has(ordinal)) errors.push(`down file for ordinal ${ordinal} has no up migration`);
  }
  if (errors.length) throw new Error('Invalid migrations:\n - ' + errors.join('\n - '));
  return [...ups.values()].sort((a, b) => a.ordinal - b.ordinal);
}
