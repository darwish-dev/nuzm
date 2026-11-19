import Anthropic from '@anthropic-ai/sdk';

/** What a connection test can say. Nothing in it is, or is derived from, the key. */
export type ProbeOutcome =
  'ok' | 'invalid_key' | 'forbidden' | 'rate_limited' | 'unreachable' | 'error';
export interface ProbeResult {
  outcome: ProbeOutcome;
  httpStatus?: number;
  /** how many models the key can see (only when `ok`) */
  modelCount?: number;
}
/** Takes the key (already read from the secret store) and says whether the provider accepts it. Injected so tests never touch the network. */
export type ConnectionProbe = (apiKey: string) => Promise<ProbeResult>;

/** The ONE host this probe talks to. Fixed in code on purpose: never from the environment, a request or the database (no way to aim the key elsewhere). */
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const TIMEOUT_MS = 10_000;

/**
 * LIVE connection test for Claude: lists the models the key can see (`GET /v1/models`: read-only, no prompt, no customer data, nothing billed).
 * One attempt, no retries, a short timeout. The SDK's typed errors are mapped most specific first; the message of an error is never returned (it could
 * carry request details), only the outcome and the HTTP status.
 */
export const probeAnthropic: ConnectionProbe = async (apiKey) => {
  const client = new Anthropic({
    apiKey,
    authToken: null, // never fall back to a token from the environment
    baseURL: ANTHROPIC_BASE_URL,
    maxRetries: 0,
    timeout: TIMEOUT_MS,
  });
  try {
    const page = await client.models.list({ limit: 100 });
    return { outcome: 'ok', httpStatus: 200, modelCount: page.data.length };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError)
      return { outcome: 'invalid_key', httpStatus: 401 };
    if (e instanceof Anthropic.PermissionDeniedError)
      return { outcome: 'forbidden', httpStatus: 403 };
    if (e instanceof Anthropic.RateLimitError) return { outcome: 'rate_limited', httpStatus: 429 };
    if (e instanceof Anthropic.APIConnectionError) return { outcome: 'unreachable' }; // includes the timeout
    if (e instanceof Anthropic.APIError)
      return {
        outcome: 'error',
        ...(typeof e.status === 'number' ? { httpStatus: e.status } : {}),
      };
    return { outcome: 'error' };
  }
};
