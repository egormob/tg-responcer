import type { AiPort, ConversationTurn } from '../../ports';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;

export interface OpenAIResponsesAdapterOptions {
  apiKey: string;
  assistantId: string;
  fetchApi?: typeof fetch;
  baseUrl?: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
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
  text?: string;
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
}

const removeControlCharacters = (text: string): string =>
  text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

const sanitizeOutputText = (text: string): string => removeControlCharacters(text).trim();

const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

const mapTurnToContentType = (role: ConversationTurn['role']): string => {
  switch (role) {
    case 'user':
      return 'input_text';
    case 'assistant':
      return 'output_text';
    default:
      return 'text';
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
        text: removeControlCharacters(turn.text),
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
          text: removeControlCharacters(latestText),
        },
      ],
    },
  ];
};

const extractTextFromPayload = (payload: ResponsesApiSuccessPayload): string => {
  const chunks: string[] = [];

  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!Array.isArray(item?.content)) {
      continue;
    }

    for (const piece of item.content) {
      if (typeof piece?.text === 'string' && piece.text.trim().length > 0) {
        chunks.push(piece.text);
      }
    }
  }

  const combined = sanitizeOutputText(chunks.join('\n'));
  if (combined.length === 0) {
    throw new Error('openai-responses adapter received empty output');
  }

  return combined;
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

export const createOpenAIResponsesAdapter = (
  options: OpenAIResponsesAdapterOptions,
): AiPort => {
  const fetchImpl = options.fetchApi ?? fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutBudgetMs = Math.min(
    options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );
  const maxRetries = Math.max(1, Math.min(options.maxRetries ?? DEFAULT_MAX_RETRIES, DEFAULT_MAX_RETRIES));
  const { logger } = options;

  const execute = async (
    requestInit: RequestInit,
    attempt: number,
    attemptTimeoutMs: number,
  ): Promise<{ payload: ResponsesApiSuccessPayload; requestId?: string }> => {
    const { signal, dispose } = createAbortSignal(attemptTimeoutMs);

    try {
      const response = await fetchImpl(baseUrl, {
        ...requestInit,
        signal,
      });

      const requestId = response.headers.get('x-request-id') ?? undefined;

      if (!response.ok) {
        const errorPayload = (await response.json().catch(() => undefined)) as
          | ResponsesApiErrorPayload
          | undefined;
        const message = errorPayload?.error?.message ?? `HTTP ${response.status}`;
        const error = new Error(message);

        if (!isRetryableStatus(response.status) || attempt === maxRetries - 1) {
          logger?.error?.('openai-responses request failed', {
            status: response.status,
            attempt,
            requestId,
          });
          throw createWrappedError(error);
        }

        logger?.warn?.('openai-responses retryable failure', {
          status: response.status,
          attempt,
          requestId,
        });

        throw Object.assign(error, { retryable: true });
      }

      const payload = (await response.json()) as ResponsesApiSuccessPayload;
      return { payload, requestId };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        const timeoutError = new Error('OpenAI Responses request timed out');
        if (attempt === maxRetries - 1) {
          logger?.error?.('openai-responses request timeout', { attempt });
          throw createWrappedError(timeoutError);
        }

        logger?.warn?.('openai-responses retryable timeout', { attempt });
        throw Object.assign(timeoutError, { retryable: true });
      }

      if (error instanceof Error && (error as { retryable?: boolean }).retryable === true) {
        throw error;
      }

      if (attempt === maxRetries - 1) {
        logger?.error?.('openai-responses request failed', { attempt });
        throw createWrappedError(error instanceof Error ? error : new Error(DEFAULT_ERROR_MESSAGE));
      }

      logger?.warn?.('openai-responses retryable network error', { attempt });
      throw Object.assign(error instanceof Error ? error : new Error('retryable failure'), { retryable: true });
    } finally {
      dispose();
    }
  };

  return {
    async reply(input) {
      const body = {
        assistant_id: options.assistantId,
        input: buildInputMessages(input.context, input.text),
        metadata: {
          userId: input.userId,
        },
      };

      let attempt = 0;
      let lastError: unknown;

      const deadline = Date.now() + timeoutBudgetMs;

      while (attempt < maxRetries) {
        const remainingTime = deadline - Date.now();
        if (remainingTime <= 0) {
          logger?.error?.('openai-responses global timeout exceeded', { attempt });
          throw createWrappedError(new Error('OpenAI Responses request timed out'));
        }

        try {
          const attemptTimeout = Math.max(1, remainingTime);
          const { payload, requestId } = await execute(
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${options.apiKey}`,
                'Content-Type': 'application/json',
                'OpenAI-Beta': 'assistants=v2',
              },
              body: JSON.stringify(body),
            },
            attempt,
            attemptTimeout,
          );

          const text = extractTextFromPayload(payload);

          return {
            text,
            metadata: {
              responseId: payload.id,
              status: payload.status,
              requestId,
            },
          };
        } catch (error) {
          lastError = error;
          const retryable = error instanceof Error && (error as { retryable?: boolean }).retryable === true;
          if (!retryable || attempt === maxRetries - 1) {
            throw createWrappedError(error instanceof Error ? error : new Error(DEFAULT_ERROR_MESSAGE));
          }

          attempt += 1;
        }
      }

      throw createWrappedError(lastError instanceof Error ? lastError : new Error(DEFAULT_ERROR_MESSAGE));
    },
  };
};

export type OpenAIResponsesAdapter = ReturnType<typeof createOpenAIResponsesAdapter>;
