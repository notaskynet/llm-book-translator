import { describe, expect, it } from 'vitest';
import { KeyPool, normalizeApiKeys } from '../src/llm/keyPool';
import { RateLimitError } from '../src/llm/errors';
import { computeWaitTime, handleRateLimit, isRetryableHttpStatus, rateLimitBudget } from '../src/llm/rateLimit';

describe('normalizeApiKeys', () => {
  it('splits on commas and newlines and trims', () => {
    expect(normalizeApiKeys(' a ,b\nc,,')).toEqual(['a', 'b', 'c']);
    expect(normalizeApiKeys(undefined)).toEqual([]);
  });
});

describe('KeyPool', () => {
  it('rotates round-robin and skips throttled keys', () => {
    let now = 0;
    const pool = new KeyPool('a,b,c', 'test', () => now);
    expect([pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()]).toEqual(['a', 'b', 'c', 'a']);

    pool.markThrottled('b', 10_000);
    expect([pool.acquire(), pool.acquire(), pool.acquire()]).toEqual(['c', 'a', 'c']);

    now = 10_000;
    expect(pool.hasAvailable()).toBe(true);
    expect(new Set([pool.acquire(), pool.acquire(), pool.acquire()])).toEqual(new Set(['a', 'b', 'c']));
  });

  it('returns the soonest-recovering key when all are throttled', () => {
    const pool = new KeyPool('a,b', 'test', () => 0);
    pool.markThrottled('a', 9_000);
    pool.markThrottled('b', 3_000);
    expect(pool.hasAvailable()).toBe(false);
    expect(pool.acquire()).toBe('b');
    expect(pool.timeUntilNextAvailableMs()).toBe(3_000);
  });

  it('drops duplicates and rejects an empty pool', () => {
    expect(new KeyPool('a,a,b').size).toBe(2);
    expect(() => new KeyPool(' , ')).toThrow();
  });
});

describe('rate limit helpers', () => {
  it('prefers Retry-After, then X-RateLimit-Reset, then exponential backoff', () => {
    expect(computeWaitTime({ 'retry-after': '7' }, 0)).toBe(7);
    expect(computeWaitTime({ 'Retry-After': '0' }, 0)).toBe(1);
    expect(computeWaitTime({ 'x-ratelimit-reset': String(1_000_000 + 5_000) }, 0, 1_000_000)).toBe(6);
    expect(computeWaitTime({}, 0)).toBe(4);
    expect(computeWaitTime({}, 3)).toBe(32);
    expect(computeWaitTime({}, 10)).toBe(60);
  });

  it('works with a real Headers object', () => {
    expect(computeWaitTime(new Headers({ 'Retry-After': '3' }), 0)).toBe(3);
  });

  it('retries 5xx, 408 and 429 but not other 4xx', () => {
    expect([500, 502, 408, 429].every(isRetryableHttpStatus)).toBe(true);
    expect([400, 401, 402, 403, 404].some(isRetryableHttpStatus)).toBe(false);
  });

  it('sizes the budget as one rotation per key plus the usual waits', () => {
    expect(rateLimitBudget(3, 2)).toBe(4);
  });

  it('rotates without sleeping when a spare key is available', async () => {
    const pool = new KeyPool('a,b', 'test', () => 0);
    const slept: number[] = [];
    await handleRateLimit(pool, 'a', { 'retry-after': '5' }, 1, 2, undefined, async (ms) => void slept.push(ms));
    expect(slept).toEqual([]);
    expect(pool.acquire()).toBe('b');
  });

  it('sleeps for a single-key pool and raises once the budget is spent', async () => {
    const pool = new KeyPool('a', 'test', () => 0);
    const slept: number[] = [];
    const sleep = async (ms: number) => void slept.push(ms);
    await handleRateLimit(pool, 'a', { 'retry-after': '5' }, 1, 2, undefined, sleep);
    expect(slept).toEqual([5_000]);
    await expect(handleRateLimit(pool, 'a', { 'retry-after': '5' }, 2, 2, undefined, sleep)).rejects.toBeInstanceOf(RateLimitError);
  });
});
