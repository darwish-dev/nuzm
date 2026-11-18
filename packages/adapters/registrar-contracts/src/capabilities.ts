import type { CapabilityState } from './mirror/base';

/**
 * Registrar capability vocabulary (docs/09 §4, M07 S28). Our ids; they assert nothing about any vendor. Unknown = unsupported: only an explicit
 * `supported` unlocks an action. Stored as `kind=registrar` rows of the capability matrix (`cloud.provider_capabilities` once M05 lands).
 */
export const REGISTRAR_CAPABILITY_IDS = [
  'registrar.search',
  'registrar.register',
  'registrar.transfer-in',
  'registrar.renew',
  'registrar.contacts',
  'registrar.nameservers',
  'registrar.lock',
  'registrar.auth-code',
  'registrar.privacy',
  'registrar.dns',
  'registrar.dnssec',
  'registrar.find-by-token',
  'registrar.eligibility',
  'registrar.billing-export',
  'registrar.webhooks',
] as const;
export type RegistrarCapabilityId = (typeof REGISTRAR_CAPABILITY_IDS)[number];

export const isRegistrarCapabilityId = (s: string): s is RegistrarCapabilityId =>
  (REGISTRAR_CAPABILITY_IDS as readonly string[]).includes(s);

export const isSupported = (
  caps: Partial<Record<RegistrarCapabilityId, CapabilityState>> | undefined,
  id: RegistrarCapabilityId,
): boolean => caps?.[id] === 'supported';

export function completeCapabilities(
  partial: Partial<Record<RegistrarCapabilityId, CapabilityState>>,
): Record<RegistrarCapabilityId, CapabilityState> {
  const out = {} as Record<RegistrarCapabilityId, CapabilityState>;
  for (const id of REGISTRAR_CAPABILITY_IDS) out[id] = partial[id] ?? 'unknown';
  return out;
}
