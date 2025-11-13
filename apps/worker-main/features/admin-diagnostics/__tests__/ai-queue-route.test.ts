import { describe, expect, it } from 'vitest';

import type { AiPort, AiQueueStats } from '../../../ports';
import { createAiQueueDiagRoute } from '../ai-queue-route';

const createAiPort = (overrides: Partial<AiPort> = {}): AiPort => ({
  async reply() {
    throw new Error('not implemented');
  },
  ...overrides,
});

const createQueueStats = (overrides: Partial<AiQueueStats> = {}): AiQueueStats => ({
  active: 0,
  queued: 0,
  maxConcurrency: 4,
  maxQueue: 64,
  droppedSinceBoot: 0,
  avgWaitMs: 0,
  lastDropAt: null,
  requestTimeoutMs: 18_000,
  retryMax: 3,
  sources: {
    maxConcurrency: 'default',
    maxQueueSize: 'default',
    requestTimeoutMs: 'default',
    retryMax: 'default',
    baseUrls: 'default',
    endpointFailoverThreshold: 'default',
    kvConfig: null,
  },
  endpoints: {
    activeEndpointId: 'endpoint_1',
    activeBaseUrl: 'https://api.openai.com/v1/responses',
    backupBaseUrls: [],
    failoverCounts: { endpoint_1: 0 },
  },
  ...overrides,
  sources: {
    maxConcurrency: overrides.sources?.maxConcurrency ?? 'default',
    maxQueueSize: overrides.sources?.maxQueueSize ?? 'default',
    requestTimeoutMs: overrides.sources?.requestTimeoutMs ?? 'default',
    retryMax: overrides.sources?.retryMax ?? 'default',
    baseUrls: overrides.sources?.baseUrls ?? 'default',
    endpointFailoverThreshold: overrides.sources?.endpointFailoverThreshold ?? 'default',
    kvConfig: overrides.sources?.kvConfig ?? null,
  },
  endpoints: {
    activeEndpointId: overrides.endpoints?.activeEndpointId ?? 'endpoint_1',
    activeBaseUrl:
      overrides.endpoints?.activeBaseUrl ?? 'https://api.openai.com/v1/responses',
    backupBaseUrls: overrides.endpoints?.backupBaseUrls ?? [],
    failoverCounts: overrides.endpoints?.failoverCounts ?? { endpoint_1: 0 },
  },
});

describe('createAiQueueDiagRoute', () => {
  it('returns queue stats when available', async () => {
    const ai = createAiPort({
      getQueueStats: () =>
        createQueueStats({
          active: 1,
          queued: 2,
          avgWaitMs: 12,
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
      requestTimeoutMs: 18_000,
      retryMax: 3,
      droppedSinceBoot: 0,
      avgWaitMs: 12,
      lastDropAt: null,
      endpoints: {
        activeBaseUrl: 'https://api.openai.com/v1/responses',
        backupBaseUrls: [],
        failoverCounts: { endpoint_1: 0 },
      },
      sources: {
        maxConcurrency: 'default',
        maxQueueSize: 'default',
        requestTimeoutMs: 'default',
        retryMax: 'default',
        baseUrls: 'default',
        endpointFailoverThreshold: 'default',
        kvConfig: null,
      },
    });
  });

  it('marks warning when queue usage crosses the threshold', async () => {
    const ai = createAiPort({
      getQueueStats: () =>
        createQueueStats({
          active: 4,
          queued: 48,
          avgWaitMs: 42,
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
      requestTimeoutMs: 18_000,
      retryMax: 3,
      droppedSinceBoot: 0,
      avgWaitMs: 42,
      lastDropAt: null,
      endpoints: {
        activeBaseUrl: 'https://api.openai.com/v1/responses',
        backupBaseUrls: [],
        failoverCounts: { endpoint_1: 0 },
      },
      sources: {
        maxConcurrency: 'default',
        maxQueueSize: 'default',
        requestTimeoutMs: 'default',
        retryMax: 'default',
        baseUrls: 'default',
        endpointFailoverThreshold: 'default',
        kvConfig: null,
      },
    });
  });

  it('exposes endpoint diagnostics block', async () => {
    const ai = createAiPort({
      getQueueStats: () =>
        createQueueStats({
          endpoints: {
            activeEndpointId: 'endpoint_2',
            activeBaseUrl: 'https://api.openai.com/v1/responses?cf_region=eu',
            backupBaseUrls: [
              'https://api.openai.com/v1/responses',
              'https://api.openai.com/v1/responses?cf_region=asia',
            ],
            failoverCounts: { endpoint_1: 2, endpoint_2: 0, endpoint_3: 1 },
          },
        }),
    });

    const route = createAiQueueDiagRoute({ ai });
    const response = await route(new Request('https://example.test/admin/diag?q=ai-queue'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      endpoints: {
        activeBaseUrl: 'https://api.openai.com/v1/responses?cf_region=eu',
        backupBaseUrls: [
          'https://api.openai.com/v1/responses',
          'https://api.openai.com/v1/responses?cf_region=asia',
        ],
        failoverCounts: { endpoint_1: 2, endpoint_2: 0, endpoint_3: 1 },
      },
    });
  });

  it('marks degraded when drops are observed', async () => {
    const now = Date.now();
    const ai = createAiPort({
      getQueueStats: () =>
        createQueueStats({
          active: 4,
          queued: 64,
          droppedSinceBoot: 2,
          avgWaitMs: 75,
          lastDropAt: now,
          requestTimeoutMs: 20_000,
          retryMax: 5,
          sources: {
            maxConcurrency: 'kv',
            maxQueueSize: 'kv',
            requestTimeoutMs: 'env',
            retryMax: 'env',
            baseUrls: 'kv',
            endpointFailoverThreshold: 'env',
            kvConfig: 'AI_QUEUE_CONFIG',
          },
          endpoints: {
            activeEndpointId: 'endpoint_2',
            activeBaseUrl: 'https://api.openai.com/v1/responses?cf_region=eu',
            backupBaseUrls: ['https://api.openai.com/v1/responses'],
            failoverCounts: { endpoint_1: 1, endpoint_2: 0 },
          },
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
      requestTimeoutMs: 20_000,
      retryMax: 5,
      droppedSinceBoot: 2,
      avgWaitMs: 75,
      endpoints: {
        activeBaseUrl: 'https://api.openai.com/v1/responses?cf_region=eu',
        backupBaseUrls: ['https://api.openai.com/v1/responses'],
        failoverCounts: { endpoint_1: 1, endpoint_2: 0 },
      },
      sources: {
        maxConcurrency: 'kv',
        maxQueueSize: 'kv',
        requestTimeoutMs: 'env',
        retryMax: 'env',
        baseUrls: 'kv',
        endpointFailoverThreshold: 'env',
        kvConfig: 'AI_QUEUE_CONFIG',
      },
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
      getQueueStats: () => createQueueStats({ maxConcurrency: 1, maxQueue: 1 }),
    });
    const route = createAiQueueDiagRoute({ ai });

    const response = await route(new Request('https://example.test/admin/diag?q=other'));

    expect(response.status).toBe(400);
  });

  it('returns 405 for non-GET requests', async () => {
    const ai = createAiPort({
      getQueueStats: () => createQueueStats({ maxConcurrency: 1, maxQueue: 1 }),
    });
    const route = createAiQueueDiagRoute({ ai });

    const response = await route(new Request('https://example.test/admin/diag?q=ai-queue', { method: 'POST' }));

    expect(response.status).toBe(405);
  });
});
