import { describe, expect, it } from 'vitest';

import type { AiPort } from '../../../ports';
import { createAiQueueDiagRoute } from '../ai-queue-route';

const createAiPort = (overrides: Partial<AiPort> = {}): AiPort => ({
  async reply() {
    throw new Error('not implemented');
  },
  ...overrides,
});

describe('createAiQueueDiagRoute', () => {
  it('returns queue stats when available', async () => {
    const ai = createAiPort({
      getQueueStats: () => ({
        active: 1,
        queued: 2,
        maxConcurrency: 4,
        maxQueue: 64,
        droppedSinceBoot: 0,
        avgWaitMs: 12,
        lastDropAt: null,
        requestTimeoutMs: 18_000,
        retryMax: 3,
        sources: {
          maxConcurrency: 'kv',
          maxQueueSize: 'kv',
          requestTimeoutMs: 'env',
          retryMax: 'default',
          kvConfig: 'AI_QUEUE_CONFIG',
        },
      }),
    });

    const route = createAiQueueDiagRoute({ ai });
    const response = await route(new Request('https://example.test/admin/diag?q=ai-queue'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      active: 1,
      queued: 2,
      maxConcurrency: 4,
      maxQueue: 64,
      droppedSinceBoot: 0,
      avgWaitMs: 12,
      lastDropAt: null,
      requestTimeoutMs: 18_000,
      retryMax: 3,
      sources: {
        maxConcurrency: 'kv',
        maxQueueSize: 'kv',
        requestTimeoutMs: 'env',
        retryMax: 'default',
        kvConfig: 'AI_QUEUE_CONFIG',
      },
    });
  });

  it('marks warning when queue usage crosses the threshold', async () => {
    const ai = createAiPort({
      getQueueStats: () => ({
        active: 4,
        queued: 48,
        maxConcurrency: 4,
        maxQueue: 64,
        droppedSinceBoot: 0,
        avgWaitMs: 42,
        lastDropAt: null,
      }),
    });

    const route = createAiQueueDiagRoute({ ai });
    const response = await route(new Request('https://example.test/admin/diag?q=ai-queue'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'warning',
      active: 4,
      queued: 48,
      maxConcurrency: 4,
      maxQueue: 64,
      droppedSinceBoot: 0,
      avgWaitMs: 42,
      lastDropAt: null,
      requestTimeoutMs: null,
      retryMax: null,
      sources: null,
    });
  });

  it('marks degraded when drops are observed', async () => {
    const now = Date.now();
    const ai = createAiPort({
      getQueueStats: () => ({
        active: 4,
        queued: 64,
        maxConcurrency: 4,
        maxQueue: 64,
        droppedSinceBoot: 2,
        avgWaitMs: 75,
        lastDropAt: now,
      }),
    });

    const route = createAiQueueDiagRoute({ ai });
    const response = await route(new Request('https://example.test/admin/diag?q=ai-queue'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('degraded');
    expect(body).toMatchObject({
      active: 4,
      queued: 64,
      maxConcurrency: 4,
      maxQueue: 64,
      droppedSinceBoot: 2,
      avgWaitMs: 75,
      requestTimeoutMs: null,
      retryMax: null,
      sources: null,
    });
    expect(body.lastDropAt).toBe(new Date(now).toISOString());
  });

  it('returns 503 when queue stats are unavailable', async () => {
    const ai = createAiPort();
    const route = createAiQueueDiagRoute({ ai });

    const response = await route(new Request('https://example.test/admin/diag?q=ai-queue'));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'AI queue metrics are not available',
    });
  });

  it('returns 400 for unsupported query', async () => {
    const ai = createAiPort({
      getQueueStats: () => ({
        active: 0,
        queued: 0,
        maxConcurrency: 1,
        maxQueue: 1,
        droppedSinceBoot: 0,
        avgWaitMs: 0,
        lastDropAt: null,
      }),
    });
    const route = createAiQueueDiagRoute({ ai });

    const response = await route(new Request('https://example.test/admin/diag?q=other'));

    expect(response.status).toBe(400);
  });

  it('returns 405 for non-GET requests', async () => {
    const ai = createAiPort({
      getQueueStats: () => ({
        active: 0,
        queued: 0,
        maxConcurrency: 1,
        maxQueue: 1,
        droppedSinceBoot: 0,
        avgWaitMs: 0,
        lastDropAt: null,
      }),
    });
    const route = createAiQueueDiagRoute({ ai });

    const response = await route(new Request('https://example.test/admin/diag?q=ai-queue', { method: 'POST' }));

    expect(response.status).toBe(405);
  });
});
