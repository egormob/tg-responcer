import type { MessagingPort } from '../../ports';
import type { BroadcastAudienceFilter } from './broadcast-payload';
import type { BroadcastTelemetry } from './broadcast-telemetry';

interface Logger {
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}

export type BroadcastAbortReason = 'telegram_limit_exceeded' | 'send_text_failed';

export interface BroadcastEmergencyStopOptions {
  retryAfterMs?: number;
}

export class BroadcastAbortedError extends Error {
  readonly reason: BroadcastAbortReason;
  readonly context?: Record<string, unknown>;

  constructor(reason: BroadcastAbortReason, context?: Record<string, unknown>, cause?: unknown) {
    super(`broadcast aborted: ${reason}`);
    this.name = 'BroadcastAbortedError';
    this.reason = reason;
    this.context = context;
    if (cause !== undefined) {
      try {
        // @ts-expect-error cause might not be supported in target runtime
        this.cause = cause;
      } catch (error) {
        // ignore when cause assignment is not supported
      }
    }
  }
}

export interface BroadcastRecipient {
  chatId: string;
  threadId?: string;
  username?: string;
  languageCode?: string;
}

export interface BroadcastSendInput {
  text: string;
  requestedBy: string;
  filters?: BroadcastAudienceFilter;
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
  messagingBroadcast?: Pick<MessagingPort, 'sendText'>;
  recipients: readonly BroadcastRecipient[];
  logger?: Logger;
  pool?: BroadcastPoolOptions;
  telemetry?: BroadcastTelemetry;
  emergencyStop?: BroadcastEmergencyStopOptions;
}

export interface BroadcastRecipientsRegistry {
  listActiveRecipients(filter?: BroadcastAudienceFilter): Promise<BroadcastRecipient[]>;
}

export interface CreateRegistryBroadcastSenderOptions {
  messaging: Pick<MessagingPort, 'sendText'>;
  messagingBroadcast?: Pick<MessagingPort, 'sendText'>;
  registry: BroadcastRecipientsRegistry;
  logger?: Logger;
  pool?: BroadcastPoolOptions;
  telemetry?: BroadcastTelemetry;
  emergencyStop?: BroadcastEmergencyStopOptions;
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

const getErrorStatus = (error: unknown): number | undefined => {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
};

const shouldAbortOnFailure = (error: unknown): boolean => {
  const status = getErrorStatus(error);
  if (status === undefined) {
    return true;
  }

  if (status >= 500 || status === 401) {
    return true;
  }

  return false;
};

const sanitizeEmergencyStopThreshold = (value: number | undefined): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.floor(value);
};

const toErrorDetails = (error: unknown): { name: string; message: string } => {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }

  const message = typeof error === 'string' ? error : JSON.stringify(error);
  return { name: 'Error', message };
};

const deduplicateRecipients = (
  recipients: readonly BroadcastRecipient[],
): BroadcastRecipient[] => {
  const seen = new Map<string, number>();
  const unique: BroadcastRecipient[] = [];

  for (const recipient of recipients) {
    const key = `${recipient.chatId}:${recipient.threadId ?? ''}`;
    const existingIndex = seen.get(key);

    if (existingIndex !== undefined) {
      const existing = unique[existingIndex];
      if (!existing.username && recipient.username) {
        unique[existingIndex] = { ...existing, username: recipient.username };
      }
      if (!existing.languageCode && recipient.languageCode) {
        unique[existingIndex] = { ...existing, languageCode: recipient.languageCode };
      }
      continue;
    }

    seen.set(key, unique.length);
    unique.push(recipient);
  }

  return unique;
};

const applyAudienceFilters = (
  recipients: readonly BroadcastRecipient[],
  filters: BroadcastAudienceFilter | undefined,
): BroadcastRecipient[] => {
  if (!filters) {
    return Array.from(recipients);
  }

  let result = Array.from(recipients);

  if (filters.chatIds?.length) {
    const chatIds = new Set(filters.chatIds.map((id) => id.trim()));
    result = result.filter((recipient) => chatIds.has(recipient.chatId));
  }

  if (filters.userIds?.length) {
    const userIds = new Set(filters.userIds.map((id) => id.trim()));
    result = result.filter((recipient) => userIds.has(recipient.chatId));
  }

  if (filters.languageCodes?.length) {
    const languageCodes = new Set(filters.languageCodes.map((code) => code.trim().toLowerCase()));
    result = result.filter((recipient) => {
      if (!recipient.languageCode) {
        return false;
      }

      return languageCodes.has(recipient.languageCode.toLowerCase());
    });
  }

  return result;
};

interface ResolveRecipientsResult {
  recipients: readonly BroadcastRecipient[];
  source?: string;
}

type ResolveRecipients = (
  filters?: BroadcastAudienceFilter,
) =>
  | Promise<readonly BroadcastRecipient[] | ResolveRecipientsResult>
  | readonly BroadcastRecipient[]
  | ResolveRecipientsResult;

interface CreateBroadcastSenderOptions {
  messaging: Pick<MessagingPort, 'sendText'>;
  messagingBroadcast?: Pick<MessagingPort, 'sendText'>;
  resolveRecipients: ResolveRecipients;
  logger?: Logger;
  pool?: BroadcastPoolOptions;
  telemetry?: BroadcastTelemetry;
  emergencyStop?: BroadcastEmergencyStopOptions;
}

const createBroadcastSender = (options: CreateBroadcastSenderOptions): SendBroadcast => {
  const poolOptions = {
    ...DEFAULT_POOL_OPTIONS,
    ...options.pool,
  } satisfies Required<Omit<BroadcastPoolOptions, 'wait' | 'random'>>;
  const wait = createWait(options.pool?.wait);
  const random = options.pool?.random ?? Math.random;
  const concurrency = Math.max(1, Math.floor(poolOptions.concurrency));
  const maxAttempts = Math.max(1, Math.floor(poolOptions.maxAttempts));
  const emergencyStopThresholdMs = sanitizeEmergencyStopThreshold(options.emergencyStop?.retryAfterMs);
  const deliveryMessaging = options.messagingBroadcast ?? options.messaging;

  const normalizeResolveResult = (
    result: Awaited<ReturnType<ResolveRecipients>>,
  ): ResolveRecipientsResult => {
    if (Array.isArray(result)) {
      return { recipients: result } satisfies ResolveRecipientsResult;
    }

    return result;
  };

  return async ({ text, requestedBy, filters }) => {
    const resolved = normalizeResolveResult(await options.resolveRecipients(filters));
    const filtersToApply = filters;
    const recipients = deduplicateRecipients(
      applyAudienceFilters(
        resolved.recipients.filter((recipient) => recipient.chatId.trim().length > 0),
        filtersToApply,
      ),
    );
    const startedAt = Date.now();
    const recipientsSample = recipients.slice(0, 5).map((recipient) => ({
      chatId: recipient.chatId,
      threadId: recipient.threadId ?? null,
      username: recipient.username ?? null,
      languageCode: recipient.languageCode ?? null,
    }));

    options.logger?.info?.('broadcast recipients resolved', {
      requestedBy,
      filters: filters ?? null,
      source: resolved.source ?? null,
      recipients: recipients.length,
      sample: recipientsSample,
    });

    if (recipients.length === 0) {
      options.logger?.warn?.('broadcast recipients list is empty', {
        requestedBy,
        filters: filters ?? null,
        source: resolved.source ?? null,
      });

      return {
        delivered: 0,
        failed: 0,
        deliveries: [],
      } satisfies BroadcastSendResult;
    }

    options.logger?.info?.('broadcast pool initialized', {
      requestedBy,
      recipients: recipients.length,
      filters: filters ?? null,
      source: resolved.source ?? null,
      poolSize: concurrency,
      maxAttempts,
      baseDelayMs: poolOptions.baseDelayMs,
      jitterRatio: poolOptions.jitterRatio,
    });

    let throttledErrors = 0;
    const deliveries: BroadcastSendResultDelivery[] = new Array(recipients.length);
    let abortedError: BroadcastAbortedError | undefined;

    const ensureNotAborted = () => {
      if (abortedError) {
        throw abortedError;
      }
    };

    const abortBroadcast = (
      reason: BroadcastAbortReason,
      context: Record<string, unknown>,
      cause?: unknown,
    ): never => {
      if (!abortedError) {
        abortedError = new BroadcastAbortedError(reason, context, cause);
        options.logger?.error?.('broadcast pool aborted', {
          requestedBy,
          reason,
          context,
        });
      }

      throw abortedError;
    };

    const handleEmergencyThrottle = (retryAfterMs?: number, cause?: unknown) => {
      if (
        typeof emergencyStopThresholdMs === 'number'
        && typeof retryAfterMs === 'number'
        && retryAfterMs >= emergencyStopThresholdMs
      ) {
        abortBroadcast(
          'telegram_limit_exceeded',
          {
            retryAfterMs,
            thresholdMs: emergencyStopThresholdMs,
            requestedBy,
          },
          cause,
        );
      }
    };

    const sendWithRetry = async (
      recipient: BroadcastRecipient,
    ): Promise<BroadcastSendResultDelivery> => {
      ensureNotAborted();
      let attempt = 0;

      while (attempt < maxAttempts) {
        try {
          const result = await deliveryMessaging.sendText({
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
          ensureNotAborted();
          const tooManyRequests = isTooManyRequestsError(error);
          const shouldRetry = tooManyRequests && attempt < maxAttempts - 1;
          const retryAfterMs = getRetryAfterMs(error);

          if (tooManyRequests) {
            throttledErrors += 1;
            handleEmergencyThrottle(retryAfterMs, error);
          }

          if (!shouldRetry) {
            const details = toErrorDetails(error);

            if (!tooManyRequests && shouldAbortOnFailure(error)) {
              abortBroadcast(
                'send_text_failed',
                {
                  requestedBy,
                  chatId: recipient.chatId,
                  threadId: recipient.threadId ?? null,
                  status: getErrorStatus(error) ?? null,
                },
                error,
              );
            }

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

    let aborted = false;
    try {
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    } catch (error) {
      if (error instanceof BroadcastAbortedError) {
        aborted = true;
        for (let index = 0; index < deliveries.length; index += 1) {
          if (!deliveries[index]) {
            deliveries[index] = {
              recipient: recipients[index],
              error: {
                name: 'BroadcastAborted',
                message: error.message,
              },
            } satisfies BroadcastSendResultDelivery;
          }
        }
      } else {
        throw error;
      }
    }

    const delivered = deliveries.filter((entry) => !entry.error).length;
    const failed = deliveries.length - delivered;
    const durationMs = Date.now() - startedAt;

    if (aborted && abortedError) {
      options.logger?.error?.('broadcast pool aborted summary', {
        requestedBy,
        recipients: deliveries.length,
        filters: filters ?? null,
        source: resolved.source ?? null,
        delivered,
        failed,
        poolSize: concurrency,
        throttled429: throttledErrors,
        durationMs,
        reason: abortedError.reason,
      });
    } else {
      options.logger?.info?.('broadcast pool completed', {
        requestedBy,
        recipients: deliveries.length,
        filters: filters ?? null,
        source: resolved.source ?? null,
        delivered,
        failed,
        poolSize: concurrency,
        throttled429: throttledErrors,
        durationMs,
      });
    }

    options.logger?.info?.('broadcast deliveries recorded', {
      requestedBy,
      filters: filters ?? null,
      source: resolved.source ?? null,
      delivered,
      failed,
      recipients: deliveries.length,
    });

    options.telemetry?.record({
      requestedBy,
      recipients: deliveries.length,
      delivered,
      failed,
      throttled429: throttledErrors,
      durationMs,
      startedAt: new Date(startedAt),
      completedAt: new Date(startedAt + durationMs),
      status: aborted && abortedError ? 'aborted' : 'ok',
      abortReason: abortedError?.reason,
      error: abortedError
        ? { name: abortedError.name, message: abortedError.message }
        : undefined,
      filters,
    });

    if (aborted && abortedError) {
      throw abortedError;
    }

    return {
      delivered,
      failed,
      deliveries,
    } satisfies BroadcastSendResult;
  };
};

export const createImmediateBroadcastSender = (
  options: CreateImmediateBroadcastSenderOptions,
): SendBroadcast =>
  createBroadcastSender({
    messaging: options.messaging,
    messagingBroadcast: options.messagingBroadcast,
    resolveRecipients: () => {
      options.logger?.info?.('broadcast using env recipients', {
        filters: null,
        recipients: options.recipients.length,
      });

      return { recipients: options.recipients, source: 'env' } satisfies ResolveRecipientsResult;
    },
    logger: options.logger,
    pool: options.pool,
    telemetry: options.telemetry,
    emergencyStop: options.emergencyStop,
  });

export const createRegistryBroadcastSender = (
  options: CreateRegistryBroadcastSenderOptions,
): SendBroadcast => {
  const resolveRecipients = async (filters?: BroadcastAudienceFilter) => {
    try {
      const fromRegistry = await options.registry.listActiveRecipients(filters);
      if (fromRegistry.length > 0) {
        options.logger?.info?.('broadcast using registry recipients', {
          filters: filters ?? null,
          recipients: fromRegistry.length,
        });

        return { recipients: fromRegistry, source: 'registry' } satisfies ResolveRecipientsResult;
      }

        options.logger?.info?.('broadcast registry returned empty result', {
        filters: filters ?? null,
      });
    } catch (error) {
      options.logger?.warn?.('broadcast registry lookup failed', {
        error: toErrorDetails(error),
        filters: filters ?? null,
      });
    }

    options.logger?.warn?.('no broadcast recipients resolved', {
      filters: filters ?? null,
    });
    return { recipients: [], source: 'none' } satisfies ResolveRecipientsResult;
  };

  return createBroadcastSender({
    messaging: options.messaging,
    messagingBroadcast: options.messagingBroadcast,
    resolveRecipients,
    logger: options.logger,
    pool: options.pool,
    telemetry: options.telemetry,
    emergencyStop: options.emergencyStop,
  });
};
