import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import type { Manifest } from './migrations';

export interface RopaViolation {
  kind:
    | 'adapter_kind_without_entry'
    | 'entry_for_unknown_adapter_kind'
    | 'data_class_without_entry'
    | 'no_adapter_kinds_found';
  object: string;
  detail: string;
}
export interface RopaEntryRef {
  entryKey: string;
  kind: 'activity' | 'adapter';
  adapterKind: string | null;
  dataClasses: string[];
}

/** The adapter kinds of docs/09 §1 (`readonly kind: 'compute'|'hosting'|…`). The document is the source of truth: it is read, never edited. */
export function adapterKindsFromDocs(text: string): string[] {
  const m = /readonly kind:\s*((?:'[a-z-]+'\s*\|?\s*)+)/.exec(text);
  return m ? [...m[1]!.matchAll(/'([a-z-]+)'/g)].map((x) => x[1]!) : [];
}

/** Data classes that appear on at least one column in the classification manifest. */
export function classesInUse(manifest: Manifest): string[] {
  const used = new Set<string>();
  for (const cols of Object.values(manifest.classification.columns))
    for (const c of Object.values(cols)) used.add(c);
  return [...used].sort();
}

/**
 * AC-M04-04: every adapter kind of docs/09 has a current ROPA entry, and every data class in use appears in at least one current entry.
 * `entries` are the CURRENT versions only. An adapter entry for a kind that no longer exists is reported (a stale placeholder).
 */
export function evaluateRopaCoverage(
  adapterKinds: string[],
  classes: string[],
  entries: RopaEntryRef[],
): RopaViolation[] {
  if (adapterKinds.length === 0)
    return [
      {
        kind: 'no_adapter_kinds_found',
        object: 'docs/09',
        detail: 'no adapter kinds could be read from docs/09 §1',
      },
    ];
  const out: RopaViolation[] = [];
  const have = new Set(entries.filter((e) => e.kind === 'adapter').map((e) => e.adapterKind));
  for (const k of adapterKinds)
    if (!have.has(k))
      out.push({
        kind: 'adapter_kind_without_entry',
        object: k,
        detail: `no ROPA entry for adapter kind "${k}" (docs/09 §1)`,
      });
  for (const k of have)
    if (k && !adapterKinds.includes(k))
      out.push({
        kind: 'entry_for_unknown_adapter_kind',
        object: k,
        detail: 'ROPA entry for an adapter kind that docs/09 does not list',
      });
  const covered = new Set(entries.flatMap((e) => e.dataClasses));
  for (const c of classes)
    if (!covered.has(c))
      out.push({
        kind: 'data_class_without_entry',
        object: c,
        detail: `data class "${c}" is in use but no ROPA entry lists it`,
      });
  return out;
}

export async function checkRopaCoverage(
  url: string,
  manifest: Manifest,
  docs09Path: string,
): Promise<RopaViolation[]> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query<{
      entry_key: string;
      kind: 'activity' | 'adapter';
      adapter_kind: string | null;
      data_classes: string[];
    }>(
      `SELECT DISTINCT ON (entry_key) entry_key, kind, adapter_kind, data_classes
         FROM compliance.ropa_entries WHERE org_id IS NULL ORDER BY entry_key, version DESC`,
    );
    return evaluateRopaCoverage(
      adapterKindsFromDocs(readFileSync(docs09Path, 'utf8')),
      classesInUse(manifest),
      r.rows.map((x) => ({
        entryKey: x.entry_key,
        kind: x.kind,
        adapterKind: x.adapter_kind,
        dataClasses: x.data_classes,
      })),
    );
  } finally {
    await c.end();
  }
}
