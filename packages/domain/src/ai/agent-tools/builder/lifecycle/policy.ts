/**
 * Two small policies of PHASE-2 S05, both pure and both with a DEFAULT THAT EQUALS TODAY'S BEHAVIOUR (nothing changes until an owner or admin sets it, and an owner decision
 * records any change of the default in the approval pack).
 */

// ---- O-9: may a billing administrator read the CONTENT of a project (review, symbols, imports, components, memory)? ---------------------------------------------------------
export const CONTENT_ACCESS_KEY = 'builder.billing_admin_content_access';
export type ContentAccessMode = 'allow' | 'deny';
/** today: `billing_admin` holds `builder:read`, so it reads all of these */
export const CONTENT_ACCESS_DEFAULT: ContentAccessMode = 'allow';
export const CONTENT_OPERATIONS = [
  // the builder-tools reads (first batch)
  'review',
  'symbols',
  'imports',
  'components',
  'memory',
  // the rest of the content-returning reads of the builder, app-builder and studio routes (S07's O-9 audit, DEFECT-16)
  'version_diff',
  'file_content',
  'file_search',
  'template_workspace',
  'generation_plan',
  'claude_code',
  'instructions',
  'test_runs',
  'previews',
  'forms',
  'form_submissions',
  'cms',
  // deployments (S06's `deploy` module uses the same guard): a deployment's detail and its logs, not the policy or the list
  'deployment',
  'deployment_logs',
] as const;
export type ContentOperation = (typeof CONTENT_OPERATIONS)[number];

/**
 * The stored value: absent = the default. A value that is PRESENT but not understood is read as `deny`: a damaged policy must never open more than it was meant to
 * (CLAUDE.md §11, the more restrictive and reversible choice).
 */
export function parseContentAccess(raw: unknown): ContentAccessMode {
  if (raw === undefined || raw === null) return CONTENT_ACCESS_DEFAULT;
  const v = typeof raw === 'object' && !Array.isArray(raw) ? (raw as { mode?: unknown }).mode : raw;
  return v === 'allow' || v === 'deny' ? v : 'deny';
}

export type ContentAccessDecision =
  { allowed: true } | { allowed: false; code: 'billing_admin_content_denied' };

/** Only the `billing_admin` role is ever affected: every other role keeps exactly what its permissions give it. */
export function decideContentAccess(role: string, mode: ContentAccessMode): ContentAccessDecision {
  return role === 'billing_admin' && mode === 'deny'
    ? { allowed: false, code: 'billing_admin_content_denied' }
    : { allowed: true };
}

// ---- inference cost vs execution cost ---------------------------------------------------------------------------------------------------------------------------------------
/**
 * Why this exists (REPORT-05, Phase 2): starting a sandbox checked the organization's AI WALLET, so a release build of an app that no model touched was refused with
 * `budget_required` when the wallet was empty. Two different costs were being gated by one balance:
 *
 *   inference : tokens a model call uses. Gated and settled by the model gateway (ADR-061): reservation → provider → settlement against the wallet. Meters `ai.*`.
 *   execution : time a sandbox or build runner uses. Gated by the plan's build allowance (docs/12: `builder.build_minutes`, an INCLUDED meter with a hard quota) and the platform
 *               ceilings (concurrent sandboxes, lifetime, cpu). Meters `builder.build_minutes` and `ai.sandbox_cpu_seconds`.
 *
 * Nothing becomes free: execution is still gated, still hard-capped and always metered. Only the WRONG gate (the AI wallet) is removed from work that uses no inference.
 */
export type ExecutionPurpose = 'release_build' | 'user_sandbox' | 'ai_run_build' | 'inference_only';

export interface CostClasses {
  inference: boolean;
  execution: boolean;
}
export const costClassesOf = (p: ExecutionPurpose): CostClasses => ({
  inference: p === 'inference_only',
  execution: p !== 'inference_only',
});

export interface StartFacts {
  /** `builder_billing_separation` for this organization (default OFF = today's behaviour) */
  separationEnabled: boolean;
  /** residency decision for the placement (always required) */
  residencyAllowed: boolean;
  /** the platform ceilings: concurrent sandboxes per organization, lifetime, cpu quota (always required) */
  platformCeilingOk: boolean;
  /** the AI wallet, in minor units available */
  aiCreditMinor: number;
  /** the plan's build allowance (`QuotaService.check` on the build meter group) */
  buildQuota: { allowed: boolean; measured: boolean };
}
export type StartDecision =
  | { allowed: true; gates: string[]; mustMeter: string[] }
  | {
      allowed: false;
      code: 'residency_denied' | 'sandbox_quota_exceeded' | 'budget_required' | 'quota_exceeded';
      gate: string;
      gates: string[];
    };

/** The meters every execution must emit, whatever gate admitted it: there is no unmetered execution. */
export const EXECUTION_METERS = ['builder.build_minutes', 'ai.sandbox_cpu_seconds'] as const;

export function decideExecutionStart(p: ExecutionPurpose, f: StartFacts): StartDecision {
  const gates: string[] = [];
  const no = (
    code: Extract<StartDecision, { allowed: false }>['code'],
    gate: string,
  ): StartDecision => ({ allowed: false, code, gate, gates });
  gates.push('residency');
  if (!f.residencyAllowed) return no('residency_denied', 'residency');
  gates.push('platform_ceiling');
  if (!f.platformCeilingOk) return no('sandbox_quota_exceeded', 'platform_ceiling');
  const k = costClassesOf(p);
  // today's rule, kept while the separation switch is off: every sandbox start needs AI credit
  const walletNeeded = !f.separationEnabled || k.inference;
  if (walletNeeded) {
    gates.push('ai_wallet');
    if (f.aiCreditMinor <= 0) return no('budget_required', 'ai_wallet');
  }
  if (f.separationEnabled && k.execution) {
    gates.push('build_allowance');
    if (!f.buildQuota.allowed) return no('quota_exceeded', 'build_allowance');
    // an allowance the plan does not measure is not "unlimited": the platform ceilings above still bound it, and the metering below is mandatory
    if (!f.buildQuota.measured) gates.push('build_allowance_unmeasured');
  }
  return {
    allowed: true,
    gates,
    mustMeter: k.execution ? [...EXECUTION_METERS] : [],
  };
}
