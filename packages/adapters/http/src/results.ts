import {
  normalizedError,
  type ErrorCategory,
  type NormalizedError,
  type OperationResult,
  type RawEvidence,
} from '@nuzm/adapter-contracts';

export const opOk = <T>(
  raw: RawEvidence,
  data?: T,
  providerRef?: string,
  status: 'succeeded' | 'accepted' = 'succeeded',
): OperationResult<T> => ({
  status,
  ...(providerRef !== undefined ? { providerRef } : {}),
  ...(data !== undefined ? { data } : {}),
  raw,
});

export const opFail = <T>(raw: RawEvidence, error: NormalizedError): OperationResult<T> => ({
  status: 'failed',
  error,
  raw,
});

export const opFailCat = <T>(
  raw: RawEvidence,
  category: ErrorCategory,
  providerCode: string,
  message: string,
): OperationResult<T> => opFail(raw, normalizedError(category, providerCode, message));

/** A mutating call whose effect at the provider is unknown (timeout, connection reset, 5xx): docs/09 §1 rule 3. */
export const opUncertain = <T>(raw: RawEvidence, why: string): OperationResult<T> => ({
  status: 'uncertain',
  error: normalizedError('provider_outage', 'ambiguous_outcome', why, true),
  raw,
});

export const opUnsupported = <T>(raw: RawEvidence, what: string): OperationResult<T> =>
  opFailCat(
    raw,
    'unsupported',
    'unsupported_capability',
    `${what} is not supported by this account (probe did not mark it supported)`,
  );
