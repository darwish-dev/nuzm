/**
 * M11 S51/S52: retry schedules. Pure: the random source is injected so tests are deterministic.
 *  - workflow steps: exponential backoff with full jitter on the upper half, default 5 attempts;
 *  - outbound webhooks: exponential schedule that spans up to 24 hours, then the dead-letter queue.
 */
export interface StepRetryPolicy {
  maxAttempts: number;
  baseSeconds: number;
  capSeconds: number;
}
export const DEFAULT_STEP_RETRY: StepRetryPolicy = {
  maxAttempts: 5,
  baseSeconds: 2,
  capSeconds: 300,
};

/** Delay before attempt `attempt` (the attempt that just FAILED is `attempt`, 1-based). Jitter keeps [50%, 100%] of the exponential delay. */
export function stepBackoffSeconds(
  attempt: number,
  p: StepRetryPolicy = DEFAULT_STEP_RETRY,
  rnd: () => number = Math.random,
): number {
  const exp = Math.min(p.capSeconds, p.baseSeconds * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.round(exp * (0.5 + rnd() * 0.5)));
}
export const shouldRetryStep = (
  attempt: number,
  p: StepRetryPolicy = DEFAULT_STEP_RETRY,
): boolean => attempt < p.maxAttempts;

/** Webhook delivery waits between attempts (seconds). Sum = 24 h - 30 s... after the last wait the delivery is dead-lettered. */
export const WEBHOOK_SCHEDULE_SECONDS = [
  30, 120, 600, 1800, 3600, 7200, 14_400, 28_800, 29_400,
] as const;
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_SCHEDULE_SECONDS.length + 1; // 10 attempts: the first plus 9 retries
export const WEBHOOK_WINDOW_SECONDS = WEBHOOK_SCHEDULE_SECONDS.reduce((a, b) => a + b, 0);

/** Seconds to wait after failed attempt number `attempt` (1-based), or null when the schedule is exhausted (dead-letter). Jitter only SHORTENS (80%..100% of the step) so the whole schedule can never run past its nominal 23.9 h window. */
export function webhookDelaySeconds(
  attempt: number,
  rnd: () => number = Math.random,
): number | null {
  const base = WEBHOOK_SCHEDULE_SECONDS[attempt - 1];
  if (base === undefined) return null;
  return Math.max(1, Math.round(base * (0.8 + rnd() * 0.2)));
}

/** HTTP statuses worth retrying (the receiver may recover). 4xx other than 408/425/429 is a permanent failure of THAT delivery. */
export const isRetryableStatus = (status: number): boolean =>
  status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
