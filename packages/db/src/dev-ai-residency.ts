/**
 * DEV ONLY: lets customer content go to Claude in a local development database. Two records, both clearly labelled and both refusing a non-local database:
 *  1. the record of processing (ROPA) learns that the processor `claude` receives `customer-content` in the US: a new DRAFT version of `adapter:model`,
 *     change note "dev seed ... NOT a DPO review" (the admin console has no screen for editing processors);
 *  2. with an organization given, that organization's residency policy becomes `allow_listed` with `US` added for `customer-content`. The organization keeps
 *     every other country it already allowed, and the policy stays as strict as the platform floor makes it.
 * Neither is a legal assessment: a real deployment needs the DPO's review and a transfer assessment (HG-04-01, D-14). Idempotent.
 */
import { Client } from 'pg';

export interface AiResidencyReport {
  ropa: string[];
  residency: string[];
}

const PROCESSOR = {
  name: 'claude',
  role: 'processor',
  region: 'US',
  dataClasses: ['customer-content'],
  contractRef: null,
};

export async function devSeedAiResidency(url: string, org?: string): Promise<AiResidencyReport> {
  if (!['127.0.0.1', 'localhost', '::1'].includes(new URL(url).hostname))
    throw new Error('dev-seed-ai-residency only runs against a local database');
  const out: AiResidencyReport = { ropa: [], residency: [] };
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    const cur = (
      await c.query(
        `SELECT version, processors FROM compliance.ropa_entries WHERE entry_key = 'adapter:model' AND org_id IS NULL ORDER BY version DESC LIMIT 1`,
      )
    ).rows[0] as
      { version: number; processors: { name: string; dataClasses?: string[] }[] } | undefined;
    if (!cur) throw new Error('no adapter:model entry in the record of processing: migrate first');
    const has = cur.processors.some(
      (p) => p.name === PROCESSOR.name && (p.dataClasses ?? []).includes('customer-content'),
    );
    if (!has) {
      await c.query(
        `INSERT INTO compliance.ropa_entries (id, entry_key, version, org_id, kind, adapter_kind, activity, purpose, data_classes, processors, regions, retention_ref, status, change_note)
         SELECT gen_random_uuid(), entry_key, $2, NULL, kind, adapter_kind, activity, purpose, data_classes, $3::jsonb, regions, retention_ref, 'draft',
                'dev seed: Claude as a processor of customer content in the US, NOT a DPO review'
           FROM compliance.ropa_entries WHERE entry_key = 'adapter:model' AND org_id IS NULL AND version = $1`,
        [
          cur.version,
          cur.version + 1,
          JSON.stringify([...cur.processors.filter((p) => p.name !== PROCESSOR.name), PROCESSOR]),
        ],
      );
      out.ropa.push('claude (customer-content, US)');
    }
    if (org) {
      const o = (
        await c.query(
          `SELECT id, name FROM tenancy.organizations WHERE id::text = $1 OR lower(name) = lower($1) OR lower(slug) = lower($1) ORDER BY created_at LIMIT 2`,
          [org],
        )
      ).rows as { id: string; name: string }[];
      if (o.length !== 1)
        throw new Error(`organization "${org}" not found (or ambiguous: pass its id)`);
      const pol = (
        await c.query(
          `SELECT version, mode, allowed, exceptions FROM compliance.residency_policies WHERE org_id = $1 ORDER BY version DESC LIMIT 1`,
          [o[0]!.id],
        )
      ).rows[0] as
        | {
            version: number;
            mode: string;
            allowed: { allowedCountriesByClass?: Record<string, string[]> };
            exceptions: string[];
          }
        | undefined;
      const have = pol?.allowed?.allowedCountriesByClass?.['customer-content'] ?? [];
      if (pol?.mode !== 'allow_listed' || !have.includes('US')) {
        await c.query(
          `INSERT INTO compliance.residency_policies (id, org_id, version, mode, allowed, exceptions, change_note)
           VALUES (gen_random_uuid(), $1, $2, 'allow_listed', $3::jsonb, $4::uuid[], 'dev seed: allow the US for customer content so Claude can be used')`,
          [
            o[0]!.id,
            (pol?.version ?? 0) + 1,
            JSON.stringify({
              allowedCountriesByClass: {
                ...(pol?.allowed?.allowedCountriesByClass ?? {}),
                'customer-content': [...new Set([...have, 'US'])],
              },
            }),
            pol?.exceptions ?? [],
          ],
        );
        out.residency.push(`${o[0]!.name}: customer content allowed in US`);
      }
    }
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}
