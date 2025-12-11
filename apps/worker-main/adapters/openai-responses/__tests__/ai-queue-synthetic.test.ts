import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiQueueConfigSources } from '../../../ports';
import { createOpenAIResponsesAdapter } from '..';

type QueueConfig = {
  maxConcurrency: number;
  maxQueueSize: number;
  requestTimeoutMs: number;
  retryMax: number;
  baseUrls: string[];
  endpointFailoverThreshold: number;
};

type SyntheticEvent = {
  at: number;
  durationMs: number;
  userId: string;
};

type ScenarioResult = {
  ok: number;
  degraded: number;
  timeouts: number;
  otherErrors: number;
  fetchCalls: number;
};

const baseSources: AiQueueConfigSources = {
  maxConcurrency: 'kv',
  maxQueueSize: 'kv',
  requestTimeoutMs: 'kv',
  retryMax: 'kv',
  baseUrls: 'kv',
  endpointFailoverThreshold: 'kv',
  kvConfig: 'AI_QUEUE_CONFIG',
};

const createFetchMock = (durationsMs: number[]) => {
  let call = 0;
  return vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>((resolve) => {
    const duration = durationsMs[Math.min(call, durationsMs.length - 1)] ?? durationsMs.at(-1) ?? 1_000;
    call += 1;
    setTimeout(() => {
      resolve(
        new Response(
          JSON.stringify({
            id: `resp_${call}`,
            status: 'completed',
            output_text: `ok_${call}`,
          }),
        ),
      );
    }, duration);
  }));
};

const buildEventsFromDurations = (durations: number[]): SyntheticEvent[] => {
  const events: SyntheticEvent[] = [];
  let currentTime = 0;

  for (let index = 0; index < durations.length; index += 1) {
    const durationMs = durations[index] ?? 1_000;

    if (index % 15 === 0 && index + 1 < durations.length) {
      events.push({ at: currentTime, durationMs, userId: `user-${index % 28}` });
      events.push({
        at: currentTime,
        durationMs: durations[index + 1] ?? durationMs,
        userId: `user-${(index + 1) % 28}`,
      });
      index += 1;
      currentTime += 1_500;
      continue;
    }

    events.push({ at: currentTime, durationMs, userId: `user-${index % 28}` });
    currentTime += 1_200;
  }

  return events;
};

const buildFieldProfileDurations = (): number[] => [
  ...Array.from({ length: 12 }, () => 1_500),
  ...Array.from({ length: 23 }, () => 3_500),
  ...Array.from({ length: 25 }, () => 7_500),
  ...Array.from({ length: 11 }, () => 13_000),
  ...Array.from({ length: 12 }, () => 18_500),
  ...Array.from({ length: 2 }, () => 21_000),
  ...Array.from({ length: 1 }, () => 45_000),
  ...Array.from({ length: 1 }, () => 80_000),
];

const buildGrowthBurstEvents = (count: number, durationMs: number): SyntheticEvent[] =>
  Array.from({ length: count }, (_, index) => ({
    at: 0,
    durationMs,
    userId: `growth-${index % 50}`,
  }));

const runScenario = async (
  events: SyntheticEvent[],
  config: QueueConfig,
): Promise<ScenarioResult> => {
  const fetchMock = createFetchMock(events.map((event) => event.durationMs));
  const adapter = createOpenAIResponsesAdapter({
    apiKey: 'test-key',
    model: 'gpt-4o-mini',
    fetchApi: fetchMock,
    baseUrls: config.baseUrls,
    endpointFailoverThreshold: config.endpointFailoverThreshold,
    runtime: {
      maxConcurrency: config.maxConcurrency,
      maxQueueSize: config.maxQueueSize,
      requestTimeoutMs: config.requestTimeoutMs,
      retryMax: config.retryMax,
      baseUrls: config.baseUrls,
      endpointFailoverThreshold: config.endpointFailoverThreshold,
      sources: baseSources,
    },
    requestTimeoutMs: config.requestTimeoutMs,
    maxRetries: config.retryMax,
  });

  const tasks: Array<Promise<{ kind: 'ok' | 'degraded' | 'timeout' | 'other' }>> = [];

  for (const event of events) {
    setTimeout(() => {
      const promise = adapter
        .reply({
          userId: event.userId,
          text: 'Привет',
          context: [],
          languageCode: 'ru',
        })
        .then((result) => {
          if (result.metadata && (result.metadata as { degraded?: boolean }).degraded) {
            return { kind: 'degraded' as const };
          }
          return { kind: 'ok' as const };
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('AI_QUEUE_TIMEOUT') || message.includes('timed out')) {
            return { kind: 'timeout' as const };
          }
          return { kind: 'other' as const };
        });

      tasks.push(promise);
    }, event.at);
  }

  const lastEventTs = events.reduce(
    (max, event) => Math.max(max, event.at + event.durationMs),
    0,
  );

  const maxDurationMs = events.reduce((max, event) => Math.max(max, event.durationMs), 0);
  const batches = Math.ceil(events.length / Math.max(1, config.maxConcurrency));
  const totalBudgetMs = lastEventTs + batches * maxDurationMs + config.requestTimeoutMs + 2_000;

  await vi.advanceTimersByTimeAsync(totalBudgetMs);
  const settled = await Promise.all(tasks);

  const summary = settled.reduce<ScenarioResult>(
    (acc, current) => {
      if (current.kind === 'ok') acc.ok += 1;
      else if (current.kind === 'degraded') acc.degraded += 1;
      else if (current.kind === 'timeout') acc.timeouts += 1;
      else acc.otherErrors += 1;
      return acc;
    },
    { ok: 0, degraded: 0, timeouts: 0, otherErrors: 0, fetchCalls: 0 },
  );

  summary.fetchCalls = fetchMock.mock.calls.length;
  return summary;
};

describe('AI queue synthetic load', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reduces timeouts on field-like profile when timeout budget increases to 20s', async () => {
    const fieldEvents = buildEventsFromDurations(buildFieldProfileDurations());

    const baseline = await runScenario(fieldEvents, {
      maxConcurrency: 4,
      maxQueueSize: 64,
      requestTimeoutMs: 18_000,
      retryMax: 3,
      baseUrls: ['https://api.openai.com/v1/responses'],
      endpointFailoverThreshold: 3,
    });

    const tuned = await runScenario(fieldEvents, {
      maxConcurrency: 4,
      maxQueueSize: 64,
      requestTimeoutMs: 20_000,
      retryMax: 3,
      baseUrls: [
        'https://api.openai.com/v1/responses',
        'https://api.openai.com/v1/responses?cf_region=eu',
      ],
      endpointFailoverThreshold: 3,
    });

    expect(baseline.timeouts).toBeGreaterThan(tuned.timeouts);
    expect(tuned.timeouts).toBeGreaterThan(0);
    expect(baseline.degraded).toBe(0);
    expect(tuned.degraded).toBe(0);
  }, 20_000);

  it('avoids queue overflows for growth bursts with a wider queue', async () => {
    const growthEvents = buildGrowthBurstEvents(80, 8_000);

    const baseline = await runScenario(growthEvents, {
      maxConcurrency: 4,
      maxQueueSize: 64,
      requestTimeoutMs: 18_000,
      retryMax: 3,
      baseUrls: ['https://api.openai.com/v1/responses'],
      endpointFailoverThreshold: 3,
    });

    const tuned = await runScenario(growthEvents, {
      maxConcurrency: 4,
      maxQueueSize: 128,
      requestTimeoutMs: 20_000,
      retryMax: 3,
      baseUrls: [
        'https://api.openai.com/v1/responses',
        'https://api.openai.com/v1/responses?cf_region=eu',
      ],
      endpointFailoverThreshold: 3,
    });

    expect(baseline.degraded).toBeGreaterThan(0);
    expect(tuned.degraded).toBe(0);
  }, 20_000);
});
