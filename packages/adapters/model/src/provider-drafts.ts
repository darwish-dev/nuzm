import { ModelAdapterError, type ModelErrorCode } from './types';

/**
 * Integration CONTRACTS for providers that have no adapter yet (S-AG4, owner decision D11: OpenAI and Google Gemini are sequenced AFTER Claude is verified; contracts and
 * offline fixtures only). Nothing here is, or can become, a live adapter: there is no class, no network code, no host, no key handling. The records say what an adapter MUST satisfy
 * and what a human must decide first; every statement about a vendor's wire format is `verified: false` / `source: null` until someone cites the official documentation
 * (docs/adapters/README.md; CLAUDE.md §4: never invent API methods, regions, plans, prices, rights or results).
 */
export type DraftProviderId = 'openai' | 'gemini';

/** An element of contract 1.1 that the adapter has to map onto the vendor's API. The vendor side is intentionally empty. */
export interface WireMappingRow {
  /** the neutral contract element (types.ts) */
  element: string;
  /** the documentation reference the mapping is taken from: null until a human or a later session cites it */
  source: string | null;
  /** has the mapping been read from the official documentation AND exercised against the real service? always false in this build */
  verified: false;
}
export interface ProviderDraft {
  id: DraftProviderId;
  displayName: string;
  status: 'DRAFT_NOT_IMPLEMENTED';
  sequencing: { decision: 'D11'; rule: string };
  /** owner decisions that must be recorded before the FIRST live request (the same set as Claude, per provider) */
  requiredDecisions: readonly string[];
  /** facts the platform may never assume for this provider: they come from its signed terms and a probe */
  mustNotBeAssumed: readonly string[];
  wireMapping: readonly WireMappingRow[];
  /** what a future adapter must pass before it may be registered */
  acceptance: readonly string[];
  adapterClass: null;
  liveGate: 'AI_LIVE_PROVIDERS (default empty; ignored in production)';
}

const ELEMENTS = [
  'complete: messages and system text → request',
  'complete: response → text, finishReason, usage (null when the vendor reports none)',
  'responseFormat json',
  'stream: chunks → delta / done with usage',
  'tools → vendor tool declarations (name rule, JSON-Schema subset, limits of TOOL_LIMITS)',
  'toolChoice auto | none | {name}',
  'assistant tool_call block ↔ vendor call representation',
  'user tool_result block ↔ vendor result representation (isError)',
  'parallel tool calls: on/off control and the maximum per response',
  'streamed tool-call deltas → toolCallDelta / toolCallDone',
  'cancellation: the caller signal aborts the request; a consumer that stops reading aborts it too',
  'errors → ModelErrorCode (timeout, rate_limited, unavailable, content_filtered, invalid_request, aborted, invalid_response, unsupported_capability) with a Retry-After hint',
  'token counting: provider-reported usage, local estimate with a documented margin',
  'model listing (discoverModels) and per-model limits',
] as const;

const COMMON_DECISIONS = [
  'D1 residency option for customer data sent to this provider',
  'D2 agreement and data terms attested by a human (HG-09-01): retention, training, region, sub-processors',
  'D3 live gate opened in a named non-production environment',
  'D4 a dedicated non-production key with a vendor-side monthly cap',
  'D5 region statement and ROPA processor entry (only what the contract says)',
  'D6 customer rate card, currency and VAT treatment',
  'D9 approval of the bounded probe for this provider (its own plan and cost bound)',
] as const;
const COMMON_UNASSUMED = [
  'agreement terms, data retention, training use, region, sub-processors',
  'model ids, context windows, output limits, prices, rate limits, deprecation dates',
  'which tool-calling, streaming and parallel-call behaviours work (unknown = unsupported until a VERIFIED evidence row exists for the contract version)',
  'that any credential exists',
] as const;
const COMMON_ACCEPTANCE = [
  'passes runModelConformance with a scenario driver (every case, none skipped)',
  'a fixed host in code; no host, token or key from the environment, a request or the database',
  'refuses before the key is read while the provider is not listed in AI_LIVE_PROVIDERS',
  'never passes an upstream error message on; maps errors to the contract codes with a Retry-After hint',
  'exercised against a stubbed transport (request shapes, a recorded-shape stream) before any live probe',
  'capability evidence recorded through the audited probe wrapper (D9) before any tool capability counts',
] as const;

const draft = (id: DraftProviderId, displayName: string): ProviderDraft => ({
  id,
  displayName,
  status: 'DRAFT_NOT_IMPLEMENTED',
  sequencing: {
    decision: 'D11',
    rule: 'no adapter work for this provider until Claude is verified (approved 2026-11-22)',
  },
  requiredDecisions: COMMON_DECISIONS,
  mustNotBeAssumed: COMMON_UNASSUMED,
  wireMapping: ELEMENTS.map((element) => ({ element, source: null, verified: false as const })),
  acceptance: COMMON_ACCEPTANCE,
  adapterClass: null,
  liveGate: 'AI_LIVE_PROVIDERS (default empty; ignored in production)',
});
export const PROVIDER_DRAFTS: Readonly<Record<DraftProviderId, ProviderDraft>> = {
  openai: draft('openai', 'OpenAI'),
  gemini: draft('gemini', 'Google Gemini'),
};

/**
 * The provider-neutral mapping from an HTTP status (and an optional Retry-After hint) to the contract's error codes, for adapters that read the status themselves.
 * The Claude adapter maps its SDK's typed errors and gives the same answers; a future adapter reuses this so every provider is retried, broken and failed over the same way.
 * 408/504/524 are timeouts, 429 is rate limiting, any other 5xx (and 529) is "unavailable"; both are retryable. Credentials (401/403) and malformed requests are not: retrying
 * cannot help and could repeat a billed call.
 */
export function modelErrorFromHttpStatus(status: number, retryAfterMs?: number): ModelAdapterError {
  const make = (code: ModelErrorCode, message: string, retryable: boolean) =>
    new ModelAdapterError(code, message, retryable, retryable ? retryAfterMs : undefined);
  if (status === 408 || status === 504 || status === 524)
    return make('timeout', 'the model did not answer in time', true);
  if (status === 429) return make('rate_limited', 'the model provider is limiting requests', true);
  if (status >= 500 && status <= 599)
    return make('unavailable', `the model provider answered with an error (HTTP ${status})`, true);
  if (status === 401 || status === 403)
    return make('invalid_request', `the model provider rejected the key (HTTP ${status})`, false);
  return make(
    'invalid_request',
    `the model provider rejected the request (HTTP ${Number.isFinite(status) ? status : 'unknown'})`,
    false,
  );
}
