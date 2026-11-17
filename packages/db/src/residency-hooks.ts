import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { parse } from 'yaml';

export interface HookViolation {
  kind:
    | 'table_without_hook'
    | 'stale_table'
    | 'unknown_hook'
    | 'duplicate_hook'
    | 'bad_hook'
    | 'enforced_without_call_site'
    | 'exempt_without_reason'
    | 'adapter_kind_without_hook'
    | 'milestone_without_hook';
  object: string;
  detail: string;
}
export interface HookRegistry {
  tables: Record<string, { owner: string; hook: string }>;
  hooks: {
    id: string;
    milestone: string;
    where: string;
    data_classes: string[];
    processor_kind?: string;
    enforcement: string;
    flag: string;
    call_site: string | null;
    exempt_reason?: string;
  }[];
}
export const loadHookRegistry = (path: string): HookRegistry => {
  const raw = parse(readFileSync(path, 'utf8')) as Partial<HookRegistry> | null;
  return { tables: raw?.tables ?? {}, hooks: raw?.hooks ?? [] };
};

const MILESTONES = ['M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'M09', 'M10', 'M11', 'M12'];
const MARKER = /assertResidency\(|RequiresResidency\(|residency\.evaluate\(/;

/**
 * AC-M04-14: the registry lists every required call site. Rules: every table with a `data_region` column is registered and points at a known hook;
 * no stale table; hook ids are unique and well-formed; an `enforced` hook names a real source file that calls the residency service; an `exempt` hook
 * says why; every adapter kind of docs/09 has a hook; every milestone M05..M12 has at least one.
 */
export function evaluateHooks(
  reg: HookRegistry,
  regionTables: string[],
  adapterKinds: string[],
  readSource: (path: string) => string | null,
): HookViolation[] {
  const out: HookViolation[] = [];
  const ids = new Set<string>();
  for (const h of reg.hooks) {
    if (ids.has(h.id))
      out.push({ kind: 'duplicate_hook', object: h.id, detail: 'hook id used twice' });
    ids.add(h.id);
    if (
      !/^m\d{2}-[a-z0-9-]+$/.test(h.id) ||
      !MILESTONES.includes(h.milestone) ||
      !h.id.startsWith(h.milestone.toLowerCase() + '-')
    )
      out.push({
        kind: 'bad_hook',
        object: h.id,
        detail: 'id must be <milestone>-<name> with a known milestone',
      });
    if (!['listed', 'enforced', 'exempt'].includes(h.enforcement))
      out.push({
        kind: 'bad_hook',
        object: h.id,
        detail: `enforcement "${h.enforcement}" is not listed, enforced or exempt`,
      });
    if (
      !h.where ||
      h.where.length < 10 ||
      !h.flag ||
      !Array.isArray(h.data_classes) ||
      h.data_classes.length === 0
    )
      out.push({ kind: 'bad_hook', object: h.id, detail: 'needs where, data_classes and a flag' });
    if (h.enforcement === 'enforced') {
      const src = h.call_site ? readSource(h.call_site) : null;
      if (src === null || !MARKER.test(src))
        out.push({
          kind: 'enforced_without_call_site',
          object: h.id,
          detail:
            'an enforced hook must name a source file that calls assertResidency, RequiresResidency or residency.evaluate',
        });
    }
    if (h.enforcement === 'exempt' && (!h.exempt_reason || h.exempt_reason.length < 10))
      out.push({
        kind: 'exempt_without_reason',
        object: h.id,
        detail: 'an exempt hook needs a reason of 10+ characters',
      });
  }
  for (const t of regionTables) {
    const e = reg.tables[t];
    if (!e)
      out.push({
        kind: 'table_without_hook',
        object: t,
        detail: 'a table with a data_region column must be registered with its owner and hook',
      });
    else if (!ids.has(e.hook))
      out.push({
        kind: 'unknown_hook',
        object: t,
        detail: `hook ${e.hook} is not in the hook list`,
      });
  }
  for (const t of Object.keys(reg.tables))
    if (!regionTables.includes(t))
      out.push({
        kind: 'stale_table',
        object: t,
        detail: 'registered but it has no data_region column',
      });
  const kinds = new Set(reg.hooks.map((h) => h.processor_kind).filter(Boolean));
  for (const k of adapterKinds)
    if (!kinds.has(k))
      out.push({
        kind: 'adapter_kind_without_hook',
        object: k,
        detail: `no hook covers adapter kind "${k}" (docs/09)`,
      });
  for (const m of ['M05', 'M06', 'M07', 'M08', 'M09', 'M10', 'M11', 'M12'])
    if (!reg.hooks.some((h) => h.milestone === m))
      out.push({
        kind: 'milestone_without_hook',
        object: m,
        detail: 'AC-M04-14: every milestone M05..M12 lists its required call sites',
      });
  return out;
}

export async function checkResidencyHooks(
  url: string,
  registryPath: string,
  docs09Path: string,
  root: string,
  kinds: (text: string) => string[],
): Promise<HookViolation[]> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query<{ t: string }>(
      `SELECT n.nspname || '.' || c.relname AS t FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE a.attname = 'data_region' AND NOT a.attisdropped AND c.relkind IN ('r','p') AND NOT c.relispartition AND c.relname !~ '^archived_' ORDER BY 1`,
    );
    return evaluateHooks(
      loadHookRegistry(registryPath),
      r.rows.map((x) => x.t),
      kinds(readFileSync(docs09Path, 'utf8')),
      (p) => {
        const f = join(root, p);
        return existsSync(f) ? readFileSync(f, 'utf8') : null;
      },
    );
  } finally {
    await c.end();
  }
}
