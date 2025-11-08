import type { AdminAccessKvNamespace } from './admin-access';

interface Logger {
  warn?(message: string, details?: Record<string, unknown>): void;
}

export type AdminDiagnosticsKvNamespace = AdminAccessKvNamespace;

export type AdminMessagingErrorSource = 'primary' | 'fallback' | 'none';

const ADMIN_ERROR_KEY_PREFIX = 'admin-error:';
const ADMIN_ERROR_RATE_LIMIT_PREFIX = 'admin-error-rate:';
const ADMIN_ERROR_TTL_SECONDS = 10 * 24 * 60 * 60;
const ADMIN_ERROR_RATE_LIMIT_TTL_SECONDS = 60;
const ADMIN_ERROR_COMMAND_MAX_LENGTH = 64;
const ADMIN_ERROR_DESCRIPTION_MAX_LENGTH = 256;
const DEFAULT_LIST_PAGE_SIZE = 1000;

export interface TelegramErrorDetails {
  status?: number;
  description?: string;
}

export interface AdminCommandErrorRecorderOptions {
  primaryKv?: AdminDiagnosticsKvNamespace;
  fallbackKv?: AdminDiagnosticsKvNamespace;
  logger?: Logger;
  now?: () => Date;
}

export interface AdminCommandErrorRecorder {
  record(input: {
    userId: string;
    command: string;
    error: unknown;
    details?: TelegramErrorDetails;
  }): Promise<void>;
  source: AdminMessagingErrorSource;
  namespace?: AdminDiagnosticsKvNamespace;
}

export interface AdminMessagingErrorEntry {
  key: string;
  userId: string;
  command: string;
  code: number;
  when: string;
  desc?: string;
}

export interface AdminMessagingErrorSummary {
  entries: AdminMessagingErrorEntry[];
  total: number;
  topByCode: Array<{ code: number; count: number }>;
}

const createLogger = (logger?: Logger) => ({
  warn(message: string, details?: Record<string, unknown>) {
    logger?.warn?.(message, details);
  },
});

const normalizeUserId = (userId: string): string | undefined => {
  const normalized = userId.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const normalizeCommandLabel = (command: string): string => {
  const normalized = command.trim().toLowerCase();
  if (normalized.length === 0) {
    return 'unknown';
  }

  return normalized.length <= ADMIN_ERROR_COMMAND_MAX_LENGTH
    ? normalized
    : normalized.slice(0, ADMIN_ERROR_COMMAND_MAX_LENGTH);
};

const sanitizeDescription = (description: string | undefined): string | undefined => {
  if (!description) {
    return undefined;
  }

  const normalized = description.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  if (normalized.length <= ADMIN_ERROR_DESCRIPTION_MAX_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, ADMIN_ERROR_DESCRIPTION_MAX_LENGTH - 1)}…`;
};

const shouldPersistStatus = (status: number | undefined): status is number => {
  if (typeof status !== 'number' || !Number.isFinite(status)) {
    return false;
  }

  if (status === 400 || status === 403 || status === 429) {
    return true;
  }

  return status >= 500;
};

const shouldInvalidateAccess = (status: number | undefined): boolean =>
  status === 400 || status === 403;

const toTimestampKey = (date: Date): string => {
  const year = date.getUTCFullYear().toString().padStart(4, '0');
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  const hours = date.getUTCHours().toString().padStart(2, '0');
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');
  const seconds = date.getUTCSeconds().toString().padStart(2, '0');

  return `${year}${month}${day}${hours}${minutes}${seconds}`;
};

const toSafeTimestamp = (value: string | undefined): number => {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const extractTelegramErrorDetails = (error: unknown): TelegramErrorDetails => {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const { status } = error as { status?: unknown };
    const statusValue = typeof status === 'number' && Number.isFinite(status) ? status : undefined;

    let description: string | undefined;
    if ('description' in error) {
      const descriptionValue = (error as { description?: unknown }).description;
      description = typeof descriptionValue === 'string' ? descriptionValue : undefined;
    }

    return { status: statusValue, description };
  }

  return {};
};

export const createAdminCommandErrorRecorder = (
  options: AdminCommandErrorRecorderOptions,
): AdminCommandErrorRecorder => {
  const logger = createLogger(options.logger);
  const now = options.now ?? (() => new Date());
  const namespace = options.primaryKv ?? options.fallbackKv;
  const source: AdminMessagingErrorSource = options.primaryKv
    ? 'primary'
    : options.fallbackKv
      ? 'fallback'
      : 'none';

  const record: AdminCommandErrorRecorder['record'] = async ({
    userId,
    command,
    error,
    details: providedDetails,
  }) => {
    if (!namespace) {
      return;
    }

    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) {
      return;
    }

    const details = providedDetails ?? extractTelegramErrorDetails(error);
    if (!shouldPersistStatus(details.status)) {
      return;
    }

    const limiterKey = `${ADMIN_ERROR_RATE_LIMIT_PREFIX}${normalizedUserId}:${normalizeCommandLabel(command)}`;
    try {
      const existing = await namespace.get(limiterKey, 'text');
      if (typeof existing === 'string') {
        return;
      }
    } catch (limiterReadError) {
      logger.warn('failed to read admin error limiter key', {
        key: limiterKey,
        error:
          limiterReadError instanceof Error
            ? { name: limiterReadError.name, message: limiterReadError.message }
            : String(limiterReadError),
      });
    }

    try {
      await namespace.put(limiterKey, '1', { expirationTtl: ADMIN_ERROR_RATE_LIMIT_TTL_SECONDS });
    } catch (limiterWriteError) {
      logger.warn('failed to write admin error limiter key', {
        key: limiterKey,
        error:
          limiterWriteError instanceof Error
            ? { name: limiterWriteError.name, message: limiterWriteError.message }
            : String(limiterWriteError),
      });
    }

    const timestamp = now();
    const key = `${ADMIN_ERROR_KEY_PREFIX}${normalizedUserId}:${toTimestampKey(timestamp)}`;
    const payload: Record<string, unknown> = {
      user_id: normalizedUserId,
      cmd: normalizeCommandLabel(command),
      code: details.status,
      when: timestamp.toISOString(),
    };

    const sanitizedDescription = sanitizeDescription(details.description);
    if (sanitizedDescription) {
      payload.desc = sanitizedDescription;
    }

    try {
      await namespace.put(key, JSON.stringify(payload), { expirationTtl: ADMIN_ERROR_TTL_SECONDS });
    } catch (errorWriteError) {
      logger.warn('failed to write admin error entry', {
        key,
        error:
          errorWriteError instanceof Error
            ? { name: errorWriteError.name, message: errorWriteError.message }
            : String(errorWriteError),
      });
    }
  };

  return { record, source, namespace } satisfies AdminCommandErrorRecorder;
};

export const readAdminMessagingErrors = async (
  kv: AdminDiagnosticsKvNamespace,
  options?: { limit?: number },
): Promise<AdminMessagingErrorSummary> => {
  const limit = Math.max(1, options?.limit ?? 50);
  const keys: string[] = [];
  let cursor: string | undefined;

  do {
    const page = await kv.list({
      prefix: ADMIN_ERROR_KEY_PREFIX,
      cursor,
      limit: DEFAULT_LIST_PAGE_SIZE,
    });

    for (const key of page.keys) {
      keys.push(key.name);
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const records: AdminMessagingErrorEntry[] = [];

  for (const key of keys) {
    const raw = await kv.get(key, 'text');
    if (typeof raw !== 'string') {
      continue;
    }

    try {
      const parsed = JSON.parse(raw) as {
        user_id?: unknown;
        cmd?: unknown;
        code?: unknown;
        when?: unknown;
        desc?: unknown;
      };

      const userId = typeof parsed.user_id === 'string' ? parsed.user_id : undefined;
      const command = typeof parsed.cmd === 'string' ? parsed.cmd : undefined;
      const code = typeof parsed.code === 'number' && Number.isFinite(parsed.code) ? parsed.code : undefined;
      const when = typeof parsed.when === 'string' ? parsed.when : undefined;
      const desc = typeof parsed.desc === 'string' ? parsed.desc : undefined;

      if (!userId || !command || code === undefined || !when) {
        continue;
      }

      records.push({ key, userId, command, code, when, desc });
    } catch (parseError) {
      // Skip malformed entries but continue processing others.
    }
  }

  records.sort((a, b) => {
    const timestampDiff = toSafeTimestamp(b.when) - toSafeTimestamp(a.when);
    if (timestampDiff !== 0) {
      return timestampDiff;
    }

    return b.key.localeCompare(a.key);
  });

  const limitedEntries = records.slice(0, limit);

  const codeCounts = new Map<number, number>();
  for (const record of records) {
    codeCounts.set(record.code, (codeCounts.get(record.code) ?? 0) + 1);
  }

  const topByCode = Array.from(codeCounts.entries())
    .sort((a, b) => {
      const countDiff = b[1] - a[1];
      if (countDiff !== 0) {
        return countDiff;
      }

      return a[0] - b[0];
    })
    .slice(0, 5)
    .map(([code, count]) => ({ code, count }));

  return {
    entries: limitedEntries,
    total: records.length,
    topByCode,
  };
};

export const shouldInvalidateAdminAccess = (details: TelegramErrorDetails): boolean =>
  shouldInvalidateAccess(details.status);
