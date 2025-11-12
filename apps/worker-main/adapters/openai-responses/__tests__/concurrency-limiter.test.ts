import { describe, expect, it } from 'vitest';

import { createAiLimiter } from '../concurrency-limiter';

describe('createAiLimiter', () => {
  it('enforces concurrency limit and drains queue in FIFO order', async () => {
    let currentTime = 0;
    const limiter = createAiLimiter({ maxConcurrency: 1, maxQueueSize: 2, now: () => currentTime });

    const acquisitionLog: Array<{ phase: string; active: number; queued: number; queueWaitMs?: number }> = [];

    const releaseFirst = await limiter.acquire({
      onAcquire: (stats) => {
        acquisitionLog.push({ phase: 'first-acquired', active: stats.active, queued: stats.queued, queueWaitMs: stats.queueWaitMs });
      },
    });

    const secondAcquire = limiter.acquire({
      onQueue: (stats) => {
        acquisitionLog.push({ phase: 'second-queued', active: stats.active, queued: stats.queued });
      },
      onAcquire: (stats) => {
        acquisitionLog.push({ phase: 'second-acquired', active: stats.active, queued: stats.queued, queueWaitMs: stats.queueWaitMs });
      },
    });

    const thirdAcquire = limiter.acquire({
      onQueue: (stats) => {
        acquisitionLog.push({ phase: 'third-queued', active: stats.active, queued: stats.queued });
      },
      onAcquire: (stats) => {
        acquisitionLog.push({ phase: 'third-acquired', active: stats.active, queued: stats.queued, queueWaitMs: stats.queueWaitMs });
      },
    });

    currentTime = 25;
    releaseFirst();
    const releaseSecond = await secondAcquire;

    currentTime = 50;
    releaseSecond();
    const releaseThird = await thirdAcquire;
    releaseThird();

    expect(acquisitionLog).toEqual([
      { phase: 'first-acquired', active: 1, queued: 0, queueWaitMs: 0 },
      { phase: 'second-queued', active: 1, queued: 1 },
      { phase: 'third-queued', active: 1, queued: 2 },
      { phase: 'second-acquired', active: 1, queued: 1, queueWaitMs: 25 },
      { phase: 'third-acquired', active: 1, queued: 0, queueWaitMs: 50 },
    ]);

    expect(limiter.getStats()).toEqual({ active: 0, queued: 0, dropped: 0, maxConcurrency: 1, maxQueueSize: 2 });
  });

  it('rejects when the queue is full and tracks drops', async () => {
    const limiter = createAiLimiter({ maxConcurrency: 1, maxQueueSize: 0 });

    const release = await limiter.acquire();
    await expect(limiter.acquire()).rejects.toThrow('AI_QUEUE_FULL');
    expect(limiter.getStats()).toMatchObject({ active: 1, queued: 0, dropped: 1 });

    release();
    expect(limiter.getStats()).toMatchObject({ active: 0, queued: 0, dropped: 1 });
  });
});
