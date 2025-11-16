import type { BroadcastAudienceFilter } from './broadcast-payload';
import type { BroadcastRecipient } from './minimal-broadcast-service';

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run<T = D1Result>(): Promise<T>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface D1Result {
  success?: boolean;
  changes?: number;
}

interface Logger {
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}

export interface BroadcastRecipientRecord {
  chatId: string;
  username?: string;
  languageCode?: string;
  createdAt: Date;
  activeFlag: boolean;
}

export interface BroadcastRecipientUpsertInput {
  chatId: string;
  username?: string;
  languageCode?: string;
}

export interface BroadcastRecipientsStore {
  listActiveRecipients(filter?: BroadcastAudienceFilter): Promise<BroadcastRecipient[]>;
  listActiveRecords(): Promise<BroadcastRecipientRecord[]>;
  upsertRecipient(input: BroadcastRecipientUpsertInput): Promise<void>;
  deactivateRecipient(chatId: string): Promise<void>;
}

export interface CreateBroadcastRecipientsStoreOptions {
  db: D1Database;
  cache?: KVNamespace;
  cacheKey?: string;
  cacheTtlMs?: number;
  logger?: Logger;
  now?: () => Date;
}

interface BroadcastRecipientRow {
  chatId: string | number;
  username: string | null;
  languageCode: string | null;
  createdAt: number | string | null;
  activeFlag: number | null;
}

const SELECT_ACTIVE_RECIPIENTS_SQL = `
  SELECT
    chat_id AS chatId,
    username,
    language_code AS languageCode,
    created_at AS createdAt,
    active_flag AS activeFlag
  FROM broadcast_recipients
  WHERE active_flag = 1
  ORDER BY created_at ASC;
`;

const UPSERT_RECIPIENT_SQL = `
  INSERT INTO broadcast_recipients (chat_id, username, language_code, active_flag)
  VALUES (?1, ?2, ?3, 1)
  ON CONFLICT(chat_id) DO UPDATE SET
    username = excluded.username,
    language_code = excluded.language_code,
    active_flag = 1;
`;

const DEACTIVATE_RECIPIENT_SQL = `
  UPDATE broadcast_recipients
  SET active_flag = 0
  WHERE chat_id = ?1;
`;

const CACHE_VERSION = 1;
const DEFAULT_CACHE_KEY = 'broadcast:recipients:active';

interface CachePayload {
  version: number;
  recipients: BroadcastRecipient[];
  refreshedAt: string;
}

const normalizeChatId = (value: string): string => value.trim();

const normalizeUsername = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim().replace(/^@+/, '');
  return trimmed.length > 0 ? trimmed.toLowerCase() : undefined;
};

const normalizeLanguageCode = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
};

const toDate = (value: number | string | null | undefined, fallback: Date): Date => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000);
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return new Date(parsed * 1000);
    }

    const timestamp = new Date(value);
    if (!Number.isNaN(timestamp.getTime())) {
      return timestamp;
    }
  }

  return fallback;
};

const mapRowToRecord = (row: BroadcastRecipientRow, now: Date): BroadcastRecipientRecord => ({
  chatId: normalizeChatId(String(row.chatId)),
  username: normalizeUsername(row.username ?? undefined),
  languageCode: normalizeLanguageCode(row.languageCode ?? undefined),
  createdAt: toDate(row.createdAt, now),
  activeFlag: row.activeFlag === 1,
});

const toRecipient = (record: BroadcastRecipientRecord): BroadcastRecipient => ({
  chatId: record.chatId,
  username: record.username,
  languageCode: record.languageCode,
});

const applyFilters = (
  recipients: BroadcastRecipient[],
  filters: BroadcastAudienceFilter | undefined,
): BroadcastRecipient[] => {
  if (!filters) {
    return recipients;
  }

  let filtered = recipients;

  if (filters.chatIds?.length) {
    const chatIds = new Set(filters.chatIds.map((id) => id.trim()));
    filtered = filtered.filter((recipient) => chatIds.has(recipient.chatId));
  }

  if (filters.userIds?.length) {
    const userIds = new Set(filters.userIds.map((id) => id.trim()));
    filtered = filtered.filter((recipient) => userIds.has(recipient.chatId));
  }

  if (filters.languageCodes?.length) {
    const languages = new Set(filters.languageCodes.map((code) => code.trim().toLowerCase()));
    filtered = filtered.filter((recipient) => {
      if (!recipient.languageCode) {
        return false;
      }

      return languages.has(recipient.languageCode.toLowerCase());
    });
  }

  return filtered;
};

const serializeCachePayload = (payload: CachePayload): string => JSON.stringify(payload);

const parseCachePayload = (raw: string | null): CachePayload | undefined => {
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as CachePayload;
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.recipients)) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
};

const deduplicateRecipients = (recipients: BroadcastRecipient[]): BroadcastRecipient[] => {
  const seen = new Map<string, number>();
  const result: BroadcastRecipient[] = [];

  for (const recipient of recipients) {
    const key = `${recipient.chatId}`;
    const existingIndex = seen.get(key);

    if (existingIndex !== undefined) {
      const existing = result[existingIndex];
      if (!existing.username && recipient.username) {
        result[existingIndex] = { ...existing, username: recipient.username };
      }

      if (!existing.languageCode && recipient.languageCode) {
        result[existingIndex] = { ...existing, languageCode: recipient.languageCode };
      }

      continue;
    }

    seen.set(key, result.length);
    result.push(recipient);
  }

  return result;
};

export const createBroadcastRecipientsStore = (
  options: CreateBroadcastRecipientsStoreOptions,
): BroadcastRecipientsStore => {
  const cacheKey = options.cacheKey ?? DEFAULT_CACHE_KEY;
  const cacheTtlSeconds = options.cacheTtlMs ? Math.max(1, Math.floor(options.cacheTtlMs / 1000)) : undefined;
  const now = options.now ?? (() => new Date());

  const readActiveRecords = async (): Promise<BroadcastRecipientRecord[]> => {
    try {
      const statement = options.db.prepare(SELECT_ACTIVE_RECIPIENTS_SQL);
      const { results } = await statement.all<BroadcastRecipientRow>();
      const currentTime = now();
      return results.map((row) => mapRowToRecord(row, currentTime));
    } catch (error) {
      options.logger?.error?.('failed to read broadcast recipients from d1', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const readActiveRecipients = async (): Promise<BroadcastRecipient[]> => {
    if (options.cache) {
      const cached = parseCachePayload(await options.cache.get(cacheKey));
      if (cached) {
        return deduplicateRecipients(cached.recipients);
      }
    }

    const records = await readActiveRecords();
    const recipients = records.filter((record) => record.activeFlag).map(toRecipient);

    if (options.cache) {
      const payload: CachePayload = {
        version: CACHE_VERSION,
        recipients,
        refreshedAt: now().toISOString(),
      };

      try {
        await options.cache.put(cacheKey, serializeCachePayload(payload), {
          expirationTtl: cacheTtlSeconds,
        });
      } catch (error) {
        options.logger?.warn?.('failed to update broadcast recipients cache', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return deduplicateRecipients(recipients);
  };

  const invalidateCache = async () => {
    if (!options.cache) {
      return;
    }

    try {
      await options.cache.delete(cacheKey);
    } catch (error) {
      options.logger?.warn?.('failed to invalidate broadcast recipients cache', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    async listActiveRecipients(filter) {
      const recipients = await readActiveRecipients();
      return applyFilters(recipients, filter);
    },
    async listActiveRecords() {
      const records = await readActiveRecords();
      return records.filter((record) => record.activeFlag);
    },
    async upsertRecipient(input) {
      const chatId = normalizeChatId(input.chatId);
      const username = normalizeUsername(input.username);
      const languageCode = normalizeLanguageCode(input.languageCode);

      try {
        const statement = options.db.prepare(UPSERT_RECIPIENT_SQL);
        await statement.bind(chatId, username ?? null, languageCode ?? null).run();
        options.logger?.info?.('broadcast recipient upserted', {
          chatId,
          username: username ?? null,
          languageCode: languageCode ?? null,
        });
      } catch (error) {
        options.logger?.error?.('failed to upsert broadcast recipient', {
          chatId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      await invalidateCache();
    },
    async deactivateRecipient(chatIdInput) {
      const chatId = normalizeChatId(chatIdInput);

      try {
        const statement = options.db.prepare(DEACTIVATE_RECIPIENT_SQL);
        await statement.bind(chatId).run();
        options.logger?.info?.('broadcast recipient deactivated', { chatId });
      } catch (error) {
        options.logger?.error?.('failed to deactivate broadcast recipient', {
          chatId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      await invalidateCache();
    },
  } satisfies BroadcastRecipientsStore;
};

export type { D1Database };
