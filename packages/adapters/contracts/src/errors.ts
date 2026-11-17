import type { ErrorCategory, NormalizedError } from './types';

/** Normalization table (docs/09 §1 rule 4): which categories are worth retrying by default. A retry still goes through reconcile-before-retry. */
export const ERROR_CATEGORY_RETRYABLE: Record<ErrorCategory, boolean> = {
  auth: false,
  quota: false,
  capacity: true,
  validation: false,
  not_found: false,
  conflict: false,
  rate_limit: true,
  provider_outage: true,
  unsupported: false,
  unknown: false,
};

export const ERROR_CATEGORIES = Object.keys(ERROR_CATEGORY_RETRYABLE) as ErrorCategory[];

export const normalizedError = (
  category: ErrorCategory,
  providerCode: string,
  message: string,
  retryable: boolean = ERROR_CATEGORY_RETRYABLE[category],
): NormalizedError => ({ category, retryable, providerCode, message });

/** Raised inside an adapter when the vendor call exceeded the deadline: the outcome at the provider is unknown. */
export class AdapterTimeoutError extends Error {
  constructor(message = 'provider call timed out') {
    super(message);
    this.name = 'AdapterTimeoutError';
  }
}
