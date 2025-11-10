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
    debug?: (message: string, details?: Record<string, unknown>) => void;
    info?: (message: string, details?: Record<string, unknown>) => void;
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
  readonly description?: string;
  readonly parameters?: TelegramResponse<unknown>['parameters'];

  constructor(
    message: string,
    status: number,
    retryAfterMs?: number,
    payload?: TelegramResponse<unknown>,
  ) {
    super(message);
    this.name = 'TelegramApiError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.description = payload?.description;
    this.parameters = payload?.parameters;
    if (payload !== undefined) {
      try {
        // @ts-expect-error cause is supported in modern runtimes, fallback otherwise
        this.cause = payload;
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

type TelegramErrorMetadata = Pick<TelegramResponse<unknown>, 'description' | 'parameters'>;

const createErrorDetails = (
  input: Record<string, unknown>,
  status?: number,
  metadata?: TelegramErrorMetadata,
) => ({
  ...input,
  status,
  ...(metadata?.description ? { description: metadata.description } : {}),
  ...(metadata?.parameters ? { parameters: metadata.parameters } : {}),
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

  // Telegram API ожидает, что идентификаторы уже приведены к строкам на уровне ядра
  // (см. http/telegram-webhook.ts). Адаптер не делает попыток конвертации, чтобы
  // не потерять ведущие нули и не скрыть источник некорректных типов.
  const ensureStringId = (method: string, field: string, value: unknown): string => {
    if (typeof value === 'string') {
      return value;
    }

    const details: Record<string, unknown> = {
      method,
      field,
      value,
      valueType: typeof value,
    };
    logger?.error?.('telegram-adapter non-string identifier', details);
    throw new TypeError(`telegram-adapter expected ${field} to be a string`);
  };

  const ensureOptionalStringId = (
    method: string,
    field: string,
    value: unknown,
  ): string | undefined => {
    if (value === undefined) {
      return undefined;
    }

    return ensureStringId(method, field, value);
  };

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
                ...createErrorDetails(body, response.status, {
                  description: payload?.description,
                  parameters: payload?.parameters,
                }),
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
              ...createErrorDetails(
                body,
                error instanceof TelegramApiError ? error.status : undefined,
                error instanceof TelegramApiError
                  ? { description: error.description, parameters: error.parameters }
                  : undefined,
              ),
            });
            return undefined;
          }

          logger?.error?.('telegram-adapter exhausted retries', {
            method,
            attempt,
            ...createErrorDetails(
              body,
              error instanceof TelegramApiError ? error.status : undefined,
              error instanceof TelegramApiError
                ? { description: error.description, parameters: error.parameters }
                : undefined,
            ),
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
      const chatId = ensureStringId('sendChatAction', 'chat_id', input.chatId);
      const threadId = ensureOptionalStringId(
        'sendChatAction',
        'message_thread_id',
        input.threadId,
      );

      logger?.debug?.('telegram-adapter sendChatAction request', {
        method: 'sendChatAction',
        chatId,
        threadId,
      });

      const body: Record<string, unknown> = {
        chat_id: chatId,
        action: 'typing',
      };

      if (threadId) {
        body.message_thread_id = threadId;
      }

      await executeWithRetries('sendChatAction', body, true);
    },

    async sendText(input) {
      const chatId = ensureStringId('sendMessage', 'chat_id', input.chatId);
      const threadId = ensureOptionalStringId('sendMessage', 'message_thread_id', input.threadId);
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
          chat_id: chatId,
          text: chunk,
        };

        if (threadId) {
          body.message_thread_id = threadId;
        }

        logger?.info?.('telegram-adapter sendMessage request', {
          method: 'sendMessage',
          chatId,
          threadId,
          chunkIndex: index,
          chunkCount: chunks.length,
          textLength: chunk.length,
        });

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

    async editMessageText(input) {
      const sanitizedText = sanitizeText(input.text);

      if (sanitizedText.length > MAX_MESSAGE_LENGTH) {
        throw new Error('Telegram editMessageText payload exceeds maximum length');
      }

      const body: Record<string, unknown> = {
        chat_id: input.chatId,
        message_id: input.messageId,
        text: sanitizedText,
      };

      if (input.threadId) {
        body.message_thread_id = input.threadId;
      }

      await executeWithRetries('editMessageText', body, false);
    },

    async deleteMessage(input) {
      const body: Record<string, unknown> = {
        chat_id: input.chatId,
        message_id: input.messageId,
      };

      if (input.threadId) {
        body.message_thread_id = input.threadId;
      }

      await executeWithRetries('deleteMessage', body, false);
    },
  };
};

export type TelegramMessagingAdapter = ReturnType<typeof createTelegramMessagingAdapter>;
