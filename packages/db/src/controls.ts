import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { parse } from 'yaml';

/** The collectors that exist (collectors.ts); a control may name only these as automated evidence. */
export const COLLECTOR_NAMES = [
  'db.ownership-rls-check',
  'db.classification-coverage',
  'audit.chain-verification',
  'db.migration-lint',
  'scan.secrets-and-lockfile',
  'config.security-snapshot',
  'compliance.ropa-coverage',
  'compliance.residency-hooks',
] as const;

export interface ControlDef {
  id: string;
  title: string;
  description: string;
  frameworks: { framework: string; version: string; ref: string }[];
  applicability: 'to_confirm';
  ownerRole: string;
  implementation: { status: string; modules: string[]; milestone: string };
  evidence: ({ type: 'automated'; collector: string } | { type: 'manual'; description: string })[];
  reviewCadenceDays: number;
  claimsCompliance: false;
}

const OWNER_ROLES = ['security', 'compliance_officer', 'platform_admin'];
const IMPL = ['not_started', 'partial', 'implemented', 'not_applicable'];

/**
 * Validate spec/compliance/controls.yaml (M04 §4 task 12). Every problem is reported at once. `claims_compliance` must be present AND exactly false,
 * applicability must be `to_confirm` (only a human with counsel decides otherwise, through the validation register), and automated evidence may name
 * only a collector that exists. A bad file stops the load: nothing half-applies.
 */
export function parseControls(text: string): ControlDef[] {
  const errors: string[] = [];
  const raw = parse(text) as { version?: unknown; controls?: unknown } | null;
  if (!raw || typeof raw !== 'object') throw new Error('controls: not a mapping');
  if (!Array.isArray(raw.controls) || raw.controls.length === 0)
    throw new Error('controls: controls must be a non-empty list');
  const seen = new Set<string>();
  const out: ControlDef[] = [];
  (raw.controls as Record<string, unknown>[]).forEach((c, i) => {
    const at = (f: string) => `controls[${i}]${typeof c?.id === 'string' ? ` (${c.id})` : ''}.${f}`;
    const bad = (f: string, m: string) => errors.push(`${at(f)}: ${m}`);
    const id = c?.id;
    if (typeof id !== 'string' || !/^CTL-[A-Z]{2,6}-[0-9]{3}$/.test(id))
      bad('id', 'must look like CTL-ABC-001');
    else if (seen.has(id)) bad('id', 'is repeated');
    else seen.add(id);
    const title = c?.title;
    if (typeof title !== 'string' || title.length < 3 || title.length > 200)
      bad('title', 'must be 3..200 characters');
    const description = c?.description ?? '';
    if (typeof description !== 'string' || description.length > 1000)
      bad('description', 'must be at most 1000 characters');
    const fw = c?.frameworks ?? [];
    if (
      !Array.isArray(fw) ||
      fw.some(
        (f: Record<string, unknown>) =>
          typeof f?.framework !== 'string' ||
          typeof f?.version !== 'string' ||
          typeof f?.ref !== 'string',
      )
    )
      bad('frameworks', 'must be a list of {framework, version, ref} strings');
    if (c?.applicability !== 'to_confirm')
      bad('applicability', 'must be to_confirm: only a human with counsel decides otherwise');
    if (typeof c?.owner_role !== 'string' || !OWNER_ROLES.includes(c.owner_role))
      bad('owner_role', `must be one of ${OWNER_ROLES.join(', ')}`);
    const impl = c?.implementation as Record<string, unknown> | undefined;
    if (
      !impl ||
      typeof impl.status !== 'string' ||
      !IMPL.includes(impl.status) ||
      !Array.isArray(impl.modules) ||
      impl.modules.some((m) => typeof m !== 'string') ||
      typeof impl.milestone !== 'string' ||
      !/^M\d{2}$/.test(impl.milestone)
    )
      bad('implementation', `must be {status: ${IMPL.join('|')}, modules: [..], milestone: Mnn}`);
    const ev = c?.evidence ?? [];
    if (!Array.isArray(ev)) bad('evidence', 'must be a list');
    else
      ev.forEach((e: Record<string, unknown>, j: number) => {
        if (e?.type === 'automated') {
          if (
            typeof e.collector !== 'string' ||
            !(COLLECTOR_NAMES as readonly string[]).includes(e.collector)
          )
            bad(`evidence[${j}].collector`, `must be one of ${COLLECTOR_NAMES.join(', ')}`);
        } else if (e?.type === 'manual') {
          if (typeof e.description !== 'string' || e.description.length < 3)
            bad(`evidence[${j}].description`, 'is required');
        } else bad(`evidence[${j}].type`, "must be 'automated' or 'manual'");
      });
    const cad = c?.review_cadence_days;
    if (!Number.isInteger(cad) || (cad as number) < 1 || (cad as number) > 730)
      bad('review_cadence_days', 'must be 1..730');
    if (c?.claims_compliance !== false)
      bad(
        'claims_compliance',
        'must be present and exactly false: no control file may claim compliance',
      );
    if (errors.length === 0 || !errors.some((e) => e.startsWith(`controls[${i}]`)))
      out.push({
        id: id as string,
        title: title as string,
        description: description as string,
        frameworks: fw as ControlDef['frameworks'],
        applicability: 'to_confirm',
        ownerRole: c.owner_role as string,
        implementation: impl as ControlDef['implementation'],
        evidence: ev as ControlDef['evidence'],
        reviewCadenceDays: cad as number,
        claimsCompliance: false,
      });
  });
  if (errors.length)
    throw new Error(`controls: ${errors.length} problem(s):\n - ${errors.join('\n - ')}`);
  return out;
}

const digest = (c: ControlDef) => createHash('sha256').update(JSON.stringify(c)).digest('hex');

export interface SyncResult {
  inserted: string[];
  updated: string[];
  unchanged: string[];
  /** In the database but no longer in the file: kept (evidence may reference them), reported. */
  orphaned: string[];
}

/** Load the catalog into the database under the admin role. Idempotent; never touches mappings or evidence. */
export async function syncControls(url: string, path: string): Promise<SyncResult> {
  const defs = parseControls(readFileSync(path, 'utf8'));
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    const have = new Map<string, string>(
      (await c.query(`SELECT control_id, source_digest FROM compliance.control_catalog`)).rows.map(
        (r) => [r.control_id as string, r.source_digest as string],
      ),
    );
    const res: SyncResult = { inserted: [], updated: [], unchanged: [], orphaned: [] };
    for (const d of defs) {
      const dg = digest(d);
      const prior = have.get(d.id);
      if (prior === dg) {
        res.unchanged.push(d.id);
        continue;
      }
      await c.query(
        `INSERT INTO compliance.control_catalog (control_id, title, description, frameworks, applicability, owner_role, implementation, evidence_spec, review_cadence_days, claims_compliance, source_digest)
         VALUES ($1,$2,$3,$4::jsonb,'to_confirm',$5,$6::jsonb,$7::jsonb,$8,false,$9)
         ON CONFLICT (control_id) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, frameworks = EXCLUDED.frameworks,
           owner_role = EXCLUDED.owner_role, implementation = EXCLUDED.implementation, evidence_spec = EXCLUDED.evidence_spec,
           review_cadence_days = EXCLUDED.review_cadence_days, source_digest = EXCLUDED.source_digest, loaded_at = now()`,
        [
          d.id,
          d.title,
          d.description,
          JSON.stringify(d.frameworks),
          d.ownerRole,
          JSON.stringify(d.implementation),
          JSON.stringify(d.evidence),
          d.reviewCadenceDays,
          dg,
        ],
      );
      (prior ? res.updated : res.inserted).push(d.id);
    }
    const ids = new Set(defs.map((d) => d.id));
    res.orphaned = [...have.keys()].filter((k) => !ids.has(k));
    await c.query('COMMIT');
    return res;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}
