import type { Db } from '@nuzm/platform';
import { checkApprovalEvidence, REQUIRED_APPROVALS } from './approval-evidence';

/** Default OFF. The deterministic repair engine (error classes, fixers, guards, corpus) replaces the legacy rule-based + single-shot model repair. */
export const BUILDER_LIFECYCLE_REPAIR_ENGINE_FLAG = 'builder_lifecycle.repair_engine';
/**
 * Default OFF. The REAL path: the lifecycle runs only with the model gateway AND a real build port, with the owner approvals recorded on the flag row, and REFUSES (a specific code,
 * no silent fallback to placeholders or the mock) when any of them is missing. The flag row's value is `{ "enabled": true, "approvals": [{ "id", "ref", "recordedAt" }, ...] }`.
 */
export const BUILDER_LIFECYCLE_REAL_PATH_FLAG = 'builder_lifecycle.real_path';

/** the raw value of a flag row (an organization row beats the global row), or null */
export async function flagValue(db: Db, orgId: string, key: string): Promise<unknown> {
  const row = await db.withOrg(
    orgId,
    async (c) =>
      (
        await c.query(
          `SELECT value FROM platform.feature_flags WHERE key = $1 AND (org_id = $2 OR org_id IS NULL) ORDER BY org_id NULLS LAST LIMIT 1`,
          [key, orgId],
        )
      ).rows[0],
  );
  return row?.value ?? null;
}

export interface RealPathFacts {
  /** the raw flag value */
  flag: unknown;
  /** `builder_lifecycle.model_generation` is on */
  modelFlagOn: boolean;
  gatewayPresent: boolean;
  /** the build port the environment would use; null when there is none */
  buildPort: { origin: 'MOCK' | 'REAL' } | null;
}
export type RealPathCode =
  | 'real_path_approval_missing'
  | 'model_generation_off'
  | 'model_unavailable'
  | 'real_runtime_unavailable'
  | 'real_runtime_simulated';
export type RealPathDecision =
  { ok: true; gates: string[] } | { ok: false; code: RealPathCode; detail: string[] };

/** the owner approvals the real path needs: those of the model track and of the runtime track together */
export const REAL_PATH_APPROVALS = [...REQUIRED_APPROVALS.C, ...REQUIRED_APPROVALS.E];

const enabled = (v: unknown): boolean =>
  v === true ||
  (typeof v === 'object' && v !== null && (v as { enabled?: unknown }).enabled === true);

/**
 * Decides whether a run may use the real path. Pure. The order is the order of the checks and each refusal has its own code, so a refusal says what is missing:
 * 1. the flag value carries the recorded approvals (D2, D4, D5, D6, D9, D-21, HG-10-02, ADR-069, ISOLATION-ATTESTATION, each with a reference and a date);
 * 2. model generation is on; 3. a model gateway is wired; 4. a build port exists; 5. that port is a REAL one (a mock or twin port is refused, never accepted as "real").
 * This gate is a software check of recorded references: the real gates are the model gateway's verified-provider rules (S01) and the real port's isolation attestation (S02).
 */
export function decideRealPath(f: RealPathFacts): RealPathDecision {
  const approvals =
    (typeof f.flag === 'object' && f.flag !== null
      ? (f.flag as { approvals?: unknown }).approvals
      : undefined) ?? [];
  const missing = new Set<string>();
  for (const track of ['C', 'E'] as const) {
    const c = checkApprovalEvidence(track, { track, approvals });
    if (!c.ok) for (const m of c.missing) missing.add(m);
  }
  if (!enabled(f.flag) || missing.size > 0)
    return {
      ok: false,
      code: 'real_path_approval_missing',
      detail: enabled(f.flag) ? [...missing] : ['flag_off'],
    };
  if (!f.modelFlagOn) return { ok: false, code: 'model_generation_off', detail: [] };
  if (!f.gatewayPresent) return { ok: false, code: 'model_unavailable', detail: [] };
  if (!f.buildPort) return { ok: false, code: 'real_runtime_unavailable', detail: [] };
  if (f.buildPort.origin !== 'REAL')
    return { ok: false, code: 'real_runtime_simulated', detail: [f.buildPort.origin] };
  return { ok: true, gates: ['approvals', 'model_generation', 'gateway', 'real_build_port'] };
}
