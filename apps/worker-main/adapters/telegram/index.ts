import type { MessagingPort } from '../../ports';
import { stripControlCharacters } from '../../shared';

const DEFAULT_BASE_URL = 'https://api.telegram.org';
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;

export interface TelegramMessagingAdapterOptions {
  botToken: string;
  fetchApi?: typeof fetch;
  baseUrl?: string;
  maxRetries?: number;
  baseDelayMs?: number;
  /**
   * Используется для внедрения псевдослучайности в тестах.
   */
  random?: () => number;
  /**
   * Позволяет переопределить ожидание между попытками (например, в тестах).
   */
  wait?: (ms: number) => Promise<void>;
  logger?: {
    warn?: (message: string, details?: Record<string, unknown>) => void;
    error?: (message: string, details?: Record<string, unknown>) => void;
  };
}

interface TelegramResponse<Result> {
  ok: boolean;
  result?: Result;
  description?: string;
  parameters?: {
    retry_after?: number;
  };
}

class TelegramApiError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(message: string, status: number, retryAfterMs?: number, cause?: unknown) {
    super(message);
    this.name = 'TelegramApiError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    if (cause !== undefined) {
      try {
        // @ts-expect-error cause is supported in modern runtimes, fallback otherwise
        this.cause = cause;
      } catch (error) {
        // ignore assigning cause when not supported
      }
    }
  }
}

const MAX_MESSAGE_LENGTH = 4096;

const sanitizeText = (text: string): string => stripControlCharacters(text);

const splitTextIntoChunks = (text: string): string[] => {
  if (text.length === 0) {
    return [''];
  }

  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += MAX_MESSAGE_LENGTH) {
    chunks.push(text.slice(index, index + MAX_MESSAGE_LENGTH));
  }

  return chunks;
};

const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

const getRetryDelay = (
  attempt: number,
  baseDelayMs: number,
  random: () => number,
  retryAfterMs?: number,
): number => {
  const exponential = baseDelayMs * 2 ** attempt;
  const jitter = exponential * 0.2 * random();
  const computed = exponential + jitter;
  if (retryAfterMs === undefined) {
    return computed;
  }

  return Math.max(computed, retryAfterMs);
};

const parseRetryAfter = <T>(payload: TelegramResponse<T> | undefined): number | undefined => {
  const retryAfter = payload?.parameters?.retry_after;
  return typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfter * 1000
    : undefined;
};

const parseTelegramResponse = async <Result>(response: Response): Promise<{
  payload: TelegramResponse<Result> | undefined;
  retryAfterMs?: number;
}> => {
  let payload: TelegramResponse<Result> | undefined;

  try {
    payload = (await response.json()) as TelegramResponse<Result>;
  } catch (error) {
    payload = undefined;
  }

  const retryAfterMs = parseRetryAfter(payload);
  return { payload, retryAfterMs };
};

const createErrorDetails = (input: Record<string, unknown>, status?: number) => ({
  ...input,
  status,
});

const createWait = (optionsWait?: (ms: number) => Promise<void>) =>
  optionsWait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

export const createTelegramMessagingAdapter = (
  options: TelegramMessagingAdapterOptions,
): MessagingPort => {
  const fetchImpl = options.fetchApi ?? fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const maxRetries = Math.max(1, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const random = options.random ?? Math.random;
  const wait = createWait(options.wait);
  const { logger } = options;

  const buildUrl = (method: string) => `${baseUrl}/bot${options.botToken}/${method}`;

  const executeWithRetries = async <Result>(
    method: string,
    body: Record<string, unknown>,
    swallowErrors: boolean,
  ): Promise<Result | undefined> => {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < maxRetries) {
      try {
        const response = await fetchImpl(buildUrl(method), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        const { payload, retryAfterMs } = await parseTelegramResponse<Result>(response);

        if (!response.ok || payload?.ok !== true) {
          const description = payload?.description ?? 'Telegram API error';
          const error = new TelegramApiError(description, response.status, retryAfterMs, payload);

          if (!isRetryableStatus(response.status) || attempt === maxRetries - 1) {
            if (swallowErrors) {
              logger?.warn?.('telegram-adapter request failed', {
                method,
                attempt,
                ...createErrorDetails(body, response.status),
              });
              return undefined;
            }

            throw error;
          }

          await wait(getRetryDelay(attempt, baseDelayMs, random, retryAfterMs));
          attempt += 1;
          continue;
        }

        return payload?.result;
      } catch (error) {
        lastError = error;

        const retryable =
          error instanceof TelegramApiError ? isRetryableStatus(error.status) : true;

        if (!retryable || attempt === maxRetries - 1) {
          if (swallowErrors) {
            logger?.warn?.('telegram-adapter request failed', {
              method,
              attempt,
              ...createErrorDetails(body, error instanceof TelegramApiError ? error.status : undefined),
            });
            return undefined;
          }

          logger?.error?.('telegram-adapter exhausted retries', {
            method,
            attempt,
            ...createErrorDetails(body, error instanceof TelegramApiError ? error.status : undefined),
          });
          throw error;
        }

        const retryAfterMs = error instanceof TelegramApiError ? error.retryAfterMs : undefined;
        await wait(getRetryDelay(attempt, baseDelayMs, random, retryAfterMs));
        attempt += 1;
      }
    }

    if (swallowErrors) {
      return undefined;
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('Telegram adapter failed without explicit error');
  };

  return {
    async sendTyping(input) {
      const body: Record<string, unknown> = {
        chat_id: input.chatId,
        action: 'typing',
      };

      if (input.threadId) {
        body.message_thread_id = input.threadId;
      }

      await executeWithRetries('sendChatAction', body, true);
    },

    async sendText(input) {
      const sanitizedText = sanitizeText(input.text);
      const chunks = splitTextIntoChunks(sanitizedText);

      if (chunks.length > 1) {
        logger?.warn?.('telegram-adapter splitting long message into chunks', {
          originalLength: sanitizedText.length,
          chunkCount: chunks.length,
        });
      }

      let firstMessageId: number | undefined;

      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        const body: Record<string, unknown> = {
          chat_id: input.chatId,
          text: chunk,
        };

        if (input.threadId) {
          body.message_thread_id = input.threadId;
        }

        const result = await executeWithRetries<{
          message_id?: number;
        }>('sendMessage', body, false);

        if (index === 0) {
          firstMessageId = result?.message_id;
        }
      }

      return {
        messageId: firstMessageId ? String(firstMessageId) : undefined,
      };
    },
  };
};

export type TelegramMessagingAdapter = ReturnType<typeof createTelegramMessagingAdapter>;
