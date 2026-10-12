export const MAX_ATTEMPTS = parseInt(process.env.WEBHOOK_MAX_ATTEMPTS ?? '8', 10);
export const BACKOFF_BASE_MS = parseInt(process.env.WEBHOOK_BACKOFF_BASE_MS ?? '5000', 10);
export const BACKOFF_CAP_MS = 6 * 60 * 60 * 1_000;

/**
 * Exponential backoff with "equal jitter": the delay doubles each attempt (capped), and
 * a random half of it is jittered. Jitter stops thousands of failed deliveries from
 * retrying in lock-step and hammering a merchant's server the moment it recovers.
 *
 * With the defaults (5s base, 8 attempts) retries land at ~5s, 10s, 20s, 40s, 80s, 160s, 320s.
 */
export function nextRetryDelayMs(attemptsMade: number, random: () => number = Math.random, base = BACKOFF_BASE_MS, cap = BACKOFF_CAP_MS): number {
  const exponential = Math.min(cap, base * 2 ** Math.max(0, attemptsMade - 1));
  return Math.round(exponential / 2 + random() * (exponential / 2));
}
