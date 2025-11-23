import { describe, expect, it } from 'vitest';

import { createBroadcastTelemetry } from '../broadcast-telemetry';

class MemoryKv implements KVNamespace {
  readonly store = new Map<string, { value: string; expirationTtl?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    return entry?.value ?? null;
  }

  async put(key: string, value: string, options: { expirationTtl: number }): Promise<void> {
    this.store.set(key, { value, expirationTtl: options.expirationTtl });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string; expiration?: number }>;
    list_complete: boolean;
    cursor: string;
  }> {
    const filteredKeys = Array.from(this.store.keys()).filter((key) =>
      options?.prefix ? key.startsWith(options.prefix) : true,
    );
    const limitedKeys = typeof options?.limit === 'number'
      ? filteredKeys.slice(0, options.limit)
      : filteredKeys;

    return {
      keys: limitedKeys.map((name) => ({ name })),
      list_complete: true,
      cursor: '',
    };
  }
}

const createRecordInput = (overrides: Partial<Parameters<ReturnType<typeof createBroadcastTelemetry>['record']>[0]> = {}) => ({
  requestedBy: 'ops',
  recipients: 10,
  delivered: 8,
  failed: 2,
  throttled429: 1,
  durationMs: 100,
  startedAt: new Date('2025-01-01T00:00:00Z'),
  completedAt: new Date('2025-01-01T00:01:00Z'),
  status: 'ok' as const,
  ...overrides,
});

describe('createBroadcastTelemetry', () => {
  it('persists snapshot to KV per environment and worker', async () => {
    const kv = new MemoryKv();
    const now = new Date('2025-01-01T02:00:00Z');
    const telemetry = createBroadcastTelemetry({
      storage: {
        kv,
        environment: 'dev',
        workerId: 'worker-a',
        ttlSeconds: 120,
        now: () => now,
      },
    });

    await telemetry.record(createRecordInput());

    const entry = kv.store.get('broadcast:telemetry:dev:worker-a');
    expect(entry?.expirationTtl).toBe(120);

    const storedSnapshot = entry ? JSON.parse(entry.value) : undefined;
    expect(storedSnapshot).toMatchObject({
      workerId: 'worker-a',
      environment: 'dev',
      updatedAt: now.toISOString(),
      totalRuns: 1,
      history: [expect.objectContaining({ requestedBy: 'ops', completedAt: '2025-01-01T00:01:00.000Z' })],
    });
  });

  it('merges stored snapshots across workers and re-instantiations', async () => {
    const kv = new MemoryKv();

    const firstTelemetry = createBroadcastTelemetry({
      storage: {
        kv,
        environment: 'prod',
        workerId: 'worker-a',
        now: () => new Date('2025-01-02T10:00:00Z'),
      },
    });

    await firstTelemetry.record(
      createRecordInput({
        requestedBy: 'ops-a',
        startedAt: new Date('2025-01-02T09:00:00Z'),
        completedAt: new Date('2025-01-02T09:05:00Z'),
      }),
    );

    const rehydratedTelemetry = createBroadcastTelemetry({
      storage: {
        kv,
        environment: 'prod',
        workerId: 'worker-b',
        now: () => new Date('2025-01-02T11:00:00Z'),
      },
    });

    const initialSnapshot = await rehydratedTelemetry.snapshot();
    expect(initialSnapshot.totalRuns).toBe(1);
    expect(initialSnapshot.lastRun?.requestedBy).toBe('ops-a');

    await rehydratedTelemetry.record(
      createRecordInput({
        requestedBy: 'ops-b',
        startedAt: new Date('2025-01-02T10:30:00Z'),
        completedAt: new Date('2025-01-02T10:31:00Z'),
      }),
    );

    const mergedSnapshot = await rehydratedTelemetry.snapshot();
    expect(mergedSnapshot.totalRuns).toBe(2);
    expect(mergedSnapshot.history).toEqual([
      expect.objectContaining({ requestedBy: 'ops-a' }),
      expect.objectContaining({ requestedBy: 'ops-b' }),
    ]);
    expect(mergedSnapshot.lastRun?.requestedBy).toBe('ops-b');
  });
});
