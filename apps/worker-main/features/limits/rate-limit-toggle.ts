import type { RateLimitPort } from '../../ports';

export interface LimitsFlagKvNamespace {
  get(key: string, options?: unknown): Promise<string | null>;
}

export interface RateLimitToggleLogger {
  warn?: (message: string, details?: Record<string, unknown>) => void;
}

export interface CreateRateLimitToggleOptions {
  kv: LimitsFlagKvNamespace;
  rateLimit: RateLimitPort;
  flagKey?: string;
  refreshIntervalMs?: number;
  logger?: RateLimitToggleLogger;
  now?: () => number;
}

const DEFAULT_FLAG_KEY = 'LIMITS_ENABLED';
const DEFAULT_REFRESH_INTERVAL_MS = 5_000;

const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no', 'disabled']);
const ENABLED_VALUES = new Set(['1', 'true', 'on', 'yes', 'enabled']);

const normalizeFlagValue = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return trimmed.toLowerCase();
};

const isFlagEnabled = (value: string | null | undefined): boolean => {
  const normalized = normalizeFlagValue(value);
  if (!normalized) {
    return true;
  }

  if (DISABLED_VALUES.has(normalized)) {
    return false;
  }

  if (ENABLED_VALUES.has(normalized)) {
    return true;
  }

  return true;
};

const toErrorDetails = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return { message: 'Unknown error' };
};

const getWarn = (logger?: RateLimitToggleLogger) => {
  if (logger?.warn) {
    return logger.warn.bind(logger);
  }

  return (message: string, details?: Record<string, unknown>) => {
    if (details) {
      console.warn(`[rate-limit-toggle] ${message}`, details);
    } else {
      console.warn(`[rate-limit-toggle] ${message}`);
    }
  };
};

export const createRateLimitToggle = (options: CreateRateLimitToggleOptions): RateLimitPort => {
  const flagKey = options.flagKey ?? DEFAULT_FLAG_KEY;
  const refreshIntervalMs = Math.max(0, options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS);
  const now = options.now ?? (() => Date.now());
  const warn = getWarn(options.logger);

  let cachedState: { value: boolean; expiresAt: number } | undefined;

  const computeNextExpiry = (currentTime: number) =>
    (refreshIntervalMs === 0 ? currentTime : currentTime + refreshIntervalMs);

  const readFlag = async (): Promise<boolean> => {
    const currentTime = now();

    if (cachedState && refreshIntervalMs > 0 && currentTime < cachedState.expiresAt) {
      return cachedState.value;
    }

    try {
      const raw = await options.kv.get(flagKey);
      const enabled = isFlagEnabled(raw);
      cachedState = {
        value: enabled,
        expiresAt: computeNextExpiry(currentTime),
      };
      return enabled;
    } catch (error) {
      warn('failed to read limits flag', {
        flagKey,
        ...toErrorDetails(error),
      });

      const fallbackEnabled = false;
      cachedState = {
        value: fallbackEnabled,
        expiresAt: computeNextExpiry(currentTime),
      };
      return fallbackEnabled;
    }
  };

  return {
    async checkAndIncrement(input) {
      const enabled = await readFlag();
      if (!enabled) {
        return 'ok';
      }

      return options.rateLimit.checkAndIncrement(input);
    },
  };
};
