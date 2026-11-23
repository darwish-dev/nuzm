import type { RateCard } from './credits';

/**
 * Gateway routing (M09 S37 task 2). PURE: the caller supplies the candidates, the residency verdict per provider (evaluated by the residency service
 * BEFORE this function) and the data-terms policy. The function ranks only what is ALLOWED; it never "falls back" across a residency or data-terms
 * refusal, and a candidate whose worst-case reservation exceeds the budget is excluded, so a fallback can never overspend.
 */
export type Capability =
  | 'chat'
  | 'structured-output'
  | 'long-context'
  | 'embeddings'
  | 'vision'
  // ModelAdapter contract 1.1 (D-46, ADR-066): only counted from an adapter that declares the contract and the capability
  | 'tool-use'
  | 'streaming-tool-calls'
  | 'parallel-tool-calls';
export type DataClass =
  'public' | 'internal' | 'customer-content' | 'personal' | 'financial' | 'credentials';

export interface DataTermsView {
  attested: boolean;
  retainsPrompts: boolean | 'unknown';
  trainsOnData: boolean | 'unknown';
}
export interface Candidate {
  providerCode: string;
  modelId: string;
  region: string;
  capabilities: readonly Capability[];
  contextTokens: number;
  maxOutputTokens: number;
  latencyClass: 'low' | 'medium' | 'high';
  dataTerms: DataTermsView;
  rate: RateCard;
}
export type Exclusion =
  | 'capability'
  | 'context'
  | 'output_limit'
  | 'residency'
  | 'data_terms'
  | 'budget'
  | 'class_not_allowed';
export interface ModelRoutingRequest {
  capability: Capability;
  /** further capabilities the model must also declare (tool calling needs `tool-use` besides the capability of the task); absent for every existing caller */
  alsoRequires?: readonly Capability[];
  /** prompt tokens (estimate) + requested output tokens must fit the model context */
  promptTokens: number;
  maxTokens: number;
  dataClass: DataClass;
  /** providerCode → residency verdict evaluated by the residency service for THIS org, class and the provider's region/processor */
  residency: Record<string, 'allow' | 'deny'>;
  /** may unattested ("unknown ⇒ may retain/train") providers receive personal/customer-content? default false; true only by explicit policy */
  allowUnattestedForSensitive?: boolean;
  /** credits that can still be reserved (min over all budget levels), null = unlimited */
  reservableCredits: bigint | null;
  prefer?: 'cost' | 'latency';
}
export interface Ranked {
  candidate: Candidate;
  reservationCredits: bigint;
}
export interface ModelRoutingResult {
  ranked: Ranked[];
  excluded: { providerCode: string; modelId: string; reason: Exclusion }[];
}

const SENSITIVE: ReadonlySet<DataClass> = new Set(['personal', 'customer-content', 'financial']);
/** credentials never go to a model, whatever the terms are */
const NEVER: ReadonlySet<DataClass> = new Set(['credentials']);

/** The data-terms rule: unknown ⇒ treated as "may retain / may train"; such a provider is refused for sensitive classes unless policy says otherwise. */
export function dataTermsAllow(
  cls: DataClass,
  t: DataTermsView,
  allowUnattestedForSensitive = false,
): boolean {
  if (NEVER.has(cls)) return false;
  if (!SENSITIVE.has(cls)) return true;
  if (!t.attested) return allowUnattestedForSensitive;
  // attested: "may retain/train" still blocks `personal`; customer-content tolerates retention (not training) only if attested
  if (t.trainsOnData !== false) return allowUnattestedForSensitive;
  if (cls === 'personal' || cls === 'financial')
    return t.retainsPrompts === false || allowUnattestedForSensitive;
  return true;
}

export function routeModels(
  req: ModelRoutingRequest,
  candidates: readonly Candidate[],
  reserve: (c: Candidate, prompt: number, max: number) => bigint,
): ModelRoutingResult {
  const excluded: ModelRoutingResult['excluded'] = [];
  const ok: Ranked[] = [];
  for (const c of candidates) {
    const ex = (reason: Exclusion) =>
      excluded.push({ providerCode: c.providerCode, modelId: c.modelId, reason });
    if (NEVER.has(req.dataClass)) {
      ex('class_not_allowed');
      continue;
    }
    if (
      !c.capabilities.includes(req.capability) ||
      (req.alsoRequires ?? []).some((x) => !c.capabilities.includes(x))
    )
      ex('capability');
    else if (req.promptTokens + req.maxTokens > c.contextTokens) ex('context');
    else if (req.maxTokens > c.maxOutputTokens) ex('output_limit');
    else if (req.residency[c.providerCode] !== 'allow')
      ex('residency'); // missing verdict = deny (fail closed)
    else if (!dataTermsAllow(req.dataClass, c.dataTerms, req.allowUnattestedForSensitive))
      ex('data_terms');
    else {
      const r = reserve(c, req.promptTokens, req.maxTokens);
      if (req.reservableCredits !== null && r > req.reservableCredits) ex('budget');
      else ok.push({ candidate: c, reservationCredits: r });
    }
  }
  const lat = { low: 0, medium: 1, high: 2 } as const;
  ok.sort((a, b) => {
    const byCost =
      a.reservationCredits === b.reservationCredits
        ? 0
        : a.reservationCredits < b.reservationCredits
          ? -1
          : 1;
    const byLat = lat[a.candidate.latencyClass] - lat[b.candidate.latencyClass];
    const first = req.prefer === 'latency' ? byLat || byCost : byCost || byLat;
    return (
      first ||
      `${a.candidate.providerCode}/${a.candidate.modelId}`.localeCompare(
        `${b.candidate.providerCode}/${b.candidate.modelId}`,
      )
    );
  });
  return { ranked: ok, excluded };
}
