import { describe, expect, it, vi } from 'vitest';

import { createOpenAIResponsesAdapter } from '../adapters/openai-responses';
import type { AiPort } from '../ports';

type AiReply = Awaited<ReturnType<AiPort['reply']>>;

describe('ai queue integration', () => {
  const createResponse = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'x-request-id': 'req_integration' },
      ...init,
    });

  it('processes queued requests with low degradation rate', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    try {
      let responseIndex = 0;
      const fetchMock = vi
        .fn<Parameters<typeof fetch>, Promise<Response>>()
        .mockImplementation(() => {
          const currentIndex = responseIndex;
          responseIndex += 1;

          return new Promise((resolve) => {
            setTimeout(() => {
              resolve(
                createResponse({
                  id: `resp_${currentIndex}`,
                  status: 'completed',
                  output: [
                    {
                      type: 'message',
                      content: [{ type: 'output_text', text: `Reply ${currentIndex}` }],
                    },
                  ],
                }),
              );
            }, 500);
          });
        });

      const adapter = createOpenAIResponsesAdapter({
        apiKey: 'test-key',
        model: 'gpt-4o-mini',
        fetchApi: fetchMock,
        requestTimeoutMs: 60_000,
        maxRetries: 3,
        runtime: {
          maxConcurrency: 4,
          maxQueueSize: 64,
          requestTimeoutMs: 60_000,
          retryMax: 3,
        },
      });

      const replies = Array.from({ length: 8 }, (_, index) =>
        adapter.reply({ userId: `user-${index}`, text: `Message ${index}`, context: [] }),
      );

      const settledPromise = Promise.allSettled(replies);
      await vi.runAllTimersAsync();
      const results = await settledPromise;

      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<AiReply> => result.status === 'fulfilled',
      );
      expect(fulfilled).toHaveLength(8);

      const degradedCount = fulfilled.filter((result) => result.value.metadata?.degraded === true)
        .length;
      const degradationRate = degradedCount / fulfilled.length;

      expect(degradationRate).toBeLessThanOrEqual(0.03);
      expect(fetchMock).toHaveBeenCalledTimes(8);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
