/**
 * Residency enforcement-hook SDK (M04 S14a, docs/10 §3). Modules that place data, call a vendor or a model MUST ask the residency service first.
 * `assertResidency()` is the helper, `RequiresResidency` the decorator; `spec/compliance/residency-hooks.yaml` lists every call site that is required
 * and its owner milestone. This file has no I/O and no Nest dependency: the evaluator is passed in.
 */
export const DATA_CLASSES = [
  'public',
  'internal',
  'customer-content',
  'personal',
  'financial',
  'credentials',
] as const;
export type DataClassKey = (typeof DATA_CLASSES)[number];

export interface ResidencyRequest {
  orgId: string;
  dataClass: DataClassKey;
  /** A region id of the provider registry (`sa-central`), an ISO country code (`SA`) or a region group (`gcc`). */
  targetRegion: string;
  purpose: string;
  /** The vendor/processor that receives the data, as named in the ROPA. Must exist there, else the answer is deny. */
  processorId?: string;
  /** `write` = a mutation path (denials are audited and failures fail closed); `read` = a read path. */
  operation: 'write' | 'read';
}
export type ResidencyDecision = 'allow' | 'deny' | 'requires_assessment';
export interface ResidencyReason {
  code: string;
  message: { ar: string; en: string };
}
export interface ResidencyResult {
  decision: ResidencyDecision;
  reasons: ResidencyReason[];
  policyVersion: number | null;
  floorVersion: number | null;
  assessmentId: string | null;
  evidenceRef: string;
}
export interface ResidencyEvaluator {
  evaluate(req: ResidencyRequest): Promise<ResidencyResult>;
}

/** Thrown by `assertResidency` (HTTP 403 `residency_denied` in the API). Carries the non-technical reasons, in both languages. */
export class ResidencyDenied extends Error {
  readonly code = 'residency_denied';
  constructor(readonly result: ResidencyResult) {
    super(`residency ${result.decision}: ${result.reasons.map((r) => r.code).join(', ')}`);
  }
}

/** Ask, and refuse unless the answer is `allow`. `requires_assessment` is a refusal here: an approved assessment must exist first. */
export async function assertResidency(
  evaluator: ResidencyEvaluator,
  req: ResidencyRequest,
): Promise<ResidencyResult> {
  const r = await evaluator.evaluate(req);
  if (r.decision !== 'allow') throw new ResidencyDenied(r);
  return r;
}

/**
 * Decorator for a class method: `@RequiresResidency((orgId, dto) => ({ orgId, dataClass: 'personal', targetRegion: dto.region, purpose: 'provisioning', operation: 'write' }))`.
 * The class must expose its evaluator as `this.residency`. The check runs BEFORE the method body, so a denied call does nothing.
 */
export function RequiresResidency<A extends unknown[]>(
  resolve: (...args: A) => ResidencyRequest | Promise<ResidencyRequest>,
) {
  return (_target: object, _key: string | symbol, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: A) => unknown;
    descriptor.value = async function (this: { residency?: ResidencyEvaluator }, ...args: A) {
      if (!this.residency)
        throw new Error('RequiresResidency: the class has no `residency` evaluator (fail closed)');
      await assertResidency(this.residency, await resolve(...args));
      return original.apply(this, args);
    };
  };
}
