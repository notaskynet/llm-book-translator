// Port of src/core/llm/rate_limit_handler.py: HTTP 429 handling with key rotation.
// Rate limits have their own budget, separate from the transient-retry counter, so
// rotating to a spare key never consumes a retry attempt (issue #217).

import { RateLimitError } from './errors';
import type { KeyPool } from './keyPool';

export type HeadersLike = Headers | Record<string, string | undefined> | null | undefined;
export type LogFn = (event: string, message: string) => void;

export function getHeader(headers: HeadersLike, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/**
 * Client errors (4xx) come from the request itself and will not succeed on retry,
 * except 408 (timeout) and 429 (rate limit, handled separately). 5xx is transient.
 */
export function isRetryableHttpStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  return !(status >= 400 && status < 500);
}

/** Seconds to wait after a 429: Retry-After, then X-RateLimit-Reset, then exponential backoff. */
export function computeWaitTime(headers: HeadersLike, attempt: number, nowMs = Date.now()): number {
  const retryAfter = getHeader(headers, 'Retry-After');
  if (retryAfter) {
    const n = Number.parseInt(retryAfter, 10);
    if (!Number.isNaN(n)) return Math.max(n, 1);
  }
  const resetMs = getHeader(headers, 'X-RateLimit-Reset');
  if (resetMs) {
    const n = Number.parseInt(resetMs, 10);
    if (!Number.isNaN(n)) {
      const wait = Math.trunc((n - nowMs) / 1000) + 1;
      return Math.max(Math.min(wait, 65), 1);
    }
  }
  return Math.min(2 ** (attempt + 2), 60);
}

/** Max 429 responses tolerated for one request: one rotation per key plus the usual sleeps. */
export function rateLimitBudget(poolSize: number, maxAttempts: number): number {
  return poolSize + maxAttempts - 1;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function handleRateLimit(
  pool: KeyPool,
  failedKey: string,
  headers: HeadersLike,
  rateLimitEvents: number,
  maxAttempts: number,
  log?: LogFn,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<void> {
  const waitTime = computeWaitTime(headers, rateLimitEvents - 1);
  pool.markThrottled(failedKey, pool.currentTime() + waitTime * 1000);

  const provider = pool.providerName;
  const poolSize = pool.size;
  const budget = rateLimitBudget(poolSize, maxAttempts);

  if (rateLimitEvents >= budget) {
    throw new RateLimitError(
      `${provider} rate limit persisted after ${rateLimitEvents} 429 response(s) across ${poolSize} key(s)`,
      waitTime,
      provider,
    );
  }

  if (poolSize > 1 && pool.hasAvailable()) {
    log?.(
      'llm_key_rotated',
      `🔄 [${provider}] key #${pool.indexOf(failedKey)}/${poolSize} rate-limited (retry-after ${waitTime}s), rotating to next key`,
    );
    return;
  }

  const remainingMs = pool.timeUntilNextAvailableMs();
  const sleepFor = Math.max(remainingMs > 0 ? Math.trunc(remainingMs / 1000) : waitTime, 1);
  log?.(
    'llm_rate_limit',
    `⚠️ [${provider}] all ${poolSize} key(s) rate-limited (429 #${rateLimitEvents}/${budget}), waiting ${sleepFor}s...`,
  );
  await sleep(sleepFor * 1000);
}
