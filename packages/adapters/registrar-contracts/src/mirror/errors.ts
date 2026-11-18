/* MIRROR of @nuzm/adapter-contracts (M05 S16, contractVersion 1.0.0) errors.ts, copied READ-ONLY on 2026-11-18 so M07 can build before M05 lands.
 * Integration: replace this file by `export * from "@nuzm/adapter-contracts"`-style re-exports (docs/reports/M07-m05-interface-assumptions.md §1). */
import type { ErrorCategory, NormalizedError } from './base';

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
