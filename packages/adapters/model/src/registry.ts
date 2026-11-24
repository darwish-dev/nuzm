import {
  V1_1_CAPABILITIES,
  contractAtLeast,
  MODEL_CONTRACT_VERSION_1_1,
  type ModelCapability,
  type DiscoveredModel,
  type ModelInfo,
} from './types';
export type { DiscoveredModel };
import type { RateCardEntry } from './ratecard';

/**
 * Model capability registry and discovery reconciliation (S-AG4, gap G7). PURE. This is the single place that says which capabilities of a model the gateway may rely on;
 * `GatewayService.offers` calls `resolveCapabilities`, and the admin registry view is built from the same function, so what an administrator sees is what the router does.
 *
 * Rule (D8, SCR-K-10): unknown = unsupported. A 1.1 capability counts only when (a) the adapter declares contract >= 1.1.0, (b) the model declares it, (c) the stream/parallel
 * capabilities come with `tool-use`, and (d) for a real provider the latest recorded evidence for (provider, model, capability) is VERIFIED for the adapter's current contract.
 * Development-reference providers (`mock-*`, `local-*`) are exempt from (d).
 */
export interface ResolveInput {
  contractVersion: string;
  declared: readonly ModelCapability[];
  devReference: boolean;
  /** the contract version of the latest VERIFIED evidence row for this capability, if any */
  verifiedContract: (capability: ModelCapability) => string | undefined;
}
export type CapabilityBasis =
  | 'adapter_declared' // a 1.0 capability the adapter declares
  | 'dev_reference' // a 1.1 capability counted without evidence because the provider is a development reference
  | 'evidence_verified' // a 1.1 capability backed by a VERIFIED row for the current contract
  | 'not_declared' // the model does not declare it
  | 'contract_too_old' // declared, but the adapter is below contract 1.1.0
  | 'needs_tool_use' // declared, but without `tool-use` (streamed/parallel calls are meaningless alone)
  | 'no_evidence' // declared under 1.1, real provider, no VERIFIED row for the current contract
  | 'evidence_other_contract'; // a VERIFIED row exists, but for another contract version
export interface CapabilityExplanation {
  capability: ModelCapability;
  declared: boolean;
  effective: boolean;
  basis: CapabilityBasis;
}
export const ALL_CAPABILITIES: readonly ModelCapability[] = [
  'chat',
  'structured-output',
  'long-context',
  'embeddings',
  'vision',
  'tool-use',
  'streaming-tool-calls',
  'parallel-tool-calls',
];

export function explainCapabilities(i: ResolveInput): CapabilityExplanation[] {
  const v11 = contractAtLeast(i.contractVersion, MODEL_CONTRACT_VERSION_1_1);
  const hasTools = i.declared.includes('tool-use');
  return ALL_CAPABILITIES.map((capability): CapabilityExplanation => {
    const declared = i.declared.includes(capability);
    const out = (effective: boolean, basis: CapabilityBasis) => ({
      capability,
      declared,
      effective,
      basis,
    });
    if (!declared) return out(false, 'not_declared');
    if (!V1_1_CAPABILITIES.includes(capability)) return out(true, 'adapter_declared');
    if (!v11) return out(false, 'contract_too_old');
    if (capability !== 'tool-use' && !hasTools) return out(false, 'needs_tool_use');
    if (i.devReference) return out(true, 'dev_reference');
    const ev = i.verifiedContract(capability);
    if (ev === i.contractVersion) return out(true, 'evidence_verified');
    return out(false, ev === undefined ? 'no_evidence' : 'evidence_other_contract');
  });
}
/** The capabilities the gateway may rely on (the `effective` ones), in a stable order. */
export function resolveCapabilities(i: ResolveInput): ModelCapability[] {
  return explainCapabilities(i)
    .filter((e) => e.effective)
    .map((e) => e.capability);
}

// ───────────────────────────── registry ─────────────────────────────

export interface RegistryProviderInput {
  providerCode: string;
  providerId: string;
  contractVersion: string;
  enabled: boolean;
  models: readonly ModelInfo[];
  /** the provider row's rate card; a model without an entry is not offered (unknown price) */
  rateCard: Readonly<Record<string, RateCardEntry>>;
  /** key `providerId|modelId|capability` → contract version of the latest VERIFIED evidence row (the shape `ModelProviderService.verifiedCapabilities` returns) */
  evidence: ReadonlyMap<string, string>;
}
export interface RegistryEntry {
  providerCode: string;
  modelId: string;
  providerEnabled: boolean;
  /** has a rate card entry, so the router may offer it (when the provider is enabled) */
  priced: boolean;
  contextTokens: number;
  maxOutputTokens: number;
  latencyClass: ModelInfo['latencyClass'];
  capabilities: CapabilityExplanation[];
  /** the effective capabilities (what the router relies on) */
  effective: ModelCapability[];
  /** the declared-but-not-effective capabilities: what a probe or evidence row would still have to establish */
  pending: ModelCapability[];
}
export function buildCapabilityRegistry(
  providers: readonly RegistryProviderInput[],
): RegistryEntry[] {
  const out: RegistryEntry[] = [];
  for (const p of providers) {
    const devReference = /^(mock|local)-/.test(p.providerCode);
    for (const m of p.models) {
      const capabilities = explainCapabilities({
        contractVersion: p.contractVersion,
        declared: m.capabilities,
        devReference,
        verifiedContract: (c) => p.evidence.get(`${p.providerId}|${m.modelId}|${c}`),
      });
      out.push({
        providerCode: p.providerCode,
        modelId: m.modelId,
        providerEnabled: p.enabled,
        priced: p.rateCard[m.modelId] !== undefined,
        contextTokens: m.contextTokens,
        maxOutputTokens: m.maxOutputTokens,
        latencyClass: m.latencyClass,
        capabilities,
        effective: capabilities.filter((c) => c.effective).map((c) => c.capability),
        pending: capabilities.filter((c) => c.declared && !c.effective).map((c) => c.capability),
      });
    }
  }
  return out.sort((a, b) =>
    `${a.providerCode}/${a.modelId}`.localeCompare(`${b.providerCode}/${b.modelId}`),
  );
}

// ───────────────────────────── discovery ─────────────────────────────

export interface DiscoveryReconciliation {
  /** declared by the adapter and listed by the vendor */
  confirmed: string[];
  /** declared by the adapter but not listed by the vendor: possibly retired. Flagged for an administrator; never removed automatically. */
  unlistedByVendor: string[];
  /** listed by the vendor but unknown to the adapter: NEVER offered (no verified limits, price or capabilities); shown so an administrator can request support. */
  notDeclared: DiscoveredModel[];
}
export function reconcileDiscovery(
  declared: readonly Pick<ModelInfo, 'modelId'>[],
  discovered: readonly DiscoveredModel[],
): DiscoveryReconciliation {
  const d = new Set(discovered.map((x) => x.modelId));
  const a = new Set(declared.map((x) => x.modelId));
  return {
    confirmed: [...a].filter((id) => d.has(id)).sort(),
    unlistedByVendor: [...a].filter((id) => !d.has(id)).sort(),
    notDeclared: discovered
      .filter((x) => !a.has(x.modelId))
      .sort((x, y) => x.modelId.localeCompare(y.modelId)),
  };
}
