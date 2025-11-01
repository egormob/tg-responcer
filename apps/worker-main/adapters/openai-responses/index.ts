import type { AiPort, ConversationTurn } from '../../ports';
import { sanitizeVisibleText, stripControlCharacters } from '../../shared';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;

export interface OpenAIResponsesAdapterOptions {
  apiKey: string;
  model: string;
  promptId?: string;
  promptVariables?: Record<string, unknown>;
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
      // eslint-disable-next-line no-console
      console.info('[ai][request]', { attempt });

      const response = await fetchImpl(baseUrl, {
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
          body: rawBody,
        });

        if (!isRetryableStatus(response.status) || attempt === maxRetries - 1) {
          logger?.error?.('openai-responses request failed', {
            status: response.status,
            attempt,
            requestId,
          });
          throw new Error('AI_NON_2XX');
        }

        logger?.warn?.('openai-responses retryable failure', {
          status: response.status,
          attempt,
          requestId,
        });

        throw Object.assign(error, { retryable: true });
      }

      const payload = (await response.json()) as ResponsesApiSuccessPayload;
      // eslint-disable-next-line no-console
      console.info('[ai][ok]', { attempt, requestId: requestId ?? null });
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
      let attempt = 0;
      let lastError: unknown;

      const deadline = Date.now() + timeoutBudgetMs;
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
          });

          return {
            text,
            metadata: {
              responseId: payload.id,
              status: payload.status,
              requestId,
              usedOutputText,
              previousResponseId,
            },
          };
        } catch (error) {
          lastError = error;
          const retryable = error instanceof Error && (error as { retryable?: boolean }).retryable === true;
          if (!retryable || attempt === maxRetries - 1) {
            if (
              error instanceof Error
              && (error.message === 'AI_NON_2XX' || error.message === 'AI_EMPTY_REPLY')
            ) {
              throw error;
            }
            throw createWrappedError(error instanceof Error ? error : new Error(DEFAULT_ERROR_MESSAGE));
          }

          attempt += 1;
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
