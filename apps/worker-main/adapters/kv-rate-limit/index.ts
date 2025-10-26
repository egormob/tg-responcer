import type { RateLimitContext, RateLimitPort } from '../../ports';

export interface RateLimitKvNamespace {
  get(key: string, type?: 'text'): Promise<string | null>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
}

export interface KvRateLimitAdapterLogger {
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}

export interface KvRateLimitAdapterOptions {
  kv: RateLimitKvNamespace;
  /**
   * Максимальное число обращений за окно.
   */
  limit: number;
  /**
   * Длительность окна в миллисекундах. По умолчанию — 24 часа.
   */
  windowMs?: number;
  /**
   * Префикс ключей в KV, чтобы разделять окружения.
   */
  prefix?: string;
  logger?: KvRateLimitAdapterLogger;
  /**
   * Источник времени в миллисекундах. По умолчанию `Date.now`.
   */
  now?: () => number;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PREFIX = 'rate_limit';

const normalizeLimit = (limit: number): number => {
  if (!Number.isFinite(limit)) {
    return 1;
  }

  const normalized = Math.floor(limit);
  if (normalized <= 0) {
    return 1;
  }

  return normalized;
};

const normalizeWindow = (windowMs: number | undefined): number => {
  if (!Number.isFinite(windowMs ?? NaN)) {
    return DEFAULT_WINDOW_MS;
  }

  const normalized = Math.floor(windowMs ?? DEFAULT_WINDOW_MS);
  if (normalized <= 0) {
    return DEFAULT_WINDOW_MS;
  }

  return normalized;
};

const encodeKeyPart = (value: string | undefined): string | undefined =>
  typeof value === 'string' && value.length > 0 ? encodeURIComponent(value) : undefined;

interface KeyInput {
  prefix: string;
  userId: string;
  context?: RateLimitContext;
  bucket: number;
}

const buildKey = ({ prefix, userId, context, bucket }: KeyInput): string => {
  const parts = [prefix];

  const scope = encodeKeyPart(context?.scope);
  if (scope) {
    parts.push(`scope:${scope}`);
  }

  const chatId = encodeKeyPart(context?.chatId);
  if (chatId) {
    parts.push(`chat:${chatId}`);
  }

  const threadId = encodeKeyPart(context?.threadId);
  if (threadId) {
    parts.push(`thread:${threadId}`);
  }

  parts.push(`user:${encodeKeyPart(userId) ?? 'unknown'}`);
  parts.push(`bucket:${bucket}`);

  return parts.join(':');
};

const getLogger = (logger?: KvRateLimitAdapterLogger) => {
  const prefix = '[kv-rate-limit]';

  return {
    warn(message: string, details?: Record<string, unknown>) {
      if (logger?.warn) {
        logger.warn(message, details);
        return;
      }

      if (details) {
        console.warn(`${prefix} ${message}`, details);
      } else {
        console.warn(`${prefix} ${message}`);
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

interface WindowInfo {
  bucket: number;
  windowEnd: number;
}

const computeWindowInfo = (nowMs: number, windowMs: number): WindowInfo => {
  const bucket = Math.floor(nowMs / windowMs);
  const windowStart = bucket * windowMs;
  const windowEnd = windowStart + windowMs;

  return { bucket, windowEnd };
};

const parseCounter = (raw: string | null, logger: ReturnType<typeof getLogger>, key: string): number => {
  if (typeof raw !== 'string') {
    return 0;
  }

  const parsed = Number.parseInt(raw, 10);

  if (Number.isNaN(parsed) || parsed < 0) {
    logger.warn('invalid counter value', { key, raw });
    return 0;
  }

  return parsed;
};

const toTtlSeconds = (windowEnd: number, nowMs: number): number => {
  const remainingMs = windowEnd - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return 1;
  }

  const seconds = Math.ceil(remainingMs / 1000);
  return seconds > 0 ? seconds : 1;
};

export const createKvRateLimitAdapter = (options: KvRateLimitAdapterOptions): RateLimitPort => {
  const limit = normalizeLimit(options.limit);
  const windowMs = normalizeWindow(options.windowMs);
  const prefix = options.prefix?.trim().length ? options.prefix.trim() : DEFAULT_PREFIX;
  const now = options.now ?? (() => Date.now());
  const logger = getLogger(options.logger);

  return {
    async checkAndIncrement(input) {
      const nowMs = now();
      const { bucket, windowEnd } = computeWindowInfo(nowMs, windowMs);
      const key = buildKey({
        prefix,
        userId: input.userId,
        context: input.context,
        bucket,
      });

      let current = 0;

      try {
        const raw = await options.kv.get(key, 'text');
        current = parseCounter(raw, logger, key);
      } catch (error) {
        logger.error('failed to read counter', {
          key,
          error: error instanceof Error ? { name: error.name, message: error.message } : { message: 'Unknown error' },
        });
        return 'ok';
      }

      if (current >= limit) {
        return 'limit';
      }

      const nextValue = current + 1;
      const expirationTtl = toTtlSeconds(windowEnd, nowMs);

      try {
        await options.kv.put(key, String(nextValue), { expirationTtl });
      } catch (error) {
        logger.error('failed to update counter', {
          key,
          error: error instanceof Error ? { name: error.name, message: error.message } : { message: 'Unknown error' },
        });
        return 'ok';
      }

      return 'ok';
    },
  };
};

