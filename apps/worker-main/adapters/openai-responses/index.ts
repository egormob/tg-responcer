import type { AiPort, ConversationTurn } from '../../ports';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;
const ASSISTANTS_BASE_URL = 'https://api.openai.com/v1/assistants';

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

export const createOpenAIResponsesAdapter = (
  options: OpenAIResponsesAdapterOptions,
): AiPort => {
  const assistantId = options.assistantId.trim();

  if (assistantId.length === 0) {
    options.logger?.error?.('openai-assistant missing id');
    throw new Error('OPENAI_ASSISTANT_ID is required');
  }

  if (!/^asst_[A-Za-z0-9-]+$/.test(assistantId)) {
    options.logger?.error?.('openai-assistant invalid id format', {
      assistantId: options.assistantId,
    });
    throw new Error('OPENAI_ASSISTANT_ID must start with "asst_" and refer to an OpenAI Responses assistant');
  }

  const fetchImpl = options.fetchApi ?? fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutBudgetMs = Math.min(
    options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );
  const maxRetries = Math.max(1, Math.min(options.maxRetries ?? DEFAULT_MAX_RETRIES, DEFAULT_MAX_RETRIES));
  const { logger } = options;
  let cachedAssistantModel: string | undefined;
  let assistantModelPromise: Promise<string> | undefined;

  const fetchAssistantModel = async (timeoutMs: number): Promise<string> => {
    if (typeof cachedAssistantModel === 'string') {
      return cachedAssistantModel;
    }

    if (!assistantModelPromise) {
      assistantModelPromise = (async () => {
        const { signal, dispose } = createAbortSignal(Math.max(1, timeoutMs));
        try {
          const response = await fetchImpl(`${ASSISTANTS_BASE_URL}/${assistantId}`, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${options.apiKey}`,
              'Content-Type': 'application/json',
              'OpenAI-Beta': 'assistants=v2',
            },
            signal,
          });

          if (!response.ok) {
            const error = new Error(
              `Failed to fetch OpenAI assistant configuration (status ${response.status})`,
            );
            logger?.error?.('openai-assistant fetch failed', {
              status: response.status,
              assistantId,
            });
            throw error;
          }

          let payload: { model?: unknown };
          try {
            payload = (await response.json()) as { model?: unknown };
          } catch (parseError) {
            logger?.error?.('openai-assistant invalid payload', {
              assistantId,
            });
            throw new Error('Failed to parse OpenAI assistant configuration response');
          }

          const model = typeof payload?.model === 'string' && payload.model.trim().length > 0
            ? payload.model
            : undefined;

          if (!model) {
            logger?.error?.('openai-assistant missing model', {
              assistantId,
            });
            throw new Error('OpenAI assistant model is missing');
          }

          cachedAssistantModel = model;
          return model;
        } finally {
          dispose();
        }
      })().catch((error) => {
        assistantModelPromise = undefined;
        throw error;
      });
    }

    return assistantModelPromise;
  };

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

      const resolveAssistantModel = async (): Promise<string> => {
        const remainingTime = deadline - Date.now();
        if (remainingTime <= 0) {
          logger?.error?.('openai-responses global timeout exceeded while fetching model');
          throw createWrappedError(new Error('OpenAI Responses request timed out'));
        }

        try {
          return await fetchAssistantModel(remainingTime);
        } catch (error) {
          if (error instanceof Error && error.message === 'OpenAI assistant model is missing') {
            throw error;
          }

          throw createWrappedError(
            error instanceof Error ? error : new Error('Failed to resolve assistant model'),
          );
        }
      };

      const assistantModel = await resolveAssistantModel();

      const body = {
        assistant_id: assistantId,
        model: assistantModel,
        input: buildInputMessages(input.context, input.text),
        metadata: {
          userId: input.userId,
        },
      };

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

          const { text, usedOutputText } = extractTextFromPayload(payload);
          // eslint-disable-next-line no-console
          console.info('[ai][parsed]', {
            attempt,
            requestId: requestId ?? null,
            usedOutputText,
            length: text.length,
          });

          return {
            text,
            metadata: {
              responseId: payload.id,
              status: payload.status,
              requestId,
              usedOutputText,
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
