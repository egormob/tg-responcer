import { describe, expect, it, vi } from 'vitest';

import type { RateLimitContext } from '../../../ports';
import { createKvRateLimitAdapter, type RateLimitKvNamespace } from '../index';

class FakeKv implements RateLimitKvNamespace {
  readonly store = new Map<string, { value: string; expirationTtl: number }>();

  async get(key: string, type: 'text' = 'text'): Promise<string | null> {
    void type;
    return this.store.get(key)?.value ?? null;
  }

  async put(key: string, value: string, options: { expirationTtl: number }): Promise<void> {
    this.store.set(key, { value, expirationTtl: options.expirationTtl });
  }
}

const createAdapter = (options: {
  limit?: number;
  windowMs?: number;
  prefix?: string;
  now?: () => number;
  kv?: FakeKv;
  logger?: { warn?: ReturnType<typeof vi.fn>; error?: ReturnType<typeof vi.fn> };
}) => {
  const kv = options.kv ?? new FakeKv();
  const now = options.now ?? (() => 0);

  const adapter = createKvRateLimitAdapter({
    kv,
    limit: options.limit ?? 2,
    windowMs: options.windowMs,
    prefix: options.prefix,
    now,
    logger: options.logger,
  });

  return { adapter, kv };
};

const runCheck = async (
  adapter: ReturnType<typeof createKvRateLimitAdapter>,
  userId = 'user-1',
  context?: RateLimitContext,
) => adapter.checkAndIncrement({ userId, context });

describe('createKvRateLimitAdapter', () => {
  it('increments counter until limit is reached', async () => {
    const { adapter, kv } = createAdapter({ limit: 2 });

    await expect(runCheck(adapter)).resolves.toBe('ok');
    await expect(runCheck(adapter)).resolves.toBe('ok');

    const entries = Array.from(kv.store.entries());
    expect(entries).toHaveLength(1);
    const [key, entry] = entries[0];
    expect(entry.value).toBe('2');

    await expect(runCheck(adapter)).resolves.toBe('limit');
    expect(kv.store.get(key)?.value).toBe('2');
  });

  it('uses window ttl when updating counter', async () => {
    let nowMs = 0;
    const { adapter, kv } = createAdapter({ now: () => nowMs, windowMs: 24 * 60 * 60 * 1000 });

    await runCheck(adapter);
    const firstEntry = Array.from(kv.store.values())[0];
    expect(firstEntry?.expirationTtl).toBe(86_400);

    nowMs = 6 * 60 * 60 * 1000; // +6 часов
    await runCheck(adapter);
    const secondEntry = Array.from(kv.store.values())[0];
    expect(secondEntry?.expirationTtl).toBe(64_800);
  });

  it('creates independent buckets for different windows', async () => {
    let nowMs = 0;
    const { adapter, kv } = createAdapter({ now: () => nowMs, windowMs: 1_000 });

    await expect(runCheck(adapter)).resolves.toBe('ok');
    expect(kv.store.size).toBe(1);

    nowMs = 1_500;
    await expect(runCheck(adapter)).resolves.toBe('ok');
    expect(kv.store.size).toBe(2);
  });

  it('includes context in key generation', async () => {
    const { adapter, kv } = createAdapter({});

    await expect(
      runCheck(adapter, 'user-ctx', { scope: 'daily', chatId: 'chat-1', threadId: 'thread-5' }),
    ).resolves.toBe('ok');

    const key = Array.from(kv.store.keys())[0];
    expect(key).toContain('scope:daily');
    expect(key).toContain('chat:chat-1');
    expect(key).toContain('thread:thread-5');
  });

  it('falls back to ok when kv throws', async () => {
    const kv: RateLimitKvNamespace = {
      get: vi.fn().mockRejectedValue(new Error('boom')),
      put: vi.fn(),
    };
    const logger = { error: vi.fn(), warn: vi.fn() };

    const adapter = createKvRateLimitAdapter({ kv, limit: 1, logger });

    await expect(runCheck(adapter)).resolves.toBe('ok');
    expect(logger.error).toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('resets invalid counter values', async () => {
    const kv = new FakeKv();
    kv.store.set('rate_limit:user:demo:bucket:0', { value: 'not-a-number', expirationTtl: 1 });
    const logger = { warn: vi.fn(), error: vi.fn() };

    const adapter = createKvRateLimitAdapter({ kv, limit: 2, logger, now: () => 0 });

    await expect(runCheck(adapter, 'demo')).resolves.toBe('ok');
    expect(logger.warn).toHaveBeenCalledWith('invalid counter value', expect.any(Object));
    expect(kv.store.get('rate_limit:user:demo:bucket:0')?.value).toBe('1');
  });

  it('continues when put fails', async () => {
    const kv: RateLimitKvNamespace = {
      get: vi.fn().mockResolvedValue('0'),
      put: vi.fn().mockRejectedValue(new Error('write failed')),
    };
    const logger = { error: vi.fn() };

    const adapter = createKvRateLimitAdapter({ kv, limit: 1, logger });

    await expect(runCheck(adapter)).resolves.toBe('ok');
    expect(logger.error).toHaveBeenCalledWith('failed to update counter', expect.any(Object));
  });
});

