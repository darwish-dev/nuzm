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
  conflict: { status: 409, title: 'Conflict' },
  precondition_failed: { status: 412, title: 'Precondition failed' },
  rate_limited: { status: 429, title: 'Too many requests' },
  operation_not_cancellable: { status: 409, title: 'Operation cannot be cancelled' },
  lease_lost: { status: 409, title: 'Operation lease lost' },
  internal_error: { status: 500, title: 'Internal error' },
  service_unavailable: { status: 503, title: 'Service unavailable' },
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
