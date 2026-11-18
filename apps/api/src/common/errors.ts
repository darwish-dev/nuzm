import { HttpException } from '@nestjs/common';

/** Stable error-code registry. Mirrored in spec/openapi/errors.yaml (a test keeps them in sync). */
export const ERROR_REGISTRY = {
  unauthenticated: { status: 401, title: 'Authentication required' },
  forbidden: { status: 403, title: 'Forbidden' },
  step_up_required: { status: 401, title: 'Recent MFA verification required' },
  mfa_required: { status: 403, title: 'MFA enrollment/verification required' },
  org_suspended: { status: 403, title: 'Organization is suspended' },
  precondition_required: { status: 428, title: 'If-Match header required' },
  gone: { status: 410, title: 'Resource is no longer available' },
  csrf_failed: { status: 403, title: 'CSRF token missing or invalid' },
  invalid_return_to: { status: 400, title: 'returnTo is not allowed' },
  oidc_state_mismatch: { status: 400, title: 'OIDC state mismatch or missing login context' },
  oidc_token_invalid: { status: 400, title: 'OIDC token exchange or validation failed' },
  idp_user_disabled: { status: 403, title: 'User is disabled' },
  not_found: { status: 404, title: 'Not found' },
  validation_failed: { status: 422, title: 'Validation failed' },
  idempotency_key_required: { status: 400, title: 'Idempotency-Key header required' },
  insufficient_funds: { status: 402, title: 'Insufficient wallet balance' },
  account_restricted: {
    status: 402,
    title: 'New purchases are blocked while an invoice is overdue',
  },
  quota_exceeded: { status: 422, title: 'Quota exceeded' },
  pan_not_allowed: { status: 422, title: 'Card data is not accepted' },
  payment_method_required: { status: 422, title: 'A payment method is required' },
  invalid_signature: { status: 401, title: 'Invalid webhook signature' },
  kind_not_available: { status: 422, title: 'This kind is not available yet' },
  spend_approval_required: { status: 422, title: 'Spend approval required' },
  recipe_not_implemented: {
    status: 501,
    title: 'Ledger recipe is not implemented in this milestone',
  },
  idempotency_key_reuse: { status: 422, title: 'Idempotency-Key reused with a different request' },
  idempotency_in_progress: {
    status: 409,
    title: 'Request with this Idempotency-Key is in progress',
  },
  consent_purpose_unknown: { status: 409, title: 'Unknown consent purpose' },
  dsr_identity_unverified: {
    status: 422,
    title: 'The identity of the data subject is not verified',
  },
  legal_hold_active: { status: 409, title: 'The data is under a legal hold' },
  retention_mandatory: { status: 409, title: 'The data must be retained' },
  no_export_sink: { status: 422, title: 'No export sink is configured' },
  validation_requires_evidence: {
    status: 422,
    title: 'A validation needs a document and a named person',
  },
  residency_denied: { status: 403, title: 'Not allowed by the data residency policy' },
  policy_below_floor: {
    status: 422,
    title: 'An organization policy cannot loosen the platform floor',
  },
  assessment_expired: { status: 422, title: 'The transfer assessment has expired' },
  no_capacity: { status: 409, title: 'No hosting capacity is available' },
  unsupported_runtime: { status: 422, title: 'The runtime is not offered' },
  domain_in_use: { status: 409, title: 'The domain is already in use' },
  ownership_unverified: { status: 422, title: 'Domain ownership is not verified' },
  restore_in_progress: { status: 409, title: 'A restore is already in progress' },
  no_backup_sink: { status: 422, title: 'No backup sink is configured' },
  site_not_active: { status: 409, title: 'The site is not active' },
  conflict: { status: 409, title: 'Conflict' },
  precondition_failed: { status: 412, title: 'Precondition failed' },
  rate_limited: { status: 429, title: 'Too many requests' },
  operation_not_cancellable: { status: 409, title: 'Operation cannot be cancelled' },
  lease_lost: { status: 409, title: 'Operation lease lost' },
  internal_error: { status: 500, title: 'Internal error' },
  service_unavailable: { status: 503, title: 'Service unavailable' },
  invalid_filter: { status: 422, title: 'A query filter is invalid' },
  credential_value_rejected: {
    status: 422,
    title: 'Credential values are never accepted; send a vault reference',
  },
  unsupported_capability: {
    status: 422,
    title: 'The provider or instance does not support this capability',
  },
  no_eligible_offer: { status: 422, title: 'No eligible offer matches the request' },
  quote_expired: { status: 409, title: 'The quote has expired' },
  quote_consumed: { status: 409, title: 'The quote has already been used' },
  price_changed: { status: 409, title: 'The price changed since the quote was issued' },
  deletion_protected: { status: 409, title: 'Deletion protection is on' },
  invalid_state: { status: 409, title: 'The operation is not allowed in the current state' },
} as const;

export type ErrorCode = keyof typeof ERROR_REGISTRY;

export function isErrorCode(code: string): code is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_REGISTRY, code);
}

/** Throw this from handlers; the global filter renders RFC 9457 `application/problem+json`. */
export class ProblemException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    readonly detail?: string,
    readonly errors?: unknown[],
    /** RFC 9457 extension members merged into the problem body (e.g. `mfaFactorId` on mfa_required). */
    readonly extra?: Record<string, unknown>,
  ) {
    super(ERROR_REGISTRY[code].title, ERROR_REGISTRY[code].status);
  }
}
