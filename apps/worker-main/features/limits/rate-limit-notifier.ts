import type { MessagingPort } from '../../ports';

export interface RateLimitNotifierLogger {
  info?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}

export interface CreateRateLimitNotifierOptions {
  messaging: MessagingPort;
  limit: number;
  windowMs?: number;
  logger?: RateLimitNotifierLogger;
  now?: () => number;
  formatMessage?: (details: RateLimitNotificationDetails) => string;
}

export interface RateLimitNotificationDetails {
  userId: string;
  chatId: string;
  threadId?: string;
  limit: number;
  ttlMs: number;
}

export interface RateLimitNotifierNotificationResult {
  handled: boolean;
}

export interface RateLimitNotifier {
  notify(input: {
    userId: string;
    chatId: string;
    threadId?: string;
  }): Promise<RateLimitNotifierNotificationResult>;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

const normalizeWindowMs = (windowMs: number | undefined): number => {
  if (!Number.isFinite(windowMs ?? NaN)) {
    return DEFAULT_WINDOW_MS;
  }

  const normalized = Math.floor(windowMs ?? DEFAULT_WINDOW_MS);
  return normalized > 0 ? normalized : DEFAULT_WINDOW_MS;
};

const formatDuration = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (hours > 0) {
    return `${hours}h`;
  }

  if (minutes > 0) {
    return `${minutes}m`;
  }

  if (seconds > 0) {
    return `${seconds}s`;
  }

  return '0s';
};

const defaultMessage = (details: RateLimitNotificationDetails): string => {
  const readableTtl = formatDuration(details.ttlMs);
  return `🥶⌛️ ${readableTtl} Лимит доступных запросов исчерпан, диалог временно приостановален. Продолжение диалога доступно завтра.`;
};

const createLogger = (logger?: RateLimitNotifierLogger) => {
  const prefix = '[rate-limit-notifier]';

  return {
    info(message: string, details?: Record<string, unknown>) {
      if (logger?.info) {
        logger.info(message, details);
        return;
      }

      if (details) {
        console.info(`${prefix} ${message}`, details);
      } else {
        console.info(`${prefix} ${message}`);
      }
    },
    error(message: string, details?: Record<string, unknown>) {
      if (logger?.error) {
        logger.error(message, details);
        return;
      }

      if (details) {
        console.error(`${prefix} ${message}`, details);
      } else {
        console.error(`${prefix} ${message}`);
      }
    },
  };
};

const computeTtlMs = (nowMs: number, windowMs: number): number => {
  const remainder = nowMs % windowMs;
  if (!Number.isFinite(remainder) || remainder < 0) {
    return windowMs;
  }

  const remaining = windowMs - remainder;
  return remaining > 0 ? remaining : windowMs;
};

export const createRateLimitNotifier = (
  options: CreateRateLimitNotifierOptions,
): RateLimitNotifier => {
  const windowMs = normalizeWindowMs(options.windowMs);
  const now = options.now ?? (() => Date.now());
  const logger = createLogger(options.logger);
  const buildMessage = options.formatMessage ?? defaultMessage;

  return {
    async notify(input) {
      const nowMs = now();
      const ttlMs = computeTtlMs(nowMs, windowMs);

      const details: RateLimitNotificationDetails = {
        userId: input.userId,
        chatId: input.chatId,
        threadId: input.threadId,
        limit: options.limit,
        ttlMs,
      };

      const message = buildMessage(details);

      try {
        await options.messaging.sendText({
          chatId: input.chatId,
          threadId: input.threadId,
          text: message,
        });
        logger.info('rate limit notification sent', {
          userId: input.userId,
          chatId: input.chatId,
          threadId: input.threadId,
          limit: options.limit,
          ttlMs,
        });

        return { handled: true };
      } catch (error) {
        logger.error('failed to send rate limit notification', {
          userId: input.userId,
          chatId: input.chatId,
          threadId: input.threadId,
          limit: options.limit,
          ttlMs,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : { message: 'Unknown error' },
        });

        return { handled: false };
      }
    },
  };
};

