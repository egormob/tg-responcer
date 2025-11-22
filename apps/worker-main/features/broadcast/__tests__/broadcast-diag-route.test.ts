import { describe, expect, it, vi } from 'vitest';

import { createBroadcastDiagRoute } from '../broadcast-diag-route';

class MemoryKv implements KVNamespace {
  constructor(private readonly now: () => number = () => Date.now()) {}

  private readonly store = new Map<string, { value: string; expiration?: number }>();

  async get(key: string, type: 'text'): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiration && entry.expiration * 1000 <= this.now()) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const expiration = options?.expirationTtl
      ? Math.floor(this.now() / 1000) + options.expirationTtl
      : undefined;
    this.store.set(key, { value, expiration });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    keys: Array<{ name: string; expiration?: number }>;
    list_complete: boolean;
    cursor: string;
  }> {
    const filtered = Array.from(this.store.entries())
      .filter(([name]) => (options?.prefix ? name.startsWith(options.prefix) : true))
      .map(([name, entry]) => ({ name, expiration: entry.expiration }));

    const keys = typeof options?.limit === 'number' ? filtered.slice(0, options.limit) : filtered;

    return { keys, list_complete: true, cursor: '' };
  }
}

const createRequest = () =>
  new Request('https://example.com/admin/diag?q=broadcast', { method: 'GET' });

describe('createBroadcastDiagRoute', () => {
  it('returns disabled snapshot when telemetry is unavailable', async () => {
    const route = createBroadcastDiagRoute({});

    const response = await route(createRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'disabled',
      feature: 'broadcast_metrics',
    });
  });

  it('returns telemetry snapshot from storage-aware handler', async () => {
    const snapshot = {
      status: 'ok' as const,
      feature: 'broadcast_metrics' as const,
      totalRuns: 1,
      lastRun: null,
      history: [],
    };
    const telemetry = { snapshot: vi.fn().mockResolvedValue(snapshot) };
    const route = createBroadcastDiagRoute({ telemetry });

    const response = await route(createRequest());

    expect(await response.json()).toEqual({ ...snapshot, progress: null });
    expect(telemetry.snapshot).toHaveBeenCalled();
  });

  it('includes active checkpoint progress with TTL and commands', async () => {
    const now = new Date('2025-01-01T00:00:05Z');
    const kv = new MemoryKv(() => now.getTime());
    const checkpoint = {
      jobId: 'job-42',
      status: 'paused' as const,
      offset: 5,
      delivered: 4,
      failed: 1,
      throttled429: 2,
      total: 10,
      text: 'hello',
      textHash: 'text-hash',
      audienceHash: 'aud-hash',
      pool: { concurrency: 2, maxRps: 28 },
      batchSize: 5,
      maxBatchTextBytes: 10_000,
      filters: undefined,
      source: 'D1' as const,
      updatedAt: '2025-01-01T00:00:00.000Z',
      ttlSeconds: 600,
      expiresAt: '2025-01-01T00:10:00.000Z',
      reason: 'telegram_limit_exceeded' as const,
    };

    await kv.put('broadcast:progress:job-42', JSON.stringify({ version: 1, checkpoint }), {
      expirationTtl: checkpoint.ttlSeconds,
    });

    const telemetrySnapshot = {
      status: 'ok' as const,
      feature: 'broadcast_metrics' as const,
      totalRuns: 2,
      lastRun: null,
      history: [],
    };

    const route = createBroadcastDiagRoute({
      telemetry: { snapshot: vi.fn().mockResolvedValue(telemetrySnapshot) },
      progressKv: kv,
      now: () => now.getTime(),
    });

    const response = await route(createRequest());
    const body = await response.json();

    expect(body.progress).toMatchObject({
      jobId: 'job-42',
      status: 'paused',
      remaining: 5,
      ttlSeconds: 600,
      commands: { resume: '/broadcast_resume job-42', cancel: '/cancel_broadcast' },
      reason: 'telegram_limit_exceeded',
      pool: { concurrency: 2, maxRps: 28 },
      batchSize: 5,
      maxBatchTextBytes: 10_000,
    });
    expect(body.progress.ttlSecondsRemaining).toBeGreaterThanOrEqual(594);
  });
});
