import { describe, expect, it, vi } from 'vitest';

import type { RateLimitPort } from '../../../ports';
import { createRateLimitToggle } from '../rate-limit-toggle';

const createKv = (implementation: () => Promise<string | null>) => ({
  get: vi.fn().mockImplementation(implementation),
});

const createRateLimitPort = (result: 'ok' | 'limit') => ({
  checkAndIncrement: vi
    .fn<
      Parameters<RateLimitPort['checkAndIncrement']>,
      ReturnType<RateLimitPort['checkAndIncrement']>
    >()
    .mockResolvedValue(result),
});

describe('createRateLimitToggle', () => {
  it('delegates to the underlying rate limit port when flag is enabled', async () => {
    const kvValue = 'true';
    const kv = createKv(async () => kvValue);
    const rateLimit = createRateLimitPort('ok');

    const toggle = createRateLimitToggle({ kv, rateLimit });

    const result = await toggle.checkAndIncrement({ userId: 'user-1' });

    expect(result).toBe('ok');
    expect(rateLimit.checkAndIncrement).toHaveBeenCalledTimes(1);
    expect(kv.get).toHaveBeenCalledWith('LIMITS_ENABLED');
  });

  it('bypasses rate limit when flag is disabled', async () => {
    const kv = createKv(async () => 'false');
    const rateLimit = createRateLimitPort('limit');

    const toggle = createRateLimitToggle({ kv, rateLimit });

    const result = await toggle.checkAndIncrement({ userId: 'user-2' });

    expect(result).toBe('ok');
    expect(rateLimit.checkAndIncrement).not.toHaveBeenCalled();
  });

  it('treats unknown or missing value as enabled', async () => {
    const kv = createKv(async () => null);
    const rateLimit = createRateLimitPort('ok');

    const toggle = createRateLimitToggle({ kv, rateLimit });

    await toggle.checkAndIncrement({ userId: 'user-3' });

    expect(rateLimit.checkAndIncrement).toHaveBeenCalledTimes(1);
  });

  it('refreshes flag after the configured interval', async () => {
    let kvValue = 'true';
    let currentTime = 0;
    const kv = createKv(async () => kvValue);
    const rateLimit = createRateLimitPort('ok');

    const toggle = createRateLimitToggle({
      kv,
      rateLimit,
      refreshIntervalMs: 1_000,
      now: () => currentTime,
    });

    await toggle.checkAndIncrement({ userId: 'user-4' });
    expect(kv.get).toHaveBeenCalledTimes(1);
    expect(rateLimit.checkAndIncrement).toHaveBeenCalledTimes(1);

    kvValue = 'false';
    currentTime = 500;
    await toggle.checkAndIncrement({ userId: 'user-5' });
    expect(kv.get).toHaveBeenCalledTimes(1);
    expect(rateLimit.checkAndIncrement).toHaveBeenCalledTimes(2);

    currentTime = 1_500;
    const result = await toggle.checkAndIncrement({ userId: 'user-6' });
    expect(kv.get).toHaveBeenCalledTimes(2);
    expect(result).toBe('ok');
    expect(rateLimit.checkAndIncrement).toHaveBeenCalledTimes(2);
  });

  it('allows requests when kv access fails', async () => {
    const kvError = new Error('network down');
    const kv = createKv(async () => {
      throw kvError;
    });
    const rateLimit = createRateLimitPort('limit');
    const warn = vi.fn();

    const toggle = createRateLimitToggle({
      kv,
      rateLimit,
      logger: { warn },
    });

    const result = await toggle.checkAndIncrement({ userId: 'user-7' });

    expect(result).toBe('ok');
    expect(rateLimit.checkAndIncrement).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('failed to read limits flag', {
      flagKey: 'LIMITS_ENABLED',
      message: 'network down',
      name: 'Error',
    });
  });
});
