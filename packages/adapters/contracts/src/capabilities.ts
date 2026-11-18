/**
 * Capability vocabulary (docs/09 §1-§2, M05 S16). Our ids; they assert nothing about any vendor. `spec/providers/capabilities.schema.json`
 * lists the same ids (capabilities.spec.ts keeps both in sync). Unknown = unsupported.
 */
export const CAPABILITY_IDS = [
  'compute.provision',
  'compute.inspect',
  'compute.delete',
  'compute.action.start',
  'compute.action.stop',
  'compute.action.reboot',
  'compute.action.resize',
  'compute.action.snapshot',
  'compute.metrics',
  'compute.billing-export',
  'compute.find-by-token',
  'compute.quote-api',
] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];
export type CapabilityState = 'supported' | 'unsupported' | 'unknown';

export const COMPUTE_ACTIONS = ['start', 'stop', 'reboot', 'resize', 'snapshot'] as const;
export type ComputeAction = (typeof COMPUTE_ACTIONS)[number];
export const actionCapability = (a: ComputeAction): CapabilityId => `compute.action.${a}`;

export const isCapabilityId = (s: string): s is CapabilityId =>
  (CAPABILITY_IDS as readonly string[]).includes(s);

/** Only an explicit `supported` counts. Missing and `unknown` are unsupported (FR-CLD-02). */
export const isSupported = (
  caps: Partial<Record<CapabilityId, CapabilityState>> | undefined,
  id: CapabilityId,
): boolean => caps?.[id] === 'supported';

/** Every id with an explicit state; ids the probe did not mention become `unknown`. */
export function completeCapabilities(
  partial: Partial<Record<CapabilityId, CapabilityState>>,
): Record<CapabilityId, CapabilityState> {
  const out = {} as Record<CapabilityId, CapabilityState>;
  for (const id of CAPABILITY_IDS) out[id] = partial[id] ?? 'unknown';
  return out;
}
