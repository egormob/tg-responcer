import type { MessagingPort } from '../../ports';

interface Logger {
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}

export interface BroadcastRecipient {
  chatId: string;
  threadId?: string;
}

export interface BroadcastSendInput {
  text: string;
  requestedBy: string;
}

export interface BroadcastSendResultDelivery {
  recipient: BroadcastRecipient;
  messageId?: string;
  error?: { name: string; message: string };
}

export interface BroadcastSendResult {
  delivered: number;
  failed: number;
  deliveries: ReadonlyArray<BroadcastSendResultDelivery>;
}

export type SendBroadcast = (input: BroadcastSendInput) => Promise<BroadcastSendResult>;

export interface BroadcastPoolOptions {
  concurrency?: number;
  /**
   * Максимальное число попыток доставки одному получателю.
   */
  maxAttempts?: number;
  /**
   * Базовая задержка для экспоненциального бэкоффа (мс).
   */
  baseDelayMs?: number;
  /**
   * Коэффициент джиттера (0-1). Используется для сдвига задержек.
   */
  jitterRatio?: number;
  /**
   * Позволяет подменить генератор случайных чисел (например, в тестах).
   */
  random?: () => number;
  /**
   * Позволяет переопределить ожидание (используется в тестах).
   */
  wait?: (ms: number) => Promise<void>;
}

export interface CreateImmediateBroadcastSenderOptions {
  messaging: Pick<MessagingPort, 'sendText'>;
  recipients: readonly BroadcastRecipient[];
  logger?: Logger;
  pool?: BroadcastPoolOptions;
}

const DEFAULT_POOL_OPTIONS: Required<Omit<BroadcastPoolOptions, 'wait' | 'random'>> = {
  concurrency: 4,
  maxAttempts: 3,
  baseDelayMs: 1000,
  jitterRatio: 0.2,
};

const createWait = (wait?: (ms: number) => Promise<void>) =>
  wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const computeDelay = (
  retryIndex: number,
  baseDelayMs: number,
  jitterRatio: number,
  random: () => number,
  retryAfterMs?: number,
): number => {
  const exponential = baseDelayMs * 2 ** retryIndex;
  const jitter = exponential * clamp(jitterRatio, 0, 1) * random();
  const computedDelay = exponential + jitter;

  if (retryAfterMs === undefined) {
    return computedDelay;
  }

  return Math.max(computedDelay, retryAfterMs);
};

const isTooManyRequestsError = (error: unknown): error is Error & { status?: number } => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const status = (error as { status?: unknown }).status;
  return status === 429;
};

const getRetryAfterMs = (error: unknown): number | undefined => {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const retryAfter = (error as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter;
  }

  const parameters = (error as { parameters?: { retry_after?: unknown } }).parameters;
  const retryAfterSeconds = parameters?.retry_after;
  if (
    typeof retryAfterSeconds === 'number' &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds > 0
  ) {
    return retryAfterSeconds * 1000;
  }

  return undefined;
};

const toErrorDetails = (error: unknown): { name: string; message: string } => {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }

  const message = typeof error === 'string' ? error : JSON.stringify(error);
  return { name: 'Error', message };
};

export const createImmediateBroadcastSender = (
  options: CreateImmediateBroadcastSenderOptions,
): SendBroadcast => {
  const recipients = options.recipients.filter((recipient) => recipient.chatId.trim().length > 0);
  const poolOptions = {
    ...DEFAULT_POOL_OPTIONS,
    ...options.pool,
  } satisfies Required<Omit<BroadcastPoolOptions, 'wait' | 'random'>>;
  const wait = createWait(options.pool?.wait);
  const random = options.pool?.random ?? Math.random;
  const concurrency = Math.max(1, Math.floor(poolOptions.concurrency));
  const maxAttempts = Math.max(1, Math.floor(poolOptions.maxAttempts));

  return async ({ text, requestedBy }) => {
    const startedAt = Date.now();

    options.logger?.info?.('broadcast pool initialized', {
      requestedBy,
      recipients: recipients.length,
      poolSize: concurrency,
      maxAttempts,
      baseDelayMs: poolOptions.baseDelayMs,
      jitterRatio: poolOptions.jitterRatio,
    });

    let throttledErrors = 0;
    const deliveries: BroadcastSendResultDelivery[] = new Array(recipients.length);

    const sendWithRetry = async (
      recipient: BroadcastRecipient,
    ): Promise<BroadcastSendResultDelivery> => {
      let attempt = 0;

      while (attempt < maxAttempts) {
        try {
          const result = await options.messaging.sendText({
            chatId: recipient.chatId,
            threadId: recipient.threadId,
            text,
          });

          options.logger?.info?.('broadcast delivered', {
            requestedBy,
            chatId: recipient.chatId,
            threadId: recipient.threadId ?? null,
            messageId: result?.messageId ?? null,
            attempt: attempt + 1,
          });

          return {
            recipient,
            messageId: result?.messageId,
          } satisfies BroadcastSendResultDelivery;
        } catch (error) {
          const tooManyRequests = isTooManyRequestsError(error);
          const shouldRetry = tooManyRequests && attempt < maxAttempts - 1;

          if (tooManyRequests) {
            throttledErrors += 1;
          }

          if (!shouldRetry) {
            const details = toErrorDetails(error);

            options.logger?.error?.('broadcast delivery failed', {
              requestedBy,
              chatId: recipient.chatId,
              threadId: recipient.threadId ?? null,
              error: details,
              attempt: attempt + 1,
            });

            return {
              recipient,
              error: details,
            } satisfies BroadcastSendResultDelivery;
          }

          const retryIndex = attempt;
          const retryAfterMs = getRetryAfterMs(error);
          const delayMs = computeDelay(
            retryIndex,
            poolOptions.baseDelayMs,
            poolOptions.jitterRatio,
            random,
            retryAfterMs,
          );

          options.logger?.warn?.('broadcast throttled', {
            requestedBy,
            chatId: recipient.chatId,
            threadId: recipient.threadId ?? null,
            attempt: attempt + 1,
            delayMs,
            retryAfterMs: retryAfterMs ?? null,
            poolSize: concurrency,
          });

          await wait(delayMs);
          attempt += 1;
        }
      }

      const details = toErrorDetails(new Error('broadcast delivery exceeded retries'));

      return {
        recipient,
        error: details,
      } satisfies BroadcastSendResultDelivery;
    };

    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        if (currentIndex >= recipients.length) {
          return;
        }

        deliveries[currentIndex] = await sendWithRetry(recipients[currentIndex]);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    const delivered = deliveries.filter((entry) => !entry.error).length;
    const failed = deliveries.length - delivered;

    options.logger?.info?.('broadcast pool completed', {
      requestedBy,
      recipients: deliveries.length,
      delivered,
      failed,
      poolSize: concurrency,
      throttled429: throttledErrors,
      durationMs: Date.now() - startedAt,
    });

    return {
      delivered,
      failed,
      deliveries,
    } satisfies BroadcastSendResult;
  };
};
