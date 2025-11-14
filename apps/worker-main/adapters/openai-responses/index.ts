import type {
  AiPort,
  AiQueueConfigSources,
  AiQueueStats,
  ConversationTurn,
} from '../../ports';
import { sanitizeVisibleText, stripControlCharacters } from '../../shared';
import { createAiLimiter, type AiLimiterStats } from './concurrency-limiter';
import { getFriendlyOverloadMessage } from './overload-message';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_ENDPOINT_FAILOVER_THRESHOLD = 3;

export interface OpenAIResponsesAdapterOptions {
  apiKey: string;
  model: string;
  promptId?: string;
  promptVariables?: Record<string, unknown>;
  fetchApi?: typeof fetch;
  baseUrl?: string;
  baseUrls?: ReadonlyArray<string>;
  requestTimeoutMs?: number;
  maxRetries?: number;
  endpointFailoverThreshold?: number;
  runtime: {
    maxConcurrency: number;
    maxQueueSize: number;
    requestTimeoutMs: number;
    retryMax: number;
    sources: AiQueueConfigSources;
  };
  logger?: {
    warn?: (message: string, details?: Record<string, unknown>) => void;
    error?: (message: string, details?: Record<string, unknown>) => void;
  };
}

interface ResponsesApiErrorPayload {
  error?: {
    message?: string;
    type?: string;
    code?: string | number;
  };
}

interface ResponsesOutputContent {
  type?: string;
  text?: string | { value?: unknown };
}

interface ResponsesOutputItem {
  type?: string;
  role?: string;
  content?: ResponsesOutputContent[];
}

interface ResponsesApiSuccessPayload {
  id?: string;
  status?: string;
  output?: ResponsesOutputItem[];
  metadata?: Record<string, unknown>;
  output_text?: string | string[];
}

const sanitizeOutputText = (text: string): string => sanitizeVisibleText(text);

const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

const mapTurnToContentType = (role: ConversationTurn['role']): string => {
  switch (role) {
    case 'assistant':
      return 'output_text';
    case 'system':
    case 'user':
    default:
      return 'input_text';
  }
};

const buildInputMessages = (
  context: ReadonlyArray<ConversationTurn>,
  latestText: string,
): Array<Record<string, unknown>> => {
  const history = context.map((turn) => ({
    role: turn.role,
    content: [
      {
        type: mapTurnToContentType(turn.role),
        text: stripControlCharacters(turn.text),
      },
    ],
  }));

  return [
    ...history,
    {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: stripControlCharacters(latestText),
        },
      ],
    },
  ];
};

const mapLimiterStatsToQueueStats = (
  stats: AiLimiterStats,
  runtime: OpenAIResponsesAdapterOptions['runtime'],
  endpoints: AiQueueStats['endpoints'],
): AiQueueStats => ({
  active: stats.active,
  queued: stats.queued,
  maxConcurrency: stats.maxConcurrency,
  maxQueue: stats.maxQueueSize,
  droppedSinceBoot: stats.droppedSinceBoot,
  avgWaitMs: stats.avgWaitMs,
  lastDropAt: stats.lastDropAt,
  requestTimeoutMs: runtime.requestTimeoutMs,
  retryMax: runtime.retryMax,
  sources: runtime.sources,
  endpoints,
});

const createQueueLogPayload = (
  stats: AiLimiterStats,
  runtime: OpenAIResponsesAdapterOptions['runtime'],
  endpoints: AiQueueStats['endpoints'],
  extra: Record<string, unknown>,
): Record<string, unknown> => ({
  ...mapLimiterStatsToQueueStats(stats, runtime, endpoints),
  ...extra,
});

const extractTextFromPayload = (
  payload: ResponsesApiSuccessPayload,
): { text: string; usedOutputText: boolean } => {
  const normalizeChunks = (value: string | string[]): string[] => {
    if (typeof value === 'string') {
      return [value];
    }

    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string');
    }

    return [];
  };

  const preferOutputText = normalizeChunks(payload.output_text ?? '')
    .map((chunk) => sanitizeOutputText(chunk))
    .filter((chunk) => chunk.length > 0);

  if (preferOutputText.length > 0) {
    return { text: preferOutputText.join('\n'), usedOutputText: true };
  }

  const chunks: string[] = [];

  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!Array.isArray(item?.content)) {
      continue;
    }

    for (const piece of item.content) {
      const rawText = (() => {
        const directText = piece?.text;

        if (typeof directText === 'string') {
          return directText;
        }

        if (
          directText
          && typeof directText === 'object'
          && 'value' in directText
          && typeof (directText as { value?: unknown }).value === 'string'
        ) {
          return (directText as { value: string }).value;
        }

        return undefined;
      })();

      if (typeof rawText === 'string' && rawText.trim().length > 0) {
        chunks.push(rawText);
      }
    }
  }

  const combined = sanitizeOutputText(chunks.join('\n'));
  if (combined.length === 0) {
    throw new Error('AI_EMPTY_REPLY');
  }

  return { text: combined, usedOutputText: false };
};

const createAbortSignal = (timeoutMs: number): { signal: AbortSignal; dispose: () => void } => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const dispose = () => {
    clearTimeout(timeoutId);
  };

  return { signal: controller.signal, dispose };
};

const DEFAULT_ERROR_MESSAGE = 'OpenAI Responses request failed';

const textEncoder = new TextEncoder();

const createUserIdHash = (userId: string): string => {
  const encoded = textEncoder.encode(userId);
  let hash = 0x811c9dc5;

  for (let index = 0; index < encoded.length; index += 1) {
    hash ^= encoded[index] ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
};

const waitFor = (ms: number): Promise<void> => {
  if (!Number.isFinite(ms) || ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const createWrappedError = (cause: unknown, fallbackMessage?: string): Error => {
  const suffix = cause instanceof Error && cause.message ? `: ${cause.message}` : '';
  const error = new Error(`${fallbackMessage ?? DEFAULT_ERROR_MESSAGE}${suffix}`);

  if (cause instanceof Error) {
    try {
      // @ts-expect-error cause is supported in modern runtimes, fallback otherwise
      error.cause = cause;
    } catch {
      // ignore assigning cause when not supported
    }
  }

  return error;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && Object.getPrototypeOf(value) === Object.prototype;

const extractPreviousResponseId = (
  context: ReadonlyArray<ConversationTurn>,
): string | undefined => {
  for (let index = context.length - 1; index >= 0; index -= 1) {
    const turn = context[index] as ConversationTurn & {
      metadata?: unknown;
    };

    if (turn.role !== 'assistant') {
      continue;
    }

    const metadata = (turn as { metadata?: unknown }).metadata;
    if (!metadata || typeof metadata !== 'object') {
      continue;
    }

    const rawResponseId = (metadata as { responseId?: unknown }).responseId;
    if (typeof rawResponseId === 'string') {
      const trimmed = rawResponseId.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }

  return undefined;
};

export const createOpenAIResponsesAdapter = (
  options: OpenAIResponsesAdapterOptions,
): AiPort => {
  const model = options.model.trim();

  if (model.length === 0) {
    options.logger?.error?.('openai-responses missing model');
    throw new Error('OPENAI_MODEL is required');
  }

  const promptId = typeof options.promptId === 'string' ? options.promptId.trim() : undefined;
  if (promptId && !/^pmpt_[A-Za-z0-9-]+$/.test(promptId)) {
    options.logger?.error?.('openai-prompt invalid id format', { promptId: options.promptId });
    throw new Error('OPENAI_PROMPT_ID must start with "pmpt_" and refer to a published OpenAI prompt');
  }

  const promptVariables = (() => {
    if (options.promptVariables === undefined) {
      return undefined;
    }

    if (!isPlainObject(options.promptVariables)) {
      options.logger?.error?.('openai-prompt variables must be a plain object');
      throw new Error('OPENAI_PROMPT_VARIABLES must be a JSON object');
    }

    return options.promptVariables;
  })();

  const runtime = options.runtime;
  const limiter = createAiLimiter({
    maxConcurrency: runtime.maxConcurrency,
    maxQueueSize: runtime.maxQueueSize,
  });

  const fetchImpl = options.fetchApi ?? fetch;
  const configuredBaseUrls = (() => {
    if (Array.isArray(options.baseUrls) && options.baseUrls.length > 0) {
      const normalized = options.baseUrls
        .map((url) => (typeof url === 'string' ? url.trim() : ''))
        .filter((url) => url.length > 0);
      if (normalized.length > 0) {
        return normalized;
      }
    }

    if (typeof options.baseUrl === 'string' && options.baseUrl.trim().length > 0) {
      return [options.baseUrl.trim()];
    }

    return [DEFAULT_BASE_URL];
  })();

  const endpoints = configuredBaseUrls.map((url, index) => ({
    id: `endpoint_${index + 1}`,
    url,
  }));

  if (endpoints.length === 0) {
    endpoints.push({ id: 'endpoint_1', url: DEFAULT_BASE_URL });
  }

  const failoverCounts = new Map<string, number>();
  endpoints.forEach((endpoint) => {
    failoverCounts.set(endpoint.id, 0);
  });

  const endpointHealth = endpoints.map(() => ({
    consecutiveRetryableErrors: 0,
    lastFailureAt: null as number | null,
  }));

  let activeEndpointIndex = 0;

  const endpointFailoverThreshold = Math.max(
    1,
    Math.floor(options.endpointFailoverThreshold ?? DEFAULT_ENDPOINT_FAILOVER_THRESHOLD),
  );

  const getEndpointByIndex = (index: number): { id: string; url: string } =>
    endpoints[index] ?? endpoints[0];

  const getEndpointDiagnostics = (): AiQueueStats['endpoints'] => {
    const activeEndpoint = getEndpointByIndex(activeEndpointIndex);
    return {
      activeEndpointId: activeEndpoint.id,
      activeBaseUrl: activeEndpoint.url,
      backupBaseUrls: endpoints
        .filter((_, index) => index !== activeEndpointIndex)
        .map((endpoint) => endpoint.url),
      failoverCounts: Object.fromEntries(
        endpoints.map((endpoint) => [endpoint.id, failoverCounts.get(endpoint.id) ?? 0]),
      ),
    };
  };

  const markEndpointSuccess = (index: number) => {
    const health = endpointHealth[index];
    if (health) {
      health.consecutiveRetryableErrors = 0;
      health.lastFailureAt = null;
    }
  };

  const markRetryableFailure = (index: number, reason: string) => {
    const health = endpointHealth[index];
    if (!health) {
      return;
    }

    health.consecutiveRetryableErrors += 1;
    health.lastFailureAt = Date.now();

    if (health.consecutiveRetryableErrors < endpointFailoverThreshold) {
      return;
    }

    if (endpoints.length <= 1 || index !== activeEndpointIndex) {
      health.consecutiveRetryableErrors = 0;
      return;
    }

    const previousEndpoint = endpoints[index];
    const nextIndex = (index + 1) % endpoints.length;
    const nextEndpoint = endpoints[nextIndex];

    activeEndpointIndex = nextIndex;
    failoverCounts.set(previousEndpoint.id, (failoverCounts.get(previousEndpoint.id) ?? 0) + 1);

    const nextHealth = endpointHealth[nextIndex];
    if (nextHealth) {
      nextHealth.consecutiveRetryableErrors = 0;
      nextHealth.lastFailureAt = null;
    }

    const consecutiveFailures = health.consecutiveRetryableErrors;

    // eslint-disable-next-line no-console
    console.warn('[ai][endpoint_failover]', {
      reason,
      from: previousEndpoint.id,
      fromBaseUrl: previousEndpoint.url,
      to: nextEndpoint.id,
      toBaseUrl: nextEndpoint.url,
      threshold: endpointFailoverThreshold,
      consecutiveFailures,
    });

    health.consecutiveRetryableErrors = 0;
  };

  const runtimeTimeoutMs = Math.max(1, Math.floor(runtime.requestTimeoutMs));
  const timeoutBudgetMs = Math.max(
    1,
    Math.min(options.requestTimeoutMs ?? runtimeTimeoutMs, DEFAULT_TIMEOUT_MS),
  );
  const runtimeRetryMax = Math.max(1, Math.floor(runtime.retryMax));
  const maxRetries = Math.max(
    1,
    Math.min(options.maxRetries ?? runtimeRetryMax, DEFAULT_MAX_RETRIES),
  );
  const { logger } = options;

  const execute = async (
    requestInit: RequestInit,
    attempt: number,
    attemptTimeoutMs: number,
  ): Promise<{ payload: ResponsesApiSuccessPayload; requestId?: string; endpointId: string; baseUrl: string }> => {
    const endpointIndex = activeEndpointIndex;
    const endpoint = getEndpointByIndex(endpointIndex);
    const requestBaseUrl = endpoint.url;
    const endpointId = endpoint.id;
    const { signal, dispose } = createAbortSignal(attemptTimeoutMs);

    try {
      // eslint-disable-next-line no-console
      console.info('[ai][request]', { attempt, endpointId, baseUrl: requestBaseUrl });

      const response = await fetchImpl(requestBaseUrl, {
        ...requestInit,
        signal,
      });

      const requestId = response.headers.get('x-request-id') ?? undefined;

      if (!response.ok) {
        const rawBody = await response.text();
        let errorPayload: ResponsesApiErrorPayload | undefined;
        try {
          errorPayload = rawBody ? (JSON.parse(rawBody) as ResponsesApiErrorPayload) : undefined;
        } catch {
          errorPayload = undefined;
        }
        const message = errorPayload?.error?.message ?? `HTTP ${response.status}`;
        const error = new Error(message);

        // eslint-disable-next-line no-console
        console.error('[ai][non-2xx]', {
          status: response.status,
          attempt,
          requestId,
          endpointId,
          baseUrl: requestBaseUrl,
          body: rawBody,
        });

        if (!isRetryableStatus(response.status) || attempt === maxRetries - 1) {
          logger?.error?.('openai-responses request failed', {
            status: response.status,
            attempt,
            requestId,
          });
          const terminalError = new Error('AI_NON_2XX');
          if (requestId) {
            (terminalError as { requestId?: string }).requestId = requestId;
          }
          throw terminalError;
        }

        logger?.warn?.('openai-responses retryable failure', {
          status: response.status,
          attempt,
          requestId,
        });

        markRetryableFailure(endpointIndex, `http_${response.status}`);
        throw Object.assign(error, { retryable: true, requestId, endpointId, baseUrl: requestBaseUrl });
      }

      const payload = (await response.json()) as ResponsesApiSuccessPayload;
      // eslint-disable-next-line no-console
      console.info('[ai][ok]', {
        attempt,
        requestId: requestId ?? null,
        endpointId,
        baseUrl: requestBaseUrl,
      });
      markEndpointSuccess(endpointIndex);
      return { payload, requestId, endpointId, baseUrl: requestBaseUrl };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        const timeoutError = new Error('OpenAI Responses request timed out');
        if (attempt === maxRetries - 1) {
          logger?.error?.('openai-responses request timeout', { attempt });
          throw createWrappedError(timeoutError);
        }

        logger?.warn?.('openai-responses retryable timeout', { attempt });
        // eslint-disable-next-line no-console
        console.warn('[ai][timeout]', { attempt, endpointId, baseUrl: requestBaseUrl });
        markRetryableFailure(endpointIndex, 'timeout');
        throw Object.assign(timeoutError, { retryable: true, endpointId, baseUrl: requestBaseUrl });
      }

      if (error instanceof Error && (error as { retryable?: boolean }).retryable === true) {
        throw error;
      }

      if (attempt === maxRetries - 1) {
        logger?.error?.('openai-responses request failed', { attempt });
        throw createWrappedError(error instanceof Error ? error : new Error(DEFAULT_ERROR_MESSAGE));
      }

      logger?.warn?.('openai-responses retryable network error', { attempt });
      markRetryableFailure(endpointIndex, 'network_error');
      throw Object.assign(error instanceof Error ? error : new Error('retryable failure'), {
        retryable: true,
        endpointId,
        baseUrl: requestBaseUrl,
      });
    } finally {
      dispose();
    }
  };

  return {
    getQueueStats(): AiQueueStats {
      return mapLimiterStatsToQueueStats(limiter.getStats(), runtime, getEndpointDiagnostics());
    },
    async reply(input) {
      const previousResponseId = extractPreviousResponseId(input.context);

      const body: Record<string, unknown> = {
        model,
        input: buildInputMessages(input.context, input.text),
        metadata: {
          userId: input.userId,
        },
      };

      if (promptId) {
        body.prompt = promptVariables
          ? { id: promptId, variables: promptVariables }
          : { id: promptId };
      }

      if (previousResponseId) {
        body.previous_response_id = previousResponseId;
      }

      const serializedBody = JSON.stringify(body);
      const deadline = Date.now() + timeoutBudgetMs;
      const userIdHash = createUserIdHash(input.userId);
      const overloadMessage = getFriendlyOverloadMessage(input.languageCode);

      let lastError: unknown;

      for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        const remainingBeforeAcquire = deadline - Date.now();
        if (remainingBeforeAcquire <= 0) {
          // eslint-disable-next-line no-console
          console.error(
            '[ai][timeout]',
            createQueueLogPayload(limiter.getStats(), runtime, getEndpointDiagnostics(), {
              phase: 'budget_exhausted',
              attempt: attempt + 1,
              userIdHash,
              requestId: null,
              queueWaitMs: 0,
            }),
          );
          throw new Error('AI_QUEUE_TIMEOUT');
        }

        let release: (() => void) | undefined;
        let queueWaitMs = 0;
        let lastDropStats: AiLimiterStats | undefined;
        let shouldRetry = false;
        let retryDelayMs = 0;

        try {
          release = await limiter.acquire({
            onQueue: (stats) => {
              // eslint-disable-next-line no-console
            console.info(
              '[ai][queue_enter]',
              createQueueLogPayload(stats, runtime, getEndpointDiagnostics(), {
                requestId: null,
                userIdHash,
                queueWaitMs: 0,
              }),
            );
          },
          onAcquire: ({ queueWaitMs: waitMs, ...stats }) => {
            queueWaitMs = waitMs;
            // eslint-disable-next-line no-console
            console.info(
              '[ai][queue_leave]',
              createQueueLogPayload(stats, runtime, getEndpointDiagnostics(), {
                requestId: null,
                userIdHash,
                queueWaitMs: waitMs,
              }),
            );
            },
            onDrop: (stats) => {
              lastDropStats = stats;
            },
          });
        } catch (error) {
          if (error instanceof Error && error.message === 'AI_QUEUE_DROPPED') {
            const stats = lastDropStats ?? limiter.getStats();
            logger?.error?.('openai-responses queue full', stats);
            // eslint-disable-next-line no-console
            console.error(
              '[ai][dropped]',
              createQueueLogPayload(stats, runtime, getEndpointDiagnostics(), {
                reason: 'queue_overflow',
                userIdHash,
                requestId: null,
                queueWaitMs: 0,
              }),
            );
            lastDropStats = undefined;

            return {
              text: overloadMessage,
              metadata: {
                degraded: true,
                reason: 'queue_overflow',
                previousResponseId,
              },
            };
          }

          throw error instanceof Error ? error : new Error('AI_QUEUE_DROPPED');
        }

        let retryEndpointId: string | undefined;
        let retryBaseUrl: string | undefined;

        try {
          const now = Date.now();
          if (now > deadline) {
            // eslint-disable-next-line no-console
            console.error(
              '[ai][timeout]',
              createQueueLogPayload(limiter.getStats(), runtime, getEndpointDiagnostics(), {
                phase: 'queue_wait',
                attempt: attempt + 1,
                queueWaitMs,
                userIdHash,
                requestId: null,
              }),
            );
            throw new Error('AI_QUEUE_TIMEOUT');
          }

          const remainingTime = deadline - now;
          const attemptTimeout = Math.max(1, remainingTime);
          const { payload, requestId, endpointId, baseUrl } = await execute(
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${options.apiKey}`,
                'Content-Type': 'application/json',
              },
              body: serializedBody,
            },
            attempt,
            attemptTimeout,
          );

          const { text, usedOutputText } = extractTextFromPayload(payload);
          // eslint-disable-next-line no-console
          console.info('[ai][parsed]', {
            attempt,
            requestId: requestId ?? null,
            usedOutputText,
            length: text.length,
            previousResponseId: previousResponseId ?? null,
            endpointId,
            baseUrl,
          });

          return {
            text,
            metadata: {
              responseId: payload.id,
              status: payload.status,
              requestId,
              usedOutputText,
              previousResponseId,
              endpointId,
              baseUrl,
            },
          };
        } catch (error) {
          lastError = error;

          if (
            error instanceof Error
            && (error.message === 'AI_NON_2XX' || error.message === 'AI_EMPTY_REPLY')
          ) {
            throw error;
          }

          const retryable = error instanceof Error && (error as { retryable?: boolean }).retryable === true;
          if (!retryable || attempt === maxRetries - 1) {
            if (error instanceof Error && error.message === 'AI_QUEUE_TIMEOUT') {
              throw error;
            }

            throw createWrappedError(error instanceof Error ? error : new Error(DEFAULT_ERROR_MESSAGE));
          }

          retryEndpointId =
            typeof (error as { endpointId?: unknown }).endpointId === 'string'
              ? ((error as { endpointId?: string }).endpointId as string)
              : undefined;
          retryBaseUrl =
            typeof (error as { baseUrl?: unknown }).baseUrl === 'string'
              ? ((error as { baseUrl?: string }).baseUrl as string)
              : undefined;

          const reason =
            error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0
              ? error.message
              : DEFAULT_ERROR_MESSAGE;

          const requestId =
            typeof (error as { requestId?: unknown }).requestId === 'string'
              ? ((error as { requestId?: string }).requestId as string)
              : undefined;

          // eslint-disable-next-line no-console
          console.warn(
            '[ai][retry]',
            createQueueLogPayload(limiter.getStats(), runtime, getEndpointDiagnostics(), {
              attempt: attempt + 1,
              reason,
              requestId: requestId ?? null,
              userIdHash,
              queueWaitMs,
              endpointId: retryEndpointId ?? null,
              baseUrl: retryBaseUrl ?? null,
            }),
          );

          const baseDelayMs = 1_000 * 2 ** attempt;
          const jitterFactor = 0.8 + Math.random() * 0.4;
          retryDelayMs = Math.round(baseDelayMs * jitterFactor);
          shouldRetry = true;
        } finally {
          release?.();
        }

        if (shouldRetry) {
          const remainingBeforeSleep = deadline - Date.now();
          if (remainingBeforeSleep <= 0) {
            // eslint-disable-next-line no-console
            console.error(
              '[ai][timeout]',
              createQueueLogPayload(limiter.getStats(), runtime, getEndpointDiagnostics(), {
                phase: 'before_retry_sleep',
                attempt: attempt + 1,
                userIdHash,
                requestId: null,
                queueWaitMs,
                endpointId: retryEndpointId ?? null,
                baseUrl: retryBaseUrl ?? null,
              }),
            );
            throw new Error('AI_QUEUE_TIMEOUT');
          }

          const delayMs = Math.min(Math.max(0, retryDelayMs), Math.max(0, remainingBeforeSleep));
          await waitFor(delayMs);
        }
      }

      if (
        lastError instanceof Error
        && (lastError.message === 'AI_NON_2XX' || lastError.message === 'AI_EMPTY_REPLY')
      ) {
        throw lastError;
      }

      throw createWrappedError(lastError instanceof Error ? lastError : new Error(DEFAULT_ERROR_MESSAGE));
    },
  };
};

export type OpenAIResponsesAdapter = ReturnType<typeof createOpenAIResponsesAdapter>;
